import { COMPACTION_RECORD, COMPACTION_SUMMARY_RECORD, normalizeSummary } from './compaction-summary.mjs'

const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  && !['constructor', 'prototype'].includes(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const trigger = value => ['auto', 'manual'].includes(value) ? value : 'unknown'
const eventsOf = session => session.snapshotEvents()
const keyOf = value => `${value.runId}:${value.completedAt}`
const legacyKey = value => count(value.preTokens) ? `${value.trigger}:${value.preTokens}` : undefined

/** Persist native summary evidence once; a late missing/conflicting result cannot erase known text. */
export function appendCompactionSummary(session, value, helpers) {
  if (!id(value?.boundaryUuid)) return 0
  let summary = normalizeSummary(value.summary)
  const source = value.source === 'native-transcript' ? 'native-transcript' : 'sdk-postcompact'
  const prior = eventsOf(session).findLast(event => event.type === COMPACTION_SUMMARY_RECORD
    && event.ignorable === true && event.data.boundaryUuid === value.boundaryUuid)?.data
  const previousSource = prior?.source ?? 'sdk-postcompact'
  const conflictingTrigger = prior && previousSource === source && trigger(prior.trigger) !== 'unknown'
    && trigger(value.trigger) !== 'unknown' && prior.trigger !== value.trigger
  if (conflictingTrigger) summary = { status: 'unavailable', code: 'SUMMARY_CONFLICT' }
  if (prior?.summary?.code === 'SUMMARY_CONFLICT'
    && !(previousSource === 'native-transcript' && source === 'sdk-postcompact' && summary.status === 'available')) return 0
  if (prior?.summary?.status === 'available') {
    if (previousSource === 'sdk-postcompact' && source === 'native-transcript') return 0
    if (summary.status !== 'available' && summary.code !== 'SUMMARY_CONFLICT') return 0
    if (summary.status === 'available' && summary.text !== prior.summary.text
      && previousSource === source) summary = { status: 'unavailable', code: 'SUMMARY_CONFLICT' }
    else if (summary.status === 'available' && previousSource === source) return 0
  }
  const data = { version: 1, boundaryUuid: value.boundaryUuid, trigger: trigger(value.trigger), source, summary }
  for (const name of ['runId', 'completedAt', 'anchorSeq']) {
    if (name === 'runId' ? typeof value[name] === 'string' : count(value[name])) data[name] = value[name]
  }
  if (prior && JSON.stringify(prior) === JSON.stringify(data)) return 0
  helpers.appendPluginRecord(session, COMPACTION_SUMMARY_RECORD, data)
  return 1
}

function localMarkers(session) {
  const markers = new Map()
  const events = eventsOf(session)
  for (const event of events) {
    if (event.ignorable !== true) continue
    const data = event.type === COMPACTION_RECORD ? event.data
      : event.type === 'plugin:claude-bridge/progress' && event.data?.compaction?.status === 'completed'
        && count(event.data.compaction.preTokens) ? { runId: event.data.runId, ...event.data.compaction } : undefined
    if (!data || typeof data.runId !== 'string' || !count(data.completedAt)) continue
    const key = keyOf(data)
    const existing = markers.get(key)
    if (!existing) markers.set(key, { ...data, anchorSeq: event.seq })
    else if (id(data.boundaryUuid)) existing.boundaryUuid = data.boundaryUuid
  }
  // A successful legacy recovery persists its exact locator in the summary
  // record. Reuse that evidence even if later cycles make numeric matching ambiguous.
  for (const event of events) {
    const data = event.data
    if (event.type !== COMPACTION_SUMMARY_RECORD || event.ignorable !== true || !id(data?.boundaryUuid)) continue
    const marker = markers.get(keyOf(data))
    if (marker && marker.anchorSeq === data.anchorSeq && !marker.boundaryUuid) marker.boundaryUuid = data.boundaryUuid
  }
  return [...markers.values()]
}

/** Recover only verified native boundaries; legacy numeric links require uniqueness on both sides. */
export function restoreCompactionSummaries(session, records, helpers) {
  const valid = records.filter(value => id(value?.boundaryUuid))
  const local = localMarkers(session)
  const counts = values => {
    const result = new Map()
    for (const value of values) { const key = legacyKey(value); if (key) result.set(key, (result.get(key) ?? 0) + 1) }
    return result
  }
  const localCounts = counts(local), cloudCounts = counts(valid)
  let added = 0
  for (const record of valid) {
    const keyed = legacyKey(record)
    let marker = local.find(value => value.boundaryUuid === record.boundaryUuid)
    if (!marker && keyed && localCounts.get(keyed) === 1 && cloudCounts.get(keyed) === 1) {
      marker = local.find(value => !value.boundaryUuid && legacyKey(value) === keyed)
    }
    if (!marker) {
      // A real boundary with no local positional evidence is visibly a historical
      // addition, never presented as an accurately reconstructed transcript location.
      const data = { version: 1, boundaryUuid: record.boundaryUuid, runId: `history:${record.boundaryUuid}`,
        completedAt: count(record.completedAt) ? record.completedAt : 0, trigger: trigger(record.trigger), recovered: true }
      for (const name of ['preTokens', 'postTokens', 'durationMs']) if (count(record[name])) data[name] = record[name]
      const seq = helpers.appendPluginRecord(session, COMPACTION_RECORD, data)
      marker = { ...data, anchorSeq: seq }
      local.push(marker)
      added++
    }
    added += appendCompactionSummary(session, { ...record, source: 'native-transcript', runId: marker.runId,
      completedAt: marker.completedAt, anchorSeq: marker.anchorSeq }, helpers)
  }
  return added
}

/** Cache only native snapshot cursors in memory; summary bodies remain in the DSH event store. */
export function createCompactionRecovery(helpers) {
  const cursors = new WeakMap()
  return { async sync({ session, binding, transport, signal }) {
    const cached = cursors.get(session)
    let cursor = cached?.transport === transport ? cached.cursor : undefined
    const records = [], seen = new Set()
    let bytes = 0, finished = false, resets = 0
    for (let page = 0; page < 1024; page++) {
      signal.throwIfAborted()
      const response = await transport.peer.request('compaction.history', { deviceId: binding.deviceId,
        dshSessionId: session.id, sessionId: binding.sdkSessionId, projectPath: binding.projectPath,
        ...(cursor ? { cursor } : {}) }, { signal, timeoutMs: 30_000 })
      if (response.status === 'busy') return 0
      if (response.status === 'cursor-reset' && resets++ === 0) {
        cursor = undefined; records.length = 0; seen.clear(); bytes = 0; continue
      }
      if (response.status !== 'ok' || !Array.isArray(response.records) || response.sessionId !== binding.sdkSessionId) {
        throw Object.assign(new Error('原生压缩摘要暂时无法回补。'), { code: 'COMPACTION_HISTORY_UNAVAILABLE' })
      }
      bytes += Buffer.byteLength(JSON.stringify(response.records))
      if (bytes > 32 * 1024 * 1024) throw Object.assign(new Error('压缩摘要恢复超出本次上限。'), { code: 'COMPACTION_HISTORY_TOO_LARGE' })
      for (const record of response.records) if (!seen.has(record.boundaryUuid)) { seen.add(record.boundaryUuid); records.push(record) }
      const next = response.nextCursor
      if (!response.done && (!next || JSON.stringify(cursor) === JSON.stringify(next))) {
        throw Object.assign(new Error('压缩摘要分页未推进。'), { code: 'COMPACTION_HISTORY_INVALID' })
      }
      cursor = next
      if (response.done === true) { finished = true; break }
    }
    if (!finished) throw Object.assign(new Error('压缩摘要分页超出上限。'), { code: 'COMPACTION_HISTORY_TOO_LARGE' })
    signal.throwIfAborted()
    const added = restoreCompactionSummaries(session, records, helpers)
    cursors.set(session, { transport, cursor })
    return added
  } }
}
