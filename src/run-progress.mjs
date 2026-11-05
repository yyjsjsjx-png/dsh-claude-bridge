import { CLAUDE_PRESET, CLAUDE_PROVIDER } from '../plugin/policy.mjs'
import { contextSnapshot } from './context-usage.mjs'

// Separate ignorable records keep the existing v1 status readable by older clients.
export const RUN_PROGRESS_RECORD = 'plugin:claude-bridge/progress'
const count = value => Number.isSafeInteger(value) && value >= 0
const CONTEXT_ERRORS = ['CONTEXT_SUMMARY_TIMEOUT', 'CONTEXT_SUMMARY_UNAVAILABLE']

export function initialRunProgress(model = null, runId = null) {
  return { version: 1, model, runId, compaction: null, contextUpdate: null }
}

/** Display-only progress; never injects messages into the SDK or model history. */
export function createRunProgressReporter({ runId, model, isActive, readStatus,
  writeStatus, writeProgress, now = Date.now }) {
  let closed = false
  let state = initialRunProgress(model, runId)
  const write = patch => {
    state = { ...state, ...patch }
    writeProgress(state)
  }
  const resume = () => {
    if (readStatus()?.phase === 'compacting') writeStatus({ phase: 'running' })
  }
  return {
    start() { writeProgress(state) },
    accept(event) {
      if (closed || !isActive()) return
      const current = readStatus()
      if (current?.runId !== runId || current.model !== model
        || !['running', 'compacting'].includes(current.phase)) return
      if (event.type === 'context') {
        if (CONTEXT_ERRORS.includes(event.code)) {
          write({ contextUpdate: { status: 'unavailable', code: event.code, observedAt: now() } })
          return
        }
        // A compaction boundary owns context changes while compaction is running.
        if (current.phase === 'compacting') return
        const observedAt = count(event.observedAt) ? event.observedAt : now()
        if (state.contextUpdate?.status === 'updated' && state.contextUpdate.observedAt > observedAt) return
        const context = contextSnapshot(event.context, observedAt)
        if (context.status !== 'known') return
        writeStatus({ context })
        write({ contextUpdate: { status: 'updated', observedAt } })
      } else if (event.type === 'status') {
        if (event.status === 'compacting') {
          if (state.compaction?.status === 'running') return
          write({ compaction: { trigger: 'auto', status: 'running', startedAt: now() } })
          writeStatus({ phase: 'compacting' })
        } else if (event.status === null && state.compaction?.status === 'running') {
          write({ compaction: { ...state.compaction, status: 'completed', completedAt: now() } })
          resume()
        }
      } else if (event.type === 'compact-boundary') {
        const compaction = { trigger: ['auto', 'manual'].includes(event.trigger) ? event.trigger : 'unknown',
          status: 'completed', completedAt: now() }
        if (state.compaction?.status === 'running') compaction.startedAt = state.compaction.startedAt
        for (const key of ['preTokens', 'postTokens', 'durationMs']) if (count(event[key])) compaction[key] = event[key]
        write({ compaction })
        resume()
        return compaction
      }
    },
    close(context) {
      if (closed) return
      if (contextSnapshot(context).status === 'known') {
        write({ contextUpdate: { status: 'updated', observedAt: now() } })
      }
      closed = true
    },
  }
}

export function createRunProgressProjection(z) {
  const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  const schema = z.object({
    version: z.literal(1), model: z.string().nullable(), runId: z.string().nullable(),
    compaction: z.object({ trigger: z.enum(['auto', 'manual', 'unknown']),
      status: z.enum(['running', 'completed']), startedAt: tokens.optional(), completedAt: tokens.optional(),
      preTokens: tokens.optional(), postTokens: tokens.optional(), durationMs: tokens.optional(),
    }).strict().nullable(),
    contextUpdate: z.object({ status: z.enum(['updated', 'unavailable']), observedAt: tokens,
      code: z.enum(CONTEXT_ERRORS).optional(),
    }).strict().nullable(),
  }).strict().nullable()
  return { key: 'claudeBridgeProgress', stateVersion: 1, stateSchema: schema,
    init: header => header.agentPreset === CLAUDE_PRESET ? initialRunProgress() : null,
    apply(state, event) {
      if (state === null) return state
      if (event.type === RUN_PROGRESS_RECORD && event.ignorable === true) return schema.parse(event.data)
      if (event.type === 'model/selection' && event.data.provider === CLAUDE_PROVIDER
        && event.data.model !== state.model) return initialRunProgress(event.data.model)
      return state
    },
    wire: { viewSchema: schema, view: state => state },
  }
}
