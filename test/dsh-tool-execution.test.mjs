import test from 'node:test'
import assert from 'node:assert/strict'
import { currentDshSelection, createStepToolAdmission, executeDshTool } from '../src/dsh-tool-execution.mjs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { BridgeBackend } from '../src/backend.mjs'
import { ConnectionContext } from '../src/connection-context.mjs'
import { admittedRemoteAssembly, remoteCapabilityPrompt } from '../src/remote-capabilities.mjs'

test('执行器batch契约保留调用关联、准入和上下文，不让原生日志重复写入', async () => {
  const agent = {}, toolSet = {}, signal = new AbortController().signal
  const input = { agent, signal, callId: 'call-a', name: 'pwsh', arguments: { command: 'echo 1' } }
  const context = { source: { kind: 'fixture' }, content: [] }
  let executions = 0
  const tools = { resolve() {}, setExecutor() {}, async execute(batch) {
    executions++
    assert.deepEqual(batch, { agent, signal, toolSet,
      calls: [{ type: 'tool-call', id: 'call-a', name: 'pwsh', arguments: '{"command":"echo 1"}' }] })
    return { results: [{ callId: 'call-a', result: { content: [], isError: true, additionalContexts: [context],
      error: { info: { code: 'ABORTED_BEFORE_DISPATCH' } } } }], additionalContexts: [context], concluded: true }
  } }
  const result = await executeDshTool(tools, input, toolSet)
  assert.equal(result.error.info.code, 'ABORTED_BEFORE_DISPATCH')
  assert.deepEqual(result.additionalContexts, [context]); assert.equal(result.concludesTurn, true)
  assert.equal(executions, 1)
  tools.execute = async () => { executions++; return { results: [{ callId: 'other', result: {} }] } }
  await assert.rejects(executeDshTool(tools, input, toolSet), { code: 'DSH_TOOL_RESULT_INVALID' })
  assert.equal(executions, 2)
})

test('rc.5单调用契约不转换；副作用执行异常不重试', async () => {
  const input = { callId: 'legacy' }, result = { content: [] }
  let calls = 0
  const tools = { execute(value) { calls++; assert.equal(value, input); return result } }
  assert.equal(await executeDshTool(tools, input), result)
  tools.execute = () => { calls++; throw new Error('结果未知') }
  await assert.rejects(executeDshTool(tools, input), /结果未知/)
  assert.equal(calls, 2)
})

test('步骤准入幂等释放且失败候选不影响当前准入，型号优先读原生AgentModel', () => {
  const closed = [], first = { dispose() { closed.push('first') } }, second = { dispose() { closed.push('second') } }
  const rejected = { dispose() { closed.push('rejected') } }
  const owner = createStepToolAdmission(first)
  owner.release(); owner.release(first)
  owner.replace(second); owner.release(rejected); owner.close(); owner.close()
  assert.deepEqual(closed, ['first', 'rejected', 'second'])
  const current = { provider: 'remote', model: 'selected' }
  assert.equal(currentDshSelection({ sessionProjections: { stateOf() { assert.fail('新版不读弃用投影') } } },
    { model: { current: () => current } }), current)
})

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
test('实际安装执行器：Bridge单调用保留原生策略、取消和步骤准入，不调用模型', { skip: !native }, async t => {
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'))
  const official = async name => {
    const module = await import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
    return module.default ?? module
  }
  const { Context } = await import(resolveDshModule('@deepseek-ai/cordis'))
  const { createUserMessage } = await import(resolveDshModule('@deepseek-ai/dsh-llm'))
  const deferred = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic-context' }] })
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(await official('dsh-system-prompt'), {})
  await ctx.plugin(await official('dsh-tools'), {})
  const batches = typeof ctx.tools.resolve === 'function'
  if (batches) await ctx.plugin(await official('dsh-tool-executor-native'), {})
  let bodies = 0, allow = true
  ctx.on('tools/pre-execute', () => allow ? { kind: 'allow' } : { kind: 'deny', reason: 'fixture denied' })
  ctx.tools.register({ name: 'fixture_echo', description: '无副作用合成工具',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(_args, exec) { bodies++; exec.deferContext(deferred); return 'native-executor' } })
  const agent = { id: 'executor-fixture', ctx }, signal = new AbortController().signal
  const toolSet = batches ? await ctx.tools.resolve({ agent, signal, modelSelection: { provider: 'fixture', model: 'fixture' } }) : undefined
  const input = { agent, signal, callId: 'native-a', name: 'fixture_echo', arguments: {} }
  const result = await executeDshTool(ctx.tools, input, toolSet)
  assert.equal(result.isError, false)
  assert.equal(result.value, 'native-executor'); assert.equal(bodies, 1)
  assert.deepEqual(result.additionalContexts.map(message => message.id), [deferred.id])
  allow = false
  const denied = await executeDshTool(ctx.tools, { ...input, callId: 'native-denied' }, toolSet)
  assert.equal(denied.isError, true); assert.equal(bodies, 1)
  allow = true
  const abort = new AbortController(); abort.abort()
  const cancelled = await executeDshTool(ctx.tools, { ...input, callId: 'native-cancelled', signal: abort.signal }, toolSet)
  assert.equal(cancelled.error.info.code, 'ABORTED_BEFORE_DISPATCH'); assert.equal(bodies, 1)
  if (toolSet) {
    toolSet.dispose()
    const closed = await executeDshTool(ctx.tools, { ...input, callId: 'native-closed' }, toolSet)
    assert.equal(closed.isError, true); assert.equal(bodies, 1)
  }
})

