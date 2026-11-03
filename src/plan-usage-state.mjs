import { planUsageFreshUntil } from './plan-usage.mjs'

export const PLAN_USAGE_RETRY_MS = 30_000

/** Plan-usage snapshot cache and in-flight singleflight for one backend. */
export class PlanUsageState {
  constructor() {
    this.cache = undefined
    this.pending = undefined
  }

  isFresh() { return this.cache?.until > Date.now() }

  cachedValue() { return structuredClone(this.cache.value) }

  /** Available snapshots follow their own freshness; others retry soon. */
  store(value) {
    this.cache = { value, until: value.status === 'available' ? planUsageFreshUntil(value) : Date.now() + PLAN_USAGE_RETRY_MS }
  }

  track(pending) { this.pending = pending }

  settle(pending) { if (this.pending === pending) this.pending = undefined }

  /** Drop the cached snapshot; an in-flight read still settles normally. */
  invalidate() { this.cache = undefined }

  /** Connection change: forget the snapshot and the in-flight read. */
  reset() {
    this.cache = undefined
    this.pending = undefined
  }
}
