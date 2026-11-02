export const NETWORK_TIMING_VERSION = 1

// Epoch-shaped timestamps from a monotonic clock: wall-clock adjustments after
// process startup cannot move a probe's elapsed times backwards.
export const networkNow = () => performance.timeOrigin + performance.now()
const timestamp = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
const probeId = value => Number.isSafeInteger(value) && value > 0
export function readNetworkTime(now) {
  try { const value = now(); return timestamp(value) ? value : undefined } catch {}
}

export function networkPongTiming(request, t2, t3) {
  if (!request || request.version !== NETWORK_TIMING_VERSION || !probeId(request.probeId)
    || !timestamp(request.t1) || !timestamp(t2) || !timestamp(t3) || t3 < t2) return undefined
  return { version: NETWORK_TIMING_VERSION, probeId: request.probeId, t1: request.t1, t2, t3 }
}

/** NTP-style application observations, not a pure network/one-way measurement.
 * Bounds assume nonnegative path delays and a stable offset during this probe;
 * the midpoint/one-way estimate additionally assumes a symmetric path. */
export function networkTimingSample({ t1, t2, t3, t4 }) {
  if (![t1, t2, t3, t4].every(timestamp) || t4 < t1 || t3 < t2) return undefined
  const roundTripMs = t4 - t1, serverResidenceMs = t3 - t2
  if (serverResidenceMs > roundTripMs) return undefined
  const networkRoundTripMs = roundTripMs - serverResidenceMs
  const offsetLowerMs = t3 - t4, offsetUpperMs = t2 - t1
  return { version: NETWORK_TIMING_VERSION, stage: 'sample', roundTripMs, serverResidenceMs,
    networkRoundTripMs, clockOffsetMs: (offsetLowerMs + offsetUpperMs) / 2,
    offsetLowerMs, offsetUpperMs, oneWayEstimateMs: networkRoundTripMs / 2,
    uncertaintyMs: networkRoundTripMs / 2, assumption: 'symmetric-path' }
}

/** One pending observation per socket attempt. Only the existing heartbeat
 * calls ping(); the one-shot deadline never sends or retries any operation. */
export function createNetworkProbe({ now = networkNow, timeoutMs, onDiagnostic = () => {} }) {
  if (typeof now !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('网络探测配置无效')
  let pending, serial = 0, closed = false, unsupported = false
  const emit = fields => { try { Promise.resolve(onDiagnostic({ version: NETWORK_TIMING_VERSION, ...fields })).catch(() => {}) } catch {} }
  const clear = () => { clearTimeout(pending?.timer); pending = undefined }
  const unavailable = code => { if (!unsupported) { unsupported = true; emit({ stage: 'unsupported', code }) } }
  const expire = () => { if (!pending) return; clear(); emit({ stage: 'timeout' }) }
  return {
    ping() {
      if (closed) return undefined
      const t1 = readNetworkTime(now)
      if (t1 === undefined) { unavailable('NETWORK_CLOCK_INVALID'); return undefined }
      if (pending && t1 - pending.t1 >= timeoutMs) expire()
      if (pending) return undefined
      serial = serial === Number.MAX_SAFE_INTEGER ? 1 : serial + 1
      const request = { version: NETWORK_TIMING_VERSION, probeId: serial, t1 }
      pending = { ...request, timer: setTimeout(expire, timeoutMs) }
      pending.timer.unref?.()
      return request
    },
    pong(response, receivedAt = readNetworkTime(now)) {
      if (closed || !pending) return
      if (receivedAt !== undefined && receivedAt - pending.t1 >= timeoutMs) { expire(); return }
      if (response === undefined) { clear(); unavailable('NETWORK_TIMING_UNSUPPORTED'); return }
      // Foreign, repeated or old-attempt IDs cannot consume the current probe.
      if (response?.version === NETWORK_TIMING_VERSION
        && (response.probeId !== pending.probeId || response.t1 !== pending.t1)) return
      const sample = response?.version === NETWORK_TIMING_VERSION
        ? networkTimingSample({ t1: pending.t1, t2: response.t2, t3: response.t3, t4: receivedAt }) : undefined
      clear()
      if (sample) emit(sample)
      else unavailable('NETWORK_TIMING_INVALID')
    },
    close() { closed = true; clear() },
  }
}
