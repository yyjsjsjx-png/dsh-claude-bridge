import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { BridgeBackend } from '../src/backend.mjs'
import { BridgeState } from '../src/state.mjs'
import { readModelEffortPreferences, applyModelEffortPreference } from '../src/model-preferences.mjs'
import { makeGuardedSessionController } from '../plugin/controller-guards.mjs'
import { encodeRemoteCreationSelection } from '../plugin/policy.mjs'
import { createPickerController } from '../plugin/ui/client/picker-controller.mjs'
import { createStore } from '../plugin/ui/client/store.mjs'

const provider = 'claude-sdk-remote'
const selected = (model, reasoningEffort) => ({ provider, model,
  ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })

async function preferences(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-effort-memory-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert(basename(directory).startsWith('dsh-effort-memory-'))
    await rm(directory, { recursive: true, force: true })
  })
  const backend = Object.create(BridgeBackend.prototype)
  backend.state = new BridgeState(directory)
  backend.ctx = { agentDefaultModel: { currentSelection: () => ({ provider: 'ordinary', model: 'native' }) } }
  const models = ['a', 'b'].map(value => ({ value, supportedEffortLevels: ['low', 'high'] }))
  backend.catalog = async () => ({ status: 'ok', models })
  await backend.state.ready
  return { backend, directory, models }
}

test('远程模型逐个记住成功选型，默认用 null 保存，重启后仍与显示偏好独立', async t => {
  const { backend, directory } = await preferences(t)
  await backend.rememberCreationSelection(selected('a', 'high'))
  await backend.rememberCreationSelection(selected('b', 'low'))
  assert.deepEqual(await backend.applyModelEffortPreference(selected('a'), selected('b')), selected('a', 'high'))
  assert.deepEqual(await backend.applyModelEffortPreference(selected('b'), selected('a')), selected('b', 'low'))
  await backend.rememberCreationSelection(selected('a'))
  assert.deepEqual(await backend.modelEffortPreferences(), { a: null, b: 'low' })
  const restored = new BridgeState(directory)
  await restored.ready
  assert.deepEqual(restored.value.creationSelection, selected('a'))
  assert.deepEqual(restored.value.modelEffortPreferences, { version: 1, byModel: { b: 'low', a: null } })
  assert.equal(restored.value.modelPreferences, undefined)
  backend.state = restored
  assert.deepEqual(await backend.applyModelEffortPreference(selected('a'), selected('b')), selected('a'))
  assert.deepEqual(await backend.applyModelEffortPreference(selected('b'), selected('a')), selected('b', 'low'))
})

test('旧选型可作为记忆种子，过期强度或无强度目录退回模型默认', async t => {
  const { backend, models } = await preferences(t)
  backend.state.value.creationSelection = selected('a', 'high')
  assert.deepEqual(await backend.modelEffortPreferences(), { a: 'high' })
  models[0].supportedEffortLevels = ['low']
  assert.deepEqual(await backend.applyModelEffortPreference(selected('a'), selected('b')), selected('a'))
  models[0].supportedEffortLevels = []
  assert.deepEqual(await backend.applyModelEffortPreference(selected('a'), selected('b')), selected('a'))
  assert.deepEqual(readModelEffortPreferences({ creationSelection: { provider: 'ordinary', model: 'native', reasoningEffort: 'high' } }), {})
  const explicitDefault = { ...selected('a'), reasoningEffort: undefined }
  assert.deepEqual(applyModelEffortPreference(explicitDefault, selected('b'), { a: 'high' }, models), selected('a'))
  assert.deepEqual(applyModelEffortPreference(selected('a'), selected('a', 'high'), { a: 'high' }, models), selected('a'))
})

