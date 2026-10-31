import { mkdir, appendFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

const STRING_FIELDS = new Set(['stage', 'code', 'method', 'requestId', 'sessionId', 'deviceId', 'runId', 'callId', 'toolName', 'status', 'signal', 'errorName', 'model', 'effort'])
const NUMBER_FIELDS = new Set(['durationMs', 'bytes', 'inputBytes', 'outputBytes', 'exitCode', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])

function safeLabel(value) {
  if (typeof value !== 'string') return undefined
  // Identifiers, methods, and stages only. Never accept URLs or arbitrary prose.
  return /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) && !value.includes('://') ? value : undefined
}

/** Keep operational diagnostics separate from DSH's user-owned transcript. */
export function diagnosticRecord(event, fields = {}) {
  const record = { time: new Date().toISOString(), event: safeLabel(event) ?? 'invalid-event' }
  for (const [key, value] of Object.entries(fields)) {
    if (STRING_FIELDS.has(key)) {
      const accepted = safeLabel(value)
      if (accepted !== undefined) record[key] = accepted
    } else if (NUMBER_FIELDS.has(key) && Number.isFinite(value)) record[key] = value
    else if (key === 'toolMayHaveExecuted' && typeof value === 'boolean') record[key] = value
  }
  return record
}

/** Serialize bounded diagnostic files; propagate failures through flush(). */
export function createDiagnostics({ directory, maxBytes = 2 * 1024 * 1024, onRecord = () => {} }) {
  if (!directory || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new TypeError('诊断日志配置无效')
  const path = join(directory, 'bridge.jsonl')
  let queue = Promise.resolve()
  let failure
  let size
  async function write(record) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (size === undefined) {
      try { size = (await stat(path)).size } catch (error) {
        if (error.code !== 'ENOENT') throw error
        size = 0
      }
    }
    const line = JSON.stringify(record) + '\n'
    const bytes = Buffer.byteLength(line)
    if (size + bytes > maxBytes) {
      try { await rename(path, join(directory, 'bridge.previous.jsonl')) } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      size = 0
    }
    await appendFile(path, line, { encoding: 'utf8', mode: 0o600 })
    size += bytes
  }
  return {
    path,
    event(event, fields) {
      const record = diagnosticRecord(event, fields)
      onRecord(record)
      queue = queue.then(() => write(record)).catch(error => { failure ??= error })
      return record
    },
    async flush() { await queue; if (failure) throw failure },
  }
}
