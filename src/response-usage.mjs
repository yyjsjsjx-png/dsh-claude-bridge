import { CLAUDE_PRESET } from '../plugin/policy.mjs'

// Numerical settlements never impersonate Assistant messages or attempts.
export const RESPONSE_USAGE_RECORD = 'plugin:claude-bridge/response-usage'
export const RUN_USAGE_RECORD = 'plugin:claude-bridge/run-usage'
const fields = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
const count = n => Number.isSafeInteger(n) && n >= 0
const zero = () => Object.fromEntries(fields.map(k => [k, 0]))
const add = (a, b) => Object.fromEntries(fields.map(k => [k, a[k] + b[k]]))
const valid = u => u && fields.every(k => count(u[k]))

/** Only a complete API usage snapshot is eligible; absence is not zero. */
export function responseUsageFromSdk(u) {
  if (!u || !count(u.input_tokens) || !count(u.output_tokens)
    || (u.cache_read_input_tokens !== undefined && !count(u.cache_read_input_tokens))
    || (u.cache_creation_input_tokens !== undefined && !count(u.cache_creation_input_tokens))) return undefined
  return { uncachedInputTokens: u.input_tokens, outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 }
}

/** TTL details are optional and only authoritative when they reconcile to the write total. */
export function responseLedgerUsageFromSdk(u) {
  const usage = responseUsageFromSdk(u)
  if (!usage) return undefined
  const five = u.cache_creation?.ephemeral_5m_input_tokens
  const hour = u.cache_creation?.ephemeral_1h_input_tokens
  if (count(five) && count(hour) && five + hour === usage.cacheWriteTokens) {
    return { ...usage, cacheWrite5mTokens: five, cacheWrite1hTokens: hour }
  }
  return usage
}

function nativeUsage(event) {
  let u = event.type === 'assistant/message' ? event.data.usage : undefined
  if (u === undefined) for (let i = (event.data.stream?.length ?? 0) - 1; i >= 0; i--) {
    const chunk = event.data.stream[i]?.chunk
    if (chunk?.type === 'usage') { u = chunk.usage; break }
  }
  if (!u || !count(u.inputTokens) || !count(u.outputTokens)) return undefined
  const buckets = { uncachedInputTokens: u.inputTokens, outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadTokens ?? 0, cacheWriteTokens: u.cacheWriteTokens ?? 0 }
  return valid(buckets) ? buckets : undefined
}

export function initialResponseUsage() { return { native: {}, responses: {}, runs: {}, steps: {} } }

/** Pure replay fold. New numerical records take precedence over legacy usage. */
export function applyResponseUsage(state, event) {
  if (state === null) return state
  const d = event.data
  if (event.ignorable === true && event.type === RESPONSE_USAGE_RECORD) {
    const key = JSON.stringify([d.turn, d.runId, d.responseId])
    return { ...state, responses: { ...state.responses, [key]: d } }
  }
  if (event.ignorable === true && event.type === RUN_USAGE_RECORD) {
    const key = JSON.stringify([d.turn, d.runId])
    return { ...state, runs: { ...state.runs, [key]: d } }
  }
  if (!count(d?.turn) || !count(d?.step)) return state
  const key = `${d.turn}:${d.step}`
  if (['step/start', 'step/end'].includes(event.type)) return { ...state,
    steps: { ...state.steps, [key]: { turn: d.turn, step: d.step } } }
  if (event.type === 'llm/retry-started') {
    const previous = state.native[key]
    return previous ? { ...state, native: { ...state.native, [key]: { ...previous, last: null } } } : state
  }
  if (!['assistant/message', 'assistant/attempt'].includes(event.type)) return state
  const usage = nativeUsage(event)
  if (!usage) return state
  const previous = state.native[key]
  const total = Object.fromEntries(fields.map(k => [k,
    (previous?.usage[k] ?? 0) - (previous?.last?.[k] ?? 0) + usage[k]]))
  return { ...state, native: { ...state.native, [key]: { turn: d.turn, step: d.step, usage: total, last: usage } } }
}

