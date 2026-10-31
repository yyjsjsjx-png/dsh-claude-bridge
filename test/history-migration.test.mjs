import test from 'node:test'
import assert from 'node:assert/strict'
import { migrateBridgeHistory } from '../src/history-migration.mjs'
import { HISTORY_ASSISTANT, HISTORY_TOOL_RESULT } from '../src/history-records.mjs'

const header = { version: 4, agentPreset: 'claude-sdk-remote' }
const tool = id => ({ type: 'tool-call', id, name: 'local_wait', arguments: '{}' })
const assistant = (seq, content) => ({ type: 'assistant/message', seq, time: seq, surfaceOp: 'append',
  data: { turn: 1, step: 1, stream: [], message: { id: `claude-sdk:api:${seq}`, source: { provider: 'claude-sdk-remote' }, content } } })
const boundary = (type, seq) => ({ type, seq, time: seq, data: { turn: 1, ...(type.startsWith('step/') ? { step: 1 } : {}) } })

test('迁移仅更正已闭合的桥接补齐事件，消息和既有序号保留', () => {
  const old = assistant(4, [{ type: 'text', text: '合成补齐内容' }])
  const call = { type: 'tool/call', seq: 5, time: 5, data: { turn: 1, step: 1, callId: 'a' } }
  const result = { type: 'tool/result', seq: 6, time: 6, surfaceOp: 'append', sourceEventSeqs: [5],
    data: { turn: 1, step: 1, meta: { claudeBridgeRecovered: true }, message: { toolCallId: 'a' } } }
  const original = [boundary('turn/start', 0), boundary('step/start', 1), boundary('step/end', 2), boundary('turn/end', 3), old, call, result]
  const migrated = migrateBridgeHistory(header, original)
  assert.equal(migrated.changed, 2)
  assert.deepEqual(migrated.events.slice(0, 4), original.slice(0, 4))
  assert.equal(migrated.events[4].type, HISTORY_ASSISTANT)
  assert.equal(migrated.events[4].data, old.data)
  assert.equal(migrated.events[6].type, HISTORY_TOOL_RESULT)
  assert.equal(migrated.events[6].data.callSeq, 5)
  assert.equal('sourceEventSeqs' in migrated.events[6], false)
  assert.equal(migrateBridgeHistory(header, migrated.events).changed, 0)
})

test('旧累计快照保留新工具的原生广告，重复部分移入完整展示记录', () => {
  const complete = assistant(3, [{ type: 'text', text: '合成完整说明' }, tool('a'), tool('b')])
  const original = [boundary('turn/start', 0), boundary('step/start', 1), assistant(2, [tool('a')]), complete]
  const migrated = migrateBridgeHistory(header, original)
  assert.equal(migrated.changed, 1)
  assert.deepEqual(migrated.events[3].data.message.content.map(block => block.id ?? block.text), ['合成完整说明', 'b'])
  assert.equal(migrated.events[4].type, HISTORY_ASSISTANT)
  assert.equal(migrated.events[4].data, complete.data)
  assert.equal(migrated.events[4].seq, 4)
  assert.equal(migrateBridgeHistory(header, migrated.events).changed, 0)
  assert.equal(migrateBridgeHistory({ ...header, agentPreset: 'standard' }, original).events, original)
  assert.throws(() => migrateBridgeHistory(header, [...original.slice(0, 3), assistant(3, [{ ...tool('a'), arguments: '{"changed":1}' }])]), /参数冲突/)
})
