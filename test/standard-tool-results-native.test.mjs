import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { executeDshTool } from '../src/dsh-tool-execution.mjs'
import { toMcpContent, toMcpToolDefinitions, toSdkPrompt } from '../src/dsh-content.mjs'
import { asMcpResult, convertToolDefinitions, validateToolDefinitions } from '../remote/query-input.mjs'

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
const text = result => result.content.map(block => block.text).join('\n')

// These are real installed tool bodies, domains and pipelines. The root Agent
// carrier and child's LlmAdapter are synthetic; neither invokes an upstream model.
async function fixture(t, { loop = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-tool-results-'))
  const old = { DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME }
  process.env.DSH_HOME = directory
  process.env.DSH_AGENTS_HOME = join(directory, 'agents-home')
  const { Context } = await import(resolveDshModule('@deepseek-ai/cordis'))
  const { createScope } = await import(resolveDshModule('@deepseek-ai/dsh-scope'))
  const { createUserMessage } = await import(resolveDshModule('@deepseek-ai/dsh-llm'))
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'))
  const official = async name => {
    const module = await import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
    return module.default ?? module
  }
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    for (const [name, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('dsh-native-tool-results-'))
    await rm(directory, { recursive: true, force: true })
  })
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools',
    'dsh-fs-local', 'dsh-working-directory']) {
    await ctx.plugin(await official(name), name === 'dsh-fs-local' ? { cwd: directory }
      : name === 'dsh-working-directory' ? { defaultDirectory: directory } : {})
  }
  if (typeof ctx.tools.setExecutor === 'function') await ctx.plugin(await official('dsh-tool-executor-native'), {})
  if (!loop && typeof ctx.agents.turnBoundaryOf !== 'function') {
    // rc.5's loop owns this public projection; newer AgentRegistry owns it.
    const { turnBoundaryProjectionDefinition } = await import(resolveDshModule('@deepseek-ai/dsh-agent-loop'))
    assert.ok(turnBoundaryProjectionDefinition)
    await ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  }
  const selection = { provider: 'fixture', model: 'no-model' }
  const session = ctx.sessions.create('standard-result-owner')
  const nextStep = [], nextTurn = []
  const inbox = { nextStep, nextTurn,
    append(delivery, ...messages) { (delivery === 'next-step' ? nextStep : nextTurn).push(...messages) },
    splice(delivery, ...args) { return (delivery === 'next-step' ? nextStep : nextTurn).splice(...args) },
  }
  let scope
  const agent = { id: session.id, options: selection, session, inbox, status: 'running',
    model: { current: () => selection }, get ctx() { return scope.ctx },
    inject(message) { inbox.append('next-step', message) }, send() {}, followup() {}, cancel() {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' }) }),
    runMaintenance: operation => operation(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  scope = createScope(ctx, agent)
  await ctx.agents.register(agent)
  let turn = 0, call = 0
  const open = source => {
    if (turn) session.append('turn/end', { turn, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: ++turn })
    session.append('user/message', createUserMessage({ source, content: [{ type: 'text', text: 'synthetic input' }] }), { surfaceOp: 'append' })
  }
  const execute = async (name, args, signal = new AbortController().signal, beforeDispatch = () => {}) => {
    const toolSet = typeof ctx.tools.resolve === 'function'
      ? await ctx.tools.resolve({ agent, signal, modelSelection: selection }) : undefined
    try {
      beforeDispatch()
      return await ctx.agents.withInitiator(agent, () => executeDshTool(ctx.tools,
        { agent, signal, name, arguments: args, callId: `result-${++call}` }, toolSet))
    } finally { toolSet?.dispose() }
  }
  if (loop) {
    await ctx.plugin(await official('cordis-plugin-loader'), { baseUrl: resolveDshModule('@deepseek-ai/dsh-session') })
    for (const name of ['dsh-llm', 'dsh-user-approval', 'dsh-agent-preset-registry', 'dsh-subagent', 'dsh-subagent-spawn-in-process']) {
      await ctx.plugin(await official(name), name === 'dsh-agent-preset-registry' ? { default: 'standard' } : {})
    }
    await ctx.plugin(await official('dsh-session-persistence-jsonl'), { root: join(directory, 'sessions') })
    await ctx.agentPresets.register({ id: 'standard', plugins: [] })
    await ctx.plugin(await official('dsh-agent-loop'), { agents: [] })
  }
  return { ctx, agent, directory, official, open, execute, require }
}

// The same content/effect projections used by Host dispatch and the remote MCP
// callback, without a websocket, SDK, or fabricated tool result.
async function rpcResult(result) {
  const additionalContexts = []
  for (const message of result.additionalContexts ?? []) {
    const blocks = await toSdkPrompt([message])
    assert.ok(blocks.every(block => block.type === 'text'))
    additionalContexts.push(blocks.map(block => block.text).join('\n'))
  }
  return asMcpResult({ content: await toMcpContent(result.content), isError: result.isError,
    ...(additionalContexts.length ? { additionalContexts } : {}),
    ...(result.concludesTurn ? { concludesTurn: true } : {}),
  })
}

test('实际原生 goal：自主轮收尾上下文经 batch/RPC 保留一次，人类轮仍可交互', { skip: !native }, async t => {
  const f = await fixture(t)
  await f.ctx.plugin(await f.official('dsh-goal'), {})
  await f.ctx.plugin(await f.official('dsh-tool-goal'), {})
  f.open({ kind: 'user' })
  const goal = f.ctx.goals.create(f.agent, { objective: 'synthetic goal wrap-up' })
  const paused = await f.execute('update_goal', { goal_id: goal.id, revision: goal.revision, action: 'pause' })
  assert.equal(paused.isError, false, text(paused))
  assert.deepEqual((await rpcResult(paused)).effects, { additionalContexts: [], concludesTurn: false })
  const resumed = f.ctx.goals.resume(f.agent, { id: goal.id, revision: 2 })
  f.open({ kind: 'goal', goalId: goal.id, revision: resumed.revision, round: 1 })
  const completed = await f.execute('update_goal', { goal_id: goal.id, revision: resumed.revision, action: 'complete' })
  assert.equal(completed.isError, false, text(completed))
  assert.equal(JSON.parse(text(completed)).goal.phase, 'complete')
  assert.equal(completed.additionalContexts.length, 1)
  assert.equal(completed.additionalContexts[0].source.kind, 'tool-goal')
  const { mcpResult, effects } = await rpcResult(completed)
  assert.equal(mcpResult.isError, false)
  assert.equal(effects.concludesTurn, false)
  assert.equal(effects.additionalContexts.length, 1)
  assert.match(effects.additionalContexts[0], /<goal_complete>/)
  assert.match(effects.additionalContexts[0], /synthetic goal wrap-up/)
  assert.doesNotMatch(JSON.stringify(mcpResult.content), /<goal_complete>/)
})

test('实际原生 present：保留交付事件身份，失败或取消不发布交付', { skip: !native }, async t => {
  const f = await fixture(t)
  await f.ctx.plugin(await f.official('dsh-tool-present'), { maxFiles: 2 })
  f.open({ kind: 'user' })
  const path = join(f.directory, 'synthetic.bin')
  await writeFile(path, Uint8Array.of(0, 255, 80, 75))
  const result = await f.execute('present', { files: [{ path, description: 'synthetic delivery' }] })
  assert.equal(result.isError, false, text(result))
  const deliveries = () => f.agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')
  assert.equal(deliveries().length, 1)
  assert.deepEqual(deliveries()[0].data, { turn: 1, callId: 'result-1',
    files: [{ path: await realpath(path), description: 'synthetic delivery' }] })
  const converted = await rpcResult(result)
  assert.deepEqual(converted.mcpResult.content, [{ type: 'text', text: `Presented ${await realpath(path)}` }])
  assert.deepEqual(converted.effects, { additionalContexts: [], concludesTurn: false })
  const dispose = f.ctx.on('tools/post-execute', async (exec, _result, next) => {
    await next()
    if (exec.name === 'present') return { kind: 'block', feedback: [{ type: 'text', text: 'synthetic post-execute denial' }] }
  })
  const denied = await f.execute('present', { files: [{ path }] })
  assert.equal(denied.isError, true)
  assert.equal((await rpcResult(denied)).mcpResult.isError, true)
  assert.equal(deliveries().length, 1)
  dispose()
  const abort = new AbortController()
  const cancelled = await f.execute('present', { files: [{ path }] }, abort.signal, () => abort.abort())
  assert.equal(cancelled.isError, true)
  assert.equal(cancelled.error.info.code, 'ABORTED_BEFORE_DISPATCH')
  assert.equal(deliveries().length, 1)
})

test('实际原生结构化子任务：动态 schema 进入 MCP，权威结果与结束标记保留', { skip: !native, timeout: 15000 }, async t => {
  const f = await fixture(t, { loop: true })
  const { LlmAdapter } = await import(resolveDshModule('@deepseek-ai/dsh-llm'))
  const schema = { type: 'object', additionalProperties: false,
    properties: { answer: { type: 'integer' }, note: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
    required: ['answer', 'note'] }
  const value = { answer: 42, note: null }, results = [], requests = []
  f.ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'structured_output') results.push({ exec, result })
  })
  class SyntheticAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      requests.push(options)
      assert.equal(requests.length, 1, '结构化结果提交后不能追加模型轮')
      const block = { type: 'tool-call', id: 'synthetic-structured', name: 'structured_output', arguments: JSON.stringify(value) }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
  f.ctx.llm.registerAdapter(['fixture'], new SyntheticAdapter())
  const activation = await f.ctx.subagents.startActivation({ provider: 'spawn', label: 'synthetic structured child',
    request: { parent: f.agent, prompt: [{ type: 'text', text: 'synthetic structured task' }], outputSchema: schema },
    signal: new AbortController().signal, delivery: 'caller' })
  try {
    const completed = await activation.result
    assert.equal(completed.stopReason, 'completed', completed.error)
    assert.deepEqual(completed.structured, value)
    assert.equal(requests.length, 1)
    const converted = toMcpToolDefinitions(requests[0].tools)
    const definition = converted.tools.find(tool => tool.name === 'structured_output')
    assert.ok(definition)
    assert.deepEqual(definition.inputSchema, schema)
    const zod = await import(pathToFileURL(f.require.resolve('zod')).href)
    assert.equal(convertToolDefinitions(zod, validateToolDefinitions([definition])).length, 1)
    assert.equal(results.length, 1)
    assert.equal(results[0].exec.callId, 'synthetic-structured')
    const result = await rpcResult(results[0].result)
    assert.equal(result.mcpResult.isError, false)
    assert.deepEqual(result.mcpResult.content, [{ type: 'text', text: 'Structured output recorded.' }])
    assert.deepEqual(result.effects, { additionalContexts: [], concludesTurn: true })
  } finally { await activation.dispose() }
})
