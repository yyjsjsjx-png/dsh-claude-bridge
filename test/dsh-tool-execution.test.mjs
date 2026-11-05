import test from 'node:test'
import assert from 'node:assert/strict'
import { currentDshSelection, createStepToolAdmission, executeDshTool } from '../src/dsh-tool-execution.mjs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'

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
