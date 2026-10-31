import test from 'node:test'
import assert from 'node:assert/strict'
import { localHistory, coalesceHistory, restoreAssistant, assistantIdentity, knownToolResult, UNKNOWN_TOOL_TEXT } from '../src/history-sync.mjs'

function fixture() {
  const events = []
  const session = { get seq() { return events.length }, eventAt: seq => events[seq],
    append(type, data, intent) { const event = { seq: events.length, type, data, ...intent }; events.push(event); return event } }
  const helpers = { appendPluginRecord(session, type, data) { return session.append(type, data, { ignorable: true }).seq },
    createAssistantMessage({ content, source }) { return { id: 'generated', role: 'assistant', source: { kind: 'model', ...source }, content } } }
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
  assert.deepEqual(f.events.at(-1).data.message.content, merged[0].content)
  assert.equal(restoreAssistant(f.session, merged[0], history, f.helpers, 'fixture'), 0)
  assert.equal(restoreAssistant(f.session, merged[0], localHistory(f.session), f.helpers, 'fixture'), 0)
  assert.throws(() => restoreAssistant(f.session, { ...merged[0], content: [{ type: 'text', text: '不一致的替代正文' }] }, history, f.helpers, 'fixture'), { code: 'HISTORY_DIVERGED' })
})

test('恢复旧版补尾记录为完整快照，保留原步骤并修复被占位消息遮挡的回复', () => {
  const f = fixture()
  const append = (content, step = 3, id = assistantIdentity('api-old', content)) => f.session.append('assistant/message', {
    turn: 2, step, message: { id, content },
  })
  append([{ type: 'text', text: '合成开头' }])
  append([{ type: 'text', text: '补齐尾部' }])
  append([{ type: 'text', text: 'No response requested.' }], 3, 'synthetic-placeholder')
  const record = { type: 'assistant', apiId: 'api-old', model: 'fixture', content: [{ type: 'text', text: '合成开头补齐尾部' }] }
  const history = localHistory(f.session)
  history.turn = 9; history.step = 1
  assert.equal(restoreAssistant(f.session, record, history, f.helpers), 1)
  assert.equal(f.events.at(-1).data.turn, 2)
  assert.equal(f.events.at(-1).data.step, 3)
  assert.deepEqual(f.events.at(-1).data.message.content, record.content)
  assert.equal(restoreAssistant(f.session, record, localHistory(f.session), f.helpers), 0)
})

test('仅忽略 CLI 的精确合成占位，普通同文回复和其他 synthetic 错误保留', () => {
  const f = fixture(), history = localHistory(f.session)
  const record = { type: 'assistant', apiId: 'placeholder', uuid: 'p', model: '<synthetic>',
    content: [{ type: 'text', text: 'No response requested.' }] }
  assert.equal(restoreAssistant(f.session, record, history, f.helpers), 0)
  assert.equal(coalesceHistory([record]).length, 0)
  assert.equal(restoreAssistant(f.session, { ...record, apiId: 'real', model: 'fixture' }, history, f.helpers), 1)
  history.step++
  assert.equal(restoreAssistant(f.session, { ...record, apiId: 'error', content: [{ type: 'text', text: 'Other error' }] }, history, f.helpers), 1)
})

test('未知占位结果不能冒充真实结果，实际已保存的失败结果仍是可核实结果', () => {
  const event = text => ({ type: 'tool/result', data: { message: { content: [{ type: 'text', text }], isError: true } } })
  assert.equal(knownToolResult(event(UNKNOWN_TOOL_TEXT)), false)
  assert.equal(knownToolResult({ ...event('未开始'), data: { ...event('未开始').data, error: { code: 'TOOL_NOT_STARTED' } } }), false)
  assert.equal(knownToolResult(event('进程返回非零退出码')), true)
})

test('同内容的块分段和工具参数键序不同，不追加旧响应；部分片段不覆盖完整快照', () => {
  const f = fixture()
  const content = [{ type: 'reasoning', text: '合成分析' }, { type: 'text', text: '工具前说明' },
    { type: 'tool-call', id: 'call-order', name: 'local_wait', arguments: '{"first":1,"second":2}' }]
  f.session.append('assistant/message', { turn: 1, step: 1, message: { id: assistantIdentity('api-order', content), content } })
  const record = { apiId: 'api-order', content: [content[0], { type: 'text', text: '工具前' }, { type: 'text', text: '说明' },
    { ...content[2], arguments: '{"second":2,"first":1}' }] }
  assert.equal(restoreAssistant(f.session, record, localHistory(f.session), f.helpers), 0)
  assert.equal(restoreAssistant(f.session, { ...record, content: [content[0]] }, localHistory(f.session), f.helpers), 0)
  assert.equal(f.events.length, 1)
  assert.throws(() => restoreAssistant(f.session, { ...record, content: [{ type: 'reasoning', text: '合成分析补齐' }] },
    localHistory(f.session), f.helpers), { code: 'HISTORY_FRAGMENT_INCOMPLETE' })
  assert.equal(f.events.length, 1)
})
