import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { isNoResponsePlaceholder } from './sdk-message.mjs'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const assistantPrefix = apiId => `claude-sdk:${apiId}:`
export const assistantIdentity = (apiId, content) => assistantPrefix(apiId) + hash(content)
export const UNKNOWN_TOOL_TEXT = '本机工具已开始派发，但未取得执行结果；可能已产生副作用，请核实后再决定是否重试。'
const diverged = () => Object.assign(new Error('云端记录与本机已保存内容不一致，未覆盖历史。'), { code: 'HISTORY_DIVERGED' })

/** Native transcripts can store each block of one API message on a separate
 * line. Join those blocks before comparing with the locally streamed message. */
export function coalesceHistory(records) {
  const output = [], assistants = new Map(), seen = new Map()
  for (const record of records) {
    if (record.type !== 'assistant') { output.push(record); continue }
    if (isNoResponsePlaceholder(record)) continue
    if (seen.has(record.uuid)) {
      if (seen.get(record.uuid) !== hash(record)) throw diverged()
      continue
    }
    seen.set(record.uuid, hash(record))
    let grouped = assistants.get(record.apiId)
    if (!grouped) {
      grouped = { ...record, content: [] }; assistants.set(record.apiId, grouped); output.push(grouped)
    }
    if (grouped.model !== record.model) throw diverged()
    grouped.content.push(...record.content)
  }
  return output
}

/** Read only the owning session; do not duplicate bodies in bridge state. */
export function localHistory(session) {
  if (!Number.isSafeInteger(session.seq) || session.seq < 0 || session.seq > 100_000 || typeof session.eventAt !== 'function') {
    throw Object.assign(new Error('本机会话尚不能可靠读取，未进行恢复。'), { code: 'LOCAL_HISTORY_UNAVAILABLE' })
  }
  const assistants = [], calls = new Map(), results = new Map()
  let turn = 0, step = 1
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(seq)
    if (!event || event.seq !== seq) throw Object.assign(new Error('本机会话存在记录缺口。'), { code: 'LOCAL_HISTORY_GAP' })
    if (Number.isSafeInteger(event.data?.turn)) turn = Math.max(turn, event.data.turn)
    if (Number.isSafeInteger(event.data?.step)) step = event.data.step
    if (event.type === 'assistant/message') assistants.push(event)
    if (event.type === 'tool/call') calls.set(event.data.callId, event)
    if (event.type === 'tool/result') {
      const id = event.data.message.toolCallId ?? event.data.message.source?.callId
      if (id) results.set(id, event)
    }
  }
  return { assistants, calls, results, turn, step, matchedLegacy: new Set() }
}

/** DSH renders the last assistant message of a step as a complete snapshot.
 * Old bridge versions appended tails; fold both tails and newer snapshots when
 * checking consistency, then repair the visible step with the whole message. */
export function restoreAssistant(session, record, history, helpers, fallbackModel) {
  // Older servers can still return the CLI's interrupted-turn placeholder.
  if (isNoResponsePlaceholder(record)) return 0
  const prefix = assistantPrefix(record.apiId)
  let existing = history.assistants.filter(event => event.data.message.id.startsWith(prefix))
  if (!existing.length) {
    const exact = history.assistants.find(event => !event.data.message.id.startsWith('claude-sdk:')
      && !history.matchedLegacy.has(event.seq) && hash(event.data.message.content) === hash(record.content))
    if (exact) { history.matchedLegacy.add(exact.seq); return 0 }
    // Upgrade an interrupted pre-feature record only when the actual text is
    // a substantial prefix, or a stable tool-use id proves the association.
    const candidate = history.assistants.find(event => !event.data.message.id.startsWith('claude-sdk:')
      && !history.matchedLegacy.has(event.seq) && event.data.interrupted === true
      && event.data.message.content.some(block => block.type === 'tool-call'
        ? record.content.some(next => next.type === 'tool-call' && next.id === block.id)
        : ['text', 'reasoning'].includes(block.type) && block.text.length >= 8
          && record.content.some(next => next.type === block.type && next.text.startsWith(block.text))))
    if (candidate) { existing = [candidate]; history.matchedLegacy.add(candidate.seq) }
  }
  let missing = !existing.length
  for (const type of ['text', 'reasoning']) {
    const complete = record.content.filter(item => item.type === type).map(item => item.text).join('')
    let known = ''
    for (const event of existing) {
      const next = event.data.message.content.filter(item => item.type === type).map(item => item.text).join('')
      if (next.startsWith(known)) known = next
      else if (!known.startsWith(next)) known += next
    }
    if (!known.startsWith(complete) && !complete.startsWith(known)) throw diverged()
    // A cursor can point into a split SDK message. Never replace a longer
    // locally saved answer with that incomplete cloud fragment.
    if (known.length > complete.length) return 0
    if (complete.length > known.length) missing = true
  }
  for (const block of record.content) {
    if (block.type === 'tool-call') {
      const old = history.assistants.flatMap(event => event.data.message.content).find(item => item.type === 'tool-call' && item.id === block.id)
      if (old) {
        let same = false
        try { same = old.name === block.name && isDeepStrictEqual(JSON.parse(old.arguments), JSON.parse(block.arguments)) } catch {}
        if (!same) throw diverged()
        continue
      }
      missing = true
    }
  }
  const anchor = existing.at(-1)?.data
  const turn = anchor?.turn ?? history.turn, step = anchor?.step ?? history.step
  const visible = history.assistants.findLast(event => event.data.turn === turn && event.data.step === step)
  if (!missing && visible && hash(visible.data.message.content) === hash(record.content)) return 0
  const message = helpers.createAssistantMessage({ content: record.content,
    source: { provider: 'claude-sdk-remote', model: record.model ?? fallbackModel } })
  const event = session.append('assistant/message', { turn, step,
    message: { ...message, id: assistantIdentity(record.apiId, record.content) }, stream: [] }, { surfaceOp: 'append' })
  history.assistants.push(event)
  return 1
}

export function knownToolResult(event) {
  return event?.type === 'tool/result' && Array.isArray(event.data?.message?.content) && event.data.meta?.claudeBridgeOutcome !== 'unknown'
    && !['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED'].includes(event.data.error?.code)
    && !event.data.message.content.some(block => block.type === 'text' && block.text === UNKNOWN_TOOL_TEXT)
}