test('实际网页激活与Bridge门禁：SDK路径不依赖本机凭据，配置、策略与步骤准入仍有效', { skip: !native }, async t => {
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'))
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
  const [{ Context }, prompt, tools, web, officialWeb, deepseek, projection, approval, sessionModule]
    = await Promise.all(['cordis', 'dsh-system-prompt', 'dsh-tools', 'dsh-web', 'dsh-tool-web',
      'dsh-web-deepseek-api', 'dsh-session-projection', 'dsh-user-approval', 'dsh-session'].map(load))
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  for (const module of [prompt, tools, web, projection, approval]) await ctx.plugin(module.default ?? module, {})
  if (typeof ctx.tools.resolve !== 'function') {
    // rc.5 has no provider-ready activation; its original policy seam remains.
    await ctx.plugin(officialWeb.default ?? officialWeb, { fetch: true })
    assert.ok(ctx.tools.get('web_search')); assert.ok(ctx.tools.get('web_fetch'))
    assert.equal(typeof ctx.tools.prepareScheduledExecution, 'function')
    return
  }
  const executor = await load('dsh-tool-executor-native')
  await ctx.plugin(executor.default ?? executor, {})
  const { ToolExecutionPipeline } = await import(resolveDshModule('@deepseek-ai/dsh-tools/pipeline'))
  const wrapper = await import('../plugin/remote-web.mjs')
  let credentialReads = 0, networkCalls = 0, handshakes = 0, mode = 'claude', supported = true
  const value = data => ({ get: () => data })
  deepseek.apply({ web: ctx.web, get(name) {
    if (name === 'deepseekAccount') return { async resolveToken() { credentialReads++; throw new Error('no account read') } }
    if (name === 'credentials') return { describe: async () => ({ configured: false }),
      async resolve() { credentialReads++; return undefined } }
  } }, { apiKey: value(undefined), apiKeyEnv: value('SYNTHETIC_UNSET_WEB_KEY'),
    baseURL: value('https://synthetic.invalid'), count: value(5), sendOriginalQuestion: value(false) })
  // These are actual official providers; no tool body may reach their transport.
  ctx.web.search = async () => { networkCalls++; assert.fail('不能执行本机网页请求') }
  ctx.web.fetch = async () => { networkCalls++; assert.fail('不能执行本机网页请求') }
  const { Session, SESSION_FORMAT_VERSION } = sessionModule
  const header = { version: SESSION_FORMAT_VERSION, id: 'native-web-fixture', createdAt: 0,
    isSeeded: false, delegationDepth: 0, agentPreset: 'claude-sdk-remote' }
  const agent = { id: header.id, ctx, session: Session.create(header.id, undefined, header), inject() {} }
  agent.session.append('turn/start', { turn: 1 })
  const { createScope } = await import(resolveDshModule('@deepseek-ai/dsh-scope'))
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  t.after(() => scope.dispose())
  const signal = new AbortController().signal, modelSelection = { provider: 'claude-sdk-remote', model: 'fixture' }
  const backend = Object.assign(Object.create(BridgeBackend.prototype), { connectionContext: new ConnectionContext(),
    state: { ready: Promise.resolve() },
    contextPreferences: () => ({ webToolProvider: mode }), runs: new Map(), helpers: { ToolExecutionPipeline },
    ctx: new Proxy(ctx, { get(target, key) { return key === 'agents'
      ? { withInitiator: (_agent, action) => action() } : Reflect.get(target, key, target) } }),
    async connect() {
      if (this.connection) return this.connection
      handshakes++
      const identity = this.connectionContext.capture()
      this.connectionContext.beginInitialization(identity)
      this.connectionContext.completeInitialization(identity, { capabilities: { nativeWebTools: supported } })
      this.connectionContext.bind(identity, {})
      return this.connection
    },
  })
  const mount = async (remote, config = {}) => {
    const plugin = remote ? wrapper : officialWeb
    const mounted = ctx.plugin({ inject: officialWeb.inject, apply(inner) { return plugin.apply(new Proxy(inner, { get(target, key) {
      return key === 'claudeBridge' ? { backend } : Reflect.get(target, key, target)
    } }), plugin.Config({ fetch: true, ...config })) } }, {})
    await mounted
    return mounted
  }
  const resolve = () => ctx.tools.resolve({ agent, signal, modelSelection })
  const names = toolSet => ['web_search', 'web_fetch'].filter(name => ctx.tools.get(name, agent, toolSet))
  let mounted = await mount(false), toolSet = await resolve()
  assert.deepEqual(names(toolSet), []) // Reproduces the native-only credential gate.
  toolSet.dispose(); await mounted.dispose()
  mounted = await mount(true)
  assert.equal(handshakes, 0) // Mount and history inspection do not connect.
  toolSet = await resolve()
  assert.deepEqual(names(toolSet), ['web_search', 'web_fetch']); assert.equal(handshakes, 1)
  let gate = 'ask', answer = 'allowed-once', approvals = 0, denyGuard = false, call = 0
  ctx.on('tools/pre-execute', () => ({ kind: gate, reason: 'synthetic web policy' }))
  ctx.tools.guard(() => denyGuard ? 'synthetic guard denied' : undefined)
  ctx.on('approval/request', request => { approvals++; assert.equal(request.agent, agent); return answer })
  const approve = async (admission = toolSet, callerSignal = signal, name = 'WebSearch') => {
    const id = `web-${++call}`, input = name === 'WebSearch' ? { query: 'synthetic' } : { url: 'https://example.com/' }
    const run = { signal, agent, step: 1, nativeWebTools: true, nativeApprovals: new Map(),
      settledToolIds: new Set(), toolAdmission: { current: admission },
      projection: { committedToolCalls: new Map([[id, { name, step: 1, arguments: JSON.stringify(input) }]]) } }
    backend.runs.set(id, run)
    return backend.dispatchApproval({ runId: id, toolUseId: id, toolName: name, input }, { signal: callerSignal })
  }
  assert.equal((await approve()).behavior, 'allow'); assert.equal(approvals, 1)
  assert.equal((await approve(toolSet, signal, 'WebFetch')).behavior, 'allow'); assert.equal(approvals, 2)
  answer = 'rejected'; assert.equal((await approve()).behavior, 'deny'); assert.equal(approvals, 3)
  gate = 'allow'; denyGuard = true; assert.equal((await approve()).behavior, 'deny')
  denyGuard = false
  const abort = new AbortController(); abort.abort()
  assert.equal((await approve(toolSet, abort.signal)).behavior, 'deny'); assert.equal(approvals, 3)
  const restriction = agent.ctx.inject(['tools'], inner => { inner.tools.restrict({ deny: ['web_search'] }) })
  await restriction
  assert.equal((await approve()).behavior, 'deny'); await restriction.dispose()
  // A route change after assembly cannot leak the promoted declaration to DSH.
  const assembly = { tools: ctx.tools.schemas(agent, toolSet), sections: [
    { name: 'tool:web_search', text: 'search-only native instruction' },
    { name: 'tool:web_fetch', text: 'fetch-only native instruction' },
  ] }
  mode = 'dsh'
  const converted = await backend.convertTools(assembly, modelSelection, [], false, { agent, toolSet, signal })
  assert.deepEqual(converted.tools, [])
  assert.deepEqual(converted.compatibility.map(row => row.name).sort(), ['web_fetch', 'web_search'])
  const admitted = admittedRemoteAssembly(assembly, converted)
  assert.deepEqual(admitted.tools, []); assert.deepEqual(admitted.sections, [])
  assert.match(remoteCapabilityPrompt('', converted), /web_search：网页执行路径已变化/)
  const local = await resolve(); assert.deepEqual(names(local), []); local.dispose()
  assert.equal(handshakes, 1)
  mode = 'claude'; supported = false
  backend.connectionContext.invalidate()
  const legacy = await resolve(); assert.deepEqual(names(legacy), []); legacy.dispose()
  assert.equal(handshakes, 2)
  toolSet.dispose(); assert.equal((await approve()).behavior, 'deny')
  await mounted.dispose()
  mounted = await mount(true, { search: false })
  supported = true; backend.connectionContext.invalidate()
  toolSet = await resolve(); assert.deepEqual(names(toolSet), ['web_fetch'])
  assert.equal((await approve()).behavior, 'deny')
  await mounted.dispose()
  assert.equal((await approve(toolSet, signal, 'WebFetch')).behavior, 'deny')
  toolSet.dispose()
  assert.equal(credentialReads, 0); assert.equal(networkCalls, 0)
})
