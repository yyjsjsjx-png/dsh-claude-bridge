import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { readCompactionTranscript } from './compaction-transcript.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ID = /^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9_.:-]{1,256}$/
const problem = (code, message) => Object.assign(new Error(message), { code })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
async function readMetadata(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw problem('RECOVERY_METADATA_INVALID', '云端归属记录无法读取') }
}
function validate(params) {
  if (!object(params) || Object.keys(params).some(key => !['deviceId', 'dshSessionId', 'sessionId', 'projectPath', 'cursor'].includes(key))) {
    throw problem('INVALID_REQUEST', '云端压缩记录请求无效')
  }
  const { deviceId, sessionId, dshSessionId, projectPath, cursor } = params
  if (!UUID.test(deviceId) || !UUID.test(sessionId) || typeof dshSessionId !== 'string' || !ID.test(dshSessionId)
    || typeof projectPath !== 'string' || !projectPath || projectPath.length > 8192) throw problem('INVALID_REQUEST', '云端压缩记录参数无效')
  if (cursor !== undefined && (!object(cursor)
    || Object.keys(cursor).some(key => !['fingerprint', 'offset', 'done'].includes(key))
    || !/^[a-f0-9]{64}$/.test(cursor.fingerprint) || !Number.isSafeInteger(cursor.offset)
    || cursor.offset < 0 || cursor.offset > 100_000 || typeof cursor.done !== 'boolean')) {
    throw problem('INVALID_REQUEST', '云端压缩记录游标无效')
  }
}

/** Same owner/auth/lock boundary as history; native summary reads never invoke a model. */
export function createCompactionHistoryReader({ sessionRoot, configDir, authorizedDeviceId, acquireLock,
  requireAuth, activeSessions }) {
  return async function compactionHistory(params, context = {}) {
    let lock, result
    const read = async () => {
      validate(params)
      const deviceId = params.deviceId.toLowerCase(), sessionId = params.sessionId.toLowerCase()
      if (authorizedDeviceId !== undefined && deviceId !== authorizedDeviceId.toLowerCase()) {
        throw problem('DEVICE_MISMATCH', '此连接不能读取其他设备的会话')
      }
      await requireAuth(context.signal)
      context.signal?.throwIfAborted()
      if (activeSessions.has(sessionId)) return { status: 'busy', code: 'SESSION_BUSY' }
      const root = await realpath(sessionRoot)
      const cwd = join(root, 'devices', deviceId, sessionId)
      const owner = await readMetadata(join(root, '_owners', sessionId + '.json'))
      if (!owner) return { status: 'missing', code: 'NATIVE_CONTEXT_MISSING' }
      const bound = row => row?.version === 2 && row.engine === 'claude-sdk' && row.sessionId === sessionId
        && row.deviceId === deviceId && row.dshSessionId === params.dshSessionId
      if (!bound(owner)) throw problem('SESSION_BINDING_MISMATCH', '云端会话不属于当前设备和对话')
      lock = await acquireLock(join(root, '_locks', sessionId + '.lock'), { signal: context.signal })
      if (activeSessions.has(sessionId)) return { status: 'busy', code: 'SESSION_BUSY' }
      if (await realpath(cwd) !== cwd) throw problem('COMPACTION_TRANSCRIPT_UNSAFE', '原生会话目录不安全')
      const metadata = await readMetadata(join(cwd, 'bridge-session.json'))
      if (!bound(metadata) || metadata.projectPath !== params.projectPath) {
        throw problem('SESSION_BINDING_MISMATCH', '云端会话或项目路径与原记录不一致')
      }
      const reply = await readCompactionTranscript({ configDir, cwd, sessionId, cursor: params.cursor, signal: context.signal })
      context.signal?.throwIfAborted()
      if (lock.held === false) throw problem('SESSION_LOCK_LOST', '云端记录读取期间会话锁已释放')
      return reply.status === 'ok' ? { ...reply, sessionId } : reply
    }
    try { result = await read() }
    catch (error) {
      result = { status: error.code === 'SESSION_BUSY' ? 'busy' : 'failed',
        code: context.signal?.aborted ? 'CANCELLED'
          : error.code === 'ENOENT' ? 'COMPACTION_TRANSCRIPT_MISSING'
          : /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? error.code : 'COMPACTION_HISTORY_FAILED' }
    } finally {
      try { await lock?.release() }
      catch { result = { status: 'failed', code: 'LOCK_RELEASE_FAILED' } }
    }
    return result
  }
}
