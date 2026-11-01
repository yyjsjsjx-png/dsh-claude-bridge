import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installControllerGuards } from '../plugin/controller-guards.mjs'

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)

async function nativeController() {
  const { resolveDshModule } = await import('../plugin/compat/resolve-dsh-module.mjs')
  const { SessionController } = await import(resolveDshModule('@deepseek-ai/dsh-api-session-controller'))
  const { Remote, RemoteError, remoteMethods } = await import(resolveDshModule('@deepseek-ai/dsh-typert-protocol'))
  const controller = Object.create(SessionController.prototype)
  // Run the native Remote instance initializer without starting a Host or
  // touching file-upload resolvers, persistence, credentials or user sessions.
  const initializers = []
  Remote('selectModel')(SessionController.prototype.selectModel, { kind: 'method', name: 'selectModel',
    static: false, private: false, addInitializer: callback => initializers.push(callback) })
  for (const initialize of initializers) initialize.call(controller)
  return { controller, SessionController, RemoteError, remoteMethods }
}

test('安装版原生控制器保留 RPC 签名和身份，实际调用命中实例守卫，卸载后恢复', { skip: !native }, async () => {
  const { controller, SessionController, RemoteError, remoteMethods } = await nativeController()
  const { TypertGatewayService } = await import(pathToFileURL(join(process.env.DSH_CLAUDE_BRIDGE_RESOURCES,
    'app.asar/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js')).href)
  const session = { id: 'fixture', header: { agentPreset: 'standard' } }
  let calls = 0
  controller.agents = { resolveAgent: async () => ({ agent: { id: session.id, session } }) }
  controller.commands = { async selectModel() { calls++; return { selected: {} } } }
  const registry = { async select() {} }
  const ctx = { sessionController: controller, agentPresets: registry,
    agentDefaultModel: { async saveSelection() {} },
    sessionProjections: { stateOf: () => 'standard' } }
  const gateway = Object.create(TypertGatewayService.prototype)
  Object.defineProperty(gateway, 'ctx', { value: { typert: { lookups: { definitions: () => [] } } } })
  const marker = remoteMethods(controller).find(item => item.method === 'selectModel')
  assert.ok(marker)
  const binding = { service: controller, serviceKey: 'sessionController', namespace: 'session' }
  const original = controller.selectModel
  const before = gateway.srcDescriptor(binding, marker, 'selectModel', 'session/selectModel')
  const dispose = installControllerGuards(ctx, RemoteError)
  try {
    assert.equal(Object.getPrototypeOf(controller), SessionController.prototype)
    assert.equal(SessionController.prototype.selectModel, original)
    assert.deepEqual(gateway.srcDescriptor(binding, marker, 'selectModel', 'session/selectModel'), before)
    assert.deepEqual(before.parameters.map(parameter => parameter.wire), ['request'])
    // Gateway dispatch retrieves the implementation from this same receiver.
    await assert.rejects(Reflect.get(controller, 'selectModel').call(controller,
      { sessionId: 'fixture', provider: 'claude-sdk-remote', model: 'fixture' }),
    error => error.code === 'agent-preset/locked')
    assert.equal(calls, 0)
  } finally { dispose() }
  assert.equal(controller.selectModel, original)
  assert.equal((await controller.selectModel({ sessionId: 'fixture' })).selected.constructor, Object)
  assert.equal(calls, 1)
})

