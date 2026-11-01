import test from 'node:test'
import assert from 'node:assert/strict'
import { RESPONSE_TIMING_RECORD, createResponseTimingTracker, initialResponseTiming,
  applyResponseTiming, responseTimingView } from '../src/response-timing.mjs'
import { RESPONSE_USAGE_RECORD } from '../src/response-usage.mjs'

function fixture({ runId = 'run-1', turn = 1 } = {}) {
  const records = []
  let clock = 0
  const tracker = createResponseTimingTracker({ runId, turn, now: () => clock,
    onRecord: data => records.push({ type: RESPONSE_TIMING_RECORD, ignorable: true, data }) })
  return { tracker, records, time(value) { clock = value }, latest: () => records.at(-1).data,
    view: () => responseTimingView(records.reduce(applyResponseTiming, initialResponseTiming())) }
}
const start = (f, responseId = 'api-1', extra = {}) => {
  const { firstOutputMs, ...options } = extra
  const started = f.tracker.responseStarted({ responseId, step: 1, streamStarted: true, at: 10, ...options })
  if (firstOutputMs !== undefined) f.tracker.sourceTtft({ responseId, ms: firstOutputMs })
  return started
}
const token = (f, at, kind = 'text', responseId = 'api-1', eventId = `raw-${at}`) =>
  f.tracker.token({ responseId, kind, eventId, at })

test('首有效输出 TTFT 估算立即按响应更新，不从本机首增量或请求等待补造', () => {
  const f = fixture()
  start(f)
  assert.equal(f.latest().ttft.status, 'unknown')
  token(f, 100)
  assert.equal(f.records.length, 1) // No per-token journal writes.
  f.tracker.sourceTtft({ responseId: 'api-1', ms: 71 })
  assert.deepEqual(f.latest().ttft, { status: 'known', ms: 71, source: 'sdk-first-output-estimate' })
  f.tracker.sourceTtft({ responseId: 'api-1', ms: 71 })
  assert.equal(f.records.length, 2)
  assert.equal(f.tracker.sourceTtft({ responseId: 'api-1', ms: 9999 }), false)
  assert.equal(f.latest().ttft.ms, 71)
  assert.equal(f.view().ttftSteps, 1)
  assert.equal(f.view().tpsSamples, 0)
  f.tracker.responseCompleted({ responseId: 'api-1', streamComplete: true })
  assert.equal(f.tracker.sourceTtft({ responseId: 'api-1', ms: 1 }), false)
  const unknown = fixture()
  start(unknown)
  unknown.tracker.responseCompleted({ responseId: 'api-1', streamComplete: true })
  assert.equal(unknown.tracker.sourceTtft({ responseId: 'api-1', ms: 1 }), false)
  assert.equal(unknown.latest().ttft.status, 'unknown')
})

test('接收窗口从原始响应开始帧至末内容帧，晚到 usage 补样本而不纳入工具等待', () => {
  const f = fixture()
  start(f, 'api-1', { firstOutputMs: 20 })
  const recordsBeforeTokens = f.records.length
  token(f, 100, 'thinking')
  token(f, 150, 'tool-input')
  token(f, 150, 'tool-input') // Stable raw-event identity deduplicates it.
  assert.equal(f.records.length, recordsBeforeTokens)
  f.time(50_000)
  f.tracker.responseCompleted({ responseId: 'api-1', streamComplete: true })
  assert.equal(f.latest().tps.reason, 'awaiting-final-usage')
  f.time(100_000)
  f.tracker.responseUsage({ responseId: 'api-1', outputTokens: 28, final: true, cacheReadTokens: 999999 })
  assert.deepEqual(f.latest().tps, { status: 'known', durationMs: 140,
    outputTokens: 28, source: 'sdk-stream-receive' })
  assert.equal(f.latest().rawDeltaCount, 2)
  assert.equal(f.latest().contentSpanMs, 50)
  f.tracker.responseUsage({ responseId: 'api-1', outputTokens: 28, final: true })
  f.tracker.responseUsage({ responseId: 'api-1', outputTokens: 27, final: true })
  assert.equal(f.view().decodeTokens, 28)
  assert.equal(f.view().decodeMs, 140)
  assert.equal(f.view().tpsSamples, 1)
})

test('单批到达、缺原始开始帧、零输出或不完整内容不会被算作有效接收速度', () => {
  for (const scenario of ['single-batch', 'no-start', 'zero-output', 'supplement', 'redacted']) {
    const f = fixture()
    start(f, 'api-1', { firstOutputMs: 10, streamStarted: scenario !== 'no-start' })
    token(f, 100)
    token(f, scenario === 'single-batch' ? 100 : 150, 'thinking', 'api-1', 'other-event')
    if (scenario === 'supplement') f.tracker.failCapture({ responseId: 'api-1', reason: 'assistant-supplement' })
    if (scenario === 'redacted') f.tracker.token({ responseId: 'api-1', kind: 'redacted-thinking', at: 160 })
    f.tracker.responseUsage({ responseId: 'api-1', outputTokens: scenario === 'zero-output' ? 0 : 100, final: true })
    f.tracker.responseCompleted({ responseId: 'api-1', streamComplete: true })
    assert.equal(f.latest().tps.status, 'unknown', scenario)
    assert.equal(f.view().tpsSamples, 0, scenario)
    assert.equal(f.view().ttftSteps, 1, scenario) // Validated remote first-output evidence is independent.
  }
})

