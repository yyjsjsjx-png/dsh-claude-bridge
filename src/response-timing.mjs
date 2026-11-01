import { CLAUDE_PRESET } from '../plugin/policy.mjs'
import { RESPONSE_USAGE_RECORD } from './response-usage.mjs'

export const RESPONSE_TIMING_RECORD = 'plugin:claude-bridge/response-timing'
const count = n => Number.isSafeInteger(n) && n >= 0
const milliseconds = n => Number.isFinite(n) && n >= 0
const identifier = s => typeof s === 'string' && s.length > 0 && s.length <= 256
const keyOf = (runId, responseId) => JSON.stringify([runId, responseId])
const stepOf = r => `${r.turn}:${r.step}`
const failureReasons = ['incomplete-stream', 'unsupported-block', 'assistant-supplement',
  'message-start-missing', 'message-stop-missing', 'interrupted', 'clock-invalid', 'late-stream-data']
const rateReasons = [...failureReasons, 'awaiting-message-stop', 'awaiting-final-usage',
  'final-usage-unavailable', 'no-raw-token-delta', 'nonpositive-duration', 'zero-output-tokens']

/** Numerical evidence only. SDK TTFT and local receive spans never share a clock. */
export function createResponseTimingTracker({ runId, turn, onRecord = () => {}, now = () => performance.now() }) {
  if (!identifier(runId) || !count(turn)) throw new TypeError('RESPONSE_TIMING_IDENTITY_INVALID')
  const responses = new Map()
  let closed = false
  const snapshot = r => {
    const ttft = milliseconds(r.sdkTtftMs)
      ? { status: 'known', ms: r.sdkTtftMs, source: 'sdk-response-start' }
      : { status: 'unknown', reason: 'sdk-ttft-unavailable' }
    const contentSpanMs = r.first === null ? null : r.last - r.first
    const reason = r.failure ?? (!r.ended ? 'awaiting-message-stop'
      : r.first === null ? 'no-raw-token-delta'
        : contentSpanMs <= 0 ? 'nonpositive-duration'
          : r.outputTokens === undefined ? closed ? 'final-usage-unavailable' : 'awaiting-final-usage'
            : r.outputTokens === 0 ? 'zero-output-tokens' : null)
    const tps = reason ? { status: 'unknown', reason }
      : { status: 'known', durationMs: r.last - r.startAt, outputTokens: r.outputTokens, source: 'sdk-stream-receive' }
    return { version: 1, runId, responseId: r.id, turn, step: r.step, source: 'sdk-remote',
      state: r.interrupted ? 'interrupted' : r.ended ? 'closed' : 'open',
      captureStatus: r.failure ? 'incomplete' : r.ended ? 'complete' : 'pending',
      reason: r.failure ?? null, rawDeltaCount: r.deltas, streamStarted: r.startAt !== null,
      contentSpanMs, ttft, tps }
  }
  const publish = r => {
    const record = snapshot(r), signature = JSON.stringify(record)
    if (signature === r.signature) return
    onRecord(record)
    r.signature = signature
  }
  const fail = (r, reason) => {
    if (!r.failure) r.failure = failureReasons.includes(reason) ? reason : 'incomplete-stream'
    publish(r)
  }
  return {
    responseStarted({ responseId, step, sdkTtftMs, at, streamStarted = false } = {}) {
      if (closed || !identifier(responseId) || !count(step)) return false
      let r = responses.get(responseId)
      if (!r) {
        const startAt = streamStarted === true ? at ?? now() : null
        r = { id: responseId, step, first: null, last: null, deltas: 0, ended: false,
          eventIds: new Set(), startAt: milliseconds(startAt) ? startAt : null,
          failure: streamStarted !== true ? 'message-start-missing' : !milliseconds(startAt) ? 'clock-invalid' : null,
          outputTokens: undefined, sdkTtftMs: undefined }
        responses.set(responseId, r)
      } else if (r.step !== step) return false
      if (milliseconds(sdkTtftMs)) r.sdkTtftMs = sdkTtftMs
      publish(r)
      return true
    },
    sourceTtft({ responseId, ms } = {}) {
      const r = responses.get(responseId)
      if (closed || !r || !milliseconds(ms)) return false
      r.sdkTtftMs = ms
      publish(r)
      return true
    },
    token({ responseId, kind, eventId, at } = {}) {
      const r = responses.get(responseId)
      if (closed || !r) return false
      if (!['text', 'thinking', 'tool-input', 'tool-name'].includes(kind)) { fail(r, 'unsupported-block'); return false }
      if (identifier(eventId)) {
        if (r.eventIds.has(eventId)) return false
        r.eventIds.add(eventId)
      }
      if (r.ended || r.interrupted) { fail(r, 'late-stream-data'); return false }
      const time = at ?? now()
      if (!milliseconds(time) || (r.startAt !== null && time < r.startAt)
        || (r.last !== null && time < r.last)) { fail(r, 'clock-invalid'); return false }
      r.first ??= time
      r.last = time
      r.deltas++
      // No per-token records: publish when source TTFT, closure, usage or
      // capture validity changes. Raw text and tool arguments never enter it.
      return true
    },
    responseCompleted({ responseId, streamComplete = false } = {}) {
      const r = responses.get(responseId)
      if (closed || !r) return false
      if (!r.ended) {
        r.ended = true
        if (streamComplete !== true && !r.failure) r.failure = 'incomplete-stream'
      }
      publish(r)
      return true
    },
    responseUsage({ responseId, outputTokens, final = false } = {}) {
      const r = responses.get(responseId)
      if (closed || !r || final !== true || !count(outputTokens)) return false
      // Messages API output usage is cumulative. Duplicate/older samples do
      // not add tokens or lower a response's already confirmed count.
      r.outputTokens = Math.max(r.outputTokens ?? 0, outputTokens)
      publish(r)
      return true
    },
    failCapture({ responseId, reason = 'incomplete-stream' } = {}) {
      const r = responses.get(responseId)
      if (closed || !r) return false
      fail(r, reason)
      return true
    },
    interrupt() {
      if (closed) return
      closed = true
      for (const r of responses.values()) {
        if (!r.ended) {
          r.interrupted = true
          if (!r.failure) r.failure = 'interrupted'
        }
        publish(r)
      }
    },
    close() {
      if (closed) return
      closed = true
      for (const r of responses.values()) {
        if (!r.ended) {
          r.ended = true
          if (!r.failure) r.failure = 'message-stop-missing'
        }
        publish(r)
      }
    },
  }
}

