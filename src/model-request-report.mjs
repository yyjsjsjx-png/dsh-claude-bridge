import { createHash } from 'node:crypto'

const events = new Set(['perf.model_cycle', 'perf.model_usage', 'perf.model_sdk', 'perf.model_identity'])
const owns = (value, field) => Object.hasOwn(value, field)
const count = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const milliseconds = value => Number.isFinite(value) && value >= 0
const label = value => typeof value === 'string' && /^[a-z][a-z0-9_.:-]{0,100}$/i.test(value)
  && !/^(?:sk-|pk-|bearer|eyJ)/i.test(value) ? value : null
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null
const identity = (value, prefix) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return null
  return new RegExp(`^${prefix}-[a-f0-9]{12}$`).test(value) ? value
    : `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}
const buckets = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
const boundaries = new Set(['query-preparation', 'query', 'tool-results', 'step-prepare'])
const kinds = new Set(['text', 'thinking', 'tool-input', 'tool-name'])

const columns = ['runId', 'responseId', 'turn', 'step', 'requestedModel', 'actualModel', 'requestedEffort',
  ...buckets, 'inputContextTokens', 'totalTokens',
  'hostTtftMs', 'hostTtftQuality', 'hostTtftCode', 'hostDurationMs', 'hostDurationQuality', 'hostDurationCode',
  'startBoundary', 'endBoundary', 'firstOutputKind', 'sdkTtftMs', 'sdkTtftQuality', 'sdkTtftSource',
  'receiveSpanMs', 'receiveSpanQuality', 'receiveOutputTokens', 'tps']

function empty(runId, responseId) {
  return { ...Object.fromEntries(columns.map(name => [name, null])), runId, responseId,
    hostTtftQuality: 'unknown', hostDurationQuality: 'unknown', sdkTtftQuality: 'unknown', receiveSpanQuality: 'unknown' }
}

function hostMetric(row, input, prefix) {
  const known = input.quality === 'precise' && milliseconds(input.durationMs)
  row[`${prefix}Ms`] = known ? input.durationMs : null
  row[`${prefix}Quality`] = known ? 'precise' : 'unknown'
  row[`${prefix}Code`] = known ? null : code(input.code)
}

/** One row per SDK response, never per user submission or cumulative run.
 * Repeated/late snapshots update the same metric in input order, not totals.
 * Host boundaries and SDK estimates remain separate; clocks are never joined. */
export function analyzeModelRequests(sanitizedRows) {
  const responses = new Map()
  for (const input of sanitizedRows) {
    if (!input || !events.has(input.event)) continue
    if (input.event === 'perf.model_cycle' && !['first-output', 'duration'].includes(input.stage)) continue
    if (input.event === 'perf.model_sdk' && !['first-output', 'receive-span'].includes(input.stage)) continue
    const runId = identity(input.runId, 'run'), responseId = identity(input.responseId, 'response')
    if (runId === null || responseId === null) continue
    const key = JSON.stringify([runId, responseId])
    if (!responses.has(key)) responses.set(key, empty(runId, responseId))
    const row = responses.get(key)
    for (const field of ['turn', 'step']) if (count(input[field])) row[field] = input[field]
    if (input.event === 'perf.model_cycle') {
      if (owns(input, 'startBoundary')) row.startBoundary = boundaries.has(input.startBoundary) ? input.startBoundary : null
      if (input.stage === 'first-output') {
        hostMetric(row, input, 'hostTtft')
        if (owns(input, 'kind')) row.firstOutputKind = kinds.has(input.kind) ? input.kind : null
      } else {
        hostMetric(row, input, 'hostDuration')
        if (owns(input, 'endBoundary')) row.endBoundary = input.endBoundary === 'message-stop' ? input.endBoundary : null
      }
    } else if (input.event === 'perf.model_usage') {
      for (const field of buckets) if (owns(input, field)) row[field] = count(input[field]) ? input[field] : null
    } else if (input.event === 'perf.model_identity') {
      if (owns(input, 'model')) row.actualModel = label(input.model)
      if (owns(input, 'requestedModel')) row.requestedModel = label(input.requestedModel)
      if (owns(input, 'effort')) row.requestedEffort = label(input.effort)
    } else if (input.stage === 'first-output') {
      const known = input.quality === 'estimated' && input.source === 'sdk-first-output-estimate' && milliseconds(input.durationMs)
      row.sdkTtftMs = known ? input.durationMs : null
      row.sdkTtftQuality = known ? 'estimated' : 'unknown'
      row.sdkTtftSource = known ? input.source : null
    } else {
      const known = input.quality === 'precise' && input.source === 'sdk-stream-receive' && milliseconds(input.durationMs)
      row.receiveSpanMs = known ? input.durationMs : null
      row.receiveSpanQuality = known ? 'precise' : 'unknown'
      row.receiveOutputTokens = known && count(input.outputTokens) ? input.outputTokens : null
    }
  }
  for (const row of responses.values()) {
    const input = [row.inputTokens, row.cacheReadTokens, row.cacheWriteTokens]
    const context = input.reduce((sum, value) => sum + (value ?? 0), 0)
    row.inputContextTokens = input.every(count) && count(context) ? context : null
    const total = row.inputContextTokens + row.outputTokens
    row.totalTokens = row.inputContextTokens !== null && count(row.outputTokens) && count(total) ? total : null
    const rate = row.receiveOutputTokens * 1000 / row.receiveSpanMs
    row.tps = row.receiveSpanMs > 0 && count(row.receiveOutputTokens) && Number.isFinite(rate) ? rate : null
  }
  return [...responses.values()]
}

/** Fixed columns only; null is an empty CSV cell, never a fabricated zero. */
export function formatModelRequestsCsv(rows) {
  const cell = value => {
    const text = value === null || value === undefined ? '' : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  return [columns.join(','), ...rows.map(row => columns.map(field => cell(row[field])).join(','))].join('\r\n') + '\r\n'
}
