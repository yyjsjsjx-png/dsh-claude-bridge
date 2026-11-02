import test from 'node:test'
import assert from 'node:assert/strict'
import { readHistoryPages } from '../src/history-reader.mjs'

const start = () => ({ offset: 0, lastUuid: null })
const signal = () => new AbortController().signal
const page = (cursor, records = [], extra = {}) => ({ status: 'ok', sessionId: 'session', records,
  nextOffset: cursor.offset + 1, lastUuid: `record-${cursor.offset}`, done: true, ...extra })

test('游标重置丢弃旧页，候选回放游标定位完整最后响应的起始页', async () => {
  const cursors = [], original = { offset: 5, lastUuid: 'old' }
  const result = await readHistoryPages({ sessionId: 'session', cursor: original, signal: signal(),
    readPage: async cursor => {
      cursors.push(cursor.offset)
      if (cursor.offset === 5) return page(cursor, [{ type: 'assistant', apiId: 'old' }], { done: false })
      if (cursor.offset === 6) return { status: 'cursor-reset' }
      return page(cursor, [{ type: 'assistant', apiId: 'new', uuid: `part-${cursor.offset}` }],
        { done: cursor.offset === 1, runs: { run: { status: 'completed' } } })
    } })
  assert.deepEqual(cursors, [5, 6, 0, 1])
  assert.deepEqual(result.records.map(record => record.uuid), ['part-0', 'part-1'])
  assert.deepEqual(result.replay, start())
  assert.deepEqual(result.readStart, start())
  assert.equal(result.cursor.offset, 2)
  assert.deepEqual(result.runs, { run: { status: 'completed' } })
  assert.deepEqual(original, { offset: 5, lastUuid: 'old' })
})

test('错误会话和不前进分页被拒绝，busy 不返回可提交游标', async () => {
  for (const reply of [page(start(), [], { sessionId: 'other' }),
    page(start(), [], { nextOffset: 0, done: false })]) {
    await assert.rejects(readHistoryPages({ sessionId: 'session', cursor: start(), signal: signal(),
      readPage: async () => reply }), { code: 'HISTORY_INVALID' })
  }
  assert.deepEqual(await readHistoryPages({ sessionId: 'session', cursor: start(), signal: signal(),
    readPage: async () => ({ status: 'busy' }) }), { status: 'busy' })
})

test('读取仍受3200页及累计64MiB预算约束，不把未完成内容当成功快照', async () => {
  let requests = 0
  await assert.rejects(readHistoryPages({ sessionId: 'session', cursor: start(), signal: signal(),
    readPage: async cursor => { requests++; return page(cursor, [], { done: false }) } }),
  { code: 'HISTORY_TOO_LARGE', message: '[HISTORY_TOO_LARGE] 云端记录超过本次同步上限，未静默省略。' })
  assert.equal(requests, 3200)
  // Reuse a small record to cross the byte budget without allocating 64MiB.
  const record = { type: 'assistant', apiId: 'response', content: [{ type: 'text', text: 'x'.repeat(32 * 1024) }] }
  requests = 0
  await assert.rejects(readHistoryPages({ sessionId: 'session', cursor: start(), signal: signal(),
    readPage: async cursor => { requests++; return page(cursor, [record], { done: false }) } }),
  { code: 'HISTORY_TOO_LARGE', message: '[HISTORY_TOO_LARGE] 本次恢复内容过大，已保留已同步记录。' })
  assert.ok(requests <= 2048)
})
