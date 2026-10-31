import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../plugin/recovery-command.mjs'

test('中断核实命令只在明确 confirm 时解锁，透传会话与取消信号', async () => {
  let command, unregister, removed = false
  const calls = [], agent = {}, signal = new AbortController().signal
  apply({
    effect(factory) { unregister = factory() },
    commands: { register(value) { command = value; return () => { removed = true } } },
    claudeBridge: { async recover(...args) { calls.push(args); return { kind: 'success', text: '已核对' } } },
  })
  assert.equal(command.name, 'bridge-recovery')
  assert.equal(command.handler({ rawInput: 'retry' }).kind, 'error')
  assert.equal(calls.length, 0)
  await command.handler({ rawInput: ' ', agent, signal })
  await command.handler({ rawInput: ' confirm ', agent, signal })
  assert.deepEqual(calls, [[agent, false, signal], [agent, true, signal]])
  unregister()
  assert.equal(removed, true)
})