export const initialResponseTiming = () => ({ records: {}, observed: {}, nativeSteps: {} })

export function applyResponseTiming(state, event) {
  if (state === null) return state
  const d = event.data
  if (event.type === RESPONSE_TIMING_RECORD && event.ignorable === true) {
    const key = keyOf(d.runId, d.responseId)
    return { ...state, records: { ...state.records, [key]: d },
      observed: { ...state.observed, [key]: { runId: d.runId, responseId: d.responseId, turn: d.turn, step: d.step } } }
  }
  if (event.type === RESPONSE_USAGE_RECORD && event.ignorable === true
    && identifier(d?.runId) && identifier(d?.responseId) && count(d?.turn) && count(d?.step)) {
    const key = keyOf(d.runId, d.responseId)
    if (state.records[key]) return state // Timing's coordinates own this sample.
    return { ...state, observed: { ...state.observed,
      [key]: { runId: d.runId, responseId: d.responseId, turn: d.turn, step: d.step } } }
  }
  if (event.type === 'assistant/message' && count(d?.turn) && count(d?.step)) return { ...state,
    nativeSteps: { ...state.nativeSteps, [stepOf(d)]: { turn: d.turn, step: d.step } } }
  return state
}

export function responseTimingView(state) {
  if (state === null) return null
  const rows = Object.values(state.records), observed = Object.values(state.observed)
  const coveredSteps = new Set(observed.map(stepOf))
  const legacySteps = Object.values(state.nativeSteps).filter(s => !coveredSteps.has(stepOf(s))).length
  const responseCount = observed.length + legacySteps
  const ttft = rows.filter(r => r.ttft.status === 'known'), tps = rows.filter(r => r.tps.status === 'known')
  return { ttftMs: ttft.reduce((n, r) => n + r.ttft.ms, 0), ttftSteps: ttft.length,
    decodeMs: tps.reduce((n, r) => n + r.tps.durationMs, 0),
    decodeTokens: tps.reduce((n, r) => n + r.tps.outputTokens, 0),
    responseCount, tpsSamples: tps.length, ttftUnknown: responseCount - ttft.length,
    tpsUnknown: responseCount - tps.length, legacyStepsWithoutTiming: legacySteps,
    incompleteCaptures: rows.filter(r => r.captureStatus === 'incomplete').length,
    pendingResponses: rows.filter(r => r.state === 'open').length,
    coverage: !responseCount ? 'unknown' : !rows.length ? 'legacy'
      : ttft.length === responseCount && tps.length === responseCount ? 'complete' : 'partial',
  }
}

