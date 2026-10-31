import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BridgeState } from '../src/state.mjs'
import { createHash } from 'node:crypto'

async function withDirectory(action) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-state-'))
  try { await action(directory) }
  finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + '\\dsh-bridge-state-')
      || resolve(directory).startsWith(resolve(tmpdir()) + '/dsh-bridge-state-'))
    await rm(directory, { recursive: true, force: true })
  }
}

test('设备与原生会话绑定重启后保持，多会话不串用', async () => withDirectory(async directory => {
  const first = new BridgeState(directory)
  const a = await first.binding('dsh-a', 'D:\\project-a')
  const b = await first.binding('dsh-b', 'D:\\project-b')
  assert.notEqual(a.sdkSessionId, b.sdkSessionId)
  await first.markStarted('dsh-a')
  const restarted = new BridgeState(directory)
  const restored = await restarted.binding('dsh-a', 'D:\\project-a')
  assert.equal(restored.sdkSessionId, a.sdkSessionId)
  assert.equal(restored.deviceId, a.deviceId)
  assert.equal(restored.started, true)
  await assert.rejects(restarted.binding('dsh-a', 'D:\\other'), { code: 'SESSION_BINDING_MISMATCH' })
}))

test('状态损坏不生成新身份；重放用量不重复累计', async () => withDirectory(async directory => {
  const state = new BridgeState(directory)
  await state.binding('dsh-a', 'D:\\project-a')
  assert.equal(await state.recordUsage('dsh-a', 'run-a', { usage: { input_tokens: 3 } }), true)
  assert.equal(await state.recordUsage('dsh-a', 'run-a', { usage: { input_tokens: 6 } }), false)
  await writeFile(join(directory, 'state.json'), '{invalid')
  await assert.rejects(new BridgeState(directory).ready, { code: 'LOCAL_STATE_UNAVAILABLE' })
}))

test('运行与工具先持久登记，重启保留未知门禁，确认不伪造原执行结果', async () => withDirectory(async directory => {
  const state = new BridgeState(directory)
  await state.binding('dsh-a', 'D:\\project-a')
  await state.beginRun('dsh-a', 'run-1')
  await state.markRunSent('dsh-a', 'run-1')
  const signature = createHash('sha256').update('private-tool-arguments').digest('hex')
  await state.beginTool('dsh-a', 'run-1', 'call-1', 'local_command', signature)
  await state.markToolDispatched('dsh-a', 'run-1', 'call-1', 7)
  const restarted = new BridgeState(directory)
  await restarted.ready
  assert.equal((await restarted.recoveryStatus('dsh-a'))[0].tools['call-1'].status, 'dispatched')
  await assert.rejects(restarted.beginRun('dsh-a', 'run-2'), { code: 'RECOVERY_REQUIRED' })
  assert.equal(await restarted.acknowledgeRecovery('dsh-a'), 1)
  assert.equal(restarted.value.sessions['dsh-a'].runs['run-1'].status, 'sent')
  assert.equal(restarted.value.sessions['dsh-a'].runs['run-1'].tools['call-1'].status, 'dispatched')
  assert.equal(JSON.stringify(restarted.value).includes('private-tool-arguments'), false)
  await restarted.beginRun('dsh-a', 'run-2')
  await restarted.markRunSent('dsh-a', 'run-2')
  await restarted.requestStop('dsh-a', 'run-2')
  await assert.rejects(restarted.beginTool('dsh-a', 'run-2', 'call-2', 'local_command', signature), { code: 'RUN_STOPPED' })
  await restarted.finishRun('dsh-a', 'run-2', 'cancelled')
  assert.deepEqual(await restarted.recoveryStatus('dsh-a'), [])
}))

test('已知工具结果只保存 DSH 事件引用；写入失败阻止派发，不静默丢失未知状态', async () => withDirectory(async directory => {
  const state = new BridgeState(directory)
  await state.binding('dsh-a', 'D:\\project-a')
  await state.beginRun('dsh-a', 'run-1')
  const save = state.save.bind(state)
  state.save = async () => { throw new Error('磁盘不可写') }
  await assert.rejects(state.markRunSent('dsh-a', 'run-1'), /磁盘不可写/)
  assert.equal(state.value.sessions['dsh-a'].runs['run-1'].status, 'prepared')
  state.save = save
  await state.markRunSent('dsh-a', 'run-1')
  await state.beginTool('dsh-a', 'run-1', 'call-1', 'read', 'a'.repeat(64))
  await state.markToolDispatched('dsh-a', 'run-1', 'call-1', 3)
  await state.finishTool('dsh-a', 'run-1', 'call-1', 'completed', 4)
  await assert.rejects(state.beginTool('dsh-a', 'run-1', 'call-1', 'read', 'a'.repeat(64)), { code: 'TOOL_ALREADY_RECORDED' })
  await state.finishRun('dsh-a', 'run-1', 'completed')
  assert.equal(state.value.sessions['dsh-a'].runs['run-1'].tools['call-1'].resultSeq, 4)
  assert.deepEqual(await state.recoveryStatus('dsh-a'), [])
}))
