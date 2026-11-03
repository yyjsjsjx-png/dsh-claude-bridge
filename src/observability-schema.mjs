import { sanitizePlanUsage } from './plan-usage.mjs'

export const OBSERVABILITY_SCHEMA_VERSION = 1
export const OBSERVABILITY_MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000
const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000
const buckets = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
const quotaCodes = new Set(['PLAN_LIMITS_UNAVAILABLE', 'SDK_QUOTA_UNAVAILABLE', 'QUOTA_READ_FAILED',
  'AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_METHOD_UNSUPPORTED', 'AUTHORIZATION_DENIED', 'ACCOUNT_ON_HOLD',
  'NETWORK', 'RATE_LIMITED', 'CANCELLED', 'CONNECTION_CHANGED', 'QUOTA_TIMEOUT', 'QUOTA_CLOSED', 'QUOTA_STALE_OBSERVATION',
  'QUOTA_ACCOUNT_BOUNDARY'])
/** Failure rows after which an earlier snapshot can no longer be attributed to the current login. */
export const QUOTA_ACCOUNT_BOUNDARY_CODES = Object.freeze(['QUOTA_ACCOUNT_BOUNDARY', 'AUTH_REQUIRED', 'AUTH_EXPIRED',
  'AUTH_METHOD_UNSUPPORTED', 'AUTHORIZATION_DENIED', 'ACCOUNT_ON_HOLD'])
const common = ['version', 'deviceId', 'dshSessionId', 'sdkSessionId', 'runId', 'model', 'observedAt']
const invalid = () => { throw new TypeError('OBSERVABILITY_INVALID_RECORD') }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@+\[\]-]{0,255}$/.test(value)
  && !/^(?:sk-|pk-|Bearer|eyJ)/i.test(value)
const code = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
const timestamp = value => integer(value) && value > 0
const choose = (value, choices) => choices.includes(value) ? value : invalid()

function shape(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid()
}

function base(input) {
  if (input.version !== OBSERVABILITY_SCHEMA_VERSION || !timestamp(input.observedAt)) invalid()
  const result = { version: OBSERVABILITY_SCHEMA_VERSION, observedAt: input.observedAt }
  for (const field of ['deviceId', 'dshSessionId', 'sdkSessionId', 'runId', 'model']) {
    if (!identity(input[field])) invalid()
    result[field] = input[field]
  }
  return result
}

function usage(input, scope) {
  if (input == null) return undefined
  shape(input, ['scope', ...buckets])
  if (input.scope !== scope || buckets.some(key => !integer(input[key]))) invalid()
  return { scope, ...Object.fromEntries(buckets.map(key => [key, input[key]])) }
}

/** Keep an old observation intact without pretending that it is still fresh. */
export function normalizeObservedQuota(input) {
  if (!object(input) || !timestamp(input.observedAt)) return undefined
  const snapshot = sanitizePlanUsage(input, input.observedAt)
  if (snapshot.status !== 'available') return undefined
  const windows = snapshot.windows.filter(row => !/[\\/@\x00-\x1f]/.test(row.name) && !row.name.includes('://'))
  return windows.length ? { ...snapshot, windows } : undefined
}

export function quotaFailureCode(value) { return quotaCodes.has(value) ? value : 'QUOTA_READ_FAILED' }

