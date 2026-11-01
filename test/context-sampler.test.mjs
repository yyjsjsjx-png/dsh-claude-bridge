import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as tick, setTimeout as delay } from 'node:timers/promises'
import { createContextSampler, sanitizeCompactionMessage } from '../remote/context-sampler.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const summary = totalTokens => ({ totalTokens, maxTokens: 1000 })

test('后台上下文单飞限频，只取 summary 且剔除文本与路径', async () => {
  const pending = deferred(), frames = [], calls = []
  let clock = 1000
  const sampler = createContextSampler({ query: { getContextUsage(options) { calls.push(options); return pending.promise } },
    publish: frame => frames.push(frame), now: () => clock })
  assert.equal(sampler.request(), true)
  assert.equal(sampler.request(), false)
  await tick()
  assert.deepEqual(calls, [{ detail: 'summary' }])
  pending.resolve({ ...summary(125), memoryFiles: [{ path: '私密路径' }], categories: [
    { id: 'messages', name: '私密正文', tokens: 125, kind: 'used', path: '私密路径' }] })
  await tick()
  assert.deepEqual(frames, [{ type: 'bridge_context', observedAt: 1000, context: {
    source: 'sdk-summary-approximate', ...summary(125), categories: [{ id: 'messages', name: '会话消息', tokens: 125, kind: 'used' }] } }])
  clock = 1999
  assert.equal(sampler.request(), false)
  sampler.stop()
})

test('超时仅失效结果，不释放实际请求或重复排队', async () => {
  const pending = deferred(), frames = []
  let calls = 0
  const sampler = createContextSampler({ query: { getContextUsage() { calls++; return pending.promise } },
    publish: frame => frames.push(frame), timeoutMs: 10, minIntervalMs: 0 })
  sampler.request()
  await delay(20)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].code, 'CONTEXT_SUMMARY_TIMEOUT')
  assert.deepEqual(frames[0].context, { status: 'unknown' })
  for (let i = 0; i < 3; i++) assert.equal(sampler.request(), false)
  assert.equal(calls, 1)
  pending.resolve(summary(500))
  await tick()
  assert.equal(frames.length, 1)
  sampler.stop()
})

test('失败只发固定 unknown 码，取消与压缩代际使旧采样失效', async () => {
  const pending = deferred(), frames = [], controller = new AbortController()
  let calls = 0
  const sampler = createContextSampler({ query: { getContextUsage() {
    calls++; return calls === 1 ? pending.promise : Promise.reject(new Error('私密错误正文'))
  } }, publish: frame => frames.push(frame), signal: controller.signal, minIntervalMs: 0 })
  sampler.request()
  sampler.invalidate({ compacting: true })
  assert.equal(sampler.request(), false)
  sampler.invalidate()
  assert.equal(sampler.request(), false)
  pending.resolve(summary(900))
  await tick()
  assert.equal(frames.length, 0)
  assert.equal(sampler.request(), true)
  await tick()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].code, 'CONTEXT_SUMMARY_UNAVAILABLE')
  assert.equal(JSON.stringify(frames).includes('私密'), false)
  controller.abort()
  assert.equal(sampler.request(), false)
})

test('final 先封闭后台发布，再用新的 summary，迟到结果不会覆盖', async () => {
  const pending = deferred(), frames = []
  let calls = 0
  const sampler = createContextSampler({ query: { getContextUsage() {
    calls++; return calls === 1 ? pending.promise : Promise.resolve(summary(100))
  } }, publish: frame => frames.push(frame) })
  sampler.request()
  const final = sampler.finish()
  pending.resolve(summary(900))
  assert.deepEqual(await final, { source: 'sdk-summary-approximate', ...summary(100) })
  assert.equal(calls, 2)
  assert.deepEqual(frames, [])
  assert.equal(sampler.request(), false)
})

test('取消后晚到 summary 不再发送，并保持原请求自然收尾', async () => {
  const pending = deferred(), frames = [], controller = new AbortController()
  const sampler = createContextSampler({ query: { getContextUsage() { return pending.promise } },
    publish: frame => frames.push(frame), signal: controller.signal })
  sampler.request()
  controller.abort()
  pending.resolve(summary(900))
  await tick()
  assert.deepEqual(frames, [])
  assert.equal(sampler.request(), false)
  assert.equal(await sampler.finish(), undefined)
})

test('final 等待旧请求和新读取共用预算，未结束的读取不排第二个', async () => {
  const pending = deferred(), frames = []
  let calls = 0
  const sampler = createContextSampler({ query: { getContextUsage() { calls++; return pending.promise } },
    publish: frame => frames.push(frame), timeoutMs: 20 })
  sampler.request()
  const started = Date.now()
  const [result] = await Promise.all([sampler.finish(), delay(35)])
  assert.equal(result, undefined)
  assert.ok(Date.now() - started < 150)
  assert.equal(calls, 1)
  pending.resolve(summary(100))
  await tick()
  assert.deepEqual(frames, [])
})

test('自动压缩与状态只传固定字段和安全整数', () => {
  assert.deepEqual(sanitizeCompactionMessage({ type: 'system', subtype: 'compact_boundary', session_id: 'session',
    uuid: 'event', summary: '私密摘要', compact_metadata: { trigger: 'auto', pre_tokens: 900, post_tokens: 100,
      cumulative_dropped_tokens: 800, duration_ms: 12, private: '私密摘要', invalid: -1 } }), {
    type: 'system', subtype: 'compact_boundary', session_id: 'session', uuid: 'event', compact_metadata: {
      trigger: 'auto', pre_tokens: 900, post_tokens: 100, cumulative_dropped_tokens: 800, duration_ms: 12 } })
  assert.deepEqual(sanitizeCompactionMessage({ subtype: 'compact_boundary', compact_metadata: {
    trigger: '私密摘要', pre_tokens: -1, post_tokens: Infinity, duration_ms: 1.2 } }), {
    type: 'system', subtype: 'compact_boundary', compact_metadata: {} })
  assert.deepEqual(sanitizeCompactionMessage({ subtype: 'status', status: 'compacting', text: '私密摘要' }),
    { type: 'system', subtype: 'status', status: 'compacting' })
  assert.equal(sanitizeCompactionMessage({ subtype: 'status', status: '不支持' }), undefined)
})
