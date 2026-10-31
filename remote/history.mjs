import { open, readFile, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ID = /^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9_.:-]{1,256}$/
const MAX_REPLY_BYTES = 3 * 1024 * 1024
const problem = (code, message) => Object.assign(new Error(message), { code })
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const timestamp = value => Number.isSafeInteger(value) && value >= 0
function runsOf(state) {
  if (!object(state) || state.version !== 1 || !object(state.runs)) throw problem('RECOVERY_METADATA_INVALID', '云端运行记录不兼容')
  const clean = {}
  for (const [id, run] of Object.entries(state.runs)) {
    if (!ID.test(id) || !object(run) || !['query', 'compact'].includes(run.kind)
      || !['running', 'completed', 'cancelled', 'failed', 'unknown'].includes(run.status)
      || !timestamp(run.startedAt) || !object(run.tools)
      || (run.finishedAt !== undefined && !timestamp(run.finishedAt))
      || Object.keys(run.tools).length > 4096) throw problem('RECOVERY_METADATA_INVALID', '云端运行记录无法确认')
    const tools = {}
    for (const [callId, receipt] of Object.entries(run.tools)) {
      if (!ID.test(callId) || !object(receipt) || typeof receipt.name !== 'string'
        || !/^[A-Za-z0-9_-]{1,64}$/.test(receipt.name)
        || !/^[a-f0-9]{64}$/.test(receipt.argumentsSha256) || !timestamp(receipt.receivedAt)) {
        throw problem('RECOVERY_METADATA_INVALID', '云端工具回执无法确认')
      }
      tools[callId] = { name: receipt.name, argumentsSha256: receipt.argumentsSha256, receivedAt: receipt.receivedAt }
    }
    clean[id] = { kind: run.kind, status: run.status, startedAt: run.startedAt, tools,
      ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
      ...(run.toolMayHaveExecuted === undefined ? {} : { toolMayHaveExecuted: run.toolMayHaveExecuted === true }),
      ...(typeof run.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(run.code) ? { code: run.code } : {}) }
  }
  return clean
}
async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw problem('RECOVERY_METADATA_INVALID', '云端恢复记录无法读取') }
}

/** Private metadata only. Native SDK transcripts remain the source of text. */
export function createRunStore() {
  const queues = new Map()
  function update(cwd, action) {
    const job = (queues.get(cwd) ?? Promise.resolve()).then(async () => {
      const path = join(cwd, 'bridge-runs.json')
      const state = await readJson(path) ?? { version: 1, runs: {} }
      state.runs = runsOf(state)
      action(state.runs)
      const removable = Object.entries(state.runs).filter(([, run]) => run.status !== 'running')
      while (Object.keys(state.runs).length > 64 && removable.length) delete state.runs[removable.shift()[0]]
      const temporary = join(cwd, `bridge-runs.${randomUUID()}.tmp`)
      const file = await open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(state)); await file.sync() } finally { await file.close() }
      try {
        await rename(temporary, path)
        if (process.platform !== 'win32') {
          const directory = await open(cwd, 'r')
          try { await directory.sync() } finally { await directory.close() }
        }
      } catch (error) { await unlink(temporary).catch(() => {}); throw error }
    })
    const settled = job.catch(() => {})
    queues.set(cwd, settled)
    settled.finally(() => { if (queues.get(cwd) === settled) queues.delete(cwd) })
    return job
  }
  return {
    begin(cwd, runId, kind) {
      if (!ID.test(runId) || !['query', 'compact'].includes(kind)) throw problem('INVALID_REQUEST', '云端运行标识无效')
      return update(cwd, runs => {
      if (Object.hasOwn(runs, runId)) throw problem('DUPLICATE_RUN', '运行标识已被使用')
      runs[runId] = { kind, status: 'running', startedAt: Date.now(), tools: {} }
    }) },
    receipt(cwd, runId, callId, name, argumentsValue) { return update(cwd, runs => {
      const run = runs[runId]
      if (!ID.test(callId) || !/^[A-Za-z0-9_-]{1,64}$/.test(name)
        || !run || Object.keys(run.tools).length >= 4096) throw problem('RECOVERY_METADATA_INVALID', '云端工具记录无法保存')
      run.tools[callId] = { name, argumentsSha256: createHash('sha256').update(JSON.stringify(argumentsValue)).digest('hex'), receivedAt: Date.now() }
    }) },
    finish(cwd, runId, outcome) { return update(cwd, runs => {
      const run = runs[runId]
      if (!run) throw problem('RECOVERY_METADATA_INVALID', '缺少云端运行记录')
      Object.assign(run, { status: ['completed', 'cancelled', 'failed'].includes(outcome?.status) ? outcome.status : 'unknown', finishedAt: Date.now(),
        toolMayHaveExecuted: outcome?.toolMayHaveExecuted === true,
        ...(typeof outcome?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(outcome.code) ? { code: outcome.code } : {}) })
    }) },
  }
}

