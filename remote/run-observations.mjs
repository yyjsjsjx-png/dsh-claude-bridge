import { firstOutputKind } from '../src/sdk-output-kind.mjs'
import { responseUsageFromSdk } from '../src/response-usage.mjs'
import { isNoResponsePlaceholder } from '../src/sdk-message.mjs'
import { createResponseTimingTracker } from '../src/response-timing.mjs'

/** Numerical audit only. Response details never add to authoritative run totals. */
export function createRunObservations({ params, record, now = () => performance.now(), wall = Date.now }) {
  const started = now(), startedAt = wall(), responses = new Map(), models = new Set()
  const rates = new Map(), timing = createResponseTimingTracker({ runId: params.runId, turn: 0, now,
    onRecord: row => rates.set(row.responseId, row.tps) })
  let current, closed = false
  const base = (model = models.size === 1 ? [...models][0] : models.size > 1 ? 'mixed' : 'unknown') => ({
    version: 1, deviceId: params.deviceId, dshSessionId: params.dshSessionId, sdkSessionId: params.sessionId,
    runId: params.runId, model, observedAt: wall(),
  })
  const emit = (kind, row) => { try { record(kind, row) } catch {} }
  const publish = response => {
    if (!response) return
    const usage = response.final ? responseUsageFromSdk(response.usage) : undefined
    const row = { ...base(response.model ?? 'unknown'), responseId: response.id,
      ...(usage ? { usage: { scope: 'response-main-agent', ...usage } } : {}) }
    const signature = JSON.stringify({ model: row.model, usage: row.usage })
    if (response.signature !== signature) { emit('response', row); response.signature = signature }
  }
  return {
    observe(message) {
      if (closed || message?.parent_tool_use_id != null || message?.type === 'assistant' && isNoResponsePlaceholder(message.message)) return
      if (typeof message?.session_id === 'string') params.sessionId = message.session_id
      const event = message?.type === 'stream_event' ? message.event : undefined
      if (event?.type === 'message_start' && typeof event.message?.id === 'string') {
        const id = event.message.id
        if (!responses.has(id)) responses.set(id, { id, usage: event.message.usage, model: event.message.model })
        current = responses.get(id)
        if (typeof current.model === 'string') models.add(current.model)
        timing.responseStarted({ responseId: id, step: responses.size - 1, streamStarted: true })
      }
      if (current && firstOutputKind(event)) timing.token({ responseId: current.id, kind: firstOutputKind(event) })
      if (current && (event?.type === 'content_block_start' && !['text', 'thinking', 'tool_use'].includes(event.content_block?.type)
        || event?.type === 'content_block_delta' && !['text_delta', 'thinking_delta', 'input_json_delta', 'signature_delta'].includes(event.delta?.type))) {
        timing.failCapture({ responseId: current.id, reason: 'unsupported-block' })
      }
      if (event?.type === 'message_delta' && event.usage && current) {
        const previous = current.usage ?? {}
        current.usage = { ...previous, ...event.usage }
        if (Number.isFinite(previous.output_tokens)) current.usage.output_tokens = Math.max(previous.output_tokens, current.usage.output_tokens ?? 0)
        current.final ||= Number.isSafeInteger(event.usage.output_tokens)
        timing.responseUsage({ responseId: current.id, outputTokens: current.usage.output_tokens, final: current.final })
        publish(current)
      }
      if (event?.type === 'message_stop' && current) {
        timing.responseCompleted({ responseId: current.id, streamComplete: true }); publish(current)
      }
      const first = message?.bridge_first_output
      if (current && !current.timed && first?.version === 1 && first.responseId === current.id
        && first.source === 'sdk-first-output-estimate' && first.kind === firstOutputKind(event)
        && firstOutputKind(event) && Number.isFinite(first.ms) && first.ms >= 0) {
        current.timed = true
        emit('timing', { ...base(current.model ?? 'unknown'), responseId: current.id, level: 'response',
          side: 'upstream', metric: 'first-output', quality: 'estimate', clock: 'upstream-duration',
          source: 'sdk-first-output-estimate', durationMs: first.ms })
      }
      if (message?.type === 'assistant' && typeof message.message?.id === 'string') {
        const id = message.message.id
        if (!responses.has(id)) responses.set(id, { id })
        const response = responses.get(id)
        if (!rates.has(id)) timing.responseStarted({ responseId: id, step: responses.size - 1 })
        if (typeof message.message.model === 'string') { response.model = message.message.model; models.add(response.model) }
        // Full assistant usage can be a placeholder; raw final usage owns the response.
        publish(response)
      }
    },
    finish(outcome) {
      if (closed) return
      closed = true
      timing.close()
      for (const response of responses.values()) {
        publish(response)
        if (!response.timed) emit('timing', { ...base(response.model ?? 'unknown'), responseId: response.id,
          level: 'response', side: 'upstream', metric: 'first-output', quality: 'unknown', clock: 'unknown',
          source: 'sdk-first-output-unavailable', reason: 'SDK_TIMING_UNAVAILABLE' })
        const rate = rates.get(response.id)
        emit('timing', { ...base(response.model ?? 'unknown'), responseId: response.id, level: 'response',
          side: 'upstream', metric: 'receive-rate', source: 'remote-sdk-stream-receive',
          ...(rate?.status === 'known' ? { quality: 'estimate', clock: 'remote-monotonic', durationMs: rate.durationMs, outputTokens: rate.outputTokens }
            : { quality: 'unknown', clock: 'unknown', reason: 'SDK_RECEIVE_RATE_UNAVAILABLE' }) })
      }
      const m = outcome?.metrics, u = m?.usage
      const usage = u?.scope === 'current-turn-main-agent'
        && ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].every(key => Number.isSafeInteger(u[key]) && u[key] >= 0) ? {
        scope: 'current-turn-main-agent', uncachedInputTokens: u.input_tokens, outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens, cacheWriteTokens: u.cache_creation_input_tokens } : undefined
      emit('run', { ...base(), kind: params.action === 'compact' ? 'compact' : 'query',
        status: ['completed', 'failed', 'cancelled'].includes(outcome?.status) ? outcome.status : 'unknown',
        startedAt, finishedAt: wall(), ...(usage ? { usage } : {}),
        ...(m?.cost?.scope === 'session-cumulative-estimate' ? { cumulativeCostUsd: m.cost.usd, costScope: m.cost.scope } : {}) })
      emit('timing', { ...base(), level: 'run', side: 'upstream', metric: 'duration',
        quality: 'precise', clock: 'remote-monotonic', source: 'remote-worker-run', durationMs: Math.max(0, now() - started) })
    },
  }
}
