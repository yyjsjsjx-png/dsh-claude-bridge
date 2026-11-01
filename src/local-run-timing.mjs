import { firstOutputKind } from './sdk-output-kind.mjs'

/** Exact at the named local RPC boundaries, including transport/queue waits.
 * This is a run-level observation, never a per-model-request upstream TTFT. */
export function createLocalRunTiming({ now = () => performance.now(), wall = () => Date.now(), onTiming = () => {} } = {}) {
  const calls = new Map(), runs = new Map()
  const emit = (run, metric, quality, durationMs) => {
    if (!run.row.sdkSessionId) return
    try { onTiming({ ...run.row, observedAt: wall(), level: 'run', side: 'local', metric,
      quality, clock: 'local-monotonic', source: 'local-rpc-first-output',
      ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : { reason: 'LOCAL_TIMING_UNAVAILABLE' }) }) } catch {}
  }
  return {
    observe({ direction, message }) {
      const at = now()
      if (direction === 'sent' && message.method === 'query' && message.id !== undefined) {
        const p = message.params
        if (!p?.runId || runs.has(p.runId) || runs.size >= 128) return
        const run = { at, first: false, row: { version: 1, runId: p.runId, deviceId: p.deviceId,
          dshSessionId: p.dshSessionId, sdkSessionId: p.sessionId, model: p.model ?? 'unknown' } }
        runs.set(p.runId, run); calls.set(message.id, p.runId)
      } else if (direction === 'received' && message.method === 'sdk.message') {
        const run = runs.get(message.params?.runId), sdk = message.params?.message
        if (!run || run.first || sdk?.parent_tool_use_id != null || sdk?.type !== 'stream_event' || !firstOutputKind(sdk.event)) return
        if (typeof sdk.session_id === 'string') run.row.sdkSessionId = sdk.session_id
        run.first = true
        emit(run, 'first-output', 'precise', at - run.at)
      } else if (direction === 'received' && message.id !== undefined && calls.has(message.id)) {
        this.finish(calls.get(message.id), at)
      }
    },
    finish(runId, at = now()) {
      const run = runs.get(runId)
      if (!run) return
      if (!run.first) emit(run, 'first-output', 'unknown')
      emit(run, 'duration', 'precise', at - run.at)
      runs.delete(runId)
      for (const [id, value] of calls) if (value === runId) calls.delete(id)
    },
  }
}
