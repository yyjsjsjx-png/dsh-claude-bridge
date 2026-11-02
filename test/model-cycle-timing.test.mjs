import test from 'node:test'
import assert from 'node:assert/strict'
import { createModelCycleTiming } from '../src/model-cycle-timing.mjs'

function fixture() {
  let at = 0
  const rows = [], timing = createModelCycleTiming({ now: () => at, onTiming: row => rows.push(row) })
  const observe = (direction, message, origin) => timing.observe({ direction, message, origin, at })
  return { rows, timing, at(value) { at = value },
    query(run = 'run-one') { observe('sent', { id: 'query-' + run, method: 'query', params: { runId: run } }) },
    sdk(run, event, parent) { observe('received', { method: 'sdk.message', params: { runId: run,
      message: { type: 'stream_event', ...(parent ? { parent_tool_use_id: parent } : {}), event } } }) },
    assistant(run, id, content) { observe('received', { method: 'sdk.message', params: { runId: run,
      message: { type: 'assistant', message: { id, content } } } }) },
    start(run, id, parent) { this.sdk(run, { type: 'message_start', message: { id } }, parent) },
    text(run, parent) { this.sdk(run, { type: 'content_block_delta', delta: { type: 'text_delta', text: '合成输出' } }, parent) },
    stop(run) { this.sdk(run, { type: 'message_stop' }) },
    tool(run, callId, rpcId = 'rpc-' + callId, result = {}) {
      observe('received', { id: rpcId, method: 'tool.execute', params: { runId: run, callId } })
      observe('sent', { id: rpcId, result }, { id: rpcId, method: 'tool.execute', runId: run, callId })
    },
    prepare(run, rpcId = 'prepare-' + run, result = {}) {
      observe('received', { id: rpcId, method: 'step.prepare', params: { runId: run } })
      observe('sent', { id: rpcId, result }, { id: rpcId, method: 'step.prepare', runId: run })
    },
    finish(run, reason) { timing.finish(run, reason) },
  }
}

test('并行工具一批最后结果起计，prepare仅确认；TTFT与duration同response独立发布', () => {
  const f = fixture(), run = 'run-one'
  f.query(run); f.at(5); f.start(run, 'response-one')
  f.at(10); f.sdk(run, { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-a', name: 'synthetic' } })
  assert.equal(f.rows.length, 1)
  assert.equal(f.rows[0].kind, 'tool-name')
  f.assistant(run, 'response-one', [{ type: 'tool_use', id: 'tool-a', name: 'synthetic' },
    { type: 'tool_use', id: 'tool-b', name: 'synthetic' }])
  f.at(20); f.stop(run)
  f.at(100); f.tool(run, 'tool-b')
  f.at(200); f.tool(run, 'tool-a')
  // Same tool's cached/replayed result must not move the batch's clock.
  f.at(250); f.tool(run, 'tool-b', 'rpc-tool-b-again')
  f.at(350); f.prepare(run)
  f.at(400); f.start(run, 'response-two')
  assert.equal(f.rows.length, 2, 'message_start不是首输出')
  f.at(450); f.text(run)
  f.at(600); f.stop(run)
  f.stop(run); f.assistant(run, 'response-two', [{ type: 'text', text: '合成输出' }])
  f.finish(run)
  assert.deepEqual(f.rows.map(r => [r.responseId, r.metric, r.startBoundary, r.durationMs]), [
    ['response-one', 'first-output', 'query', 10], ['response-one', 'duration', 'query', 20],
    ['response-two', 'first-output', 'tool-results', 250], ['response-two', 'duration', 'tool-results', 400],
  ])
  assert.equal(f.rows[3].endBoundary, 'message-stop')
  assert.ok(f.rows.every(r => r.quality === 'precise'))
})

test('4轮9模型响应产生9个首输出与9个耗时，5次工具续推理各独立计数', () => {
  const f = fixture()
  let at = 0
  for (const [turn, count] of [1, 2, 3, 3].entries()) {
    const run = `run-${turn}`
    f.at(at); f.query(run)
    for (let step = 0; step < count; step++) {
      const id = `response-${turn}-${step}`
      f.at(at += 10); f.start(run, id)
      f.at(at += 10); f.text(run)
      const callId = `tool-${turn}-${step}`
      if (step < count - 1) f.assistant(run, id, [{ type: 'tool_use', id: callId, name: 'synthetic' }])
      f.at(at += 10); f.stop(run)
      if (step < count - 1) {
        f.at(at += 100); f.tool(run, callId)
        f.at(at += 50); f.prepare(run, `prepare-${turn}-${step}`)
      }
    }
    f.finish(run)
  }
  const first = f.rows.filter(r => r.metric === 'first-output'), duration = f.rows.filter(r => r.metric === 'duration')
  assert.equal(first.length, 9); assert.equal(duration.length, 9)
  assert.equal(new Set(first.map(r => `${r.runId}/${r.responseId}`)).size, 9)
  assert.equal(first.filter(r => r.startBoundary === 'query').length, 4)
  assert.equal(first.filter(r => r.startBoundary === 'tool-results').length, 5)
  assert.ok(f.rows.every(r => r.quality === 'precise'))
})

test('SDK子流与重发不抢父响应，签名/开始帧不算输出，思考与输入参数可计', () => {
  const f = fixture(), run = 'run-one'
  f.query(run); f.start(run, 'parent')
  f.at(10); f.start(run, 'child', 'tool-parent'); f.text(run, 'tool-parent')
  f.sdk(run, { type: 'content_block_delta', delta: { type: 'signature_delta', signature: '合成签名' } })
  assert.equal(f.rows.length, 0)
  f.at(30); f.sdk(run, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '合成思考' } })
  f.at(40); f.text(run); f.start(run, 'parent'); f.text(run)
  f.at(50); f.stop(run)
  assert.equal(f.rows.length, 2); assert.equal(f.rows[0].durationMs, 30)
  assert.equal(f.rows[0].kind, 'thinking')
  assert.ok(f.rows.every(r => r.responseId === 'parent'))
  f.finish(run)
  f.at(100); f.query('run-json'); f.start('run-json', 'json')
  f.at(120); f.sdk('run-json', { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } })
  assert.equal(f.rows.at(-1).kind, 'tool-input'); assert.equal(f.rows.at(-1).durationMs, 20)
  f.timing.close()
  assert.doesNotMatch(JSON.stringify(f.rows), /合成|signature|partial_json/)
})

