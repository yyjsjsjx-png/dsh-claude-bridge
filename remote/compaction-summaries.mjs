import { createHash } from 'node:crypto'
import { parseSummary } from '../src/compaction-summary.mjs'

const ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_PENDING_COMPACTIONS = 32
const unavailable = code => ({ status: 'unavailable', code })
const validTrigger = value => value === 'auto' || value === 'manual'

/** Pair only SDK PostCompact callbacks and confirmed boundaries from one query's native Session. */
export function createCompactionSummaries({ sessionId, enabled, signal, publish, diagnose = () => {} }) {
  const boundaries = new Map(), hooks = [], pending = [], lastMatched = new Map()
  const ambiguous = new Set()
  let closed = false, unpairedHooks = 0
  let cycleStarted = false, cycleEnded = false, cycleHasBoundary = false, unanchoredBlocked = false
  const active = () => enabled === true && !closed && !signal?.aborted
  const report = code => { try { diagnose('compact-summary', 'unavailable', code) } catch {} }
  function emit(boundary, summary) {
    boundary.summary = summary
    if (!active()) return
    try {
      publish({ type: 'bridge_compaction_summary', boundaryUuid: boundary.uuid,
        trigger: boundary.trigger, summary, source: 'sdk-postcompact' })
    } catch {
      boundary.summary = unavailable('SUMMARY_UNAVAILABLE')
      report('SUMMARY_UNAVAILABLE')
    }
  }
  function match() {
    for (const trigger of ['auto', 'manual']) {
      if (pending.filter(row => row.trigger === trigger).length > 1
        || hooks.filter(row => row.trigger === trigger).length > 1) ambiguous.add(trigger)
      if (!ambiguous.has(trigger)) continue
      for (let index = hooks.length - 1; index >= 0; index--) if (hooks[index].trigger === trigger) hooks.splice(index, 1)
      for (let index = pending.length - 1; index >= 0; index--) if (pending[index].trigger === trigger) {
        emit(pending.splice(index, 1)[0], unavailable('SUMMARY_UNPAIRED'))
      }
    }
    for (let index = 0; index < pending.length;) {
      const boundary = pending[index]
      const hookIndex = hooks.findIndex(hook => hook.trigger === boundary.trigger)
      if (hookIndex < 0) { index++; continue }
      const [hook] = hooks.splice(hookIndex, 1)
      pending.splice(index, 1)
      lastMatched.set(boundary.trigger, hook.signature)
      emit(boundary, hook.summary)
    }
  }
  function beginCycle() {
    for (const row of pending.splice(0)) emit(row, unavailable('SUMMARY_UNPAIRED'))
    if (hooks.length) report('SUMMARY_UNPAIRED')
    hooks.length = 0
    lastMatched.clear()
    ambiguous.clear()
    cycleStarted = true
    cycleEnded = false
    cycleHasBoundary = false
    unanchoredBlocked = false
  }
  function status(message) {
    if (!active() || message?.type !== 'system' || message.subtype !== 'status'
      || message.session_id !== sessionId) return
    if (message.status === 'compacting') {
      // Repeated progress in the same unfinished cycle is not a new generation.
      if (!cycleStarted || cycleEnded || cycleHasBoundary) beginCycle()
    } else if (message.status === null) cycleEnded = true
  }
  function beginSingleCompaction() {
    // A maintenance query runs exactly one /compact command. This is a query
    // scope anchor, not a synthetic SDK completion or model-context message.
    if (active() && !cycleStarted) beginCycle()
  }
  function boundary(message) {
    if (!active() || message?.type !== 'system' || message.subtype !== 'compact_boundary') return
    if (message.session_id !== sessionId || !ID.test(message.uuid ?? '')) {
      report('SUMMARY_UNPAIRED')
      return
    }
    const trigger = validTrigger(message.compact_metadata?.trigger) ? message.compact_metadata.trigger : 'unknown'
    const signature = JSON.stringify([trigger, ...['pre_tokens', 'post_tokens', 'duration_ms'].map(key => {
      const value = message.compact_metadata?.[key]
      return Number.isSafeInteger(value) && value >= 0 ? value : null
    })])
    const known = boundaries.get(message.uuid)
    if (known) {
      if (known.signature !== signature) {
        ambiguous.add(known.trigger)
        const index = pending.indexOf(known)
        if (index >= 0) pending.splice(index, 1)
        emit(known, unavailable('SUMMARY_CONFLICT'))
        match()
      }
      return
    }
    const row = { uuid: message.uuid, trigger, signature, summary: unavailable('SUMMARY_MISSING') }
    boundaries.set(row.uuid, row)
    cycleHasBoundary = true
    if (!cycleStarted && (unanchoredBlocked || !hooks.some(hook => hook.trigger === trigger))) {
      // With no cycle status, a later hook might belong to the next boundary.
      // Never retroactively attach it to this earlier, unanchored completion.
      unanchoredBlocked = true
      hooks.length = 0
      emit(row, unavailable('SUMMARY_UNPAIRED'))
      return
    }
    if (trigger === 'unknown' || ambiguous.has(trigger) || pending.length >= MAX_PENDING_COMPACTIONS) {
      emit(row, unavailable('SUMMARY_UNPAIRED'))
      return
    }
    pending.push(row)
    match()
  }
  function acceptHook(input, hookSignal) {
    // Display failures must never alter the SDK compaction or add model context.
    if (!active() || hookSignal?.aborted) return {}
    if (input?.hook_event_name !== 'PostCompact' || input.session_id !== sessionId || !validTrigger(input.trigger)) {
      report('SUMMARY_UNPAIRED')
      return {}
    }
    if (!cycleStarted && unanchoredBlocked) { report('SUMMARY_UNPAIRED'); return {} }
    if (ambiguous.has(input.trigger)) { report('SUMMARY_UNPAIRED'); return {} }
    let summary
    try { summary = parseSummary(input.compact_summary) }
    catch { summary = unavailable('SUMMARY_UNAVAILABLE') }
    const signature = summary.status === 'available'
      ? createHash('sha256').update(summary.text, 'utf8').digest('hex') : summary.code
    const waiting = pending.some(row => row.trigger === input.trigger)
    // A duplicate hook has no UUID of its own. Without a new confirmed boundary,
    // repeated identical callbacks cannot be evidence of a second compaction.
    if (!waiting && (lastMatched.get(input.trigger) === signature
      || hooks.some(hook => hook.trigger === input.trigger && hook.signature === signature))) return {}
    if (hooks.length >= MAX_PENDING_COMPACTIONS) {
      unpairedHooks++
      report('SUMMARY_UNPAIRED')
      return {}
    }
    hooks.push({ trigger: input.trigger, summary, signature })
    match()
    return {}
  }
  function postCompact(input, hookSignal) {
    try { return acceptHook(input, hookSignal) }
    catch { report('SUMMARY_UNAVAILABLE'); return {} }
  }
  function finish() {
    if (!active()) { stop(); return }
    match()
    for (const row of pending.splice(0)) emit(row, unavailable(hooks.length ? 'SUMMARY_UNPAIRED' : 'SUMMARY_MISSING'))
    unpairedHooks += hooks.length
    if (unpairedHooks) report('SUMMARY_UNPAIRED')
    hooks.length = 0
    closed = true
  }
  function stop() {
    closed = true
    hooks.length = 0
    pending.length = 0
  }
  return { status, beginSingleCompaction, boundary, postCompact, finish, stop,
    summaryFor(uuid) { return boundaries.get(uuid)?.summary ?? unavailable('SUMMARY_UNPAIRED') } }
}
