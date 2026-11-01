import { firstOutputKind } from '../src/sdk-output-kind.mjs'

const ms = n => Number.isFinite(n) && n >= 0
const id = s => typeof s === 'string' && s.length > 0 && s.length <= 256

/** Add two durations, never clocks from different processes. SDK buffering and
 * worker scheduling remain part of this observation estimate, not an upstream
 * precise TTFT. Scope one observer to one Query; sidechains cannot move it. */
export function createFirstOutputObserver({ now = () => performance.now(), isActive = () => true } = {}) {
  const responses = new Map()
  let current
  return {
    observe(input, at = now()) {
      if (!input || typeof input !== 'object') return input
      let message = input
      if (Object.hasOwn(input, 'bridge_first_output')) {
        const { bridge_first_output: ignored, ...clean } = input
        message = clean
      }
      if (!isActive() || message.type !== 'stream_event' || message.parent_tool_use_id != null) return message
      const event = message.event
      if (event?.type === 'message_start') {
        const responseId = event.message?.id
        if (!id(responseId)) { current = undefined; return message }
        if (!responses.has(responseId)) responses.set(responseId, { responseId, at,
          headerMs: message.ttft_ms, seenOutput: false })
        current = responses.get(responseId)
        if (current.closed) current = undefined
        return message
      }
      if (event?.type === 'message_stop') {
        if (current) current.closed = true
        current = undefined
        return message
      }
      if (current && !current.seenOutput && (event?.type === 'content_block_start'
        && !['text', 'thinking', 'tool_use'].includes(event.content_block?.type)
        || event?.type === 'content_block_delta'
        && !['text_delta', 'thinking_delta', 'input_json_delta', 'signature_delta'].includes(event.delta?.type))) {
        // An opaque earlier output cannot be timed from a later visible token.
        current.seenOutput = true
        return message
      }
      const kind = firstOutputKind(event)
      if (!kind || !current || current.seenOutput) return message
      current.seenOutput = true // Missing/invalid evidence cannot shift to a later token.
      if (!ms(current.at) || !ms(current.headerMs) || !ms(at) || at < current.at) return message
      const duration = current.headerMs + (at - current.at)
      if (!ms(duration)) return message
      return { ...message, bridge_first_output: { version: 1, responseId: current.responseId,
        ms: duration, kind, source: 'sdk-first-output-estimate' } }
    },
  }
}