test('原生远程入口换模型恢复记忆、同模型默认清除记忆，失败与普通模型不写偏好', async t => {
  const { backend, models } = await preferences(t)
  await backend.rememberCreationSelection(selected('a', 'high'))
  await backend.rememberCreationSelection(selected('b', 'low'))
  const agents = new Map(), selections = new Map(), calls = []
  const add = (id, preset, selection) => {
    agents.set(id, { id, session: { id, header: { agentPreset: preset } } })
    selections.set(id, selection)
  }
  add('remote', provider, selected('a', 'high'))
  add('ordinary', 'standard', { provider: 'ordinary', model: 'native' })
  const ctx = { agentPresets: { defaultId: 'standard' },
    agentDefaultModel: { currentSelection: () => ({ provider: 'ordinary', model: 'native' }) },
    get: name => name === 'claudeBridge' ? { backend } : undefined,
    sessionProjections: { stateOf: (session, name) => name === 'agentPreset' ? session.header.agentPreset
      : { pending: selections.get(session.id) ?? null, lastUsed: null } },
    llm: { listModels: async () => models.map(model => ({ id: model.value })), resolveCallConfig: async () => ({}) },
    logger: { warn() {} }, reject: false }
  class NativeController {
    async resolveAgent(id) { return { agent: agents.get(id) } }
    async selectModel(request) {
      calls.push(request)
      if (ctx.reject) throw new Error('controlled selection failure')
      const selection = { provider: request.provider, model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }) }
      selections.set(request.sessionId, selection)
      return { selected: selection }
    }
    async create(request) {
      add('created', request.agentPreset)
      return { sessionId: 'created', agentPreset: request.agentPreset }
    }
  }
  const Controller = makeGuardedSessionController(NativeController, Error)
  const controller = new Controller(ctx)
  assert.deepEqual((await controller.selectModel({ sessionId: 'remote', ...selected('b') })).selected, selected('b', 'low'))
  assert.deepEqual((await controller.selectModel({ sessionId: 'remote', ...selected('a') })).selected, selected('a', 'high'))
  assert.deepEqual((await controller.selectModel({ sessionId: 'remote', ...selected('a') })).selected, selected('a'))
  assert.equal((await backend.modelEffortPreferences()).a, null)
  const before = structuredClone(backend.state.value.modelEffortPreferences)
  ctx.reject = true
  await assert.rejects(controller.selectModel({ sessionId: 'remote', ...selected('b', 'high') }), /controlled/)
  assert.deepEqual(backend.state.value.modelEffortPreferences, before)
  ctx.reject = false
  const native = { sessionId: 'ordinary', provider: 'ordinary', model: 'another', reasoningEffort: 'native-effort' }
  await controller.selectModel(native)
  assert.deepEqual(calls.at(-1), native)
  assert.deepEqual(backend.state.value.modelEffortPreferences, before)
  // Explicit model default in the creation dialog must not restore a stored high.
  await backend.rememberCreationSelection(selected('a', 'high'))
  await controller.create({ agentPreset: encodeRemoteCreationSelection(selected('a')) })
  assert.deepEqual(selections.get('created'), selected('a'))
  assert.equal((await backend.modelEffortPreferences()).a, null)
})

test('新建入口切换模型读取共享记忆，未提交草稿不记忆，失效强度与显式默认可创建', async () => {
  const modelEfforts = { a: 'high', b: 'low' }
  const models = ['a', 'b'].map(id => ({ id, reasoning: { efforts: ['low', 'high'].map(id => ({ id })) } }))
  const calls = [], opened = []
  let reject = false
  const picker = createPickerController({ createStore, textError: error => error.message,
    rpc: { visibleModels: async () => ({ ok: true, value: { models, selection: selected('a', 'high'), modelEfforts } }) },
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w', sessionIds: ['s'] }] }) } },
    sessions: { async create(request) { calls.push(request); if (reject) throw new Error('controlled creation failure'); return 'new' } },
    uiWorkspace: { openSession: id => opened.push(id) } })
  await picker.open('s')
  assert.equal(picker.store.getSnapshot().effort, 'high')
  picker.selectModel('b')
  assert.equal(picker.store.getSnapshot().effort, 'low')
  picker.selectEffort('high')
  picker.selectModel('a'); picker.selectModel('b')
  assert.equal(picker.store.getSnapshot().effort, 'low')
  modelEfforts.b = 'removed'
  picker.selectModel('b')
  assert.equal(picker.store.getSnapshot().effort, '')
  modelEfforts.b = null
  picker.selectModel('b')
  assert.equal(picker.store.getSnapshot().effort, '')
  reject = true
  await picker.create()
  assert.equal(picker.store.getSnapshot().open, true)
  assert.equal(picker.store.getSnapshot().busy, false)
  assert.deepEqual(modelEfforts, { a: 'high', b: null })
  reject = false
  await picker.create()
  const marker = calls.at(-1).agentPreset
  assert.deepEqual(JSON.parse(decodeURIComponent(marker.slice(marker.indexOf(':') + 1))), { model: 'b' })
  assert.deepEqual(opened, ['new'])
  assert.equal(picker.store.getSnapshot().open, false)
})
