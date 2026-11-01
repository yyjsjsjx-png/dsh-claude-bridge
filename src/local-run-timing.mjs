import { firstOutputKind } from './sdk-output-kind.mjs'
import { isNoResponsePlaceholder } from './sdk-message.mjs'

/** Exact at the named local RPC boundaries, including transport/queue waits.
 * This is a run-level observation, never a per-model-request upstream TTFT. */
export function createLocalRunTiming({ now = () => performance.now(), wall = () => Date.now(), onTiming = () => {} } = {}) {
  const calls = new Map(), runs = new Map()
  const emit = (run, metric, quality, durationMs) => {
    if (!run.row.sdkSessionId) return
    if (quality === 'precise' && (!Number.isFinite(durationMs) || durationMs < 0)) quality = 'unknown'
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
        const run = { at, first: false, models: new Set(), row: { version: 1, runId: p.runId, deviceId: p.deviceId,
          dshSessionId: p.dshSessionId, sdkSessionId: p.sessionId, model: 'unknown' } }
        runs.set(p.runId, run); calls.set(message.id, p.runId)
      } else if (direction === 'received' && message.method === 'sdk.message') {
        const run = runs.get(message.params?.runId), sdk = message.params?.message
        if (!run || sdk?.parent_tool_use_id != null || sdk?.type === 'assistant' && isNoResponsePlaceholder(sdk.message)) return
        const model = sdk?.event?.message?.model ?? sdk?.message?.model
        if (typeof model === 'string') run.models.add(model)
        run.row.model = run.models.size === 1 ? [...run.models][0] : run.models.size > 1 ? 'mixed' : 'unknown'
        if (!run.first && (sdk?.event?.type === 'content_block_start'
          && !['text', 'thinking', 'tool_use'].includes(sdk.event.content_block?.type)
          || sdk?.event?.type === 'content_block_delta'
          && !['text_delta', 'thinking_delta', 'input_json_delta', 'signature_delta'].includes(sdk.event.delta?.type))) run.opaque = true
        if (run.first || run.opaque || sdk?.type !== 'stream_event' || !firstOutputKind(sdk.event)) return
        if (typeof sdk.session_id === 'string') run.row.sdkSessionId = sdk.session_id
        run.first = true
        run.firstMs = at - run.at
        run.emittedModel = run.row.model
        emit(run, 'first-output', 'precise', at - run.at)
      } else if (direction === 'received' && message.id !== undefined && calls.has(message.id)) {
        this.finish(calls.get(message.id), at)
      }
    },
    finish(runId, at = now()) {
      const run = runs.get(runId)
      if (!run) return
      if (!run.first) emit(run, 'first-output', 'unknown')
      else if (run.emittedModel !== run.row.model) emit(run, 'first-output', 'precise', run.firstMs)
      emit(run, 'duration', 'precise', at - run.at)
      runs.delete(runId)
      for (const [id, value] of calls) if (value === runId) calls.delete(id)
    },
  }
}
