import test from 'node:test'
import assert from 'node:assert/strict'
import { contextSnapshot } from '../src/context-usage.mjs'

test('SDK 当前上下文快照保留容量与可信分类，未知字段和私有正文不进入展示', () => {
  const value = contextSnapshot({ source: 'sdk-summary-approximate', totalTokens: 125, maxTokens: 1000,
    rawMaxTokens: 1200, categories: [
      { id: 'system_prompt', name: 'PRIVATE', tokens: 20, kind: 'used', path: '/private' },
      { id: 'messages', name: 'PRIVATE', tokens: 105, kind: 'used' },
      { id: 'unknown', name: 'PRIVATE', tokens: 99, kind: 'used' },
    ], memoryFiles: [{ path: '/private' }], percentage: 99,
  }, 100)
  assert.equal(value.percentage, 12.5)
  assert.equal(value.rawMaxTokens, 1200)
  assert.equal(value.observedAt, 100)
  assert.deepEqual(value.categories.map(row => row.id), ['system_prompt', 'messages'])
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false)
  assert.equal(JSON.stringify(value).includes('/private'), false)
  assert.equal(contextSnapshot({ source: 'sdk-summary-approximate', totalTokens: 0, maxTokens: 1000 }).status, 'known')
})

test('缺失或无效上下文显示未知，不使用 usage 或本机历史补值', () => {
  for (const input of [undefined, { usage: { input_tokens: 500 } }, { source: 'sdk-result', totalTokens: 500, maxTokens: 1000 },
    { source: 'sdk-summary-approximate', totalTokens: 5, maxTokens: 0 },
    { source: 'sdk-summary-approximate', totalTokens: NaN, maxTokens: 1000 }]) {
    assert.deepEqual(contextSnapshot(input), { status: 'unknown' })
  }
})
