export const PLAN_USAGE_MAX_AGE_MS = 120_000
const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
const timestamp = value => Number.isSafeInteger(value) && value > 0
const label = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 64
  && !/[\x00-\x1f\x7f]/.test(value)
const scopes = new Set(['session', 'weekly', 'model-weekly', 'extra'])
const unavailableCodes = new Set(['PLAN_LIMITS_UNAVAILABLE', 'SDK_QUOTA_UNAVAILABLE', 'QUOTA_READ_FAILED',
  'CLIENT_UPDATE_REQUIRED', 'SERVER_COMPATIBILITY_INVALID',
  'AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_METHOD_UNSUPPORTED', 'AUTHORIZATION_DENIED', 'ACCOUNT_ON_HOLD',
  'NETWORK', 'RATE_LIMITED', 'CANCELLED', 'CONNECTION_CHANGED'])
const unavailable = code => ({ status: 'unavailable', code })

/** Whitelist the SDK's plan counters; never retain session totals or behaviors. */
export function planUsageSnapshot(reply, observedAt = Date.now()) {
  if (reply?.rate_limits_available !== true || !reply.rate_limits || !timestamp(observedAt)) {
    return unavailable('PLAN_LIMITS_UNAVAILABLE')
  }
  const limits = reply.rate_limits
  const windows = []
  const add = (id, name, scope, value) => {
    if (!percent(value?.utilization)) return
    if (value.resets_at != null && typeof value.resets_at !== 'string') return
    const reset = value.resets_at == null ? null : Date.parse(value.resets_at)
    if (reset !== null && (!timestamp(reset) || reset <= observedAt)) return
    windows.push({ id, name, scope, usedPercent: value.utilization, resetsAt: reset })
  }
  add('five_hour', '5 小时', 'session', limits.five_hour)
  add('seven_day', '周额度', 'weekly', limits.seven_day)
  add('seven_day_oauth_apps', '周额度 · OAuth 应用', 'weekly', limits.seven_day_oauth_apps)
  const scoped = Array.isArray(limits.model_scoped) ? limits.model_scoped.slice(0, 16) : []
  // The pinned SDK 0.3.314 explicitly defines model_scoped as weekly windows.
  for (const [index, value] of scoped.entries()) {
    if (label(value?.display_name)) add(`model_weekly_${index}`, value.display_name.trim(), 'model-weekly', value)
  }
  for (const [id, name] of [['seven_day_opus', 'Opus'], ['seven_day_sonnet', 'Sonnet']]) {
    if (!windows.some(row => row.scope === 'model-weekly' && row.name.toLowerCase() === name.toLowerCase())) {
      add(id, name, 'model-weekly', limits[id])
    }
  }
  if (limits.extra_usage?.is_enabled === true) add('extra_usage', '额外用量', 'extra', limits.extra_usage)
  return windows.length ? { status: 'available', source: 'sdk-plan-usage', observedAt,
    expiresAt: observedAt + PLAN_USAGE_MAX_AGE_MS, windows } : unavailable('PLAN_LIMITS_UNAVAILABLE')
}

/** Validate again at the Host boundary and expire counters at their reset. */
export function sanitizePlanUsage(snapshot, now = Date.now()) {
  if (snapshot?.status === 'unavailable') {
    return unavailable(unavailableCodes.has(snapshot.code) ? snapshot.code : 'QUOTA_READ_FAILED')
  }
  if (snapshot?.status !== 'available' || snapshot.source !== 'sdk-plan-usage'
    || !timestamp(snapshot.observedAt) || snapshot.observedAt > now + 30_000
    || !timestamp(snapshot.expiresAt) || snapshot.expiresAt <= now
    || snapshot.expiresAt > snapshot.observedAt + PLAN_USAGE_MAX_AGE_MS
    || !Array.isArray(snapshot.windows)) return unavailable('PLAN_LIMITS_UNAVAILABLE')
  const seen = new Set()
  const windows = snapshot.windows.slice(0, 24).flatMap(row => {
    if (typeof row?.id !== 'string' || !/^[a-z0-9_]{1,64}$/.test(row.id) || seen.has(row.id)
      || !label(row.name) || !scopes.has(row.scope) || !percent(row.usedPercent)
      || (row.resetsAt !== null && (!timestamp(row.resetsAt) || row.resetsAt <= now))) return []
    seen.add(row.id)
    return [{ id: row.id, name: row.name.trim(), scope: row.scope,
      usedPercent: row.usedPercent, resetsAt: row.resetsAt }]
  })
  return windows.length ? { status: 'available', source: 'sdk-plan-usage', observedAt: snapshot.observedAt,
    expiresAt: snapshot.expiresAt, windows } : unavailable('PLAN_LIMITS_UNAVAILABLE')
}

export function planUsageFreshUntil(snapshot) {
  return snapshot?.status === 'available'
    ? Math.min(snapshot.expiresAt, snapshot.observedAt + 30_000,
      ...snapshot.windows.flatMap(row => row.resetsAt === null ? [] : [row.resetsAt])) : 0
}