/** Owner-scoped, read-only native history; never starts query() or a model. */
export function createHistoryReader({ sdk, sessionRoot, authorizedDeviceId, acquireLock, requireAuth, activeSessions }) {
  return async function history(params, context = {}) {
    let lock, result
    const read = async () => {
      if (!params || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).some(key => !['deviceId', 'dshSessionId', 'sessionId', 'projectPath', 'offset', 'afterUuid'].includes(key))) {
        throw problem('INVALID_REQUEST', '云端记录请求无效')
      }
      const { deviceId, sessionId, dshSessionId, projectPath, offset = 0, afterUuid } = params
      if (!UUID.test(deviceId) || !UUID.test(sessionId) || typeof dshSessionId !== 'string'
        || !ID.test(dshSessionId) || typeof projectPath !== 'string' || !projectPath || projectPath.length > 8192
        || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000
        || (offset > 0 && (typeof afterUuid !== 'string' || !ID.test(afterUuid)))) throw problem('INVALID_REQUEST', '云端记录请求参数无效')
      if (authorizedDeviceId !== undefined && deviceId.toLowerCase() !== authorizedDeviceId.toLowerCase()) {
        throw problem('DEVICE_MISMATCH', '此连接不能读取其他设备的会话')
      }
      if (typeof sdk.getSessionMessages !== 'function') throw problem('HISTORY_UNAVAILABLE', '固定 SDK 未提供原生历史读取')
      await requireAuth(context.signal)
      context.signal?.throwIfAborted()
      if (activeSessions.has(sessionId.toLowerCase())) return { status: 'busy', code: 'SESSION_BUSY' }
      const owner = await readJson(join(sessionRoot, '_owners', `${sessionId.toLowerCase()}.json`))
      if (!owner) return { status: 'missing', code: 'NATIVE_CONTEXT_MISSING' }
      if (owner.deviceId !== deviceId.toLowerCase() || owner.dshSessionId !== dshSessionId) {
        throw problem('SESSION_BINDING_MISMATCH', '云端会话不属于当前设备和对话')
      }
      lock = await acquireLock(join(sessionRoot, '_locks', `${sessionId.toLowerCase()}.lock`), { signal: context.signal })
      const cwd = join(sessionRoot, 'devices', deviceId.toLowerCase(), sessionId.toLowerCase())
      const metadata = await readJson(join(cwd, 'bridge-session.json'))
      for (const record of [owner, metadata]) if (!record || record.version !== 2 || record.engine !== 'claude-sdk'
        || record.sessionId !== sessionId.toLowerCase() || record.deviceId !== deviceId.toLowerCase()
        || record.dshSessionId !== dshSessionId) throw problem('SESSION_BINDING_MISMATCH', '云端会话不属于当前设备和对话')
      if (metadata.projectPath !== projectPath) throw problem('SESSION_BINDING_MISMATCH', '云端会话项目路径不一致')
      if (offset > 0) {
        const previous = await sdk.getSessionMessages(sessionId, { dir: cwd, offset: offset - 1, limit: 1, includeSystemMessages: false })
        if (previous?.[0]?.uuid !== afterUuid) return { status: 'cursor-reset' }
      }
      const items = await sdk.getSessionMessages(sessionId, { dir: cwd, offset, limit: 32, includeSystemMessages: false })
      if (!Array.isArray(items) || items.length > 32) throw problem('HISTORY_INVALID', 'SDK 历史格式无法确认')
      const records = []
      for (const item of items) {
        if (item.session_id?.toLowerCase() !== sessionId.toLowerCase() || typeof item.uuid !== 'string' || !ID.test(item.uuid)) {
          throw problem('HISTORY_INVALID', 'SDK 历史会话标识不一致')
        }
        if (item.parent_tool_use_id != null || item.parent_agent_id != null) continue
        const body = item.message
        if (!body || typeof body !== 'object') throw problem('HISTORY_INVALID', 'SDK 历史消息无法读取')
        if (item.type === 'assistant') {
          const content = []
          for (const block of Array.isArray(body.content) ? body.content : []) {
            if (!object(block)) throw problem('HISTORY_INVALID', 'SDK 历史内容无效')
            if (block.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text })
            else if (block.type === 'thinking' && typeof block.thinking === 'string') content.push({ type: 'reasoning', text: block.thinking })
            else if (block.type === 'tool_use' && typeof block.id === 'string' && ID.test(block.id)
              && typeof block.name === 'string' && block.name.startsWith('mcp__dsh__')) {
              content.push({ type: 'tool-call', id: block.id, name: block.name.slice(10), arguments: JSON.stringify(block.input ?? {}) })
            } else if (block.type !== 'redacted_thinking') throw problem('HISTORY_CONTENT_UNSUPPORTED', '云端存在暂不能同步的消息内容')
          }
          if (content.length) records.push({ type: 'assistant', uuid: item.uuid,
            apiId: typeof body.id === 'string' && ID.test(body.id) ? body.id : item.uuid,
            model: typeof body.model === 'string' ? body.model : null, content })
        } else if (item.type === 'user') {
          // User prompts already checkpointed in DSH before transmission. Do
          // not copy SDK memory, hook context or compact summaries into chat.
          records.push({ type: 'prompt', uuid: item.uuid })
          for (const block of Array.isArray(body.content) ? body.content : []) if (block.type === 'tool_result') {
            if (typeof block.tool_use_id !== 'string' || !ID.test(block.tool_use_id)) throw problem('HISTORY_INVALID', '云端工具结果标识无效')
            const content = typeof block.content === 'string' ? [{ type: 'text', text: block.content }]
              : Array.isArray(block.content) && block.content.every(part => part.type === 'text' && typeof part.text === 'string')
                ? block.content.map(part => ({ type: 'text', text: part.text })) : null
            records.push({ type: 'tool-result', uuid: item.uuid, callId: block.tool_use_id,
              isError: block.is_error === true, content })
          }
        }
      }
      // getSessionInfo() may be undefined when a transcript lacks a displayable
      // prompt. Native messages themselves are sufficient proof of existence.
      if (!offset && !items.length && !await sdk.getSessionInfo(sessionId, { dir: cwd })) {
        throw problem('NATIVE_CONTEXT_UNCONFIRMED', '尚不能确认云端原生上下文，请保留本机会话等待核实')
      }
      const runState = await readJson(join(cwd, 'bridge-runs.json'))
      const reply = { status: 'ok', sessionId: sessionId.toLowerCase(), records, runs: runState ? runsOf(runState) : {},
        nextOffset: offset + items.length, lastUuid: items.at(-1)?.uuid ?? afterUuid ?? null, done: items.length < 32 }
      if (Buffer.byteLength(JSON.stringify(reply)) > MAX_REPLY_BYTES) throw problem('HISTORY_TOO_LARGE', '云端单页记录过大，未静默省略内容')
      context.signal?.throwIfAborted()
      if (lock.held === false) throw problem('SESSION_LOCK_LOST', '云端记录读取期间会话锁已释放')
      return reply
    }
    try { result = await read() }
    catch (error) {
      result = { status: error.code === 'SESSION_BUSY' ? 'busy' : 'failed',
        code: typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'HISTORY_READ_FAILED' }
    } finally {
      try { await lock?.release() }
      catch { result = { status: 'failed', code: 'LOCK_RELEASE_FAILED' } }
    }
    return result
  }
}