test('缺工具结果或prepare不能猜新请求起点，无工具prepare显式标来源', () => {
  for (const missing of ['result', 'prepare']) {
    const f = fixture(), run = 'run-one'
    f.query(run); f.start(run, 'one'); f.at(10); f.text(run)
    f.assistant(run, 'one', [{ type: 'tool_use', id: 'call', name: 'synthetic' }]); f.stop(run)
    f.at(100)
    if (missing !== 'result') f.tool(run, 'call')
    if (missing !== 'prepare') f.prepare(run)
    f.start(run, 'two'); f.at(120); f.text(run); f.at(140); f.stop(run)
    const sample = f.rows.find(r => r.responseId === 'two' && r.metric === 'first-output')
    assert.equal(sample.quality, 'unknown')
    assert.equal(sample.reason, missing === 'result' ? 'TOOL_RESULTS_UNCONFIRMED' : 'PREPARATION_UNCONFIRMED')
    assert.equal(sample.durationMs, undefined)
    f.finish(run)
  }
  const f = fixture(), run = 'run-one'
  f.query(run); f.start(run, 'one'); f.at(10); f.text(run); f.stop(run)
  f.at(100); f.prepare(run); f.start(run, 'two'); f.at(125); f.text(run)
  const sample = f.rows.at(-1)
  assert.equal(sample.startBoundary, 'step-prepare'); assert.equal(sample.durationMs, 25)
  f.finish(run)
})

test('取消保留已到首输出，缺stop仅duration unknown；缺头/空输出也保留覆盖事实', () => {
  const f = fixture(), run = 'run-one'
  f.query(run); f.start(run, 'one'); f.at(10); f.text(run)
  f.finish(run, 'CANCELLED'); f.finish(run, 'CANCELLED')
  assert.equal(f.rows[0].quality, 'precise')
  assert.deepEqual([f.rows[1].metric, f.rows[1].quality, f.rows[1].reason], ['duration', 'unknown', 'CANCELLED'])
  f.query('run-missing'); f.assistant('run-missing', 'missing', [{ type: 'text', text: '合成输出' }]); f.finish('run-missing')
  assert.ok(f.rows.filter(r => r.responseId === 'missing').every(r => r.quality === 'unknown'))
  assert.equal(f.rows.find(r => r.responseId === 'missing' && r.metric === 'first-output').reason, 'MESSAGE_START_MISSING')
  f.query('run-empty'); f.start('run-empty', 'empty'); f.at(20); f.stop('run-empty')
  assert.equal(f.rows.find(r => r.responseId === 'empty' && r.metric === 'first-output').reason, 'NO_EFFECTIVE_OUTPUT')
  assert.equal(f.rows.find(r => r.responseId === 'empty' && r.metric === 'duration').quality, 'precise')
  f.query('run-close'); f.start('run-close', 'closed'); f.timing.close()
  assert.ok(f.rows.filter(r => r.responseId === 'closed').every(r => r.reason === 'CONNECTION_CLOSED'))
})

test('continue:false不建立下一请求；时钟错误与无message_stop不造精确耗时', () => {
  const f = fixture(), run = 'run-one'
  f.query(run); f.start(run, 'one'); f.at(5); f.text(run)
  f.prepare(run, 'prepare-stop', { continue: false })
  f.at(10); f.start(run, 'unexpected'); f.at(15); f.text(run)
  assert.equal(f.rows.find(r => r.responseId === 'one' && r.metric === 'duration').reason, 'MESSAGE_STOP_MISSING')
  assert.equal(f.rows.find(r => r.responseId === 'unexpected' && r.metric === 'first-output').reason, 'PREPARATION_STOPPED')
  f.finish(run)
  f.at(100); f.query('run-clock'); f.start('run-clock', 'clock'); f.at(90); f.text('run-clock')
  assert.equal(f.rows.at(-1).reason, 'CLOCK_INVALID'); f.finish('run-clock')
})

test('CLI合成占位不冒充模型响应，观察回调失败不影响下一条事件', async () => {
  const rows = [], timing = createModelCycleTiming({ onTiming: row => { rows.push(row); return Promise.reject(Error('合成失败')) } })
  timing.observe({ direction: 'sent', at: 0, message: { method: 'query', id: 'query', params: { runId: 'run-one' } } })
  timing.observe({ direction: 'received', at: 10, message: { method: 'sdk.message', params: { runId: 'run-one', message: {
    type: 'assistant', message: { id: 'synthetic', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] },
  } } } })
  timing.finish('run-one')
  assert.equal(rows.length, 0)
  timing.observe({ direction: 'sent', at: 20, message: { method: 'query', id: 'query-2', params: { runId: 'run-two' } } })
  timing.observe({ direction: 'received', at: 30, message: { method: 'sdk.message', params: { runId: 'run-two', message: {
    type: 'stream_event', event: { type: 'message_start', message: { id: 'actual' } },
  } } } })
  timing.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(rows.length, 2)
})
