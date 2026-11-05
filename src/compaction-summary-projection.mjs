import { CLAUDE_PRESET } from '../plugin/policy.mjs'
import { COMPACTION_SUMMARY_RECORD, MAX_COMPACTION_SUMMARY_BYTES, SUMMARY_CODES } from './compaction-summary.mjs'

/** Browser-safe exact-identity merge rules; the client bundle supplies the shared constants. */
export function createCompactionSummaryRules() {
  const count = value => Number.isSafeInteger(value) && value >= 0
  const uuid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined
  const unavailable = code => ({ status: 'unavailable', code })
  const normalize = value => {
    if (value?.status !== 'available') return unavailable(SUMMARY_CODES.includes(value?.code) ? value.code : 'SUMMARY_UNAVAILABLE')
    if (typeof value.text !== 'string') return unavailable('SUMMARY_MISSING')
    if (new TextEncoder().encode(value.text).byteLength > MAX_COMPACTION_SUMMARY_BYTES) return unavailable('SUMMARY_TOO_LARGE')
    if (!value.text.trim()) return unavailable('SUMMARY_EMPTY')
    return { status: 'available', text: value.text }
  }
  const locator = data => typeof data.runId === 'string' && data.runId.length > 0
    && count(data.completedAt) && count(data.anchorSeq ?? data.seq)
    ? JSON.stringify([data.runId, data.completedAt, data.anchorSeq ?? data.seq]) : undefined
  const initial = () => ({ summaries: {}, links: {} })
  function apply(state, event) {
    if (state === null || event.type !== COMPACTION_SUMMARY_RECORD || event.ignorable !== true) return state
    const data = event.data
    if (data?.version !== 1 || !uuid(data.boundaryUuid) || !['auto', 'manual', 'unknown'].includes(data.trigger)) return state
    const key = `$${data.boundaryUuid}`, previous = own(state.summaries, key)
    const source = data.source === 'native-transcript' ? 'native-transcript' : 'sdk-postcompact'
    const previousSource = previous?.source === 'native-transcript' ? 'native-transcript' : 'sdk-postcompact'
    let summary = normalize(data.summary)
    let entry
    // The native transcript can wrap or transform Hook text. Only compare
    // verbatim equality within one source; PostCompact owns the live wording.
    if (previous && source !== previousSource) {
      entry = source === 'native-transcript' ? previous : { boundaryUuid: data.boundaryUuid, trigger: data.trigger, source, summary }
    } else {
      if (previous?.summary.status === 'available') {
        if (summary.status !== 'available' && summary.code !== 'SUMMARY_CONFLICT') summary = previous.summary
        else if (summary.text !== previous.summary.text) summary = unavailable('SUMMARY_CONFLICT')
      } else if (previous?.summary.code === 'SUMMARY_CONFLICT') summary = previous.summary
      if (previous && previous.trigger !== 'unknown' && data.trigger !== 'unknown' && previous.trigger !== data.trigger) {
        summary = unavailable('SUMMARY_CONFLICT')
      }
      entry = { boundaryUuid: data.boundaryUuid, trigger: previous?.trigger ?? data.trigger, source, summary }
    }
    const linkKey = locator(data), links = { ...state.links }
    if (linkKey !== undefined) {
      const previousLink = own(links, linkKey)
      links[linkKey] = previousLink === undefined || previousLink === data.boundaryUuid ? data.boundaryUuid : null
    }
    return { summaries: { ...state.summaries, [key]: entry }, links }
  }
  function lookup(state, card) {
    if (!state) return undefined
    const linkKey = locator(card)
    const boundaryUuid = uuid(card.boundaryUuid) ? card.boundaryUuid
      : linkKey === undefined ? undefined : own(state.links, linkKey)
    if (boundaryUuid === null || card.boundaryConflict) return unavailable('SUMMARY_CONFLICT')
    if (!uuid(boundaryUuid)) return undefined
    const entry = own(state.summaries, `$${boundaryUuid}`)
    if (!entry) return undefined
    if (card.trigger !== 'unknown' && entry.trigger !== 'unknown' && card.trigger !== entry.trigger) return unavailable('SUMMARY_CONFLICT')
    return normalize(entry.summary)
  }
  return { initial, apply, lookup, normalize }
}

/** Display-only summary state never contributes messages to the model surface. */
export function createCompactionSummaryProjection(z) {
  const rules = createCompactionSummaryRules()
  const summary = z.union([z.object({ status: z.literal('available'), text: z.string()
    .refine(text => rules.normalize({ status: 'available', text }).status === 'available') }).strict(),
  z.object({ status: z.literal('unavailable'), code: z.enum(SUMMARY_CODES) }).strict()])
  const entry = z.object({ boundaryUuid: z.string(), trigger: z.enum(['auto', 'manual', 'unknown']),
    source: z.enum(['sdk-postcompact', 'native-transcript']).optional(), summary }).strict()
  const schema = z.object({ summaries: z.record(z.string(), entry), links: z.record(z.string(), z.string().nullable()) }).strict().nullable()
  return { key: 'claudeBridgeCompactionSummaries', stateVersion: 1, stateSchema: schema,
    init: header => header.agentPreset === CLAUDE_PRESET ? rules.initial() : null,
    apply: rules.apply, wire: { viewSchema: schema, view: state => state } }
}
