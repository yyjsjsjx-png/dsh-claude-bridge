import test from 'node:test'
import assert from 'node:assert/strict'
import { RESPONSE_USAGE_RECORD, RUN_USAGE_RECORD, initialResponseUsage,
  applyResponseUsage, responseUsageView as fullView, responseUsageFromSdk } from '../src/response-usage.mjs'

const usage = n => ({ uncachedInputTokens: 2, outputTokens: n, cacheReadTokens: 100, cacheWriteTokens: 10 })
const native = (step, n) => ({ type: 'assistant/message', data: { turn: 1, step,
  usage: { inputTokens: 2, outputTokens: n, cacheReadTokens: 100, cacheWriteTokens: 10 } } })
const response = (step, n, id = `response-${step}`) => ({ type: RESPONSE_USAGE_RECORD, ignorable: true,
  data: { version: 1, turn: 1, step, runId: 'run-1', responseId: id, source: 'sdk-stream', usage: usage(n) } })
const run = (n = 50) => ({ type: RUN_USAGE_RECORD, ignorable: true,
  data: { version: 1, turn: 1, startStep: 1, endStep: 2, runId: 'run-1', source: 'sdk-result-main-agent', usage: usage(n) } })
const fold = events => events.reduce(applyResponseUsage, initialResponseUsage())
const responseUsageView = state => { const { turns, ...totals } = fullView(state); return totals }

test('远程数值账保留旧版基线，自有响应覆盖而不叠加，晚到原生记录不覆盖', () => {
  const old = responseUsageView(fold([native(1, 4)]))
  assert.deepEqual(old, { ...usage(4), coverage: 'legacy' })
  const result = responseUsageView(fold([native(1, 4), response(1, 6), response(1, 6), native(1, 1)]))
  assert.deepEqual(result, { ...usage(6), coverage: 'partial' })
})

test('累计 usage 按响应替换，跨步晚到更新不重复计算，整轮终态覆盖该 run', () => {
  const partial = fold([response(1, 4), response(2, 6), response(1, 8)])
  assert.equal(responseUsageView(partial).outputTokens, 14)
  const terminal = [run(), response(1, 10), native(2, 1), run()].reduce(applyResponseUsage, partial)
  assert.deepEqual(responseUsageView(terminal), { ...usage(50), coverage: 'complete' })
})

test('不同 run/turn 不串槽，终态不覆盖别的旧步骤或其他运行', () => {
  const other = response(3, 7)
  other.data.runId = 'run-2'
  const result = responseUsageView(fold([native(4, 3), response(1, 4), other, run()]))
  assert.equal(result.outputTokens, 60)
  assert.equal(result.coverage, 'partial')
})

test('旧版 attempt 与 message 同步替换，明确 retry 才保留前次用量', () => {
  const attempt = { type: 'assistant/attempt', data: { turn: 1, step: 1,
    stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: native(1, 4).data.usage } }] } }
  assert.equal(responseUsageView(fold([attempt, native(1, 6)])).outputTokens, 6)
  assert.equal(responseUsageView(fold([attempt, { type: 'llm/retry-started', data: { turn: 1, step: 1 } }, native(1, 6)])).outputTokens, 10)
})

test('完整 SDK usage 只取四个互斥桶，未知或占位助手值不补成完整计数', () => {
  assert.equal(responseUsageFromSdk({ output_tokens: 1 }), undefined)
  assert.equal(responseUsageFromSdk({ input_tokens: -1, output_tokens: 2 }), undefined)
  assert.deepEqual(responseUsageFromSdk({ input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 10,
    cache_creation_input_tokens: 4, output_tokens_details: { thinking_tokens: 2 } }), {
    uncachedInputTokens: 2, outputTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 4,
  })
})

test('逐轮汇总只在终态覆盖全部已观察步骤时完整，不把运行中快照当完整', () => {
  const start = step => ({ type: 'step/start', data: { turn: 1, step } })
  let state = fold([start(1), response(1, 4)])
  assert.equal(fullView(state).turns['1'].coverage, 'partial')
  state = applyResponseUsage(state, run())
  assert.deepEqual(fullView(state).turns['1'], { ...usage(50), coverage: 'complete' })
  state = applyResponseUsage(state, start(3))
  assert.equal(fullView(state).turns['1'].coverage, 'partial')
  const secondTurn = run(60)
  secondTurn.data = { ...secondTurn.data, turn: 2, runId: 'run-2' }
  state = applyResponseUsage(state, secondTurn)
  assert.deepEqual(fullView(state).turns['2'], { ...usage(60), coverage: 'complete' })
  assert.equal(fullView(state).outputTokens, 110)
})
