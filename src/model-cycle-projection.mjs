import { CLAUDE_PRESET } from '../plugin/policy.mjs'
import { RESPONSE_TIMING_RECORD, initialResponseTiming, applyResponseTiming,
  createResponseTimingProjection } from './response-timing.mjs'
import { RESPONSE_USAGE_RECORD, initialResponseUsage, applyResponseUsage,
  createResponseUsageProjection } from './response-usage.mjs'
import { MODEL_OBSERVATION_RECORD, initialModelObservation, applyModelObservation,
  createModelObservationProjection } from './model-observation.mjs'

export const CLIENT_MODEL_TIMING_RECORD = 'plugin:claude-bridge/model-cycle-timing'
const keyOf = row => JSON.stringify([row.runId, row.responseId])
const stepOf = row => `${row.turn}:${row.step}`
const count = value => Number.isSafeInteger(value) && value >= 0
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256
const coordinate = row => row && identity(row.runId) && identity(row.responseId) && count(row.turn) && count(row.step)

export const initialModelCycle = () => ({ records: {}, sdkTiming: initialResponseTiming(),
  sdkUsage: initialResponseUsage(), models: {} })

/** One slot per real SDK response, with independent metrics. SDK measurements
 * remain separate evidence and never fill a missing Host timing sample. */
export function applyModelCycle(state, event) {
  if (state === null) return null
  const data = event.data
  if (event.type === CLIENT_MODEL_TIMING_RECORD && event.ignorable === true) {
    const key = keyOf(data), previous = state.records[key] ?? {}
    const metric = data.metric === 'first-output' ? 'firstOutput' : 'duration'
    return { ...state, records: { ...state.records, [key]: { ...previous, [metric]: data } } }
  }
  if (event.type === MODEL_OBSERVATION_RECORD && event.ignorable === true && coordinate(data)) {
    // The existing model projection validates and retains only its declared
    // metadata. Keep each response instead of replacing the session's current.
    const model = applyModelObservation(initialModelObservation(), event)
    return { ...state, models: { ...state.models, [keyOf(data)]: model } }
  }
  const sdkTiming = applyResponseTiming(state.sdkTiming, event)
  const sdkUsage = event.type === RESPONSE_USAGE_RECORD && event.ignorable === true
    ? applyResponseUsage(state.sdkUsage, event) : state.sdkUsage
  return sdkTiming === state.sdkTiming && sdkUsage === state.sdkUsage ? state : { ...state, sdkTiming, sdkUsage }
}

function coordinates(state) {
  const rows = { ...state.sdkTiming.observed }
  for (const model of Object.values(state.models)) if (coordinate(model.current)) rows[keyOf(model.current)] ??= model.current
  for (const [key, metrics] of Object.entries(state.records)) rows[key] = metrics.firstOutput ?? metrics.duration
  return rows
}

/** Small wire summary only. Detailed joins are computed on explicit metadata
 * export, so token/usage updates never push a session-sized row list to UI. */
export function modelCycleView(state) {
  if (state === null) return null
  const observed = Object.values(coordinates(state)), values = Object.values(state.records)
  const covered = new Set(observed.map(stepOf))
  const legacySteps = Object.values(state.sdkTiming.nativeSteps).filter(row => !covered.has(stepOf(row))).length
  const responseCount = observed.length + legacySteps
  const first = values.map(row => row.firstOutput).filter(row => row?.quality === 'precise')
  const duration = values.map(row => row.duration).filter(row => row?.quality === 'precise')
  return { ttftMs: first.reduce((sum, row) => sum + row.durationMs, 0), ttftSamples: first.length,
    responseCount, ttftUnknown: responseCount - first.length,
    durationMs: duration.reduce((sum, row) => sum + row.durationMs, 0), durationSamples: duration.length,
    coverage: !responseCount ? 'unknown' : !values.length ? 'legacy'
      : first.length === responseCount && duration.length === responseCount ? 'complete' : 'partial' }
}

const timingMetadata = row => row ? { quality: row.quality, startBoundary: row.startBoundary,
  ...(row.quality === 'precise' ? { durationMs: row.durationMs } : { reason: row.reason }),
  ...(row.kind === undefined ? {} : { kind: row.kind }),
  ...(row.endBoundary === undefined ? {} : { endBoundary: row.endBoundary }) }
  : { quality: 'unknown', reason: 'HOST_TIMING_UNAVAILABLE' }

/** Metadata only; no transcript, model prose, tool arguments or aggregate run
 * usage is used to invent response rows. Missing reasoning/effort stays unknown. */
