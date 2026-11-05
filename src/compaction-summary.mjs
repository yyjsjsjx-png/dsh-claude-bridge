/** Bound display-only native summaries without truncating or changing their text. */
export const MAX_COMPACTION_SUMMARY_BYTES = 1_048_576
// Leave room for RPC envelopes and metadata below the transport's 4 MiB frame.
export const MAX_COMPACTION_SUMMARY_JSON_BYTES = 3 * 1024 * 1024
export const COMPACTION_SUMMARY_RECORD = 'plugin:claude-bridge/compaction-summary'
export const COMPACTION_RECORD = 'plugin:claude-bridge/compaction'
export const SUMMARY_CODES = Object.freeze(['SUMMARY_MISSING', 'SUMMARY_EMPTY', 'SUMMARY_TOO_LARGE',
  'SUMMARY_UNPAIRED', 'SUMMARY_UNAVAILABLE', 'SUMMARY_CONFLICT'])

export function parseSummary(text) {
  if (typeof text !== 'string') return { status: 'unavailable', code: 'SUMMARY_MISSING' }
  if (Buffer.byteLength(text, 'utf8') > MAX_COMPACTION_SUMMARY_BYTES
    || Buffer.byteLength(JSON.stringify(text), 'utf8') > MAX_COMPACTION_SUMMARY_JSON_BYTES) {
    return { status: 'unavailable', code: 'SUMMARY_TOO_LARGE' }
  }
  if (!text.trim()) return { status: 'unavailable', code: 'SUMMARY_EMPTY' }
  return { status: 'available', text }
}

/** Ignore foreign metadata; only one exact, bounded native text or stable failure code survives. */
export function normalizeSummary(value) {
  if (value?.status === 'available') return parseSummary(value.text)
  return { status: 'unavailable', code: SUMMARY_CODES.includes(value?.code) ? value.code : 'SUMMARY_UNAVAILABLE' }
}
