function failure(code, message) {
  return Object.assign(new Error(`[${code}] ${message}`), { code })
}

/** Reads one bounded history snapshot without projecting or committing it.
 * A projection-level fragment conflict may ask the caller to read from zero. */
export async function readHistoryPages({ sessionId, cursor, signal, readPage }) {
  let bytes = 0, reset = false, readStart = cursor, lastApi, runs = {}
  const assistantPages = new Map(), records = []
  for (let page = 0; page < 3200; page++) {
    signal.throwIfAborted()
    const pageCursor = cursor
    const reply = await readPage(cursor)
    if (reply.status === 'busy') return { status: 'busy' }
    if (reply.status === 'cursor-reset' && !reset) {
      cursor = readStart = { offset: 0, lastUuid: null }; records.length = 0; bytes = 0
      assistantPages.clear(); lastApi = undefined; reset = true; continue
    }
    if (reply.status !== 'ok' || reply.sessionId !== sessionId || !Array.isArray(reply.records)
      || !Number.isSafeInteger(reply.nextOffset) || reply.nextOffset < cursor.offset
      || (reply.nextOffset === cursor.offset && reply.done !== true)
      || (reply.lastUuid !== null && typeof reply.lastUuid !== 'string')) {
      throw failure(reply.code ?? 'HISTORY_INVALID', '云端记录尚未同步，未继续执行。')
    }
    bytes += Buffer.byteLength(JSON.stringify(reply.records))
    if (bytes > 64 * 1024 * 1024) throw failure('HISTORY_TOO_LARGE', '本次恢复内容过大，已保留已同步记录。')
    runs = reply.runs ?? {}
    for (const record of reply.records) if (record.type === 'assistant') {
      if (!assistantPages.has(record.apiId)) assistantPages.set(record.apiId, pageCursor)
      lastApi = record.apiId
    }
    records.push(...reply.records)
    cursor = { offset: reply.nextOffset, lastUuid: reply.lastUuid }
    if (reply.done) return { status: 'ok', records, runs, cursor, readStart,
      replay: assistantPages.get(lastApi) ?? readStart }
  }
  throw failure('HISTORY_TOO_LARGE', '云端记录超过本次同步上限，未静默省略。')
}