export function modelCycleRows(state) {
  if (state == null) return []
  const usage = Object.fromEntries(Object.values(state.sdkUsage.responses).map(row => [keyOf(row), row.usage]))
  return Object.entries(coordinates(state)).map(([key, row]) => {
    const metrics = state.records[key] ?? {}, sdk = state.sdkTiming.records[key], model = state.models[key]?.current
    return { runId: row.runId, responseId: row.responseId, turn: row.turn, step: row.step,
      firstOutput: timingMetadata(metrics.firstOutput), duration: timingMetadata(metrics.duration),
      usage: usage[key] ? { uncachedInputTokens: usage[key].uncachedInputTokens, outputTokens: usage[key].outputTokens,
        cacheReadTokens: usage[key].cacheReadTokens, cacheWriteTokens: usage[key].cacheWriteTokens } : null,
      sdkTiming: sdk ? {
        ttft: sdk.ttft.status === 'known' ? { status: 'known', ms: sdk.ttft.ms, source: sdk.ttft.source }
          : { status: 'unknown', reason: sdk.ttft.reason },
        tps: sdk.tps.status === 'known' ? { status: 'known', durationMs: sdk.tps.durationMs,
          outputTokens: sdk.tps.outputTokens, source: sdk.tps.source } : { status: 'unknown', reason: sdk.tps.reason },
      } : null,
      model: model ? { requestedModel: model.requestedModel, actualModel: model.actualModel, source: model.source } : null,
      thinkingTokens: null, actualEffort: null }
  }).sort((a, b) => a.turn - b.turn || a.step - b.step
    || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0)
    || (a.responseId < b.responseId ? -1 : a.responseId > b.responseId ? 1 : 0))
}

export function createModelCycleProjection(z) {
  const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  const ms = z.number().finite().nonnegative()
  const id = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.:-]+$/)
  const reason = z.string().min(1).max(80).regex(/^[A-Z][A-Z0-9_]*$/)
  const record = z.object({ version: z.literal(1), runId: id, responseId: id, turn: integer, step: integer,
    metric: z.enum(['first-output', 'duration']), quality: z.enum(['precise', 'unknown']),
    durationMs: ms.optional(), reason: reason.optional(),
    kind: z.enum(['text', 'thinking', 'tool-input', 'tool-name']).optional(),
    source: z.literal('host-model-cycle'), clock: z.literal('local-monotonic'),
    startBoundary: z.enum(['query-preparation', 'query', 'tool-results', 'step-prepare']).optional(),
    endBoundary: z.literal('message-stop').optional() }).strict()
    .refine(row => row.quality === 'precise' ? row.durationMs !== undefined && row.startBoundary !== undefined && row.reason === undefined
      : row.reason !== undefined && row.durationMs === undefined && row.endBoundary === undefined,
    { message: '模型请求计时缺少对应质量的证据' })
    .refine(row => row.metric !== 'duration' || row.quality !== 'precise' || row.endBoundary === 'message-stop',
      { message: '完整模型请求时长缺少message-stop边界' })
  const sdkTiming = createResponseTimingProjection(z), sdkUsage = createResponseUsageProjection(z)
  const models = createModelObservationProjection(z)
  const stateSchema = z.object({ records: z.record(z.string(), z.object({
    firstOutput: record.refine(row => row.metric === 'first-output').optional(),
    duration: record.refine(row => row.metric === 'duration').optional() }).strict()),
    sdkTiming: sdkTiming.stateSchema.refine(value => value !== null),
    sdkUsage: sdkUsage.stateSchema.refine(value => value !== null),
    models: z.record(z.string(), models.stateSchema.refine(value => value !== null)),
  }).strict().nullable()
  const viewSchema = z.object({ ttftMs: ms, ttftSamples: integer, responseCount: integer,
    ttftUnknown: integer, durationMs: ms, durationSamples: integer,
    coverage: z.enum(['unknown', 'legacy', 'partial', 'complete']) }).strict().nullable()
  return { key: 'claudeBridgeModelStats', stateVersion: 1, stateSchema,
    init: header => header.agentPreset === CLAUDE_PRESET ? initialModelCycle() : null,
    apply(state, event) {
      if (state === null) return null
      if (event.ignorable === true) {
        if (event.type === CLIENT_MODEL_TIMING_RECORD) record.parse(event.data)
        else if (event.type === RESPONSE_TIMING_RECORD) sdkTiming.apply(state.sdkTiming, event)
        else if (event.type === RESPONSE_USAGE_RECORD) sdkUsage.apply(state.sdkUsage, event)
        else if (event.type === MODEL_OBSERVATION_RECORD) models.apply(initialModelObservation(), event)
      }
      return applyModelCycle(state, event)
    }, wire: { viewSchema, view: modelCycleView } }
}
