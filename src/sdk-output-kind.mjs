const nonempty = s => typeof s === 'string' && s.length > 0

/** Observable content only: headers, tool names and signatures are not tokens. */
export function firstOutputKind(event) {
  if (event?.type === 'content_block_start') {
    if (event.content_block?.type === 'text' && nonempty(event.content_block.text)) return 'text'
    if (event.content_block?.type === 'thinking' && nonempty(event.content_block.thinking)) return 'thinking'
  } else if (event?.type === 'content_block_delta') {
    if (event.delta?.type === 'text_delta' && nonempty(event.delta.text)) return 'text'
    if (event.delta?.type === 'thinking_delta' && nonempty(event.delta.thinking)) return 'thinking'
    if (event.delta?.type === 'input_json_delta' && nonempty(event.delta.partial_json)) return 'tool-input'
  }
}
