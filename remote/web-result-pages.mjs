import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join } from 'node:path'

const CALL_ID = /^toolu_[A-Za-z0-9_-]{1,100}$/
const MAX_BYTES = 16 * 1024 * 1024
const PAGE_BYTES = 4096
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** An SDK web result is readable only after its successful hook registers it for this session. */
export function createWebResultPages({ configDir, cwd, sessionId }) {
  const directory = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'), sessionId, 'tool-results')
  const paths = id => ({
    result: join(directory, id + '.txt'),
    grant: join(cwd, '.bridge-web-result-' + id),
  })

  async function openResult(path) {
    if (await realpath(directory) !== directory || await realpath(path) !== path) throw new Error('unsafe path')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES) throw new Error('unsafe file')
      return { file, info }
    } catch (error) { await file.close(); throw error }
  }

  return {
    async register(id, response) {
      if (!CALL_ID.test(id)) return false
      const { result, grant } = paths(id)
      const text = Array.isArray(response) && response.length === 1 && response[0]?.type === 'text'
        ? response[0].text : response
      if (typeof text !== 'string' || !text.startsWith('<persisted-output>\n') || !text.endsWith('</persisted-output>')) return false
      const [, notice] = text.split('\n', 2)
      if (!/^Output (?:too large \(|exceeded the )/.test(notice) || !notice.endsWith('saved to: ' + result)) return false
      try {
        const { file, info } = await openResult(result)
        await file.close()
        const mark = await open(grant, 'wx', 0o600)
        try { await mark.writeFile(JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs])) }
        finally { await mark.close() }
        return true
      } catch { return false }
    },

    async read({ callId, offset = 0 }) {
      if (typeof callId !== 'string' || !CALL_ID.test(callId) || !Number.isSafeInteger(offset) || offset < 0) return null
      const { result, grant } = paths(callId)
      try {
        const mark = await open(grant, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        let identity
        try {
          const info = await mark.stat()
          if (!info.isFile() || info.nlink !== 1 || info.size > 256) return null
          identity = await mark.readFile('utf8')
        } finally { await mark.close() }
        const { file, info } = await openResult(result)
        try {
          if (identity !== JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs]) || offset > info.size) return null
          const buffer = Buffer.alloc(Math.min(PAGE_BYTES, info.size - offset))
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
          if (bytesRead !== buffer.length) return null
          const after = await file.stat()
          if (info.mtimeMs !== after.mtimeMs || info.size !== after.size) return null
          for (let end = bytesRead; end >= Math.max(0, bytesRead - 3); end--) {
            try {
              const content = decoder.decode(buffer.subarray(0, end))
              if (!end && offset < info.size) return null
              const nextOffset = offset + end
              return { content, nextOffset: nextOffset < info.size ? nextOffset : null, totalBytes: info.size }
            } catch {
              if (offset + bytesRead === info.size) return null
            }
          }
        } finally { await file.close() }
      } catch { return null }
      return null
    },
  }
}
