import { CLAUDE_PRESET, CLAUDE_PROVIDER } from '../plugin/policy.mjs'

// Response evidence is separate from requested selection and cumulative usage.
export const MODEL_OBSERVATION_RECORD = 'plugin:claude-bridge/model-observation'

export function sdkModelName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) && value !== '<synthetic>' ? value : null
}

export function initialModelObservation() { return { requestedModel: null, current: null } }

export function applyModelObservation(state, event) {
  if (state === null) return state
  if (event.type === 'request/header') {
    const selection = event.data?.header?.config
    return { requestedModel: selection?.provider === CLAUDE_PROVIDER ? sdkModelName(selection.model) : null, current: null }
  }
  if (event.type !== MODEL_OBSERVATION_RECORD || event.ignorable !== true) return state
  // A different requested alias cannot supply evidence for the current request.
  if (state.requestedModel !== null && event.data.requestedModel !== state.requestedModel) return state
  return { ...state, current: event.data }
}

export function createModelObservationProjection(z) {
  const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  const name = z.string().refine(value => sdkModelName(value) !== null)
  const record = z.object({ version: z.literal(1), runId: z.string().min(1).max(256),
    responseId: z.string().min(1).max(256).nullable(), turn: integer, step: integer,
    requestedModel: name, actualModel: name.nullable(),
    source: z.enum(['sdk-message-start', 'sdk-assistant']).nullable(),
  }).strict().refine(value => (value.actualModel === null) === (value.source === null))
  const schema = z.object({ requestedModel: name.nullable(), current: record.nullable() }).strict().nullable()
  return { key: 'claudeBridgeModelObservation', stateVersion: 1, stateSchema: schema,
    init: header => header.agentPreset === CLAUDE_PRESET ? initialModelObservation() : null,
    apply(state, event) {
      if (state === null) return state
      if (event.type === MODEL_OBSERVATION_RECORD && event.ignorable === true) record.parse(event.data)
      return applyModelObservation(state, event)
    }, wire: { viewSchema: schema, view: state => state } }
}
