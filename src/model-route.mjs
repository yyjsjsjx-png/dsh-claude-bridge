import { CLAUDE_PRESET } from '../plugin/policy.mjs'
import { sdkModelName } from './model-observation.mjs'

// Selected model versus the model that really answered. Display-only evidence:
// nothing here changes the selection, the SDK session or the model surface.
export const MODEL_ROUTE_RECORD = 'plugin:claude-bridge/model-route'
export const MODEL_ROUTE_PROJECTION = 'claudeBridgeModelRoute'

const FAMILY_ALIASES = new Set(['opus', 'sonnet', 'haiku'])
const MAX_EXPLANATION_CHARS = 500

function canonicalModel(value) {
  const name = sdkModelName(value)
  return name === null ? null : name.toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
}

/** Two identifiers of the same concrete model, ignoring a date or [1m] suffix. */
export function sameModel(left, right) {
  const a = canonicalModel(left), b = canonicalModel(right)
  return a !== null && a === b
}

/**
 * true: the response satisfies the selection. false: provably another model.
 * null: no verdict, such as an unknown alias. Missing evidence is never a mismatch.
 * A family alias cannot tell versions apart; only an SDK event can report those.
 */
export function modelRouteVerdict(requested, actual) {
  const wanted = canonicalModel(requested), seen = canonicalModel(actual)
  if (wanted === null || seen === null) return null
  if (wanted === seen) return true
  if (!seen.startsWith('claude-')) return null
  if (FAMILY_ALIASES.has(wanted)) {
    if (seen.startsWith(`claude-${wanted}-`)) return true
    return [...FAMILY_ALIASES].some(family => seen.startsWith(`claude-${family}-`)) ? false : null
  }
  return wanted.startsWith('claude-') ? false : null
}

function refusalCategory(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][\w.:-]{0,63}$/.test(value) ? value : null
}

// Unstable provider prose: bounded and displayed, never parsed or exported.
function refusalExplanation(value) {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  return text ? text.slice(0, MAX_EXPLANATION_CHARS) : null
}

const uuidsOf = value => Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : []

/** Per-run rules. Accepts SDK events in either order; every input is idempotent. */
export function createModelRouteTracker({ runId, open = null, append, now = Date.now }) {
  let route = open, sequence = 0
  const notices = new Set()
  const frames = new Map()
  const refused = new Set()
  const retractedUuids = new Set()
  const retractedResponses = new Set()
  let retractedOther = 0, retractedToolCalls = 0

  const emit = (kind, position, fields) => append(MODEL_ROUTE_RECORD, {
    version: 1, kind, runId, turn: position.turn, step: position.step, at: now(), ...fields })
  const nextId = () => `${runId}:${++sequence}`

  // Counts only: the text stays visible, the card just says what was withdrawn.
  function retract(uuids, responseIds) {
    for (const uuid of uuids) {
      if (retractedUuids.has(uuid)) continue
      retractedUuids.add(uuid)
      const frame = frames.get(uuid)
      if (!frame) { retractedOther++; continue }
      retractedToolCalls += frame.toolCalls
      if (frame.responseId) retractedResponses.add(frame.responseId)
    }
    for (const id of responseIds) retractedResponses.add(id)
  }

  return {
    /** Remember which API response a delivered SDK frame belongs to. */
    frame({ uuid, responseId, toolCalls = 0, supersedes, refusal = false }) {
      const id = sdkModelName(responseId)
      if (typeof uuid === 'string' && uuid && !frames.has(uuid)) frames.set(uuid, { responseId: id, toolCalls })
      if (refusal && id) refused.add(id)
      retract(uuidsOf(supersedes), [])
    },

    refusalStop(responseId) {
      const id = sdkModelName(responseId)
      if (id) refused.add(id)
    },

    response({ requestedModel, actualModel, responseId }, position) {
      if (sdkModelName(actualModel) === null) return
      const verdict = modelRouteVerdict(requestedModel, actualModel)
      if (route) {
        // An alias cannot rule out its own family, so the open route decides
        // first: the same fallback model keeps answering until selection changes.
        const stillHeld = sameModel(actualModel, route.actualModel)
        const reselected = verdict === true && requestedModel !== route.requestedModel
        if (stillHeld && !reselected) return
        if (verdict === true || sameModel(actualModel, route.originalModel)) {
          emit('recovered', position, { routeId: nextId(), requestedModel, actualModel,
            originalModel: route.originalModel, previousModel: route.actualModel })
          route = null
          return
        }
      }
      if (verdict !== false) return
      const routeId = nextId()
      route = { routeId, runId, kind: 'mismatch', requestedModel, originalModel: requestedModel, actualModel }
      emit('mismatch', position, { routeId, requestedModel, originalModel: requestedModel, actualModel,
        responseId: sdkModelName(responseId) })
    },

    notice(message, { requestedModel }, position) {
      if (typeof message.uuid === 'string') {
        if (notices.has(message.uuid)) return
        notices.add(message.uuid)
      }
      const originalModel = sdkModelName(message.original_model)
      const refusal = { category: refusalCategory(message.api_refusal_category),
        explanation: refusalExplanation(message.api_refusal_explanation) }
      if (message.subtype === 'model_refusal_no_fallback') {
        emit('refusal-no-fallback', position, { routeId: nextId(), requestedModel, originalModel, actualModel: null, ...refusal })
        return
      }
      // A local retry answered a side question; the session model is unchanged.
      if (message.direction !== 'retry' || message.scope === 'local') return
      const actualModel = sdkModelName(message.fallback_model)
      retract(uuidsOf(message.retracted_message_uuids), [...refused])
      // The takeover response usually precedes this end-of-turn notice. Explain
      // that existing card instead of describing the same switch a second time.
      const explains = route?.kind === 'mismatch' && route.runId === runId
        && (actualModel === null || sameModel(route.actualModel, actualModel))
      const routeId = explains ? route.routeId : nextId()
      const seen = actualModel ?? route?.actualModel ?? null
      route = { routeId, runId, kind: 'refusal-fallback', requestedModel, originalModel, actualModel: seen }
      emit('refusal-fallback', position, { routeId, requestedModel, originalModel, actualModel: seen, ...refusal,
        retractedResponseCount: retractedResponses.size, retractedOtherCount: retractedOther,
        retractedToolCallCount: retractedToolCalls })
    },
  }
}

