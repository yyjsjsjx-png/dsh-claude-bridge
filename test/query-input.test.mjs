import test from 'node:test'
import assert from 'node:assert/strict'
import { isValidStepPreparation, toSdkUserMessages, validateQueryEnvelope, validateRunLimits } from '../remote/query-input.mjs'

const id = '11111111-2222-4333-8444-555555555555'

test('查询信封校验按顺序拒绝未知字段、未知操作与不合规压缩', () => {
  assert.throws(() => validateQueryEnvelope({ runId: 'r', extra: 1 }), { code: 'UNSUPPORTED_REQUEST_FIELD' })
  assert.throws(() => validateQueryEnvelope({ runId: 'r', action: 'fork' }), { code: 'UNSUPPORTED_ACTION' })
  assert.throws(() => validateQueryEnvelope({ runId: 'r', action: 'compact', resume: true, prompt: 'x' }), { code: 'INVALID_COMPACT_REQUEST' })
  assert.throws(() => validateQueryEnvelope({ runId: ' ' }), { code: 'INVALID_REQUEST' })
  const valid = validateQueryEnvelope({ runId: 'r', action: 'compact', resume: true })
  assert.equal(valid.runId, 'r')
  assert.equal(valid.compact, true)
})

test('请求预算不得超过服务上限，maxTurns 必须在范围内', () => {
  assert.throws(() => validateRunLimits({ maxBudgetUsd: 2 }, 1), { code: 'BUDGET_LIMIT_EXCEEDED' })
  assert.throws(() => validateRunLimits({ maxBudgetUsd: 0 }), { code: 'BUDGET_LIMIT_EXCEEDED' })
  assert.throws(() => validateRunLimits({ maxTurns: 1001 }), { code: 'INVALID_REQUEST' })
  assert.doesNotThrow(() => validateRunLimits({ maxBudgetUsd: 1, maxTurns: 3 }, 1))
})

test('下一步准备回复不能同时结束本轮并附带上下文或插话', () => {
  const userMessages = [{ id, content: [{ type: 'text', text: '继续' }] }]
  assert.equal(isValidStepPreparation({}), true)
  assert.equal(isValidStepPreparation({ continue: false }), true)
  assert.equal(isValidStepPreparation({ userMessages }), true)
  assert.equal(isValidStepPreparation(null), false)
  assert.equal(isValidStepPreparation({ unknown: true }), false)
  assert.equal(isValidStepPreparation({ continue: false, additionalContexts: ['x'] }), false)
  assert.equal(isValidStepPreparation({ continue: false, userMessages }), false)
  assert.equal(isValidStepPreparation({ userMessages: [{ id: 'bad', content: [{ type: 'text', text: 'x' }] }] }), false)
  assert.equal(isValidStepPreparation({ userMessages: [{ id, content: [{ type: 'text', text: '  ' }] }] }), false)
})

test('插话转换为带小写 UUID 的 SDK 用户消息', () => {
  const [message] = toSdkUserMessages([{ id: id.toUpperCase(), content: [{ type: 'text', text: 'hi' }] }], 'session')
  assert.deepEqual(message, { type: 'user', uuid: id, session_id: 'session',
    message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null, priority: 'now' })
})
