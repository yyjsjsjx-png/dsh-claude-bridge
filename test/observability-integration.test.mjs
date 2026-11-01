import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { createObservabilityHost } from '../remote/observability-host.mjs'
import { createWorkerObservability } from '../remote/observability-worker.mjs'
import { createObservabilityIpc } from '../remote/observability-ipc.mjs'
import { createRunObservations } from '../remote/run-observations.mjs'
import { normalizeObservabilityRecord } from '../src/observability-schema.mjs'

function channels() {
  const a = new EventEmitter(), b = new EventEmitter()
  for (const [from, to] of [[a, b], [b, a]]) {
    from.connected = true
    from.send = (value, callback) => queueMicrotask(() => { to.emit('message', structuredClone(value)); callback?.(null) })
  }
  return [a, b]
}
const base = () => ({ version: 1, deviceId: 'device-a', dshSessionId: 'dsh-a', sdkSessionId: 'sdk-a',
  runId: 'run-a', model: 'haiku', observedAt: Date.now() })

test('两个设备共享账号采样，空闲只读缓存，断开和已排队通知不会恢复孤儿活跃任务', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-observability-integration-'))
  const diagnostics = [], host = createObservabilityHost({ directory, onDiagnostic: event => diagnostics.push(event) })
  const pairs = [channels(), channels()]
  let reads = 0, finish
  const gate = new Promise(resolve => { finish = resolve })
  const workers = pairs.map(([parent, child], index) => {
    host.attach(parent, index ? 'device-b' : 'device-a')
    return createWorkerObservability(child, { fetchQuota: async () => {
      reads++; await gate
      const observedAt = Date.now()
      return { status: 'available', source: 'sdk-plan-usage', observedAt, expiresAt: observedAt + 120_000,
        windows: [{ id: 'seven_day', name: '周额度', scope: 'weekly', usedPercent: 12, resetsAt: observedAt + 86_400_000 }] }
    } })
  })
  t.after(async () => { finish(); workers.forEach(worker => worker.close()); await host.close(); await rm(directory, { recursive: true, force: true }) })
  assert.equal((await workers[0].quota('manual')).active, false)
  assert.equal(reads, 0)
  workers[0].activity('run-a', true); workers[1].activity('run-b', true)
  const both = workers.map(worker => worker.quota('manual'))
  await tick(); assert.equal(reads, 1)
  finish()
  const views = await Promise.all(both)
  assert.equal(views[0].activeCount, 2)
  assert.equal(views[0].snapshot.observedAt, views[1].snapshot.observedAt)
  pairs[0][0].emit('disconnect')
  assert.equal((await workers[1].status()).quota.activeCount, 1)
  workers[1].activity('run-b', false)
  const idle = await workers[1].quota('manual')
  assert.equal(idle.active, false); assert.equal(reads, 1)
  assert.equal(idle.snapshot.observedAt, views[0].snapshot.observedAt)

  const run = { ...base(), kind: 'query', status: 'completed', usage: {
    scope: 'current-turn-main-agent', uncachedInputTokens: 2, outputTokens: 3, cacheReadTokens: 10, cacheWriteTokens: 4 } }
  workers[1].record('run', { ...run, deviceId: 'device-b' })
  workers[1].record('response', { ...base(), deviceId: 'device-b', responseId: 'response-a', usage: {
    scope: 'response-main-agent', uncachedInputTokens: 20, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 40 } })
  const summary = await workers[1].summarize({ from: run.observedAt - 1000, to: Date.now() + 1000 })
  assert.equal(summary.status, 'ok')
  assert.equal(summary.totals.usage.outputTokens, 3)
  workers[1].record('run', { ...run, deviceId: 'device-a' })
  await workers[1].status()
  assert.equal(diagnostics.some(event => event.code === 'OBSERVABILITY_IDENTITY_MISMATCH' && event.gap), true)

  // A notification already delivered to the IPC parser can still be waiting in a microtask.
  const [parent, child] = channels()
  host.attach(parent, 'device-c')
  const orphan = createWorkerObservability(child, { fetchQuota: () => { throw Error('不能采样') } })
  parent.emit('message', { type: 'dsh-observability-v1', kind: 'notify', id: 'queued-active', method: 'activity', params: { key: 'run-c', active: true } })
  parent.emit('disconnect')
  await tick(); orphan.close()
  assert.equal((await workers[1].status()).quota.active, false)
})

