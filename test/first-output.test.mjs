import test from 'node:test'
import assert from 'node:assert/strict'
import { createFirstOutputObserver } from '../remote/first-output.mjs'
import { observeResponseTiming } from '../src/sdk-response-timing.mjs'

const header = (id, ttft_ms = 30, parent = null) => ({ type: 'stream_event', parent_tool_use_id: parent,
  ttft_ms, event: { type: 'message_start', message: { id } } })
const delta = (type, content, parent = null) => ({ type: 'stream_event', parent_tool_use_id: parent,
  event: { type: 'content_block_delta', delta: { type, ...content } } })
const metadata = (responseId, ms, kind) => ({ version: 1, responseId, ms, kind, source: 'sdk-first-output-estimate' })

test('远端首非空思考才附估算：头帧、空增量、心跳、签名、工具名均不触发', () => {
  const o = createFirstOutputObserver()
  const h = header('main', 30)
  assert.equal(o.observe(h, 100), h)
  for (const m of [delta('thinking_delta', { thinking: '' }), { type: 'stream_event', event: { type: 'ping' } },
    delta('signature_delta', { signature: 'opaque' }), { type: 'stream_event', event: { type: 'content_block_start',
      content_block: { type: 'tool_use', name: 'mcp__dsh__tool', input: { value: 1 } } } }]) {
    assert.equal(o.observe(m, 120).bridge_first_output, undefined)
  }
  const first = delta('thinking_delta', { thinking: 'synthetic' })
  const observed = o.observe(first, 160)
  assert.deepEqual(observed.bridge_first_output, metadata('main', 90, 'thinking'))
  assert.equal(first.bridge_first_output, undefined)
  assert.equal(h.ttft_ms, 30)
  assert.equal(o.observe(first, 180).bridge_first_output, undefined)
  assert.equal(o.observe(delta('text_delta', { text: 'later' }), 200).bridge_first_output, undefined)
  o.observe(header('stopped-empty'), 220)
  o.observe({ type: 'stream_event', event: { type: 'message_stop' } }, 230)
  o.observe(header('stopped-empty'), 240)
  assert.equal(o.observe(delta('text_delta', { text: 'replayed after stop' }), 250).bridge_first_output, undefined)
})

test('非空 text/thinking 起始内容与 JSON 增量有效，响应分别绑定且重放不移动锚点', () => {
  const o = createFirstOutputObserver()
  const cases = [
    [{ type: 'content_block_start', content_block: { type: 'text', text: ' ' } }, 'text'],
    [{ type: 'content_block_start', content_block: { type: 'thinking', thinking: 'x' } }, 'thinking'],
    [{ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }, 'tool-input'],
  ]
  for (const [index, [event, kind]] of cases.entries()) {
    const id = `api-${index}`
    o.observe(header(id, 50), 100)
    o.observe(header(id, 500), 200) // Same response replay does not replace header evidence.
    const message = { type: 'stream_event', event }
    assert.deepEqual(o.observe(message, 250).bridge_first_output, metadata(id, 200, kind))
  }
})

test('缺 header/source、倒钟或不透明先行输出不能由后续文本补造首Token', () => {
  for (const ttft of [undefined, NaN, -1, '30']) {
    const o = createFirstOutputObserver()
    o.observe({ ...header('api'), ttft_ms: ttft }, 100)
    assert.equal(o.observe(delta('text_delta', { text: 'x' }), 200).bridge_first_output, undefined)
  }
  const o = createFirstOutputObserver()
  assert.equal(o.observe(delta('text_delta', { text: 'no header' }), 0).bridge_first_output, undefined)
  o.observe(header('clock'), 100)
  assert.equal(o.observe(delta('text_delta', { text: 'backwards' }), 90).bridge_first_output, undefined)
  assert.equal(o.observe(delta('text_delta', { text: 'later' }), 200).bridge_first_output, undefined)
  o.observe(header('redacted'), 300)
  o.observe({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'redacted_thinking' } } }, 310)
  assert.equal(o.observe(delta('text_delta', { text: 'after opaque output' }), 400).bridge_first_output, undefined)
})

test('子代理及取消不改主响应锚点，不接受 SDK 输入上的伪造 bridge 字段', () => {
  let active = true
  const o = createFirstOutputObserver({ isActive: () => active })
  o.observe(header('parent', 20), 100)
  o.observe(header('child', 100, 'tool-parent'), 120)
  assert.equal(o.observe(delta('text_delta', { text: 'child' }, 'tool-parent'), 140).bridge_first_output, undefined)
  assert.deepEqual(o.observe(delta('input_json_delta', { partial_json: '{}' }), 160).bridge_first_output,
    metadata('parent', 80, 'tool-input'))
  o.observe(header('cancelled'), 200); active = false
  assert.equal(o.observe({ ...delta('text_delta', { text: 'late' }), bridge_first_output: metadata('cancelled', 1, 'text') }, 300).bridge_first_output, undefined)
})

test('客户端仅接受当前主响应首有效帧的匹配来源，不用官方 header TTFT 或本机时差', () => {
  const calls = []
  const tracker = { sourceTtft: value => calls.push(value), token() {}, failCapture() {}, responseCompleted() {} }
  const apply = message => observeResponseTiming(tracker, message, { id: 'api' }, 999999)
  apply({ ...header('api', 9000), bridge_first_output: metadata('api', 1, undefined) })
  for (const bad of [metadata('other', 1, 'thinking'), { ...metadata('api', 1, 'thinking'), source: 'sdk-response-start' },
    metadata('api', -1, 'thinking'), metadata('api', 1, 'text')]) {
    apply({ ...delta('thinking_delta', { thinking: 'x' }), bridge_first_output: bad })
  }
  apply({ ...delta('thinking_delta', { thinking: 'x' }, 'child'), bridge_first_output: metadata('api', 90, 'thinking') })
  assert.equal(calls.length, 0)
  apply({ ...delta('thinking_delta', { thinking: 'x' }), bridge_first_output: metadata('api', 90, 'thinking') })
  assert.deepEqual(calls, [{ responseId: 'api', ms: 90 }])
})
