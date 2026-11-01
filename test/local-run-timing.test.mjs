import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createRpcPeer } from '../src/rpc.mjs'
import { createLocalRunTiming } from '../src/local-run-timing.mjs'
import { retainedPlanUsage } from '../src/observability-plan-usage.mjs'

test('本机计时在RPC通知排队前观察有效思考，排除头帧与重放', async () => {
  let clock = 10, release
  const rows = [], input = new PassThrough(), output = new PassThrough()
  const observe = createLocalRunTiming({ now: () => clock, wall: () => 10000, onTiming: row => rows.push(row) })
  const gate = new Promise(resolve => { release = resolve })
  let request
  output.on('data', frame => { request = JSON.parse(frame) })
  const peer = createRpcPeer({ input, output, onTraffic: event => observe.observe(event), onNotification: () => gate })
  const pending = peer.request('query', { runId: 'run-a', deviceId: 'device-a', dshSessionId: 'dsh-a', sessionId: 'sdk-a', model: 'haiku' })
  const frame = event => input.write(JSON.stringify({ jsonrpc: '2.0', method: 'sdk.message', params: {
    runId: 'run-a', message: { type: 'stream_event', parent_tool_use_id: null, session_id: 'sdk-a', event } } }) + '\n')
  frame({ type: 'message_start', message: { id: 'response-a' } })
  clock = 20; frame({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'not-content' } })
  clock = 90; frame({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'synthetic-private-marker' } })
  clock = 100; frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'later' } })
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'sdk.message', params: { runId: 'run-a', message: { type: 'assistant',
    message: { id: 'synthetic', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } } } }) + '\n')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].durationMs, 80)
  assert.equal(rows[0].quality, 'precise')
  assert.equal(JSON.stringify(rows).includes('synthetic-private-marker'), false)
  input.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { status: 'completed' } }) + '\n')
  await pending
  release(); await peer.drainNotifications(); peer.close()
  assert.equal(rows.filter(row => row.metric === 'first-output').length, 1)
  assert.equal(rows.at(-1).model, 'unknown')
})

test('额度共享缓存区分新鲜度与保留期，不改变读数时间或保留已重置窗口', () => {
  const observedAt = 1_700_000_000_000
  const snapshot = { status: 'available', source: 'sdk-plan-usage', observedAt, expiresAt: observedAt + 120_000,
    windows: [{ id: 'five_hour', name: '5 小时', scope: 'session', usedPercent: 9.25, resetsAt: observedAt + 180_000 },
      { id: 'seven_day', name: '周额度', scope: 'weekly', usedPercent: 12.5, resetsAt: observedAt + 86_400_000 }] }
  const view = retainedPlanUsage({ snapshot, fresh: false, nextAllowedAt: observedAt + 300_000, error: { code: 'RATE_LIMITED', observedAt: observedAt + 200_000 } }, observedAt + 240_000)
  assert.equal(view.status, 'available'); assert.equal(view.observedAt, observedAt)
  assert.equal(view.sampling.fresh, false); assert.equal(view.sampling.error.code, 'RATE_LIMITED')
  assert.equal(view.windows.length, 1); assert.equal(view.windows[0].usedPercent, 12.5)
  assert.equal(retainedPlanUsage({ snapshot }, observedAt + 1_800_001).status, 'unavailable')
  assert.equal(retainedPlanUsage({ status: 'unavailable', code: 'OBSERVABILITY_CHANNEL_CLOSED' }).sampling.error.code, 'OBSERVABILITY_CHANNEL_CLOSED')
})