test('安装版原生选型接线恢复远程模型强度与默认，写入共享记忆且普通作用域不变', { skip: !native }, async t => {
  const { controller, SessionController, RemoteError, remoteMethods } = await nativeController()
  const [{ BridgeBackend }, { BridgeState }] = await Promise.all([
    import('../src/backend.mjs'), import('../src/state.mjs'),
  ])
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-effort-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert(basename(directory).startsWith('dsh-native-effort-'))
    await rm(directory, { recursive: true, force: true })
  })
  const provider = 'claude-sdk-remote'
  const choice = (model, reasoningEffort) => ({ provider, model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
  const agents = new Map([
    ['remote', { id: 'remote', session: { id: 'remote', header: { agentPreset: provider } } }],
    ['ordinary', { id: 'ordinary', session: { id: 'ordinary', header: { agentPreset: 'standard' } } }],
  ])
  const selected = new Map([['remote', choice('a', 'high')]])
  const delegated = [], defaults = []
  const backend = Object.create(BridgeBackend.prototype)
  backend.state = new BridgeState(directory)
  backend.catalog = async () => ({ models: ['a', 'b'].map(value => ({ value, supportedEffortLevels: ['low', 'high'] })) })
  const ctx = { sessionController: controller, agentPresets: { async select() {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'ordinary', model: 'native' }),
      async saveSelection(value) { defaults.push(value) } },
    sessionProjections: { stateOf: (session, name) => name === 'agentPreset' ? session.header.agentPreset
      : { pending: selected.get(session.id) ?? null, lastUsed: null } },
    get: name => name === 'claudeBridge' ? { backend } : undefined,
    logger: { warn() { assert.fail('记忆保存不应失败') } } }
  backend.ctx = ctx
  await backend.rememberCreationSelection(choice('a', 'high'))
  await backend.rememberCreationSelection(choice('b', 'low'))
  controller.agents = { resolveAgent: async id => ({ agent: agents.get(id) }) }
  // Keep the installed selectModel and resolveAgent methods. Only their native
  // commands delegate is controlled; no replacement Base or Host is created.
  controller.commands = { async selectModel(request) {
    delegated.push(request)
    const { sessionId, ...selection } = request
    selected.set(sessionId, selection)
    await ctx.agentDefaultModel.saveSelection(selection)
    return { selected: selection }
  } }
  const original = controller.selectModel
  const originalResolve = controller.resolveAgent
  assert.equal(original, SessionController.prototype.selectModel)
  assert.equal(originalResolve, SessionController.prototype.resolveAgent)
  assert(remoteMethods(controller).some(item => item.method === 'selectModel'))
  const dispose = installControllerGuards(ctx, RemoteError)
  try {
    const select = request => Reflect.get(controller, 'selectModel').call(controller, request)
    assert.equal(Object.getPrototypeOf(controller), SessionController.prototype)
    assert.deepEqual((await select({ sessionId: 'remote', ...choice('b') })).selected, choice('b', 'low'))
    assert.deepEqual(delegated.at(-1), { sessionId: 'remote', ...choice('b', 'low') })
    assert.deepEqual(backend.state.value.creationSelection, choice('b', 'low'))
    assert.deepEqual((await select({ sessionId: 'remote', ...choice('a') })).selected, choice('a', 'high'))
    assert.deepEqual((await select({ sessionId: 'remote', ...choice('a') })).selected, choice('a'))
    assert.deepEqual(await backend.modelEffortPreferences(), { a: null, b: 'low' })
    assert.deepEqual(defaults, [])
    const memory = structuredClone(backend.state.value.modelEffortPreferences)
    const ordinary = { provider: 'ordinary', model: 'native-model', reasoningEffort: 'native-effort' }
    assert.deepEqual((await select({ sessionId: 'ordinary', ...ordinary })).selected, ordinary)
    assert.deepEqual(delegated.at(-1), { sessionId: 'ordinary', ...ordinary })
    assert.deepEqual(defaults, [ordinary])
    assert.deepEqual(backend.state.value.modelEffortPreferences, memory)
    const persisted = new BridgeState(directory)
    await persisted.ready
    assert.deepEqual(persisted.value.modelEffortPreferences, memory)
    assert.deepEqual(persisted.value.creationSelection, choice('a'))
  } finally { dispose() }
  assert.equal(controller.selectModel, original)
  assert.equal(controller.resolveAgent, originalResolve)
  assert.equal(SessionController.prototype.selectModel, original)
  const after = { sessionId: 'ordinary', provider: 'ordinary', model: 'after-unload' }
  await controller.selectModel(after)
  assert.deepEqual(delegated.at(-1), after)
})
