import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { localHistory, restoreAssistant, assistantIdentity, knownToolResult, UNKNOWN_TOOL_TEXT } from '../src/history-sync.mjs'

const available = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
test('实际 rc5：闭合轮次补齐消息和真实工具结果，原生日志与显示历史可重新回放', { skip: !available }, async () => {
  const { Session, SESSION_FORMAT_VERSION } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const helpers = await import(resolveDshModule('@deepseek-ai/dsh-llm'))
  const session = Session.create('native-recovery', undefined, { version: SESSION_FORMAT_VERSION,
    id: 'native-recovery', createdAt: 0, isSeeded: false, agentPreset: 'claude-sdk-remote' })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'claude-sdk-remote', model: 'fixture' },
    tools: [{ name: 'local_command', description: '合成命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } }] }, reason: 'initial' })
  const content = [{ type: 'text', text: '已收到开头' }, { type: 'tool-call', id: 'call-fixture', name: 'local_command', arguments: '{"command":"synthetic"}' }]
  const message = helpers.createAssistantMessage({ content, source: { provider: 'claude-sdk-remote', model: 'fixture' } })
  session.append('assistant/message', { turn: 1, step: 1,
    message: { ...message, id: assistantIdentity('api-fixture', content) }, stream: [], interrupted: true }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId: 'call-fixture', name: 'local_command', arguments: '{"command":"synthetic"}' })
  session.append('tool/result', { turn: 1, step: 1, meta: { claudeBridgeOutcome: 'unknown' },
    message: helpers.createToolResultMessage({ callId: 'call-fixture', content: [{ type: 'text', text: UNKNOWN_TOOL_TEXT }], isError: true }) },
    { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1 })
  const native = { apiId: 'api-fixture', content: [{ type: 'text', text: '已收到开头以及断线尾部' }, content[1]], model: 'fixture' }
  assert.equal(restoreAssistant(session, native, localHistory(session), helpers, 'fixture'), 1)
  const recovered = session.append('tool/result', { turn: 1, step: 1, meta: { claudeBridgeRecovered: true },
    message: helpers.createToolResultMessage({ callId: 'call-fixture', content: [{ type: 'text', text: '已查证的合成结果' }], isError: false }) },
    { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  assert.equal(knownToolResult(recovered), true)
  const events = Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq))
  const restored = Session.create(session.id, events, session.header)
  assert.equal(restored.firstLiveSeq, session.seq)
  assert.equal(restored.eventAt(session.seq).type, 'session/end-seed')
  assert.equal(restoreAssistant(restored, native, localHistory(restored), helpers, 'fixture'), 0)
  assert.equal(localHistory(restored).results.get('call-fixture').data.message.isError, false)
  assert.ok(restored.surface.nodes.includes(recovered.seq))
})