/** These records accept numerical metadata only, not arbitrary SDK messages. */
export function normalizeObservabilityRecord(kind, input) {
  if (kind === 'quota') {
    shape(input, ['version', 'observationId', 'observedAt', 'reason', 'status', 'snapshot', 'code', 'retryAfterMs'])
    if (input.version !== 1 || !identity(input.observationId) || !timestamp(input.observedAt)) invalid()
    const result = { version: 1, observationId: input.observationId, observedAt: input.observedAt,
      reason: choose(input.reason, ['manual', 'run-start', 'run-end', 'activity', 'account-boundary']),
      status: choose(input.status, ['available', 'unavailable']) }
    if (result.status === 'available') {
      const snapshot = normalizeObservedQuota(input.snapshot)
      if (!snapshot || input.code !== undefined || input.retryAfterMs !== undefined) invalid()
      result.snapshot = snapshot
    } else {
      if (input.snapshot != null) invalid()
      result.code = quotaFailureCode(input.code)
      if (input.retryAfterMs !== undefined) {
        if (!integer(input.retryAfterMs) || input.retryAfterMs > 24 * 60 * 60 * 1000) invalid()
        result.retryAfterMs = input.retryAfterMs
      }
    }
    return result
  }
  if (kind === 'runs') {
    shape(input, [...common, 'kind', 'status', 'startedAt', 'finishedAt', 'usage', 'cumulativeCostUsd', 'costScope'])
    const result = { ...base(input), kind: choose(input.kind, ['query', 'compact']),
      status: choose(input.status, ['completed', 'failed', 'cancelled', 'unknown']) }
    for (const field of ['startedAt', 'finishedAt']) if (input[field] != null) {
      if (!timestamp(input[field])) invalid()
      result[field] = input[field]
    }
    if (result.startedAt !== undefined && result.finishedAt !== undefined && result.finishedAt < result.startedAt) invalid()
    const observed = usage(input.usage, 'current-turn-main-agent')
    if (observed) result.usage = observed
    if (input.cumulativeCostUsd != null) {
      if (!finite(input.cumulativeCostUsd) || input.costScope !== 'session-cumulative-estimate') invalid()
      result.cumulativeCostUsd = input.cumulativeCostUsd
      result.costScope = input.costScope
    } else if (input.costScope !== undefined) invalid()
    return result
  }
  if (kind === 'responses') {
    shape(input, [...common, 'responseId', 'usage'])
    if (!identity(input.responseId)) invalid()
    const result = { ...base(input), responseId: input.responseId }
    const observed = usage(input.usage, 'response-main-agent')
    if (observed) result.usage = observed
    return result
  }
  if (kind === 'timing') {
    shape(input, [...common, 'responseId', 'level', 'side', 'metric', 'quality', 'clock', 'source',
      'durationMs', 'outputTokens', 'reason'])
    const result = { ...base(input), level: choose(input.level, ['run', 'response']),
      side: choose(input.side, ['local', 'upstream']), metric: choose(input.metric, ['first-output', 'duration', 'receive-rate']),
      quality: choose(input.quality, ['precise', 'estimate', 'unknown']),
      clock: choose(input.clock, ['local-monotonic', 'remote-monotonic', 'upstream-duration', 'unknown']) }
    if (typeof input.source !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.source)) invalid()
    result.source = input.source
    if (result.level === 'response') {
      if (!identity(input.responseId)) invalid()
      result.responseId = input.responseId
    } else if (input.responseId !== undefined) invalid()
    if (input.reason !== undefined) {
      if (!code(input.reason)) invalid()
      result.reason = input.reason
    }
    if (result.quality === 'unknown') {
      if (input.durationMs !== undefined || input.outputTokens !== undefined) invalid()
    } else {
      if (!finite(input.durationMs) || input.durationMs > Number.MAX_SAFE_INTEGER || result.clock === 'unknown') invalid()
      result.durationMs = input.durationMs
      if (result.metric === 'receive-rate') {
        if (input.durationMs <= 0 || !integer(input.outputTokens) || input.outputTokens === 0) invalid()
        result.outputTokens = input.outputTokens
      } else if (input.outputTokens !== undefined) invalid()
    }
    return result
  }
  invalid()
}

/** A bounded local read, never a SQL or upstream-execution interface. */
export function normalizeObservabilityFilters(input = {}, { now = Date.now(), summary = false } = {}) {
  const allowed = ['from', 'to', 'deviceId', 'model', ...(summary ? ['groupBy'] : ['kind', 'limit'])]
  try {
    shape(input, allowed)
    const to = input.to ?? now
    const from = input.from ?? Math.max(0, to - DEFAULT_RANGE_MS)
    if (!integer(from) || !timestamp(to) || from >= to || to - from > OBSERVABILITY_MAX_RANGE_MS) invalid()
    const result = { from, to }
    for (const field of ['deviceId', 'model']) if (input[field] !== undefined) {
      if (!identity(input[field])) invalid()
      result[field] = input[field]
    }
    if (summary) result.groupBy = choose(input.groupBy ?? 'none', ['none', 'day', 'model', 'device'])
    else {
      result.kind = choose(input.kind ?? 'runs', ['runs', 'responses', 'timing', 'quota'])
      if (!integer(input.limit ?? 100) || (input.limit ?? 100) < 1 || (input.limit ?? 100) > 500) invalid()
      result.limit = input.limit ?? 100
      if (result.kind === 'quota' && (result.deviceId !== undefined || result.model !== undefined)) invalid()
    }
    return result
  } catch {
    throw new TypeError('OBSERVABILITY_INVALID_FILTER')
  }
}
