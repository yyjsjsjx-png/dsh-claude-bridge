import { contextCategories } from '../src/context-usage.mjs'

const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const count = value => Number.isSafeInteger(value) && value >= 0

/** SDK summary metadata only; never transmit paths, labels or context text. */
export function sanitizeContextSummary(value) {
  if (!value || typeof value !== 'object' || !count(value.totalTokens) || !count(value.maxTokens) || value.maxTokens === 0) return undefined
  const counts = {}
  for (const key of ['totalTokens', 'maxTokens', 'rawMaxTokens', 'percentage']) {
    if (nonnegative(value[key])) counts[key] = value[key]
  }
  if (!Object.keys(counts).length) return undefined
  const categories = contextCategories(value.categories)
  return { source: 'sdk-summary-approximate', ...counts, ...(categories.length ? { categories } : {}) }
}

/** Preserve only the public compaction status and safe numeric evidence. */
export function sanitizeCompactionMessage(message) {
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
  const safe = { type: 'system', subtype: message.subtype,
    ...(identifier(message.session_id) ? { session_id: message.session_id } : {}),
    ...(identifier(message.uuid) ? { uuid: message.uuid } : {}) }
  if (message.subtype === 'status') {
    return message.status === 'compacting' || message.status === null ? { ...safe, status: message.status } : undefined
  }
  const source = message.compact_metadata
  const metadata = {}
  if (source?.trigger === 'auto' || source?.trigger === 'manual') metadata.trigger = source.trigger
  for (const key of ['pre_tokens', 'post_tokens', 'cumulative_dropped_tokens', 'duration_ms']) {
    if (count(source?.[key])) metadata[key] = source[key]
  }
  return { ...safe, compact_metadata: metadata }
}

/** Background observations share one actual SDK control request, including after timeout. */
export function createContextSampler({ query, signal, publish, diagnose = () => {},
  minIntervalMs = 1000, timeoutMs = 1000, now = Date.now }) {
  let closed = false, paused = false, generation = 0, lastStarted = -Infinity, inFlight, finishing
  const current = read => !closed && !signal?.aborted && !paused && read.generation === generation
  const unavailable = (read, code) => {
    if (read.reported || !current(read)) return
    read.reported = true
    try { diagnose('context', 'unavailable', code) } catch {}
    try { publish({ type: 'bridge_context', context: { status: 'unknown' }, observedAt: now(), code }) } catch {}
  }
  function start(background) {
    const read = { generation, expired: false, reported: false }
    lastStarted = now()
    inFlight = read
    read.promise = Promise.resolve().then(() => query.getContextUsage({ detail: 'summary' }))
      .then(value => ({ value }), () => ({ failed: true }))
    if (background) {
      read.timer = setTimeout(() => {
        read.expired = true
        unavailable(read, 'CONTEXT_SUMMARY_TIMEOUT')
      }, timeoutMs)
      read.timer.unref?.()
    }
    read.promise.then(result => {
      clearTimeout(read.timer)
      // A timed-out request retains the gate until this actual promise settles.
      if (inFlight === read) inFlight = undefined
      if (!background || !current(read) || read.expired) return
      const summary = result.failed ? undefined : sanitizeContextSummary(result.value)
      if (!summary) { unavailable(read, 'CONTEXT_SUMMARY_UNAVAILABLE'); return }
      try { publish({ type: 'bridge_context', context: summary, observedAt: now() }) } catch {}
    })
    return read
  }
  function request() {
    if (closed || paused || signal?.aborted || inFlight || typeof query?.getContextUsage !== 'function'
      || now() - lastStarted < minIntervalMs) return false
    start(true)
    return true
  }
  function invalidate({ compacting = false } = {}) {
    generation++
    paused = compacting
    lastStarted = -Infinity
  }
  function stop() {
    closed = true
    clearTimeout(inFlight?.timer)
    signal?.removeEventListener('abort', stop)
  }
  signal?.addEventListener('abort', stop, { once: true })
  async function within(promise, deadline) {
    const remaining = deadline - Date.now()
    if (remaining <= 0 || signal?.aborted) return undefined
    let timer, onAbort
    try {
      return await Promise.race([promise,
        new Promise(resolve => { timer = setTimeout(() => resolve(undefined), remaining); timer.unref?.() }),
        new Promise(resolve => { onAbort = () => resolve(undefined); signal?.addEventListener('abort', onAbort, { once: true }) })])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
  function finish() {
    if (finishing) return finishing
    stop()
    // One wall-clock budget covers BOTH draining an older read and the final fresh read.
    const deadline = Date.now() + timeoutMs
    finishing = (async () => {
      if (signal?.aborted || typeof query?.getContextUsage !== 'function') return undefined
      if (inFlight && !await within(inFlight.promise, deadline)) return undefined
      if (signal?.aborted || Date.now() >= deadline) return undefined
      const result = await within(start(false).promise, deadline)
      const summary = result && !result.failed ? sanitizeContextSummary(result.value) : undefined
      if (!summary && !signal?.aborted) diagnose('context', 'unavailable', 'CONTEXT_SUMMARY_UNAVAILABLE')
      return summary
    })()
    return finishing
  }
  return { request, invalidate, finish, stop }
}