test('IPC拒绝拥塞的落库通知时留下明确缺口，通道关闭清理等待', async () => {
  const [parent, child] = channels(), diagnostics = []
  let release, active = true
  const gate = new Promise(resolve => { release = resolve })
  const receiver = createObservabilityIpc(parent, { maxPending: 1,
    onDiagnostic: event => diagnostics.push(event), handlers: { record: () => gate },
    controls: { activity: value => { active = value.active } } })
  const sender = createObservabilityIpc(child)
  sender.notify('record', {}); sender.notify('record', {})
  await tick()
  assert.equal(diagnostics.some(event => event.code === 'OBSERVABILITY_REQUEST_REFUSED' && event.gap), true)
  sender.notify('activity', { active: false })
  await tick(); assert.equal(active, false)
  const waiting = sender.request('record', {})
  sender.close()
  assert.equal((await waiting).code, 'OBSERVABILITY_CHANNEL_CLOSED')
  release(); receiver.close()
})

test('响应审计不叠加整轮主代理用量，子代理和正文不入账，上游TTFT保留估算或未知', () => {
  let clock = 10
  const rows = [], capture = createRunObservations({ params: { ...base(), sessionId: 'sdk-a' },
    record: (kind, row) => rows.push({ kind, row }), now: () => clock, wall: () => 10000 })
  const stream = (event, extra = {}) => capture.observe({ type: 'stream_event', session_id: 'sdk-a', event, ...extra })
  stream({ type: 'message_start', message: { id: 'response-a', model: 'haiku', usage: { input_tokens: 2, output_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 4 } } })
  stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'synthetic-private-marker' } }, {
    bridge_first_output: { version: 1, responseId: 'response-a', kind: 'thinking', ms: 12, source: 'sdk-first-output-estimate' } })
  stream({ type: 'message_delta', usage: { output_tokens: 3 } })
  stream({ type: 'message_start', message: { id: 'child-response', model: 'child-model' } }, { parent_tool_use_id: 'child' })
  stream({ type: 'message_start', message: { id: 'response-b', model: 'haiku' } })
  capture.observe({ type: 'assistant', message: { id: 'synthetic', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } })
  clock = 100
  capture.finish({ status: 'completed', metrics: { usage: { scope: 'current-turn-main-agent', input_tokens: 2,
    output_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 4 }, cost: { scope: 'session-cumulative-estimate', usd: 1 } } })
  capture.finish({ status: 'failed' })
  for (const { kind, row } of rows) normalizeObservabilityRecord({ run: 'runs', response: 'responses', timing: 'timing' }[kind], row)
  assert.equal(rows.filter(value => value.kind === 'run').length, 1)
  assert.equal(rows.find(value => value.kind === 'run').row.usage.outputTokens, 3)
  assert.equal(rows.find(value => value.kind === 'run').row.model, 'haiku')
  assert.equal(rows.some(value => value.row.responseId === 'child-response'), false)
  assert.equal(JSON.stringify(rows).includes('synthetic-private-marker'), false)
  assert.deepEqual(rows.filter(value => value.row.metric === 'first-output').map(value => value.row.quality), ['estimate', 'unknown'])

  const partial = createRunObservations({ params: { ...base(), sessionId: 'sdk-a' }, record: (kind, row) => {
    normalizeObservabilityRecord({ run: 'runs', timing: 'timing' }[kind], row)
    if (kind === 'run') { assert.equal(row.status, 'completed'); assert.equal(row.usage, undefined) }
  } })
  partial.finish({ status: 'completed', metrics: { usage: { scope: 'current-turn-main-agent', input_tokens: 1, output_tokens: 2 } } })
})
