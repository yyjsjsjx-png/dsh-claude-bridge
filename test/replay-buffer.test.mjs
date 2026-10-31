import test from 'node:test'
import assert from 'node:assert/strict'
import { createReplayBuffer } from '../src/replay-buffer.mjs'

test('恢复帧按序提交后才确认，重复帧不再投递，缺口明确失败', async () => {
  let commit, deliveries = 0
  const barrier = new Promise(resolve => { commit = resolve })
  const sender = createReplayBuffer({ maxLineBytes: 1024, onLine() {} })
  const receiver = createReplayBuffer({ maxLineBytes: 1024, async onLine() { deliveries++; await barrier } })
  sender.enqueue('{"jsonrpc":"2.0","method":"sdk.message","params":{"synthetic":true}}\n')
  const frame = [...sender.frames()][0]
  sender.markTransmitted(frame.id)
  const accepting = receiver.accept(frame.line)
  assert.equal(receiver.received, 0)
  assert.equal(deliveries, 1)
  commit(); await accepting
  assert.equal(receiver.received, 1)
  assert.equal(await receiver.accept(frame.line), false)
  assert.equal(deliveries, 1)
  sender.acknowledge(receiver.received)
  assert.equal(sender.size, 0)
  assert.equal(sender.bytes, 0)
  const gap = JSON.parse(frame.line); gap._bridge.sequence = 3
  await assert.rejects(receiver.accept(JSON.stringify(gap) + '\n'), { code: 'RECOVERY_SEQUENCE_GAP' })
})

test('恢复缓冲满时停止接收，不能确认未发送的数据', () => {
  const buffer = createReplayBuffer({ maxLineBytes: 1024, maxBytes: 1024, maxFrames: 1, onLine() {} })
  buffer.enqueue('{"jsonrpc":"2.0","method":"first"}\n')
  assert.throws(() => buffer.acknowledge(1), { code: 'RECOVERY_ACK_INVALID' })
  assert.throws(() => buffer.enqueue('{"jsonrpc":"2.0","method":"second"}\n'), { code: 'RECOVERY_BUFFER_FULL' })
  assert.equal(buffer.size, 1)
})
