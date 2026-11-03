import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { WorkerError, throwIfAborted } from './worker-error.mjs'

async function readMetadata(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new WorkerError('SESSION_METADATA_INVALID', '会话记录无法读取')
  }
}

/**
 * Acquire the session lock, verify (resume) or reserve (new) the durable
 * owner and metadata binding, then begin the run-store ledger entry.
 * `query.lock` is assigned as soon as the lock is held so the caller's
 * settlement can release it; `run.recoveryCwd` only after the ledger began.
 * @returns {Promise<string>} the SDK session working directory
 */
export async function bindQuerySession({ sdk, sessionRoot, acquireLock, runStore }, query, { compact, systemPrompt, dshSessionId }) {
  const { params, run, runId, sessionId, deviceId, diagnose } = query
  const { controller } = run
  let lockLost = false
  const locksDir = join(sessionRoot, '_locks')
  const ownersDir = join(sessionRoot, '_owners')
  const deviceRoot = join(sessionRoot, 'devices', deviceId)
  await mkdir(locksDir, { recursive: true, mode: 0o700 })
  await mkdir(ownersDir, { recursive: true, mode: 0o700 })
  await mkdir(deviceRoot, { recursive: true, mode: 0o700 })
  try { query.lock = await acquireLock(join(locksDir, `${sessionId}.lock`), { signal: controller.signal }) } catch (error) {
    const known = ['CANCELLED', 'SESSION_BUSY', 'LOCK_UNAVAILABLE', 'LOCK_TIMEOUT'].includes(error?.code)
    throw new WorkerError(known ? error.code : 'LOCK_UNAVAILABLE', known ? error.message : '会话锁无法获取')
  }
  const lock = query.lock
  lock.lost.then((loss) => {
    if (!loss) return
    lockLost = true
    if (run && !run.problem) {
      run.problem = new WorkerError('SESSION_LOCK_LOST', '会话锁意外释放，执行结果需核实', { toolMayHaveExecuted: true })
      run.controller.abort()
    }
  }).catch(() => {
    lockLost = true
    if (run && !run.problem) {
      run.problem = new WorkerError('SESSION_LOCK_LOST', '会话锁状态异常，执行结果需核实', { toolMayHaveExecuted: true })
      run.controller.abort()
    }
  })
  const ownerPath = join(ownersDir, `${sessionId}.json`)
  const expectedOwner = { version: 2, engine: 'claude-sdk', sessionId, deviceId, dshSessionId }
  const existingOwner = await readMetadata(ownerPath)
  const cwd = join(deviceRoot, sessionId)
  const metadataPath = join(cwd, 'bridge-session.json')
  // Claude Code snapshots the system prompt on the first request. Hash the
  // exact rendered string, never the prompt itself, so later changes cannot
  // be silently accepted while the SDK continues using the old snapshot.
  const systemPromptSha256 = compact ? undefined : createHash('sha256').update(systemPrompt, 'utf8').digest('hex')
  const expectedMetadata = { ...expectedOwner, projectPath: params.projectPath, systemPromptSha256 }
  if (params.resume) {
    if (!existingOwner) throw new WorkerError('NATIVE_CONTEXT_MISSING', 'SDK 会话归属记录不存在')
    if (existingOwner.version !== 2 || existingOwner.engine !== 'claude-sdk' || existingOwner.sessionId !== sessionId
      || existingOwner.deviceId !== deviceId || existingOwner.dshSessionId !== dshSessionId) {
      throw new WorkerError('SESSION_BINDING_MISMATCH', 'SDK 会话不属于当前设备和 DSH 会话')
    }
    const metadata = await readMetadata(metadataPath)
    if (!metadata) throw new WorkerError('NATIVE_CONTEXT_MISSING', '桥接会话记录不存在')
    if (metadata.version !== 2 || metadata.engine !== 'claude-sdk' || metadata.sessionId !== sessionId
      || metadata.deviceId !== deviceId || metadata.dshSessionId !== dshSessionId || metadata.projectPath !== params.projectPath) {
      throw new WorkerError('SESSION_BINDING_MISMATCH', '会话设备、引擎或项目路径与原记录不一致')
    }
    if (typeof metadata.systemPromptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.systemPromptSha256)) {
      throw new WorkerError('SYSTEM_PROMPT_BASELINE_MISSING', '原会话缺少可验证的系统提示基线，请新建远程会话')
    }
    if (!compact && metadata.systemPromptSha256 !== systemPromptSha256) {
      throw new WorkerError('SYSTEM_PROMPT_CHANGED', '系统提示已改变；Claude 原生会话仍使用旧提示，请新建远程会话')
    }
    const existing = await sdk.getSessionInfo(sessionId, { dir: cwd })
    if (!existing) {
      const messages = typeof sdk.getSessionMessages === 'function'
        ? await sdk.getSessionMessages(sessionId, { dir: cwd, offset: 0, limit: 1, includeSystemMessages: false }) : []
      if (!Array.isArray(messages) || !messages.length || messages[0].session_id !== sessionId) {
        throw new WorkerError('NATIVE_CONTEXT_MISSING', '尚不能确认 Claude 原生会话，请保留记录后核实')
      }
    }
    diagnose('session', 'resumed')
  } else {
    // A reused ID is never guessed to be safe after an interrupted attempt.
    if (existingOwner) throw new WorkerError('SESSION_ALREADY_EXISTS', 'SDK 会话标识已被使用')
    const ownerFile = await open(ownerPath, 'wx', 0o600)
    try { await ownerFile.writeFile(`${JSON.stringify(expectedOwner)}\n`, 'utf8') } finally { await ownerFile.close() }
    try {
      await mkdir(cwd, { mode: 0o700 })
    } catch (error) {
      if (error?.code === 'EEXIST') throw new WorkerError('SESSION_ALREADY_EXISTS', '会话目录已存在，请使用新会话')
      throw error
    }
    const file = await open(metadataPath, 'wx', 0o600)
    try { await file.writeFile(`${JSON.stringify(expectedMetadata)}\n`, 'utf8') } finally { await file.close() }
    diagnose('session', 'reserved')
  }
  if (lockLost || !lock.held) throw new WorkerError('SESSION_LOCK_LOST', '会话锁意外释放')
  throwIfAborted(controller.signal)
  await runStore.begin(cwd, runId, compact ? 'compact' : 'query')
  run.recoveryCwd = cwd
  return cwd
}
