import { randomUUID } from 'node:crypto'
import { normalizeObservedQuota, quotaFailureCode } from '../src/observability-schema.mjs'

/** One account-wide coordinator in the parent server. No idle polling or SDK dependency. */
export function createQuotaCoordinator({ fetchUsage, onObservation = () => {}, onDiagnostic = () => {},
  now = Date.now, cooldownMs = 300_000, freshnessMs = 120_000, timeoutMs = 15_000 } = {}) {
  let snapshot = null, error = null, nextAllowedAt = 0, inFlight, closed = false, failures = 0
  const report = (code, gap = false) => {
    try { Promise.resolve(onDiagnostic({ code, gap })).catch(() => {}) } catch {}
  }
  const observe = row => {
    try {
      const result = onObservation(row)
      if (result === false) report('OBSERVABILITY_OBSERVATION_DROPPED', true)
      else Promise.resolve(result).catch(() => report('OBSERVABILITY_OBSERVATION_DROPPED', true))
    } catch { report('OBSERVABILITY_OBSERVATION_DROPPED', true) }
  }
  const peek = () => {
    const at = now()
    return { snapshot: snapshot ? structuredClone(snapshot) : null,
      fresh: Boolean(snapshot && at < snapshot.expiresAt && at < snapshot.observedAt + freshnessMs
        && snapshot.windows.every(row => row.resetsAt === null || at < row.resetsAt)),
      lastObservedAt: snapshot?.observedAt ?? null, error: error ? { ...error } : null,
      nextAllowedAt, inFlight: Boolean(inFlight) }
  }
  const complete = (read, reply) => {
    if (read.reported || closed) return
    read.reported = true
    clearTimeout(read.timer)
    const at = now(), candidate = normalizeObservedQuota(reply)
    const observed = candidate && candidate.observedAt >= read.startedAt && candidate.observedAt <= at + 30_000
      && (!snapshot || candidate.observedAt > snapshot.observedAt) ? candidate : undefined
    if (observed) {
      snapshot = observed; error = null; failures = 0
      observe({ version: 1, observationId: read.id, observedAt: at, reason: read.reason,
        status: 'available', snapshot: observed })
    } else {
      const code = candidate ? 'QUOTA_STALE_OBSERVATION' : quotaFailureCode(reply?.code)
      const retryAfterMs = Number.isSafeInteger(reply?.retryAfterMs) && reply.retryAfterMs >= 0
        && reply.retryAfterMs <= 24 * 60 * 60 * 1000 ? reply.retryAfterMs : undefined
      failures++
      nextAllowedAt = Math.max(nextAllowedAt, at + Math.min(3_600_000, cooldownMs * 2 ** Math.min(failures - 1, 10)),
        at + (retryAfterMs ?? 0))
      error = { code, observedAt: at }
      observe({ version: 1, observationId: read.id, observedAt: at, reason: read.reason,
        status: 'unavailable', code, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) })
      report(code)
    }
    read.resolve(peek())
  }
  function start(reason) {
    const read = { id: randomUUID(), reason, controller: new AbortController(), reported: false, startedAt: now() }
    read.outcome = new Promise(resolve => { read.resolve = resolve })
    inFlight = read
    nextAllowedAt = now() + cooldownMs
    read.timer = setTimeout(() => {
      // A timed-out fetch keeps the single-flight gate until the actual work settles.
      complete(read, { status: 'unavailable', code: 'QUOTA_TIMEOUT' })
      read.controller.abort()
    }, timeoutMs)
    const settled = reply => {
      clearTimeout(read.timer)
      if (inFlight === read) inFlight = undefined
      complete(read, reply)
    }
    Promise.resolve().then(() => closed || read.controller.signal.aborted
      ? { status: 'unavailable', code: 'QUOTA_CLOSED' } : fetchUsage({ signal: read.controller.signal })).then(settled,
      problem => settled({ status: 'unavailable', code: quotaFailureCode(problem?.code),
        retryAfterMs: problem?.retryAfterMs }))
    return read
  }
  async function wait(read, signal) {
    if (!signal) return read.outcome
    if (signal.aborted) return { ...peek(), error: { code: 'CANCELLED', observedAt: now() } }
    let onAbort
    try {
      return await Promise.race([read.outcome, new Promise(resolve => {
        onAbort = () => resolve({ ...peek(), error: { code: 'CANCELLED', observedAt: now() } })
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })])
    } finally { signal.removeEventListener('abort', onAbort) }
  }
  if (typeof fetchUsage !== 'function' || ![cooldownMs, freshnessMs, timeoutMs].every(value =>
    Number.isSafeInteger(value) && value > 0 && value <= 24 * 60 * 60 * 1000) || freshnessMs > 120_000) {
    closed = true; error = { code: 'SDK_QUOTA_UNAVAILABLE', observedAt: now() }; report(error.code)
  }
  return {
    peek,
    request(options = {}) {
      const { reason = 'manual', signal } = options && typeof options === 'object' ? options : {}
      if (!['manual', 'run-start', 'run-end', 'activity'].includes(reason)) {
        return Promise.resolve({ ...peek(), error: { code: 'QUOTA_READ_FAILED', observedAt: now() } })
      }
      if (closed) return Promise.resolve({ ...peek(), error: { code: 'QUOTA_CLOSED', observedAt: now() } })
      if (signal?.aborted) return Promise.resolve({ ...peek(), error: { code: 'CANCELLED', observedAt: now() } })
      if (inFlight) return wait(inFlight, signal)
      if (now() < nextAllowedAt) return Promise.resolve(peek())
      return wait(start(reason), signal)
    },
    noteActivity() {
      if (closed || inFlight || now() < nextAllowedAt) return false
      start('activity')
      return true
    },
    close() {
      if (closed) return Promise.resolve(peek())
      if (inFlight) {
        complete(inFlight, { status: 'unavailable', code: 'QUOTA_CLOSED' })
        inFlight.controller.abort()
        clearTimeout(inFlight.timer)
      }
      closed = true
      return Promise.resolve(peek())
    },
  }
}