export function responseUsageView(state) {
  if (state === null) return null
  const turns = new Set([...Object.values(state.native), ...Object.values(state.responses),
    ...Object.values(state.runs), ...Object.values(state.steps)].map(row => row.turn))
  const byTurn = Object.fromEntries([...turns].map(turn => [String(turn), turnUsage(state, turn)]))
  let totals = zero()
  for (const value of Object.values(byTurn)) totals = add(totals, value)
  const coverage = Object.values(byTurn).map(value => value.coverage)
  return { ...totals, coverage: coverage.length && coverage.every(c => c === 'complete') ? 'complete'
    : coverage.length && coverage.every(c => c === 'legacy') ? 'legacy' : 'partial', turns: byTurn }
}

function turnUsage(state, turn) {
  let totals = zero()
  const runs = Object.values(state.runs).filter(r => r.turn === turn)
  const responses = Object.values(state.responses).filter(r => r.turn === turn)
  const terminal = new Set(runs.map(r => JSON.stringify([r.turn, r.runId])))
  const responseSteps = new Set(responses.map(r => `${r.turn}:${r.step}`))
  let legacy = false, partial = false
  for (const baseline of Object.values(state.native).filter(r => r.turn === turn)) {
    if (responseSteps.has(`${baseline.turn}:${baseline.step}`)
      || runs.some(r => r.turn === baseline.turn && baseline.step >= r.startStep && baseline.step <= r.endStep)) continue
    totals = add(totals, baseline.usage)
    legacy = true
  }
  for (const response of responses) {
    if (terminal.has(JSON.stringify([response.turn, response.runId]))) continue
    totals = add(totals, response.usage)
    partial = true
  }
  for (const run of runs) totals = add(totals, run.usage)
  const uncovered = Object.values(state.steps).some(s => s.turn === turn
    && !runs.some(r => s.step >= r.startStep && s.step <= r.endStep))
  return { ...totals, coverage: partial || (legacy && runs.length) || (uncovered && runs.length) ? 'partial'
    : runs.length ? 'complete' : legacy ? 'legacy' : 'partial' }
}

export function createResponseUsageProjection(z) {
  const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  const buckets = z.object(Object.fromEntries(fields.map(k => [k, number]))).strict()
  const response = z.object({ version: z.literal(1), turn: number, step: number,
    runId: z.string().min(1).max(256), responseId: z.string().min(1).max(256),
    source: z.literal('sdk-stream'), usage: buckets }).strict()
  const run = z.object({ version: z.literal(1), turn: number, startStep: number, endStep: number,
    runId: z.string().min(1).max(256), source: z.literal('sdk-result-main-agent'), usage: buckets }).strict()
  const schema = z.object({ native: z.record(z.string(), z.object({ turn: number, step: number,
    usage: buckets, last: buckets.nullable() }).strict()),
    responses: z.record(z.string(), response), runs: z.record(z.string(), run),
    steps: z.record(z.string(), z.object({ turn: number, step: number }).strict()) }).strict().nullable()
  const turnView = z.object({ ...Object.fromEntries(fields.map(k => [k, number])),
    coverage: z.enum(['legacy', 'partial', 'complete']) }).strict()
  const view = turnView.extend({ turns: z.record(z.string(), turnView) }).strict().nullable()
  return { key: 'claudeBridgeUsage', stateVersion: 1, stateSchema: schema,
    init: header => header.agentPreset === CLAUDE_PRESET ? initialResponseUsage() : null,
    apply(state, event) {
      if (state === null) return state
      if (event.ignorable === true && event.type === RESPONSE_USAGE_RECORD) response.parse(event.data)
      if (event.ignorable === true && event.type === RUN_USAGE_RECORD) run.parse(event.data)
      return applyResponseUsage(state, event)
    }, wire: { viewSchema: view, view: responseUsageView } }
}
