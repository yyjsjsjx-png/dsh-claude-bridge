import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../plugin/compact-command.mjs'

test('原生 compact 命令拒绝参数、透传会话和取消信号，卸载先注销再等待运行结束', async () => {
  let command, lifecycle, finish
  let removed = false
  const operation = new Promise(resolve => { finish = resolve })
  const agent = {}, signal = new AbortController().signal
  const ctx = {
    effect(factory) { lifecycle = factory() },
    commands: { register(value) { command = value; return () => { removed = true } } },
    claudeBridge: { compact(receivedAgent, receivedSignal) {
      assert.equal(receivedAgent, agent); assert.equal(receivedSignal, signal); return operation
    } },
  }
  apply(ctx)
  const drain = lifecycle.next().value
  const unregister = lifecycle.next().value
  assert.equal(command.name, 'compact')
  assert.equal(command.handler({ rawInput: ' 多余参数' }).kind, 'error')
  const result = command.handler({ rawInput: ' ', agent, signal })
  unregister()
  assert.equal(removed, true)
  let drained = false
  const pendingDrain = drain().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  finish({ kind: 'success', text: '已确认' })
  assert.deepEqual(await result, { kind: 'success', text: '已确认' })
  await pendingDrain
})
