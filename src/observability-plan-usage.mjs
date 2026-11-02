import { sanitizePlanUsage } from './plan-usage.mjs'

const retainMs = 30 * 60_000
/** Freshness differs from retention. Never move the real observation timestamp. */
export function retainedPlanUsage(view, now = Date.now()) {
  const raw = view?.snapshot
  const failure = view?.error ?? (!Object.hasOwn(view ?? {}, 'snapshot') && view?.status === 'unavailable'
    ? { code: view.code, observedAt: now } : null)
  const sampling = { fresh: view?.fresh === true, lastObservedAt: raw?.observedAt ?? null,
    nextAllowedAt: Number.isSafeInteger(view?.nextAllowedAt) ? view.nextAllowedAt : 0,
    error: failure && /^[A-Z][A-Z0-9_]{0,79}$/.test(failure.code)
      ? { code: failure.code, observedAt: failure.observedAt } : null,
    inFlight: view?.inFlight === true }
  sampling.active = view?.active === true
  if (!raw || !Number.isSafeInteger(raw.observedAt) || raw.observedAt > now + 30_000) {
    return { status: 'unavailable', code: sampling.error?.code ?? 'PLAN_LIMITS_UNAVAILABLE', sampling }
  }
  const valid = sanitizePlanUsage(raw, raw.observedAt)
  if (valid.status !== 'available') return { status: 'unavailable', code: 'PLAN_LIMITS_UNAVAILABLE', sampling }
  // Validate at the real observation time. Keep that historical reading even
  // after its display TTL or reset; it is never a claim about today's balance.
  const lastKnown = valid
  const windows = valid.windows.filter(row => row.resetsAt === null || row.resetsAt > now)
  if (now >= raw.observedAt + retainMs || !windows.length) {
    return { status: 'unavailable', code: sampling.error?.code ?? 'PLAN_LIMITS_UNAVAILABLE',
      sampling: { ...sampling, fresh: false }, lastKnown }
  }
  return { ...valid, windows, expiresAt: raw.observedAt + retainMs, lastKnown,
    sampling: { ...sampling, fresh: sampling.fresh && now < raw.expiresAt && now < raw.observedAt + 120_000 } }
}
