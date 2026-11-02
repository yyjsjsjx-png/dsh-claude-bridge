const REASONS = new Set(['BACKGROUND', 'QUEUED', 'STEERING', 'OVERLAPPING_SUBMISSION',
  'HISTORY_REPLACED', 'STREAM_REBASELINE', 'SUBMISSION_FAILED', 'TURN_ENDED_WITHOUT_OUTPUT',
  'SESSION_DISPOSED', 'OBSERVER_DISPOSED', 'TIMING_TIMEOUT', 'TIMING_UNAVAILABLE',
  'REQUEST_UNCORRELATED', 'REMOTE_SESSION_CHANGED'])
const KEYS = new Set(['version', 'sessionId', 'requestId', 'metric', 'quality', 'durationMs', 'reason', 'source', 'clock', 'condition'])
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,160}$/.test(value) && !value.includes('://')

/** Owner-side numeric diagnostics, independent of SDK connections and usage UI. */
export function createClientTimingRecorder({ isRemoteSession, record, limit = 2048 }) {
  const seen = new Set()
  return value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !KEYS.has(key)) || value.version !== 1
      || !identifier(value.sessionId) || !identifier(value.requestId)
      || !['submission', 'first-output'].includes(value.metric)
      || !['precise', 'unknown'].includes(value.quality)
      || value.source !== 'client-session-receive' || value.clock !== 'client-monotonic'
      || (value.condition !== undefined && !['foreground', 'background', 'queued', 'steering'].includes(value.condition))
      || (value.metric === 'submission' && (value.quality !== 'precise' || value.durationMs !== 0))
      || (value.quality === 'precise' && (!Number.isFinite(value.durationMs) || value.durationMs < 0
        || value.durationMs > 86_400_000 || value.reason !== undefined))
      || (value.quality === 'unknown' && (value.metric !== 'first-output' || !REASONS.has(value.reason)
        || value.durationMs !== undefined))) {
      const error = new TypeError('客户端耗时诊断格式无效。')
      error.code = 'INVALID_CLIENT_TIMING'
      throw error
    }
    if (!isRemoteSession(value.sessionId)) return { recorded: false, reason: 'not-remote' }
    const key = JSON.stringify([value.sessionId, value.requestId, value.metric])
    if (seen.has(key)) return { recorded: false, reason: 'duplicate' }
    // Ignore extra input fields entirely: only these validated metadata reach disk.
    record('perf.client', { sessionId: value.sessionId, requestId: value.requestId, stage: value.metric,
      quality: value.quality, source: value.source, clock: value.clock, condition: value.condition,
      ...(value.quality === 'precise' ? { durationMs: value.durationMs } : { code: value.reason }) })
    seen.add(key)
    if (seen.size > limit) seen.delete(seen.values().next().value)
    return { recorded: true }
  }
}
