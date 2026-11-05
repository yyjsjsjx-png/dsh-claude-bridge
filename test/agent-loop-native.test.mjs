import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)

test('实际 rc5：配置继承、双路 driver、原生预设切换及单 factory 卸载回退', { skip: !native, timeout: 15000 }, async t => {
  const { Context, Service } = await import(resolveDshModule('@deepseek-ai/cordis'))
  const { AgentLoop: NativeAgentLoop } = await import(resolveDshModule('@deepseek-ai/dsh-agent-loop'))
  const { LlmAdapter, createUserMessage } = await import(resolveDshModule('@deepseek-ai/dsh-llm'))
  const { Loader, EntryTree } = await import(resolveDshModule('@deepseek-ai/cordis-plugin-loader'))
  const { RemoteError } = await import(resolveDshModule('@deepseek-ai/dsh-typert-protocol'))
  const preparationMethod = typeof NativeAgentLoop.prototype.prepare === 'function' ? 'prepare' : 'initializeAgent'
  const { AgentLoop: CompatAgentLoop } = await import(preparationMethod === 'prepare'
    ? '../plugin/compat/agent-loop.mjs' : '../plugin/compat/desktop-022/agent-loop.mjs')
  const { RoutedAgentLoop, apply } = await import('../plugin/agent-loop.mjs')
  const { installControllerGuards } = await import('../plugin/controller-guards.mjs')
  const { BridgeBackend } = await import('../src/backend.mjs')
  const runtime = await import('../plugin/compat/runtime.mjs')
  const { appendPluginRecord, SESSION_FORMAT_VERSION } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'))
  const official = async name => {
    const module = await import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
    return module.default ?? module
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-route-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const ctx = new Context()
  let backend
  t.after(async () => {
    await ctx.fiber.dispose()
    await backend?.dispose()
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('dsh-native-route-'))
    await rm(directory, { recursive: true, force: true })
  })
  await ctx.plugin(Loader, { baseUrl: resolveDshModule('@deepseek-ai/dsh-session') })
  const projections = []
  let register
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools',
    'dsh-llm', 'dsh-agent-preset-registry', 'dsh-user-approval']) {
    await ctx.plugin(await official(name), name === 'dsh-agent-preset-registry' ? { default: 'standard' } : {})
    if (name === 'dsh-session-projection') {
      register = ctx.sessionProjections.register.bind(ctx.sessionProjections)
      t.mock.method(ctx.sessionProjections, 'register', definition => { projections.push(definition.key); return register(definition) })
    }
  }
  if (typeof ctx.tools.setExecutor === 'function') await ctx.plugin(await official('dsh-tool-executor-native'), {})
  await ctx.plugin(await official('dsh-session-persistence-jsonl'), { root: join(directory, 'sessions') })
  await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await ctx.agentPresets.register({ id: 'alternate', plugins: [] })
  await ctx.agentPresets.register({ id: 'claude-sdk-remote', plugins: [] })
  let prepares = 0, remotePrepares = 0, requests = 0, tools = 0, bridgeCalls = 0, factories = 0, releases = 0, bridgeError
  let holdRemote = false, remoteStarted, remoteAborts = 0
  const activeRemote = new Promise(resolve => { remoteStarted = resolve })
  const prepare = NativeAgentLoop.prototype[preparationMethod]
  t.mock.method(NativeAgentLoop.prototype, preparationMethod, function(...args) { prepares++; return prepare.apply(this, args) })
  const remotePrepare = CompatAgentLoop.prototype[preparationMethod]
  t.mock.method(CompatAgentLoop.prototype, preparationMethod, function(...args) { remotePrepares++; return remotePrepare.apply(this, args) })
  const setFactory = ctx.agents.setFactory.bind(ctx.agents)
  t.mock.method(ctx.agents, 'setFactory', factory => {
    factories++
    const release = setFactory(factory)
    return () => { releases++; return release() }
  })
  ctx.tools.register({ name: 'canary', description: '合成原生工具',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { tools++; return 'synthetic tool result' } })
  ctx.tools.register({ name: 'pwsh', description: '仅声明远程最低能力，不启动进程',
    parameters: { type: 'object', properties: { command: { type: 'string' }, workdir: { type: 'string' },
      timeoutMs: { type: 'number' } }, required: ['command'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { assert.fail('本例不运行 PowerShell') } })
  class Adapter extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'fixture', name: 'Fixture' }] }
    async resolveModel(provider, id) { return { provider, id, name: 'Fixture' } }
    async *stream() {
      requests++
      if (requests === 1) yield { type: 'tool-call-delta', index: 0, id: 'native-tool', name: 'canary', argumentsDelta: '{}' }
      else yield { type: 'text-delta', index: 0, text: 'native' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['ordinary'], new Adapter())
  backend = new BridgeBackend(ctx, { stateDirectory: directory }, { helpers: { ...runtime, appendPluginRecord,
    resolveDshHome: () => directory }, createTransport: async options => ({ peer: { async request(method, params, call) {
      if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
      if (method === 'settle') return { status: 'cancelled', toolMayHaveExecuted: false }
      assert.equal(method, 'query')
      if (holdRemote) {
        remoteStarted()
        return new Promise((_resolve, reject) => call.signal.addEventListener('abort', () => {
          remoteAborts++
          reject(Object.assign(new Error('合成远程取消'), { name: 'AbortError' }))
        }, { once: true }))
      }
      await options.onNotification('sdk.message', { runId: params.runId, message: { type: 'assistant',
        message: { id: 'remote-synthetic', model: 'fixture', content: [{ type: 'text', text: 'remote' }] } } })
      await options.onNotification('sdk.message', { runId: params.runId, message: { type: 'result', subtype: 'success' } })
      return { status: 'completed' }
    }, async drainNotifications() {} }, async close() {} }) })
  class Bridge extends Service {
    constructor(context) { super(context, 'claudeBridge') }
    async runStep(...args) {
      bridgeCalls++
      try { return await backend.runStep(...args) } catch (error) { bridgeError = error; throw error }
    }
  }
  await ctx.plugin(Bridge)
  const seed = await ctx.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: 'configured-remote',
    createdAt: 0, isSeeded: false, delegationDepth: 0, agentPreset: 'claude-sdk-remote', cwd: directory })
  await seed.flush(); await seed.close()
  class Tree extends EntryTree { write() { assert.fail('配置继承不写回原配置') } }
  const tree = new Tree(ctx.extend({ routeParallelism: 3,
    baseUrl: resolveDshModule('@deepseek-ai/dsh-session') }))
  const source = { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', disabled: true, config: {
    agents: [{ id: { __jsExpr: "ctx[Symbol.for('cordis.entry')].options.id" }, provider: 'ordinary', model: 'fixture' },
      { id: 'configured-remote', resumeSessionId: 'configured-remote', provider: 'claude-sdk-remote', model: 'fixture' }],
    maxParallelToolCalls: { __jsExpr: 'routeParallelism' },
  } }
  const original = structuredClone(source)
  assert.throws(() => apply({ fiber: {} }), error => error.code === 'DSH_API_INCOMPATIBLE')
  assert.throws(() => apply({ fiber: { entry: { parent: { tree: { resolve: () => ({ options: {
    ...source, disabled: false,
  } }) } } } } }), error => error.code === 'DSH_API_INCOMPATIBLE')
  await tree.root.update([source, { id: 'claude-agent-loop', name: new URL('../plugin/agent-loop.mjs', import.meta.url).href,
    config: { sourceEntry: 'agent-loop' } }])
  await tree.await()
  assert.ok(ctx.agentLoop instanceof RoutedAgentLoop)
  assert.equal(ctx.agentLoop.config.agents[0].id, 'agent-loop')
  assert.equal(ctx.agentLoop.config.maxParallelToolCalls.get(), 3)
  assert.deepEqual(source, original)
  assert.equal(factories, 1)
  assert.equal(projections.filter(key => key === 'inbox').length, 1)
  assert.equal(projections.filter(key => key === 'turnBoundary').length, 1)
  const owned = await ctx.agentLoop.createAgent(ctx, { sessionId: 'ordinary-native-route',
    meta: { agentPreset: 'standard' }, agentOptions: { provider: 'ordinary', model: 'fixture' } })
  const guarded = { agentPresets: ctx.agentPresets, sessionProjections: ctx.sessionProjections,
    sessionController: { async create() {}, async selectModel() {}, async prompt() {}, async fork() {} },
    agentDefaultModel: { async saveSelection() {} } }
  const disposeGuards = installControllerGuards(guarded, RemoteError)
  t.after(disposeGuards)
  await ctx.agentPresets.select(owned.agent, 'alternate')
  assert.equal(owned.agent.session.header.agentPreset, 'standard')
  assert.equal(ctx.sessionProjections.stateOf(owned.agent.session, 'agentPreset'), 'alternate')
  await assert.rejects(ctx.agentPresets.select(owned.agent, 'claude-sdk-remote'), /新建远程会话/)
  const nativeBefore = prepares
  owned.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic' }] }))
  await owned.agent.activityDone
  assert.equal(prepares, nativeBefore)
  assert.equal(requests, 2)
  assert.equal(tools, 1)
  assert.equal(bridgeCalls, 0)
  await assert.rejects(ctx.agentPresets.select(owned.agent, 'standard'), /already started/)
  const deadline = Date.now() + 5000
  while (!ctx.agents.get('configured-remote') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  const remote = ctx.agents.get('configured-remote')
  assert.ok(remote, '声明式 remote resume 应在同一原生 constructor 中完成路由')
  await assert.rejects(ctx.agentPresets.select(remote, 'standard'), /不能切换预设/)
  remote.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic' }] }))
  await remote.activityDone
  assert.equal(remotePrepares, 1)
  assert.equal(bridgeCalls, 1)
  assert.equal(bridgeError, undefined, bridgeError?.stack)
  assert.equal(requests, 2)
  assert.equal(remote.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 1)
  const bound = await backend.state.binding(remote.id, directory)
  holdRemote = true
  remote.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '合成卸载中取消' }] }))
  await activeRemote
  const loop = ctx.agentLoop, owner = loop.ownership
  assert.equal(owner, ctx.agentLoop.ownership)
  await tree.resolve('claude-agent-loop').fiber.dispose()
  assert.equal(releases, 1)
  assert.equal(owner.isActive(), false)
  assert.equal(ctx.agents.list().length, 0)
  assert.equal(remoteAborts, 1)
  assert.equal(bridgeCalls, 2)
  assert.equal(bridgeError?.name, 'AbortError')
  assert.equal((await backend.state.binding(remote.id, directory)).sdkSessionId, bound.sdkSessionId)
  await owned.dispose()
  assert.equal(releases, 1)
  disposeGuards()
  await tree.root.update([{ ...original, disabled: false }])
  await tree.await()
  assert.ok(ctx.agentLoop instanceof NativeAgentLoop)
  assert.equal(ctx.agentLoop instanceof RoutedAgentLoop, false)
  assert.equal(factories, 2)
  assert.equal(ctx.agentLoop.config.agents[0].id, 'agent-loop')
  assert.deepEqual(tree.resolve('agent-loop').options.config, original.config)
})
