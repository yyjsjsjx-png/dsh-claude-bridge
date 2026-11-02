import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { CLIENT_MODEL_TIMING_RECORD, initialModelCycle, applyModelCycle, modelCycleView,
  modelCycleRows, createModelCycleProjection } from '../src/model-cycle-projection.mjs'
import { RESPONSE_TIMING_RECORD } from '../src/response-timing.mjs'
import { RESPONSE_USAGE_RECORD } from '../src/response-usage.mjs'
import { MODEL_OBSERVATION_RECORD } from '../src/model-observation.mjs'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'

const event = (type, data) => ({ type, data, ignorable: true })
const host = (runId, responseId, turn, step, metric = 'first-output', extra = {}) => event(CLIENT_MODEL_TIMING_RECORD,
  { version: 1, runId, responseId, turn, step, metric, quality: 'precise', durationMs: 10,
    source: 'host-model-cycle', clock: 'local-monotonic', startBoundary: step === 1 ? 'query' : 'tool-results',
    ...(metric === 'duration' ? { endBoundary: 'message-stop' } : { kind: 'tool-name' }), ...extra })
const usage = (runId, responseId, turn, step, outputTokens = 9) => event(RESPONSE_USAGE_RECORD,
  { version: 1, runId, responseId, turn, step, source: 'sdk-stream', usage: {
    uncachedInputTokens: 2, cacheReadTokens: 300, cacheWriteTokens: 40, outputTokens } })
const sdkTiming = (runId, responseId, turn, step) => event(RESPONSE_TIMING_RECORD, {
  version: 1, runId, responseId, turn, step, source: 'sdk-remote', state: 'closed', captureStatus: 'complete',
  reason: null, rawDeltaCount: 2, streamStarted: true, contentSpanMs: 50,
  ttft: { status: 'known', ms: 777, source: 'sdk-first-output-estimate' },
  tps: { status: 'known', durationMs: 100, outputTokens: 9, source: 'sdk-stream-receive' },
})
const model = (runId, responseId, turn, step, actualModel = 'claude-haiku-wire') => event(MODEL_OBSERVATION_RECORD,
  { version: 1, runId, responseId, turn, step, requestedModel: 'haiku', actualModel,
    source: actualModel === null ? null : 'sdk-message-start' })
const fold = events => events.reduce(applyModelCycle, initialModelCycle())

test('4个用户turn内9个模型响应均计样本，工具续推理不退化为每提交1次，wire不携明细', () => {
  const events = []
  for (const [index, steps] of [2, 3, 2, 2].entries()) {
    const turn = index + 1, runId = `run-${turn}`
    for (let step = 1; step <= steps; step++) {
      events.push(host(runId, `response-${step}`, turn, step),
        usage(runId, `response-${step}`, turn, step), sdkTiming(runId, `response-${step}`, turn, step),
        { type: 'assistant/message', data: { turn, step } },
        host(runId, `response-${step}`, turn, step, 'duration', { durationMs: 100 }))
    }
  }
  const state = fold(events), summary = modelCycleView(state)
  assert.deepEqual(summary, { ttftMs: 90, ttftSamples: 9, responseCount: 9, ttftUnknown: 0,
    durationMs: 900, durationSamples: 9, coverage: 'complete' })
  assert.equal(modelCycleRows(state).length, 9)
  assert.equal('rows' in summary, false)
  assert.deepEqual(modelCycleView(fold([...events, ...events])), summary)
})

test('同run/response的首输出与完整时长独立合并，晚到指标/SDK数据不增加分母或混均值', () => {
  let state = fold([host('run-a', 'same-response', 1, 1, 'duration', { durationMs: 900 }),
    usage('run-a', 'same-response', 1, 1), sdkTiming('run-a', 'same-response', 1, 1)])
  assert.deepEqual(modelCycleView(state), { ttftMs: 0, ttftSamples: 0, responseCount: 1, ttftUnknown: 1,
    durationMs: 900, durationSamples: 1, coverage: 'partial' })
  state = applyModelCycle(state, host('run-a', 'same-response', 1, 1, 'first-output', { durationMs: 15 }))
  state = applyModelCycle(state, host('run-b', 'same-response', 2, 1, 'first-output', { quality: 'unknown',
    durationMs: undefined, kind: undefined, reason: 'RUN_FINISHED' }))
  assert.deepEqual(modelCycleView(state), { ttftMs: 15, ttftSamples: 1, responseCount: 2, ttftUnknown: 1,
    durationMs: 900, durationSamples: 1, coverage: 'partial' })
  const rows = modelCycleRows(state)
  assert.equal(rows[0].firstOutput.kind, 'tool-name')
  assert.equal(rows[0].duration.endBoundary, 'message-stop')
  assert.equal(rows[1].firstOutput.reason, 'RUN_FINISHED')
  assert.equal(rows[1].duration.reason, 'HOST_TIMING_UNAVAILABLE')
})

