import test from 'node:test'
import assert from 'node:assert/strict'
import { localHistory, coalesceHistory, restoreAssistant, assistantIdentity, knownToolResult, UNKNOWN_TOOL_TEXT } from '../src/history-sync.mjs'

function fixture() {
  const events = []
  const session = { get seq() { return events.length }, eventAt: seq => events[seq],
    append(type, data, intent) { const event = { seq: events.length, type, data, ...intent }; events.push(event); return event } }
  const helpers = { createAssistantMessage({ content, source }) { return { id: 'generated', role: 'assistant', source: { kind: 'model', ...source }, content } } }
  return { session, helpers, events }
}

test('恢复合并 SDK 同消息分段，补齐中断尾部且重复同步不重复展示', () => {
  const f = fixture(), content = [{ type: 'text', text: '合成开头' }]
  f.session.append('assistant/message', { turn: 1, step: 1,
    message: { id: assistantIdentity('api-1', content), content }, interrupted: true })
  const history = localHistory(f.session)
  const merged = coalesceHistory([
    { type: 'assistant', apiId: 'api-1', uuid: 'part-1', model: 'fixture', content },
    { type: 'assistant', apiId: 'api-1', uuid: 'part-2', model: 'fixture', content: [{ type: 'text', text: '和完整尾部' }] },
  ])
  assert.equal(restoreAssistant(f.session, merged[0], history, f.helpers, 'fixture'), 1)
  assert.equal(f.events.at(-1).data.message.content[0].text, '和完整尾部')
  assert.equal(restoreAssistant(f.session, merged[0], history, f.helpers, 'fixture'), 0)
  assert.equal(restoreAssistant(f.session, merged[0], localHistory(f.session), f.helpers, 'fixture'), 0)
  assert.throws(() => restoreAssistant(f.session, { ...merged[0], content: [{ type: 'text', text: '不一致的替代正文' }] }, history, f.helpers, 'fixture'), { code: 'HISTORY_DIVERGED' })
})

test('未知占位结果不能冒充真实结果，实际已保存的失败结果仍是可核实结果', () => {
  const event = text => ({ type: 'tool/result', data: { message: { content: [{ type: 'text', text }], isError: true } } })
  assert.equal(knownToolResult(event(UNKNOWN_TOOL_TEXT)), false)
  assert.equal(knownToolResult({ ...event('未开始'), data: { ...event('未开始').data, error: { code: 'TOOL_NOT_STARTED' } } }), false)
  assert.equal(knownToolResult(event('进程返回非零退出码')), true)
})