test('高值不会被阈值剔除，usage 先到或后到均形成同一完整样本', () => {
  const f = fixture()
  start(f, 'api-1', { firstOutputMs: 0 })
  token(f, 11, 'tool-name')
  token(f, 12, 'tool-input')
  f.tracker.responseUsage({ responseId: 'api-1', outputTokens: 100_000, final: true })
  assert.equal(f.latest().tps.status, 'unknown')
  f.tracker.responseCompleted({ responseId: 'api-1', streamComplete: true })
  assert.equal(f.latest().tps.durationMs, 2)
  assert.equal(f.view().decodeTokens / (f.view().decodeMs / 1000), 50_000_000)
  assert.equal(f.view().coverage, 'complete')
})

test('close 与 interrupt 幂等冻结所有入口，迟到信号不再修改已结束运行', () => {
  for (const close of ['close', 'interrupt']) {
    const f = fixture()
    start(f, 'api-1', { firstOutputMs: 10 })
    token(f, 20)
    f.tracker[close]()
    const snapshot = structuredClone(f.records)
    f.tracker[close]()
    assert.equal(f.tracker.responseStarted({ responseId: 'late', step: 2, streamStarted: true }), false)
    assert.equal(f.tracker.sourceTtft({ responseId: 'api-1', ms: 1 }), false)
    assert.equal(token(f, 30), false)
    assert.equal(f.tracker.responseUsage({ responseId: 'api-1', outputTokens: 100, final: true }), false)
    assert.equal(f.tracker.responseCompleted({ responseId: 'api-1', streamComplete: true }), false)
    assert.equal(f.tracker.failCapture({ responseId: 'api-1', reason: 'unsupported-block' }), false)
    assert.deepEqual(f.records, snapshot)
    assert.equal(f.view().tpsSamples, 0)
  }
})

test('跨 run 响应去重重放，TTFT 与 TPS 各有独立覆盖率，旧步骤不伪造计时', () => {
  const a = fixture(), b = fixture({ runId: 'run-2', turn: 2 })
  start(a, 'same-id', { firstOutputMs: 10 })
  token(a, 20, 'text', 'same-id'); token(a, 110, 'thinking', 'same-id')
  a.tracker.responseCompleted({ responseId: 'same-id', streamComplete: true })
  a.tracker.responseUsage({ responseId: 'same-id', outputTokens: 20, final: true })
  start(b, 'same-id')
  token(b, 20, 'text', 'same-id'); token(b, 310, 'text', 'same-id')
  b.tracker.responseUsage({ responseId: 'same-id', outputTokens: 30, final: true })
  b.tracker.responseCompleted({ responseId: 'same-id', streamComplete: true })
  const usage = (runId, responseId, turn) => ({ type: RESPONSE_USAGE_RECORD, ignorable: true,
    data: { version: 1, runId, responseId, turn, step: 1 } })
  const legacy = turn => ({ type: 'assistant/message', data: { turn, step: 1,
    usage: { outputTokens: 9000 }, stream: [{ time: Date.now(), chunk: { type: 'text-delta', text: '不用于计时' } }] } })
  const events = [...a.records, ...a.records, ...b.records,
    usage('run-1', 'same-id', 1), legacy(1), usage('old-run', 'old-id', 3), legacy(3), legacy(4), legacy(4)]
  const state = events.reduce(applyResponseTiming, initialResponseTiming()), view = responseTimingView(state)
  assert.equal(view.responseCount, 4)
  assert.equal(view.ttftSteps, 1)
  assert.equal(view.ttftMs, 10)
  assert.equal(view.tpsSamples, 2)
  assert.equal(view.decodeTokens, 50)
  assert.equal(view.decodeMs, 400)
  assert.equal(view.ttftUnknown, 3)
  assert.equal(view.tpsUnknown, 2)
  assert.equal(view.legacyStepsWithoutTiming, 1)
  assert.equal(view.coverage, 'partial')
  assert.equal(responseTimingView([legacy(1), legacy(1)].reduce(applyResponseTiming, initialResponseTiming())).coverage, 'legacy')
  assert.equal(responseTimingView(initialResponseTiming()).coverage, 'unknown')
})

test('单调时钟倒退标记失效，源码 TTFT 仍可独立保留', () => {
  const f = fixture()
  start(f, 'api-1', { firstOutputMs: 5 })
  token(f, 30); token(f, 20)
  f.tracker.responseCompleted({ responseId: 'api-1', streamComplete: true })
  f.tracker.responseUsage({ responseId: 'api-1', outputTokens: 100, final: true })
  assert.equal(f.latest().reason, 'clock-invalid')
  assert.equal(f.view().ttftSteps, 1)
  assert.equal(f.view().tpsSamples, 0)
})
