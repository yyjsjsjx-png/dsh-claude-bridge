import { CLAUDE_PRESET, CLAUDE_PROVIDER } from '../plugin/policy.mjs'
export { contextSnapshot } from './context-usage.mjs'

export const SESSION_STATUS_RECORD = 'plugin:claude-bridge/state'

export function initialSessionStatus(model = null) {
  return { version: 1, model, runId: null, phase: 'idle', context: { status: 'unknown' },
    compatibility: null, toolMayHaveExecuted: false, updatedAt: Date.now() }
}

/** Keep a session's last observation without presenting it as a fresh reading. */
export function reconcileSessionStatus(previous, next) {
  let value = next
  if (previous?.model === next.model && previous?.context?.status === 'known'
    && next.context.status === 'unknown') {
    value = { ...value, context: previous.context }
  }
  // Starting a retry does not establish that the last failure was resolved.
  // A ready snapshot replaces recovery wholesale and clears the old code.
  if (['syncing', 'waiting'].includes(next.recovery?.status)
    && !next.recovery.code && previous?.recovery?.code) {
    value = { ...value, recovery: { ...next.recovery, code: previous.recovery.code } }
  }
  return value
}

/** A log-only, replayable whole snapshot; it never changes model-facing history. */
export function createSessionStatusProjection(z) {
  const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  const context = z.discriminatedUnion('status', [
    z.object({ status: z.literal('unknown') }).strict(),
    z.object({ status: z.literal('known'), source: z.literal('sdk-summary-approximate'),
      totalTokens: tokens, maxTokens: tokens.positive(), rawMaxTokens: tokens.positive().optional(),
      percentage: z.number().finite().nonnegative(), observedAt: tokens,
      categories: z.array(z.object({ id: z.string(), name: z.string(), tokens,
        kind: z.enum(['used', 'free', 'buffer', 'deferred']) }).strict()).max(32),
    }).strict(),
  ])
  const schema = z.object({
    version: z.literal(1), model: z.string().nullable(), runId: z.string().nullable(),
    phase: z.enum(['idle', 'running', 'stopping', 'stopped', 'completed', 'failed', 'unknown', 'compacting']),
    connection: z.enum(['connected', 'reconnecting', 'disconnected']).optional(),
    recovery: z.object({
      status: z.enum(['syncing', 'waiting', 'ready', 'unavailable']),
      added: tokens, unresolvedTools: tokens, interrupted: z.boolean(), updatedAt: tokens,
      code: z.string().regex(/^[A-Z0-9_]{1,80}$/).optional(),
    }).strict().optional(),
    context, compatibility: z.object({ model: z.string(), version: z.literal(1),
      tools: z.array(z.object({ name: z.string(), status: z.string(), reason: z.string() }).strict()),
    }).strict().nullable(),
    toolMayHaveExecuted: z.boolean(), updatedAt: tokens,
  }).strict().nullable()
  return { key: 'claudeBridge', stateVersion: 1, stateSchema: schema,
    init: header => header.agentPreset === CLAUDE_PRESET ? initialSessionStatus() : null,
    apply: (state, event) => {
      if (state === null) return state
      if (event.type === SESSION_STATUS_RECORD && event.ignorable === true) {
        return reconcileSessionStatus(state, schema.parse(event.data))
      }
      if (event.type === 'model/selection' && event.data.provider === CLAUDE_PROVIDER
        && event.data.model !== state.model) {
        return { ...state, model: event.data.model, context: { status: 'unknown' }, compatibility: null, updatedAt: event.time }
      }
      return state
    },
    wire: { viewSchema: schema, view: state => state } }
}
