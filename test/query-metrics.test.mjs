import test from 'node:test'
import assert from 'node:assert/strict'
import { combineTurnResults, failureDetail, resultMetrics } from '../remote/query-metrics.mjs'

test('合并插话轮次时累加主代理 usage，缺失字段时不伪造', () => {
  const first = { usage: { input_tokens: 1, output_tokens: 2 } }
  const last = { uuid: 'u', usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5 }, total_cost_usd: 1 }
  assert.equal(combineTurnResults([], last), last)
  assert.deepEqual(combineTurnResults([first], last), { uuid: 'u', total_cost_usd: 1,
    usage: { input_tokens: 4, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 } })
  assert.deepEqual(combineTurnResults([{ usage: { input_tokens: 1 } }], last), { uuid: 'u', total_cost_usd: 1 })
})

test('结果指标只保留非负数值，无数据时为空', () => {
  assert.equal(resultMetrics({}, 'run'), undefined)
  assert.deepEqual(resultMetrics({ usage: { input_tokens: 1, output_tokens: -1 }, total_cost_usd: 0.5 }, 'run'), {
    source: 'sdk-result', dedupeKey: 'run', usage: { scope: 'current-turn-main-agent', input_tokens: 1 },
    cost: { scope: 'session-cumulative-estimate', usd: 0.5 } })
})

test('失败结果映射为稳定错误码', () => {
  assert.equal(failureDetail({ subtype: 'error_max_turns' }).code, 'MAX_TURNS_REACHED')
  assert.equal(failureDetail({ subtype: 'error_during_execution', startup_failure_reason: 'cwd_unavailable' }).code, 'SESSION_DIRECTORY_UNAVAILABLE')
  assert.equal(failureDetail({ subtype: 'other' }, undefined, true).code, 'AUTH_FLOW_FAILED')
})