test('旧SDK时长/usage只形成unknown覆盖，不以SDK值或历史文本补造Host时长', () => {
  const state = fold([sdkTiming('run-old', 'old-a', 1, 1), usage('run-old', 'old-a', 1, 1),
    usage('run-old', 'old-b', 1, 2), { type: 'assistant/message', data: { turn: 1, step: 3,
      message: { content: [{ type: 'text', text: 'PRIVATE_OLD_BODY' }] } } }])
  assert.deepEqual(modelCycleView(state), { ttftMs: 0, ttftSamples: 0, responseCount: 3, ttftUnknown: 3,
    durationMs: 0, durationSamples: 0, coverage: 'legacy' })
  const rows = modelCycleRows(state)
  assert.equal(rows.length, 2) // No fabricated responseId for the native legacy step.
  assert.equal(rows[0].sdkTiming.ttft.ms, 777)
  assert.equal(rows[0].firstOutput.reason, 'HOST_TIMING_UNAVAILABLE')
  assert.equal(rows[1].sdkTiming, null)
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_OLD_BODY|"content"|"text"/)
})

test('明细按响应join四个独立Token桶与实际型号，晚到usage替换且不猜思考Token或实际强度', () => {
  let state = fold([host('run-a', 'response-a', 1, 1),
    model('run-a', 'response-a', 1, 1), usage('run-a', 'response-a', 1, 1)])
  state = applyModelCycle(state, usage('run-a', 'response-a', 1, 1, 20))
  state = applyModelCycle(state, model('run-b', 'response-b', 2, 1, null))
  state = applyModelCycle(state, model('run-c', null, 3, 1))
  const rows = modelCycleRows(state)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0].usage, { uncachedInputTokens: 2, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 40 })
  assert.deepEqual(rows[0].model, { requestedModel: 'haiku', actualModel: 'claude-haiku-wire', source: 'sdk-message-start' })
  assert.equal(rows[0].thinkingTokens, null)
  assert.equal(rows[0].actualEffort, null)
  assert.equal(rows[1].model.actualModel, null)
  assert.equal(rows[1].usage, null)
  rows[0].usage.outputTokens = 0
  assert.equal(modelCycleRows(state)[0].usage.outputTokens, 20)
})

test('普通scope为null，非ignorable伪记录不能进入新指标或导出明细', () => {
  const record = host('run-a', 'response-a', 1, 1)
  const state = initialModelCycle()
  assert.equal(applyModelCycle(state, { ...record, ignorable: false }), state)
  assert.equal(applyModelCycle(null, record), null)
  assert.equal(modelCycleView(null), null)
  assert.deepEqual(modelCycleRows(null), [])
  assert.deepEqual(modelCycleView(state), { ttftMs: 0, ttftSamples: 0, responseCount: 0, ttftUnknown: 0,
    durationMs: 0, durationSamples: 0, coverage: 'unknown' })
})

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
test('实际rc5 zod：新projection状态/事件/wire schema可用，质量与message-stop边界严格验证', { skip: !native }, () => {
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-agent-loop'))
  const { z } = require('zod')
  const projection = createModelCycleProjection(z)
  assert.equal(projection.key, 'claudeBridgeModelStats')
  assert.equal(projection.stateVersion, 1)
  assert.equal(projection.init({ agentPreset: 'default' }), null)
  let state = projection.init({ agentPreset: 'claude-sdk-remote' })
  for (const record of [sdkTiming('run-a', 'response-a', 1, 1), usage('run-a', 'response-a', 1, 1),
    model('run-a', 'response-a', 1, 1), host('run-a', 'response-a', 1, 1),
    host('run-a', 'response-a', 1, 1, 'duration')]) state = projection.apply(state, record)
  const restored = projection.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(projection.wire.viewSchema.parse(projection.wire.view(restored)), modelCycleView(state))
  assert.equal(modelCycleRows(restored).length, 1)
  for (const bad of [
    { durationMs: undefined }, { reason: 'INVALID_EXTRA_REASON' }, { quality: 'unknown', reason: 'RUN_FINISHED' },
    { quality: 'unknown', durationMs: undefined, reason: 'bad lowercase' },
    { metric: 'duration', endBoundary: undefined }, { rawPrompt: 'PRIVATE' },
    { runId: 'bad\nidentifier' },
  ]) assert.throws(() => projection.apply(state, host('run-a', 'response-a', 1, 1, 'first-output', bad)))
  const unknown = host('run-a', 'response-b', 1, 2, 'duration', { quality: 'unknown', durationMs: undefined,
    endBoundary: undefined, reason: 'RUN_FINISHED' })
  state = projection.apply(state, unknown)
  state = projection.apply(state, host('run-a', 'response-c', 1, 3, 'first-output', {
    quality: 'unknown', durationMs: undefined, startBoundary: undefined, reason: 'CYCLE_START_MISSING' }))
  projection.stateSchema.parse(state)
  assert.equal(projection.wire.view(state).responseCount, 3)
  const corrupted = structuredClone(state)
  corrupted.records[JSON.stringify(['run-a', 'response-a'])].firstOutput.metric = 'duration'
  assert.equal(projection.stateSchema.safeParse(corrupted).success, false)
  assert.throws(() => projection.apply(state, { ...usage('run-a', 'response-c', 1, 3),
    data: { ...usage('run-a', 'response-c', 1, 3).data, rawBody: 'PRIVATE' } }))
})
