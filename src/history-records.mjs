// Display repairs must not reopen a native turn or re-advertise executed tools.
export const HISTORY_ASSISTANT = 'plugin:claude-bridge/history-assistant'
export const HISTORY_TOOL_RESULT = 'plugin:claude-bridge/history-tool-result'

export function historyEvent(event) {
  const type = event?.type === HISTORY_ASSISTANT ? 'assistant/message'
    : event?.type === HISTORY_TOOL_RESULT ? 'tool/result' : undefined
  return type && event.ignorable === true ? { ...event, type, surfaceOp: 'append' } : event
}

export function appendHistoryRecord(session, type, data, helpers) {
  const seq = helpers.appendPluginRecord(session, type, data)
  return session.eventAt(seq)
}
