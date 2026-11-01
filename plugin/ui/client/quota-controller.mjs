/** Own plan-usage requests, pause states, backoff and connection revisions. */
export function createQuotaController({ rpc, createStore, isBusy = () => false, onAuthenticationRequired = () => {} }) {
  const UNKNOWN_QUOTA = { status: 'unavailable', windows: [], refreshing: false, nextRefreshAt: 0, minimumClientVersion: null };
  const store = createStore(UNKNOWN_QUOTA);
  const quotaAuthCodes = new Set(['AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_METHOD_UNSUPPORTED',
    'AUTHORIZATION_DENIED', 'ACCOUNT_ON_HOLD']);
  const quotaVersionCodes = new Set(['CLIENT_UPDATE_REQUIRED', 'SERVER_COMPATIBILITY_INVALID']);
  let disposed = false;
  let quotaRequest;
  let quotaGeneration = 0;
  let quotaLastAttemptAt = 0;
  let quotaFailures = 0;
  let quotaRetryAt = 0;

  function readPlanUsage(reason = 'poll') {
    if (disposed || isBusy()) return Promise.resolve();
    const now = Date.now();
    const previous = store.getSnapshot();
    const manual = reason === 'manual';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (!['auth', 'unsupported', 'version'].includes(previous.paused)
        && (previous.paused !== 'offline' || previous.nextRefreshAt)) {
        store.set({ ...previous, paused: 'offline', nextRefreshAt: 0 });
      }
      return Promise.resolve();
    }
    if (!manual && (typeof document !== 'undefined' && document.hidden
      || ['auth', 'unsupported', 'version'].includes(previous.paused))) return Promise.resolve();
    if (quotaRequest) return quotaRequest;
    if (previous.paused === 'offline') store.set({ ...previous, paused: undefined });
    if (reason === 'online') quotaRetryAt = 0;
    // New servers own the account-wide sampling gate. A manual click must not
    // turn a retained cache snapshot into another upstream quota request.
    const nextAllowedAt = previous.sampling?.nextAllowedAt;
    if (Number.isFinite(nextAllowedAt) && nextAllowedAt > now) {
      if (previous.nextRefreshAt !== nextAllowedAt) {
        store.set({ ...store.getSnapshot(), nextRefreshAt: nextAllowedAt });
      }
      return Promise.resolve();
    }
    if (!manual && ['open', 'visible', 'online'].includes(reason) && previous.status === 'available'
      && previous.expiresAt > now && now - previous.observedAt < 30_000
      && previous.windows.every(row => row.resetsAt === null || row.resetsAt > now)) return Promise.resolve();
    const earliest = manual ? now : Math.max(quotaLastAttemptAt + 30_000,
      reason === 'reset' || previous.status !== 'available' ? 0 : previous.observedAt + 30_000,
      quotaRetryAt);
    if (earliest > now) {
      if (['activity', 'online', 'reset'].includes(reason) || previous.status !== 'available') {
        const queued = previous.nextRefreshAt > now ? Math.min(previous.nextRefreshAt, earliest) : earliest;
        if (queued !== previous.nextRefreshAt) store.set({ ...previous, nextRefreshAt: queued });
      }
      return Promise.resolve();
    }
    const revision = quotaGeneration;
    quotaLastAttemptAt = now;
    store.set({ ...previous, refreshing: true, paused: undefined, nextRefreshAt: 0 });
    const request = (async () => {
      let value;
      try {
        const response = await rpc.planUsage(manual);
        value = response.ok && response.value ? response.value
          : { ...UNKNOWN_QUOTA, code: response.error?.code ?? 'QUOTA_READ_FAILED' };
      } catch { value = { ...UNKNOWN_QUOTA, code: 'QUOTA_READ_FAILED' }; }
      if (disposed || revision !== quotaGeneration) return;
      if (value.status === 'available') {
        quotaFailures = 0; quotaRetryAt = 0;
        const nextAllowedAt = value.sampling?.nextAllowedAt;
        store.set({ ...value, refreshing: false,
          nextRefreshAt: Number.isFinite(nextAllowedAt) && nextAllowedAt > Date.now() ? nextAllowedAt : 0 });
        return;
      }
      const paused = quotaAuthCodes.has(value.code) ? 'auth'
        : value.code === 'SDK_QUOTA_UNAVAILABLE' ? 'unsupported'
          : quotaVersionCodes.has(value.code) ? 'version' : undefined;
      if (paused) {
        quotaRetryAt = 0;
        store.set({ ...UNKNOWN_QUOTA, code: value.code, paused,
          ...(value.sampling ? { sampling: value.sampling } : {}),
          ...(paused === 'version' ? { minimumClientVersion: value.minimumClientVersion ?? null } : {}) });
        if (paused === 'auth') onAuthenticationRequired();
      } else {
        quotaFailures++;
        quotaRetryAt = Date.now() + [60_000, 120_000, 300_000][Math.min(quotaFailures - 1, 2)];
        // A reply with no usable plan windows supersedes the old counters.
        // Transient transport failures may keep a still-fresh snapshot.
        store.set({ ...(previous.status === 'available' && value.code !== 'PLAN_LIMITS_UNAVAILABLE' ? previous : UNKNOWN_QUOTA),
          ...(value.sampling ? { sampling: value.sampling } : {}),
          code: value.code, refreshing: false, paused: undefined,
          nextRefreshAt: Math.max(quotaRetryAt, Number.isFinite(value.sampling?.nextAllowedAt) ? value.sampling.nextAllowedAt : 0) });
      }
    })();
    quotaRequest = request;
    void request.finally(() => { if (quotaRequest === request) quotaRequest = undefined; });
    return request;
  }

  function reset() {
    quotaGeneration++;
    quotaRequest = undefined;
    quotaLastAttemptAt = 0; quotaFailures = 0; quotaRetryAt = 0;
    store.set(UNKNOWN_QUOTA);
  }

  function dispose() {
    disposed = true;
    quotaGeneration++;
    quotaRequest = undefined;
  }

  return { store, readPlanUsage, reset, dispose };
}
