import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseSummary } from '../src/compaction-summary.mjs'

const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024
const MAX_LINE_BYTES = 8 * 1024 * 1024
const PAGE_RECORDS = 2
const MAX_REPLY_BYTES = 3 * 1024 * 1024
const ID = /^(?!__proto__$|constructor$|prototype$)[A-Za-z0-9_.:-]{1,256}$/
const count = value => Number.isSafeInteger(value) && value >= 0
const problem = (code, message) => Object.assign(new Error(message), { code })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fingerprintOf = info => createHash('sha256').update([info.dev, info.ino, info.size,
  info.mtimeNs, info.ctimeNs].join(':')).digest('hex')
const checkCancelled = signal => {
  if (signal?.aborted) throw problem('CANCELLED', '压缩记录读取已取消')
}
const main = row => row.isSidechain !== true && !row.teamName
  && row.parent_tool_use_id == null && row.parent_agent_id == null && row.agentId == null

function summaryOf(row) {
  const content = row.message?.content
  if (typeof content === 'string') return parseSummary(content)
  if (Array.isArray(content) && content.every(block => object(block) && block.type === 'text' && typeof block.text === 'string')) {
    return parseSummary(content.map(block => block.text).join(''))
  }
  return { status: 'unavailable', code: 'SUMMARY_UNAVAILABLE' }
}

function boundaryOf(row) {
  if (row.type !== 'system' || row.subtype !== 'compact_boundary') return undefined
  const metadata = row.compactMetadata
  const record = { boundaryUuid: row.uuid,
    trigger: ['auto', 'manual'].includes(metadata?.trigger) ? metadata.trigger : 'unknown',
    summary: { status: 'unavailable', code: 'SUMMARY_MISSING' } }
  for (const key of ['preTokens', 'postTokens', 'durationMs']) if (count(metadata?.[key])) record[key] = metadata[key]
  const completedAt = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : row.timestamp
  if (count(completedAt)) record.completedAt = completedAt
  return record
}

/** Only raw native UUID links associate summaries; order and text never infer a pairing. */
export function createCompactionTranscriptProjection(sessionId) {
  const boundaries = new Map(), summaries = new Map(), seen = new Map()
  let beforeApiId
  const pendingAfter = []
  return {
    accept(row) {
      if (!object(row) || !['system', 'user', 'assistant'].includes(row.type) || !main(row)) return
      const boundary = boundaryOf(row)
      const summary = row.type === 'user' && row.isCompactSummary === true
      const apiId = row.type === 'assistant' && !row.isMeta && !row.isCompactSummary
        && typeof row.message?.id === 'string' && ID.test(row.message.id) ? row.message.id : undefined
      if (!boundary && !summary && !apiId) return
      if (row.sessionId !== sessionId || typeof row.uuid !== 'string' || !ID.test(row.uuid)) {
        throw problem('COMPACTION_TRANSCRIPT_INVALID', '原生压缩记录归属无法确认')
      }
      // Duplicate rows are normal only when the selected evidence is unchanged.
      const evidence = boundary ?? (summary ? { parentUuid: row.parentUuid, summary: summaryOf(row) } : { apiId })
      const signature = JSON.stringify(evidence)
      if (seen.has(row.uuid)) {
        if (seen.get(row.uuid) !== signature) throw problem('COMPACTION_TRANSCRIPT_INVALID', '原生压缩标识存在冲突')
        return
      }
      seen.set(row.uuid, signature)
      if (apiId) {
        for (const record of pendingAfter.splice(0)) record.afterApiId = apiId
        beforeApiId = apiId
      }
      if (boundary) {
        if (beforeApiId) boundary.beforeApiId = beforeApiId
        boundaries.set(row.uuid, boundary)
        pendingAfter.push(boundary)
      } else if (summary && typeof row.parentUuid === 'string' && ID.test(row.parentUuid)) {
        const previous = summaries.get(row.parentUuid)
        const value = summaryOf(row)
        summaries.set(row.parentUuid, previous && JSON.stringify(previous) !== JSON.stringify(value)
          ? { status: 'unavailable', code: 'SUMMARY_CONFLICT' } : value)
      }
    },
    records() {
      return [...boundaries.values()].map(record => ({ ...record,
        summary: summaries.get(record.boundaryUuid) ?? record.summary }))
    },
  }
}