export function createResponseTimingProjection(z) {
  const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  const ms = z.number().finite().nonnegative()
  const coordinate = z.object({ runId: z.string().min(1).max(256), responseId: z.string().min(1).max(256), turn: integer, step: integer }).strict()
  const record = coordinate.extend({ version: z.literal(1), source: z.literal('sdk-remote'),
    state: z.enum(['open', 'closed', 'interrupted']), captureStatus: z.enum(['pending', 'complete', 'incomplete']),
    reason: z.enum(failureReasons).nullable(), rawDeltaCount: integer, streamStarted: z.boolean(), contentSpanMs: ms.nullable(),
    ttft: z.discriminatedUnion('status', [z.object({ status: z.literal('known'), ms,
      source: z.literal('sdk-response-start') }).strict(),
    z.object({ status: z.literal('unknown'), reason: z.literal('sdk-ttft-unavailable') }).strict()]),
    tps: z.discriminatedUnion('status', [z.object({ status: z.literal('known'), durationMs: ms.positive(),
      outputTokens: integer.positive(), source: z.literal('sdk-stream-receive') }).strict(),
    z.object({ status: z.literal('unknown'), reason: z.enum(rateReasons) }).strict()]),
  }).strict().refine(r => r.tps.status !== 'known' || (r.state === 'closed' && r.captureStatus === 'complete'
    && r.streamStarted && r.rawDeltaCount >= 2 && r.contentSpanMs > 0 && r.tps.durationMs >= r.contentSpanMs),
  { message: '接收速率缺少完整响应证据' })
  const stateSchema = z.object({ records: z.record(z.string(), record), observed: z.record(z.string(), coordinate),
    nativeSteps: z.record(z.string(), z.object({ turn: integer, step: integer }).strict()) }).strict().nullable()
  const viewSchema = z.object({ ttftMs: ms, ttftSteps: integer, decodeMs: ms, decodeTokens: integer,
    responseCount: integer, tpsSamples: integer, ttftUnknown: integer, tpsUnknown: integer,
    legacyStepsWithoutTiming: integer, incompleteCaptures: integer, pendingResponses: integer,
    coverage: z.enum(['unknown', 'legacy', 'partial', 'complete']) }).strict().nullable()
  return { key: 'claudeBridgeResponseStats', stateVersion: 1, stateSchema,
    init: header => header.agentPreset === CLAUDE_PRESET ? initialResponseTiming() : null,
    apply(state, event) {
      if (state === null) return state
      if (event.type === RESPONSE_TIMING_RECORD && event.ignorable === true) record.parse(event.data)
      return applyResponseTiming(state, event)
    }, wire: { viewSchema, view: responseTimingView } }
}
