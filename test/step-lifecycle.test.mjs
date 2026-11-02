import test from 'node:test'
import assert from 'node:assert/strict'
import { RunStepLifecycle } from '../src/step-lifecycle.mjs'

function fixture() {
  const events = [], phase = { step: 1 }
  const agent = { phase, session: { append(type, data) { events.push({ type, ...data }) } } }
  return { events, agent, phase, steps: new RunStepLifecycle({ agent, phase, turn: 2, step: 1 }) }
}

test('首次模型响应复用原生步骤，后续响应才关闭并推进步骤', async () => {
  const f = fixture(), signal = new AbortController().signal
  assert.equal(await f.steps.modelStart({ signal, tools: Promise.resolve() }), 1)
  assert.deepEqual(f.events, [])
  assert.equal(await f.steps.modelStart({ signal, tools: Promise.resolve() }), 2)
  assert.deepEqual(f.events, [{ type: 'step/end', turn: 2, step: 1 }, { type: 'step/start', turn: 2, step: 2 }])
  assert.equal(f.phase.step, 2)
  assert.equal(f.agent._bridgeStepOpen, true)
})

test('已准备步骤只开启一次，下一模型响应消费准备标记后继续正常推进', async () => {
  const f = fixture(), signal = new AbortController().signal
  await f.steps.modelStart({ signal })
  assert.deepEqual(f.steps.beginPreparation(), { turn: 2, step: 2 })
  assert.equal(f.agent._bridgeStepOpen, false)
  assert.equal(f.steps.completePreparation(), 2)
  assert.equal(await f.steps.modelStart({ signal }), 2)
  assert.equal(f.events.length, 2)
  assert.equal(await f.steps.modelStart({ signal }), 3)
  assert.equal(f.steps.current, 3)
  assert.equal(f.phase.step, 3)
  assert.equal(f.events.length, 4)
})

test('等待工具期间取消不会关闭或开启步骤', async () => {
  const f = fixture(), controller = new AbortController()
  await f.steps.modelStart({ signal: controller.signal })
  let release
  const tools = new Promise(resolve => { release = resolve })
  const pending = f.steps.modelStart({ signal: controller.signal, tools })
  assert.deepEqual(f.events, [])
  controller.abort()
  release()
  assert.equal(await pending, undefined)
  assert.equal(f.steps.current, 1)
  assert.deepEqual(f.events, [])
})

test('准备失败停留在已关闭步骤，兼容循环可见关闭标记以免再次关闭', () => {
  const f = fixture()
  f.agent._bridgeStepOpen = true
  f.steps.beginPreparation()
  assert.equal(f.steps.current, 1)
  assert.equal(f.phase.step, 1)
  assert.equal(f.agent._bridgeStepOpen, false)
  assert.deepEqual(f.events, [{ type: 'step/end', turn: 2, step: 1 }])
})
