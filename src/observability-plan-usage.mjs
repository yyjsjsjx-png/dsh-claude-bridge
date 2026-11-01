import { sanitizePlanUsage } from './plan-usage.mjs'

const retainMs = 30 * 60_000
/** Freshness differs from retention. Never move the real observation timestamp. */
export function retainedPlanUsage(view, now = Date.now()) {
  const raw = view?.snapshot
  const sampling = { fresh: view?.fresh === true, lastObservedAt: raw?.observedAt ?? null,
    nextAllowedAt: Number.isSafeInteger(view?.nextAllowedAt) ? view.nextAllowedAt : 0,
    error: view?.error && /^[A-Z][A-Z0-9_]{0,79}$/.test(view.error.code)
      ? { code: view.error.code, observedAt: view.error.observedAt } : null,
    inFlight: view?.inFlight === true }
  if (!raw || !Number.isSafeInteger(raw.observedAt) || raw.observedAt > now + 30_000 || now >= raw.observedAt + retainMs) {
    return { status: 'unavailable', code: sampling.error?.code ?? 'PLAN_LIMITS_UNAVAILABLE', sampling }
  }
  const valid = sanitizePlanUsage(raw, raw.observedAt)
  if (valid.status !== 'available') return { status: 'unavailable', code: 'PLAN_LIMITS_UNAVAILABLE', sampling }
  const windows = valid.windows.filter(row => row.resetsAt === null || row.resetsAt > now)
  if (!windows.length) return { status: 'unavailable', code: 'PLAN_LIMITS_UNAVAILABLE', sampling }
  return { ...valid, windows, expiresAt: raw.observedAt + retainMs,
    sampling: { ...sampling, fresh: sampling.fresh && now < raw.expiresAt && now < raw.observedAt + 120_000 } }
}