export function initialModelRoute() { return { open: null } }

export function applyModelRoute(state, event) {
  if (state === null || event.type !== MODEL_ROUTE_RECORD || event.ignorable !== true) return state
  const data = event.data
  if (data.kind === 'mismatch' || data.kind === 'refusal-fallback') {
    const { routeId, runId, kind, requestedModel, originalModel, actualModel } = data
    return { ...state, open: { routeId, runId, kind, requestedModel, originalModel, actualModel } }
  }
  return data.kind === 'recovered' ? { ...state, open: null } : state
}

export function createModelRouteProjection(z) {
  const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  const name = z.string().refine(value => sdkModelName(value) !== null).nullable()
  const id = z.string().min(1).max(320)
  const base = { version: z.literal(1), runId: z.string().min(1).max(256), turn: integer, step: integer, at: integer }
  const models = { routeId: id, requestedModel: name, originalModel: name, actualModel: name }
  const refusal = { category: z.string().max(64).nullable(), explanation: z.string().max(MAX_EXPLANATION_CHARS).nullable() }
  const record = z.discriminatedUnion('kind', [
    z.object({ ...base, ...models, kind: z.literal('mismatch'), responseId: name }).strict(),
    z.object({ ...base, ...models, ...refusal, kind: z.literal('refusal-fallback'),
      retractedResponseCount: integer, retractedOtherCount: integer, retractedToolCallCount: integer }).strict(),
    z.object({ ...base, ...models, ...refusal, kind: z.literal('refusal-no-fallback') }).strict(),
    z.object({ ...base, ...models, kind: z.literal('recovered'), previousModel: name }).strict(),
  ])
  const schema = z.object({
    open: z.object({ routeId: id, runId: base.runId, kind: z.enum(['mismatch', 'refusal-fallback']),
      requestedModel: name, originalModel: name, actualModel: name }).strict().nullable(),
  }).strict().nullable()
  return { key: MODEL_ROUTE_PROJECTION, stateVersion: 1, stateSchema: schema,
    init: header => header.agentPreset === CLAUDE_PRESET ? initialModelRoute() : null,
    apply(state, event) {
      if (state === null || event.type !== MODEL_ROUTE_RECORD || event.ignorable !== true) return state
      // A display record can never make a session's projection unreadable.
      return record.safeParse(event.data).success ? applyModelRoute(state, event) : state
    }, wire: { viewSchema: schema, view: state => state } }
}