async function readRows(file, projection, signal) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = Buffer.alloc(0)
  for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
    checkCancelled(signal)
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
    let start = 0, end
    while ((end = pending.indexOf(10, start)) !== -1) {
      const line = pending.subarray(start, end)
      if (line.length > MAX_LINE_BYTES) throw problem('COMPACTION_TRANSCRIPT_TOO_LARGE', '原生记录单行过大，未截断')
      if (line.length) {
        let row
        try { row = JSON.parse(decoder.decode(line)) }
        catch { throw problem('COMPACTION_TRANSCRIPT_INVALID', '原生压缩记录无法解析') }
        projection.accept(row)
      }
      start = end + 1
    }
    pending = pending.subarray(start)
    if (pending.length > MAX_LINE_BYTES) throw problem('COMPACTION_TRANSCRIPT_TOO_LARGE', '原生记录单行过大，未截断')
  }
  // An unfinished final line is an uncommitted native write. Never display it.
  if (pending.length) throw problem('COMPACTION_TRANSCRIPT_INCOMPLETE', '原生记录尚未完整落盘')
}

/** Read exactly one bound session's transcript; no directory or session discovery. */
export async function readCompactionTranscript({ configDir, cwd, sessionId, cursor, signal }) {
  checkCancelled(signal)
  const root = await realpath(configDir)
  const canonicalCwd = await realpath(cwd)
  const projectKey = canonicalCwd.replace(/[^a-zA-Z0-9-]/g, '-')
  const directory = join(root, 'projects', projectKey)
  const path = join(directory, sessionId + '.jsonl')
  if (await realpath(directory) !== directory || await realpath(path) !== path) {
    throw problem('COMPACTION_TRANSCRIPT_UNSAFE', '原生压缩记录路径不安全')
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const initial = await file.stat({ bigint: true })
    if (!initial.isFile() || initial.nlink !== 1n) throw problem('COMPACTION_TRANSCRIPT_UNSAFE', '原生压缩记录不是独立普通文件')
    const fingerprint = fingerprintOf(initial)
    if (cursor && cursor.fingerprint !== fingerprint) return { status: 'cursor-reset' }
    if (cursor?.done === true) return { status: 'ok', records: [], nextCursor: cursor, done: true }
    if (initial.size > BigInt(MAX_TRANSCRIPT_BYTES)) throw problem('COMPACTION_TRANSCRIPT_TOO_LARGE', '原生记录超过只读扫描上限，未截断')
    const projection = createCompactionTranscriptProjection(sessionId)
    await readRows(file, projection, signal)
    checkCancelled(signal)
    if (fingerprintOf(await file.stat({ bigint: true })) !== fingerprint) return { status: 'cursor-reset' }
    const records = projection.records(), offset = cursor?.offset ?? 0
    if (offset > records.length) return { status: 'cursor-reset' }
    let nextOffset = Math.min(offset + PAGE_RECORDS, records.length)
    let page = records.slice(offset, nextOffset)
    // JSON escaping can cost more than the native UTF-8 body. Page whole
    // summaries without truncation, retaining an explicit failure if one alone
    // cannot fit the existing RPC frame budget.
    while (page.length > 1 && Buffer.byteLength(JSON.stringify(page)) > MAX_REPLY_BYTES) page = records.slice(offset, --nextOffset)
    if (Buffer.byteLength(JSON.stringify(page)) > MAX_REPLY_BYTES) {
      page = page.map(record => ({ ...record, summary: { status: 'unavailable', code: 'SUMMARY_TOO_LARGE' } }))
    }
    const done = nextOffset === records.length
    return { status: 'ok', records: page,
      nextCursor: { fingerprint, offset: nextOffset, done }, done }
  } finally { await file.close() }
}
