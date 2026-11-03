import { MODEL_CATALOG_CACHE_MS } from './catalog-cache-policy.mjs'

export const DISPLAY_CATALOG_RETRY_MS = 30_000

/**
 * Account model catalog state owned by one backend: the execution-freshness
 * cache, the in-flight singleflight and the authentication generation fence.
 * It holds no I/O; callers keep their own await boundaries and settle order.
 */
export class ModelCatalogState {
  constructor() {
    this.generation = 0
    this.cache = undefined
    this.pending = undefined
    this.pendingRefresh = undefined
    this.pendingContext = undefined
  }

  /** Whether the cached reply may still answer a non-refresh read. */
  isFresh() {
    return Boolean(this.cache && Date.now() - this.cache.time < MODEL_CATALOG_CACHE_MS)
  }

  cachedReply() { return structuredClone(this.cache.reply) }

  store(reply) { this.cache = { time: Date.now(), reply: structuredClone(reply) } }

  /** Drop the cached catalog; in-flight reads keep their own generation. */
  invalidate() { this.cache = undefined }

  /** A new read token bound to the current authentication generation. */
  request() { return { generation: this.generation } }

  isCurrent(request) { return request.generation === this.generation }

  /** A pending read of the current generation that new callers may join. */
  joinable() { return Boolean(this.pending) && this.pendingContext?.generation === this.generation }

  track(pending, refresh, request) {
    this.pending = pending
    this.pendingRefresh = refresh
    this.pendingContext = request
  }

  settle(pending) {
    if (this.pending === pending) this.pending = this.pendingRefresh = this.pendingContext = undefined
  }

  /**
   * A completed login recheck fences every read already in flight. Only the
   * explicit refresh request that owns the recheck adopts the new generation.
   */
  fence(owner) {
    this.generation++
    this.cache = undefined
    if (owner && this.pendingContext === owner) owner.generation = this.generation
  }

  /** Connection change: forget cache and pending reads; the generation stays. */
  reset() {
    this.cache = undefined
    this.pending = undefined
    this.pendingRefresh = undefined
    this.pendingContext = undefined
  }
}

/** Advisory display-catalog state: identity singleflight, detached refresh and status. */
export class DisplayCatalogState {
  constructor() {
    this.identityPending = undefined
    this.refreshPending = undefined
    this.refreshAfter = undefined
    this.status = undefined
  }

  /** A detached refresh is running or still inside its retry delay. */
  refreshBlocked() {
    return Boolean(this.refreshPending) || Date.now() < (this.refreshAfter ?? 0)
  }

  trackRefresh(pending) { this.refreshPending = pending }

  settleRefresh(pending) {
    if (this.refreshPending === pending) {
      this.refreshPending = undefined
      this.refreshAfter = Date.now() + DISPLAY_CATALOG_RETRY_MS
    }
  }

  trackIdentity(pending) { this.identityPending = pending }

  settleIdentity(pending) {
    if (this.identityPending === pending) this.identityPending = undefined
  }

  reset() {
    this.identityPending = undefined
    this.refreshPending = undefined
    this.refreshAfter = 0
    this.status = undefined
  }
}
