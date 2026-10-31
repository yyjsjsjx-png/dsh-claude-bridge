import { HISTORY_ASSISTANT, HISTORY_TOOL_RESULT } from './history-records.mjs'

/** Repair only the bridge's known V4 mistakes, preserving seq references and
 * every original message in display records. Strict native validation remains
 * mandatory before any storage write. */
export function migrateBridgeHistory(header, events) {
  if (header.version !== 4 || header.agentPreset !== 'claude-sdk-remote') return { events, changed: 0 }
  let turn, step, changed = 0
  const seen = new Map(), pending = new Set(), calls = new Map(), snapshots = []
  const record = (event, type, data = event.data) => {
    const { surfaceOp, sourceEventSeqs, ...envelope } = event
    changed++
    return { ...envelope, type, data, ignorable: true }
  }
  const next = events.map(event => {
    const data = event.data
    if (event.type === 'turn/start') { turn = data.turn; step = undefined; seen.clear(); pending.clear() }
    if (event.type === 'step/start') { step = data.step; seen.clear(); pending.clear() }
    const open = turn === data?.turn && step === data?.step && turn !== undefined && step !== undefined
    if (event.type === 'assistant/message' && data?.message?.source?.provider === 'claude-sdk-remote'
      && data.message.id?.startsWith('claude-sdk:')) {
      if (!open) return record(event, HISTORY_ASSISTANT)
      const content = [], duplicate = []
      for (const block of data.message.content) {
        if (block.type !== 'tool-call') { content.push(block); continue }
        const previous = seen.get(block.id)
        if (previous) {
          if (previous.name !== block.name || previous.arguments !== block.arguments) {
            throw new Error('桥接历史中同一工具标识的参数冲突，未修改记录。')
          }
          duplicate.push(block)
        } else { seen.set(block.id, block); pending.add(block.id); content.push(block) }
      }
      if (duplicate.length) {
        if (!content.some(block => block.type === 'tool-call')) return record(event, HISTORY_ASSISTANT)
        // New tools must remain native. Keep the complete former snapshot in
        // an appended plugin record without shifting any existing seq.
        snapshots.push(event)
        changed++
        return { ...event, data: { ...data, message: { ...data.message, content }, stream: [] } }
      }
    }
    if (event.type === 'tool/call') calls.set(data.callId, event)
    if (event.type === 'tool/result') {
      const callId = data.message?.toolCallId ?? data.message?.source?.callId
      if (data.meta?.claudeBridgeRecovered === true && (!open || !pending.has(callId))) {
        const call = calls.get(callId)
        if (!call || call.data.turn !== data.turn || call.data.step !== data.step) {
          throw new Error('已核实工具记录缺少匹配的本机调用，未修改记录。')
        }
        return record(event, HISTORY_TOOL_RESULT, { ...data, callSeq: call.seq })
      }
      pending.delete(callId)
    }
    if (event.type === 'step/end') { step = undefined; pending.clear() }
    if (event.type === 'turn/end') { turn = undefined; step = undefined; pending.clear() }
    return event
  })
  for (const event of snapshots) {
    const { surfaceOp, sourceEventSeqs, ...envelope } = event
    next.push({ ...envelope, type: HISTORY_ASSISTANT, seq: next.length, ignorable: true })
  }
  return { events: next, changed }
}
