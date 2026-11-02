import { firstOutputKind } from './sdk-output-kind.mjs'
import { isNoResponsePlaceholder } from './sdk-message.mjs'

const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const clock = value => Number.isFinite(value) && value >= 0
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.hasOwn(value, key)
export const MODEL_CYCLE_REASONS = Object.freeze(['CYCLE_START_MISSING', 'TOOL_RESULTS_UNCONFIRMED',
  'TOOL_CALL_UNCORRELATED', 'PREPARATION_UNCONFIRMED', 'PREPARATION_STOPPED', 'PREPARATION_FAILED',
  'MESSAGE_START_MISSING', 'MESSAGE_STOP_MISSING', 'NO_EFFECTIVE_OUTPUT', 'CANCELLED',
  'CONNECTION_CLOSED', 'CLOCK_INVALID', 'UNSUPPORTED_CONTENT', 'TIMING_CAPACITY_EXCEEDED'])

/** Local application boundaries, not the SDK's unobservable upstream dispatch.
 * One response owns independent first-output and duration records. A batch's
 * final tool-result write starts the next cycle; prepare only confirms it.
 * Call finish in the owning run's finally, including exceptional termination. */
export function createModelCycleTiming({ now = () => performance.now(), onTiming = () => {},
  maximumRuns = 128, maximumResponses = 1024, maximumCalls = 4096 } = {}) {
  for (const value of [maximumRuns, maximumResponses, maximumCalls]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('MODEL_CYCLE_LIMIT_INVALID')
  }
  const runs = new Map()
  const atOf = event => event.at === undefined ? now() : event.at
  function publish(run, response, metric, at, { reason, kind, endBoundary } = {}) {
    if (response.emitted.has(metric)) return
    reason ??= response.reason
    if (!reason && (!clock(response.at) || !clock(at) || at < response.at)) reason = 'CLOCK_INVALID'
    response.emitted.add(metric)
    const record = { version: 1, runId: run.id, responseId: response.id, metric,
      source: 'host-model-cycle', clock: 'local-monotonic', quality: reason ? 'unknown' : 'precise',
      ...(response.boundary ? { startBoundary: response.boundary } : {}),
      ...(endBoundary ? { endBoundary } : {}), ...(kind ? { kind } : {}),
      ...(reason ? { reason } : { durationMs: at - response.at }) }
    try { Promise.resolve(onTiming(record)).catch(() => {}) } catch { /* Observation cannot affect execution. */ }
  }
  function finish(runId, reason) {
    const run = runs.get(runId)
    if (!run) return
    const terminal = ['CANCELLED', 'CONNECTION_CLOSED'].includes(reason) ? reason : undefined
    for (const response of run.responses.values()) {
      publish(run, response, 'first-output', undefined, { reason: terminal ?? 'NO_EFFECTIVE_OUTPUT' })
      publish(run, response, 'duration', undefined, { reason: terminal ?? 'MESSAGE_STOP_MISSING' })
    }
    runs.delete(runId)
  }
  function responseFor(run, id, at, streamStarted) {
    if (!identifier(id)) { if (streamStarted) run.streamId = undefined; return }
    let response = run.responses.get(id)
    if (response) { if (streamStarted) run.streamId = id; return response }
    if (run.responses.size >= maximumResponses) { run.limited = true; run.streamId = undefined; return }
    const previous = run.responses.get(run.lastId)
    if (previous && !previous.stopped) {
      publish(run, previous, 'first-output', at, { reason: 'NO_EFFECTIVE_OUTPUT' })
      publish(run, previous, 'duration', at, { reason: 'MESSAGE_STOP_MISSING' })
    }
    const candidate = run.next
    const missing = previous?.preparationFailed ? 'PREPARATION_FAILED'
      : previous?.preparationStopped ? 'PREPARATION_STOPPED'
        : previous?.tools.size || previous?.results.size ? 'PREPARATION_UNCONFIRMED' : 'CYCLE_START_MISSING'
    response = { id, at: candidate?.at, boundary: candidate?.boundary,
      reason: run.limited ? 'TIMING_CAPACITY_EXCEEDED' : !streamStarted ? 'MESSAGE_START_MISSING'
        : candidate?.reason ?? (!candidate ? missing : !clock(candidate.at) ? 'CLOCK_INVALID' : undefined),
      emitted: new Set(), tools: new Set(), results: new Map(), failedTools: new Set(), stopped: false }
    run.next = undefined
    run.lastId = id
    if (streamStarted) run.streamId = id
    run.responses.set(id, response)
    return response
  }
  function tool(run, response, block) {
    if (!identifier(block?.id) || typeof block.name !== 'string' || !block.name.length) return
    const owner = run.toolOwners.get(block.id)
    if (owner && owner !== response.id) { response.reason ??= 'TOOL_CALL_UNCORRELATED'; return }
    if (!owner && run.toolOwners.size >= maximumCalls) { run.limited = true; return }
    response.tools.add(block.id)
    run.toolOwners.set(block.id, response.id)
  }
  function sdkMessage(run, message, at) {
    if (!object(message) || message.parent_tool_use_id != null) return
    if (message.type === 'assistant') {
      if (message.error || isNoResponsePlaceholder(message.message)) return
      const response = responseFor(run, message.message?.id, at, false)
      if (!response) return
      const content = Array.isArray(message.message?.content) ? message.message.content : []
      for (const block of content) if (block?.type === 'tool_use') tool(run, response, block)
      if (response.reason === 'MESSAGE_START_MISSING' && content.some(block =>
        block?.type === 'text' && block.text?.length || block?.type === 'thinking' && block.thinking?.length
        || block?.type === 'tool_use' && block.name?.length)) {
        publish(run, response, 'first-output', at)
      }
      // Full messages identify otherwise missing streams, but cannot prove the
      // first raw output or the exact end of a response. Do not fabricate either.
      return
    }
    if (message.type !== 'stream_event') return
    const event = message.event
    if (event?.type === 'message_start') { responseFor(run, event.message?.id, at, true); return }
    const response = run.responses.get(run.streamId)
    if (!response || response.stopped) return
    if (event?.type === 'message_stop') {
      publish(run, response, 'first-output', at, { reason: 'NO_EFFECTIVE_OUTPUT' })
      publish(run, response, 'duration', at, { endBoundary: 'message-stop' })
      response.stopped = true
      return
    }
    if (event?.type === 'content_block_start') {
      if (event.content_block?.type === 'tool_use') tool(run, response, event.content_block)
      else if (!['text', 'thinking'].includes(event.content_block?.type)) response.reason ??= 'UNSUPPORTED_CONTENT'
    } else if (event?.type === 'content_block_delta'
      && !['text_delta', 'thinking_delta', 'input_json_delta', 'signature_delta'].includes(event.delta?.type)) {
      response.reason ??= 'UNSUPPORTED_CONTENT'
    }
    const block = event?.content_block
    // A named tool call is model output even before its input JSON arrives.
    const namedTool = event?.type === 'content_block_start' && block?.type === 'tool_use'
      && identifier(block.id) && typeof block.name === 'string' && block.name.length > 0
    const kind = namedTool ? 'tool-name' : firstOutputKind(event)
    if (kind === 'tool-name' && !namedTool) return
    if (kind) publish(run, response, 'first-output', at, { kind })
  }
  function receivedCall(run, message) {
    if (run.incoming.size >= maximumCalls) { run.limited = true; return }
    if (run.incoming.has(message.id)) return
    if (message.method === 'tool.execute') {
      const callId = message.params?.callId
      const response = run.responses.get(run.toolOwners.get(callId))
      run.incoming.set(message.id, { method: message.method, callId, responseId: response?.id })
      if (!response) run.unboundTool = true
    } else if (message.method === 'step.prepare') {
      run.incoming.set(message.id, { method: message.method, responseId: run.lastId })
    }
  }
  function sentResult(run, message, origin, at) {
    const call = run.incoming.get(message.id)
    if (!call || call.method !== origin.method) return
    run.incoming.delete(message.id)
    const response = run.responses.get(call.responseId)
    if (!response) return
    if (call.method === 'tool.execute') {
      if (origin.callId !== undefined && origin.callId !== call.callId) { run.unboundTool = true; return }
      if (own(message, 'error')) { response.failedTools.add(call.callId); return }
      if (!own(message, 'result') || response.results.has(call.callId)) return
      response.results.set(call.callId, at)
      if (response.prepared && run.next) run.next.reason = 'TOOL_RESULTS_UNCONFIRMED'
      return
    }
    if (call.method !== 'step.prepare' || response.prepared) return
    if (own(message, 'error') || !object(message.result)) { response.preparationFailed = true; return }
    if (message.result.continue === false) { response.preparationStopped = true; run.next = undefined; return }
    response.prepared = true
    const tools = response.tools.size > 0 || response.results.size > 0
    const confirmed = !run.unboundTool && !response.failedTools.size
      && [...response.tools].every(id => response.results.has(id))
    run.next = { boundary: tools ? 'tool-results' : 'step-prepare',
      at: tools ? Math.max(...response.results.values()) : at,
      ...(!confirmed ? { reason: 'TOOL_RESULTS_UNCONFIRMED' } : {}) }
    run.unboundTool = false
  }
  return {
    observe(event) {
      const { direction, message, origin = {} } = event
      if (!object(message)) return
      const at = atOf(event)
      if (direction === 'sent' && message.method === 'query' && identifier(message.params?.runId)) {
        const id = message.params.runId
        if (runs.has(id) || runs.size >= maximumRuns) return
        runs.set(id, { id, queryId: message.id, next: { at, boundary: 'query' },
          responses: new Map(), incoming: new Map(), toolOwners: new Map() })
        return
      }
      if (direction === 'sent' && message.method === '$/cancelRequest') {
        for (const run of runs.values()) if (run.queryId === message.params?.id) finish(run.id, 'CANCELLED')
        return
      }
      const run = runs.get(message.params?.runId ?? origin.runId)
      if (!run) return
      if (direction === 'received' && message.method === 'sdk.message') sdkMessage(run, message.params?.message, at)
      else if (direction === 'received' && ['tool.execute', 'step.prepare'].includes(message.method)) receivedCall(run, message)
      else if (direction === 'sent' && message.id !== undefined && !message.method) sentResult(run, message, origin, at)
      else if (direction === 'received' && origin.method === 'query' && message.id === run.queryId) finish(run.id)
    },
    finish,
    close() { for (const id of [...runs.keys()]) finish(id, 'CONNECTION_CLOSED') },
  }
}
