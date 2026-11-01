/** Observe SDK content frames before canonicalization or durable message assembly. */
export function observeResponseTiming(tracker, message, response, at) {
  if (message.parent_tool_use_id != null || !response?.id || message.type !== 'stream_event') return
  const event = message.event
  const token = (kind, suffix = '') => tracker.token({ responseId: response.id, kind, at,
    ...(typeof message.uuid === 'string' ? { eventId: `${message.uuid}${suffix}` } : {}) })
  if (event?.type === 'content_block_start') {
    const block = event.content_block
    if (block?.type === 'text') { if (block.text?.length) token('text') }
    else if (block?.type === 'thinking') { if (block.thinking?.length) token('thinking') }
    else if (block?.type === 'tool_use') {
      if (block.name?.length) token('tool-name', ':name')
      if (block.input && Object.keys(block.input).length) token('tool-input', ':input')
    } else tracker.failCapture({ responseId: response.id, reason: 'unsupported-block' })
  } else if (event?.type === 'content_block_delta') {
    const delta = event.delta
    if (delta?.type === 'text_delta') { if (delta.text?.length) token('text') }
    else if (delta?.type === 'thinking_delta') { if (delta.thinking?.length) token('thinking') }
    else if (delta?.type === 'input_json_delta') { if (delta.partial_json?.length) token('tool-input') }
    // A signature authenticates a thinking block; it is not a content token.
    else if (delta?.type !== 'signature_delta') tracker.failCapture({ responseId: response.id, reason: 'unsupported-block' })
  } else if (event?.type === 'message_stop') {
    tracker.responseCompleted({ responseId: response.id, streamComplete: true })
  } else if (event?.type === 'error') {
    tracker.failCapture({ responseId: response.id, reason: 'incomplete-stream' })
  }
}
