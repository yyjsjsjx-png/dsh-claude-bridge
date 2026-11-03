/**
 * Per-query diagnostics and remote timing. `diagnose` stays silent until
 * `query.runId` is known; both write to `query.diagnosticLog` once assigned
 * and best-effort notify the local host. Transport errors are swallowed
 * because a broken transport is handled by the active query signal.
 */
export function createQueryTelemetry(query) {
  const { params, context } = query
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  const diagnose = (stage, event, code) => {
    const { runId } = query
    if (!runId) return
    query.diagnosticLog?.event(event, { runId, stage, durationMs: elapsed(), ...(code ? { code } : {}) })
    try {
      context.peer.notify('diagnostic', {
        runId, stage, event, durationMs: elapsed(),
        ...(code === undefined ? {} : { code }),
      })
    } catch { /* A broken transport is handled by the active query signal. */ }
  }
  const timing = (stage, durationMs = elapsed(), event = 'perf.remote', interval = {}) => {
    const fields = { runId: query.runId, stage, durationMs, model: params.model, effort: params.effort,
      method: params.action === 'compact' ? 'compact' : 'query', ...interval }
    query.diagnosticLog?.event(event, fields)
    try { context.peer.notify('diagnostic', { event, ...fields }) } catch {}
  }
  let phaseSequence = 0
  const startPhase = (stage, fields = {}) => {
    const startedAt = performance.now()
    return () => {
      try { timing(stage, Math.max(0, performance.now() - startedAt), 'perf.remote',
        { ...fields, sampleId: `phase-${++phaseSequence}` }) } catch {}
    }
  }
  return { diagnose, timing, startPhase }
}
