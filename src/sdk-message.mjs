/** CLI interruption bookkeeping is not an answer from the model. Match both
 * the synthetic source and exact shape so ordinary text and API errors survive. */
export function isNoResponsePlaceholder(message) {
  return message?.model === '<synthetic>' && Array.isArray(message.content)
    && message.content.length === 1 && message.content[0]?.type === 'text'
    && message.content[0].text === 'No response requested.'
}
