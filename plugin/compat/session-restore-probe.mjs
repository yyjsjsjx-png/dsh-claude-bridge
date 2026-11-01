import { isDeepStrictEqual } from 'node:util';

/** Exercise installed physical encoding and strict current restoration without I/O or tools. */
export function assertSessionRestore(modules) {
  const { Session, SESSION_FORMAT_VERSION, appendPluginRecord } = modules['@deepseek-ai/dsh-session'];
  const { createSystemMessage, createUserMessage, createAssistantMessage, createToolResultMessage }
    = modules['@deepseek-ai/dsh-llm'];
  const { sessionFormatCatalog: catalog } = modules['@deepseek-ai/dsh-session-format-catalog'];
  const { releasedV4SessionFormatCodec: codec } = modules['@deepseek-ai/dsh-session-format-v3-to-v4'];
  const id = 'claude-bridge-session-restore-probe';
  const callId = 'compatibility-probe-call';
  const name = 'compatibility_probe_tool';
  const args = '{"value":"synthetic"}';
  const header = { version: SESSION_FORMAT_VERSION, id, createdAt: 0,
    delegationDepth: 0, isSeeded: false, agentPreset: 'claude-sdk-remote' };
  const session = Session.create(id, undefined, header);
  const assistant = content => createAssistantMessage({ content,
    source: { provider: 'claude-sdk-remote', model: 'compatibility-probe' } });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('request/header', { reason: 'initial', header: {
    config: { provider: 'claude-sdk-remote', model: 'compatibility-probe' },
    tools: [{ name, description: '验证合成工具', parameters: { type: 'object',
      properties: { value: { type: 'string' } }, required: ['value'] } }],
  } });
  session.append('system/message', { turn: 1, step: 1,
    message: createSystemMessage('合成恢复检查') }, { surfaceOp: 'append' });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '合成输入' }],
    source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('assistant/message', { turn: 1, step: 1, stream: [],
    message: assistant([{ type: 'tool-call', id: callId, name, arguments: args }]) }, { surfaceOp: 'append' });
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: args });
  session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: '合成结果' }], isError: false }) },
  { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('step/start', { turn: 1, step: 2 });
  session.append('assistant/message', { turn: 1, step: 2, stream: [],
    message: assistant([{ type: 'text', text: '合成完成' }]) }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 2 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  appendPluginRecord(session, 'plugin:claude-bridge/compatibility-probe', { version: 1 });
  const events = session.snapshotEvents();
  const restore = catalog.createRestore(codec.encodeHeader(session.header, 0),
    { recovery: 'strict', validation: 'current' });
  if (typeof restore?.decodeRow !== 'function' || typeof restore?.finish !== 'function') {
    throw new Error('严格恢复接口不完整');
  }
  for (const event of events) restore.decodeRow(codec.encodeEvent(event));
  const artifact = restore.finish();
  if (artifact?.header?.id !== id || artifact.header.version !== SESSION_FORMAT_VERSION
    || artifact.header.agentPreset !== header.agentPreset || artifact.inheritedEventCount !== 0
    || !isDeepStrictEqual(artifact.events, events) || artifact.events.at(-1)?.ignorable !== true) {
    throw new Error('严格恢复结果与合成会话不一致');
  }
  return artifact;
}
