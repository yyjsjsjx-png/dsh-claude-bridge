import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BridgeState } from '../src/state.mjs'
import { createHash } from 'node:crypto'
import { REMOTE_PROMPT_POLICY } from '../src/remote-prompt-policy.mjs'

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
  assert.equal(a.promptPolicy, REMOTE_PROMPT_POLICY)
  assert.equal(restored.promptPolicy, REMOTE_PROMPT_POLICY)
  await assert.rejects(restarted.binding('dsh-a', 'D:\\other'), { code: 'SESSION_BINDING_MISMATCH' })
}))

test('旧绑定无提示词策略时保留原始身份和渲染，不因后台读取或续聊升级', async () => withDirectory(async directory => {
  const saved = { version: 1, deviceId: '11111111-2222-4333-8444-555555555555', sessions: {
    started: { sdkSessionId: '22222222-2222-4333-8444-555555555555', projectPath: 'D:\\project', started: true, usage: {} },
    prepared: { sdkSessionId: '33333333-2222-4333-8444-555555555555', projectPath: 'D:\\project', started: false, usage: {} },
  } }
  await writeFile(join(directory, 'state.json'), JSON.stringify(saved))
  const state = new BridgeState(directory)
  for (const id of ['started', 'prepared']) {
    const binding = await state.binding(id, 'D:\\project')
    assert.equal(Object.hasOwn(binding, 'promptPolicy'), false)
    assert.equal(binding.sdkSessionId, saved.sessions[id].sdkSessionId)
    await state.markStarted(id)
  }
  const fresh = await state.binding('new', 'D:\\project')
  assert.equal(fresh.promptPolicy, REMOTE_PROMPT_POLICY)
  const persisted = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))
  assert.equal(persisted.deviceId, saved.deviceId)
  for (const id of ['started', 'prepared']) assert.equal(Object.hasOwn(persisted.sessions[id], 'promptPolicy'), false)
  const restored = await new BridgeState(directory).binding('started', 'D:\\project')
  assert.equal(Object.hasOwn(restored, 'promptPolicy'), false)
  assert.equal(restored.sdkSessionId, saved.sessions.started.sdkSessionId)
}))

test('未知持久提示词策略明确阻止加载，不改写原状态或降回legacy', async () => withDirectory(async directory => {
  for (const promptPolicy of ['remote-v99', null, 1, {}, []]) {
    const text = JSON.stringify({ version: 1, deviceId: '11111111-2222-4333-8444-555555555555', sessions: {
      old: { sdkSessionId: '22222222-2222-4333-8444-555555555555', projectPath: 'D:\\project', started: true, promptPolicy },
    } })
    await writeFile(join(directory, 'state.json'), text)
    await assert.rejects(new BridgeState(directory).ready, { code: 'LOCAL_STATE_UNAVAILABLE' })
    assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), text)
  }
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
