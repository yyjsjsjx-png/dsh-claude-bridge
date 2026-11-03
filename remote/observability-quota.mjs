import { randomUUID } from 'node:crypto'
import { normalizeObservedQuota, quotaFailureCode } from '../src/observability-schema.mjs'

/** One account-wide sampler, gated by actual active runs. No SDK dependency. */
export function createQuotaCoordinator({ fetchUsage, onObservation = () => {}, onDiagnostic = () => {},
  now = Date.now, cooldownMs = 120_000, freshnessMs = 120_000, timeoutMs = 15_000 } = {}) {
  const active = new Set(), skipped = Symbol('inactive')
  let snapshot = null, error = null, nextAllowedAt = 0, inFlight, pollTimer, closed = false, failures = 0
  // restored: snapshot came from the ledger, never fresh. settledAccount: a live
  // observation or boundary already decided this process's account state.
  let finalSample = false
  let restored = false, settledAccount = false, boundaryRecorded = false
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
      restored, fresh: Boolean(snapshot && !restored && at < snapshot.expiresAt && at < snapshot.observedAt + freshnessMs
        && snapshot.windows.every(row => row.resetsAt === null || at < row.resetsAt)),
      lastObservedAt: snapshot?.observedAt ?? null, error: error ? { ...error } : null,
      nextAllowedAt, inFlight: Boolean(inFlight), active: active.size > 0, activeCount: active.size }
  }
  const stopTimer = () => { clearTimeout(pollTimer); pollTimer = undefined }
  function schedule() {
    stopTimer()
    if (closed || (!active.size && !finalSample) || inFlight) return
    pollTimer = setTimeout(() => {
      pollTimer = undefined
      if (!closed && !inFlight) {
        if (active.size) start('activity')
        else if (finalSample) { finalSample = false; start('run-end') }
      }
    }, Math.max(0, nextAllowedAt - now()))
    pollTimer.unref?.()
  }
  const complete = (read, reply) => {
    if (read.reported || closed) return
    read.reported = true
    clearTimeout(read.timer)
    // Started before an account boundary: neither its value nor its failure belongs to the new login.
    if (read.fenced) { read.resolve(peek()); return }
    const at = now(), candidate = normalizeObservedQuota(reply)
    const observed = candidate && candidate.observedAt >= read.startedAt && candidate.observedAt <= at + 30_000
      && (!snapshot || candidate.observedAt > snapshot.observedAt) ? candidate : undefined
    if (observed) {
      snapshot = observed; error = null; failures = 0
      restored = false; settledAccount = true; boundaryRecorded = false
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
    stopTimer()
    const read = { id: randomUUID(), reason, controller: new AbortController(), reported: false,
      started: false, startedAt: now(), previousAllowedAt: nextAllowedAt }
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
      if (reply === skipped) {
        if (!read.started) nextAllowedAt = read.previousAllowedAt
        if (!read.reported) { read.reported = true; read.resolve(peek()) }
      } else complete(read, reply)
      schedule()
    }
    Promise.resolve().then(() => {
      if (closed || read.fenced || (!active.size && reason !== 'run-end') || read.controller.signal.aborted) return skipped
      read.started = true
      return fetchUsage({ signal: read.controller.signal, reason })
    }).then(settled,
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
    /** Seed the last persisted reading. Never samples, never moves the cooldown. */
    restore(value) {
      if (closed || snapshot || settledAccount) return false
      const candidate = normalizeObservedQuota(value)
      if (!candidate || candidate.observedAt > now() + 30_000) return false
      snapshot = candidate; restored = true
      return true
    },
    /** A login recheck or logout. Forget the old account's reading without sampling again. */
    clearAccount() {
      if (closed) return false
      settledAccount = true
      finalSample = false
      if (!active.size) stopTimer()
      if (inFlight) inFlight.fenced = true
      snapshot = null; error = null; restored = false
      if (!boundaryRecorded) {
        boundaryRecorded = true
        observe({ version: 1, observationId: randomUUID(), observedAt: now(), reason: 'account-boundary',
          status: 'unavailable', code: 'QUOTA_ACCOUNT_BOUNDARY' })
      }
      return true
    },
    request(options = {}) {
      const { reason = 'manual', signal } = options && typeof options === 'object' ? options : {}
      if (!['manual', 'run-start', 'run-end', 'activity'].includes(reason)) {
        return Promise.resolve({ ...peek(), error: { code: 'QUOTA_READ_FAILED', observedAt: now() } })
      }
      if (closed) return Promise.resolve({ ...peek(), error: { code: 'QUOTA_CLOSED', observedAt: now() } })
      if (signal?.aborted) return Promise.resolve({ ...peek(), error: { code: 'CANCELLED', observedAt: now() } })
      if (!active.size) return Promise.resolve(peek())
      if (inFlight) return wait(inFlight, signal)
      if (now() < nextAllowedAt) return Promise.resolve(peek())
      return wait(start(reason), signal)
    },
    setActive(key, value, { sampleOnEnd = true } = {}) {
      if (closed || typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@+\[\]-]{0,255}$/.test(key)
        || typeof value !== 'boolean' || value && !active.has(key) && active.size >= 4096) return false
      if (value) {
        active.add(key)
        finalSample = false
      } else if (active.delete(key) && !active.size) {
        finalSample = sampleOnEnd
      }
      if (active.size && !inFlight && now() >= nextAllowedAt) start('run-start')
      else schedule()
      return true
    },
    close() {
      if (closed) return Promise.resolve(peek())
      stopTimer(); active.clear()
      if (inFlight) {
        if (inFlight.started) complete(inFlight, { status: 'unavailable', code: 'QUOTA_CLOSED' })
        else {
          inFlight.reported = true
          inFlight.resolve({ ...peek(), error: { code: 'QUOTA_CLOSED', observedAt: now() } })
        }
        inFlight.controller.abort()
        clearTimeout(inFlight.timer)
      }
      closed = true
      return Promise.resolve(peek())
    },
  }
}
