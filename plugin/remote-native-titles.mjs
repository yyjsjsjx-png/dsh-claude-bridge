import { CLAUDE_PRESET } from './policy.mjs'

/** Display SDK-owned titles. This module never schedules title inference. */
export function installRemoteNativeTitles(ctx, { normalizeSessionTitle, report = () => {} }) {
  const service = ctx.sessionTitle
  const diagnose = code => { try { report(code) } catch {} }
  if (typeof service?.get !== 'function' || typeof service.onUserMessage !== 'function'
    || typeof service.ensureFallback !== 'function') {
    diagnose('TITLE_NATIVE_UNAVAILABLE')
    return { sync: () => false, dispose() {} }
  }
  // Cordis wraps function getters with a new shadow proxy on each access.
  // Its public original symbol identifies this service instance for reversible
  // method assignment; normal service calls keep their traced context.
  const owner = service[Symbol.for('cordis.original')] ?? service
  let disposed = false
  const remote = session => session?.header?.agentPreset === CLAUDE_PRESET
  const live = session => !disposed && ctx.sessions.get(session.id) === session
  const originalInput = owner.onUserMessage
  const input = function(...args) {
    const [session, event] = args
    if (!remote(session)) return originalInput.apply(this, args)
    if (event.data.source?.kind === 'user') {
      void Promise.resolve().then(() => live(session) && service.ensureFallback(session))
        .catch(() => diagnose('TITLE_FALLBACK_FAILED'))
    }
  }
  const originalRefresh = owner.refresh
  const originalHeader = owner.onRequestHeader
  const originalMain = owner.onMainRequest
  const header = function(...args) {
    // A remote first prompt may have queued native work before installation.
    // Keep later headers from launching that old global-provider request.
    if (!remote(args[0])) return originalHeader.apply(this, args)
  }
  const main = function(...args) {
    if (!remote(ctx.sessions.get(args[0]?.sessionId))) return originalMain.apply(this, args)
  }
  const refresh = function(...args) {
    const [session, signal] = args
    if (!remote(session)) return originalRefresh.apply(this, args)
    // Remote titles come only from SDK query metadata. Do not unpin a user
    // title or invoke the global DSH title provider from this explicit API.
    return (async () => {
      signal?.throwIfAborted()
      if (!live(session)) return service.get(session)
      await service.ensureFallback(session)
      signal?.throwIfAborted()
      return service.get(session)
    })()
  }
  owner.onUserMessage = input
  if (typeof originalHeader === 'function') owner.onRequestHeader = header
  if (typeof originalMain === 'function') owner.onMainRequest = main
  if (typeof originalRefresh === 'function') owner.refresh = refresh
  if (typeof normalizeSessionTitle !== 'function') diagnose('TITLE_NATIVE_UNAVAILABLE')
  return {
    sync(session, value) {
      if (!remote(session) || !live(session) || value === undefined) return false
      try {
        if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096
          || typeof normalizeSessionTitle !== 'function') {
          diagnose('SDK_TITLE_INVALID'); return false
        }
        if (service.get(session)?.source.kind === 'user') return false
        const maxBytes = Number.isSafeInteger(service.config?.maxTitleBytes) && service.config.maxTitleBytes > 0
          ? service.config.maxTitleBytes : 80
        const title = normalizeSessionTitle(value, maxBytes)
        if (!title) { diagnose('SDK_TITLE_INVALID'); return false }
        const first = ctx.sessionProjections.stateOf(session, 'titleInput')?.first
        if (!first || !Number.isSafeInteger(first.seq)) return false
        const current = service.get(session)
        if (current?.source.kind === 'user' || current?.title === title) return false
        session.append('session/title', { title, messageSeqs: [first.seq], source: {
          kind: 'provider', provider: 'claude-bridge-sdk-title',
        } })
        return true
      } catch { diagnose('SDK_TITLE_SYNC_FAILED'); return false }
    },
    dispose() {
      disposed = true
      if (owner.onUserMessage === input) owner.onUserMessage = originalInput
      if (owner.onRequestHeader === header) owner.onRequestHeader = originalHeader
      if (owner.onMainRequest === main) owner.onMainRequest = originalMain
      if (owner.refresh === refresh) owner.refresh = originalRefresh
    },
  }
}
