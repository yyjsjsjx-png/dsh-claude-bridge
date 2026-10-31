import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { BridgeBackend } from '../src/backend.mjs'
import { planUsageSnapshot } from '../src/plan-usage.mjs'
import { BridgeState } from '../src/state.mjs'
import { assistantIdentity, UNKNOWN_TOOL_TEXT } from '../src/history-sync.mjs'
import { createHash } from 'node:crypto'

const provider = 'claude-sdk-remote'

test('清除连接关闭传输并保留设备和会话；活动任务、准备阶段和历史同步均拒绝清除', async t => {
  let closed = 0, cleared = 0, release
  const f = await fixture(t, async () => ({ peer: { async request() { return { protocolVersion: 1, authenticated: true } } },
    async close() { closed++ } }))
  f.backend.connectionSettings = { async clear() { cleared++; return { configured: false, status: 'missing' } } }
  await f.backend.state.binding(f.agent.id, f.agent.session.header.cwd)
  const before = structuredClone(f.backend.state.value)
  await f.backend.connect()
  f.backend.catalogCache = { time: Date.now(), reply: { models: [] } }
  f.backend.planUsageCache = { value: {}, until: Date.now() + 1000 }
  const preparing = f.backend.useConnection(() => new Promise(resolve => { release = resolve }))
  await assert.rejects(f.backend.clearConnection(), { code: 'BRIDGE_BUSY' })
  release(); await preparing
  f.backend.runs.set('active', {})
  await assert.rejects(f.backend.clearConnection(), { code: 'BRIDGE_BUSY' })
  f.backend.runs.clear()
  f.backend.syncing.set('active', Promise.resolve())
  await assert.rejects(f.backend.clearConnection(), { code: 'BRIDGE_BUSY' })
  f.backend.syncing.clear()
  assert.equal(cleared, 0)
  assert.equal((await f.backend.clearConnection()).configured, false)
  assert.equal(cleared, 1); assert.equal(closed, 1)
  assert.equal(f.backend.connection, undefined)
  assert.equal(f.backend.initialized, undefined)
  assert.equal(f.backend.authentication, 'unknown')
  assert.equal(f.backend.catalogCache, undefined); assert.equal(f.backend.planUsageCache, undefined)
  assert.deepEqual(f.backend.state.value, before)
})

test('清除连接中止迟到的初始化，旧关闭事件不能清掉重新建立的连接', async t => {
  let release, started, oldOptions, closed = 0, attempts = 0
  const ready = new Promise(resolve => { started = resolve })
  const f = await fixture(t, async options => {
    const first = attempts++ === 0
    if (first) oldOptions = options
    return { peer: { async request() {
      if (first) { started(); await new Promise(resolve => { release = resolve }) }
      return { protocolVersion: 1, authenticated: true }
    } }, async close() { closed++ } }
  })
  f.backend.connectionSettings = { async clear() { return { configured: false, status: 'missing' } } }
  const connecting = f.backend.connect()
  await ready
  const rejected = assert.rejects(connecting, { code: 'CONNECTION_CHANGED' })
  const clearing = f.backend.clearConnection()
  assert.equal(oldOptions.signal.aborted, true)
  release(); await rejected; await clearing
  assert.equal(closed, 1); assert.equal(f.backend.connection, undefined)
  assert.equal(f.backend.authentication, 'unknown')
  const current = await f.backend.connect()
  oldOptions.onClose()
  assert.equal(f.backend.connection, current)
})

test('清除以后旧目录、额度和登录响应不会恢复缓存或登录状态', async t => {
  const replies = new Map()
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true, capabilities: { planUsage: true } }
    return new Promise(resolve => replies.set(method, resolve))
  } }, async close() {} }))
  f.backend.connectionSettings = { async clear() { return { configured: false, status: 'missing' } } }
  await f.backend.connect()
  const catalog = f.backend.catalog(), usage = f.backend.planUsage(), auth = f.backend.refreshAuthentication()
  await new Promise(resolve => setImmediate(resolve))
  const rejectedCatalog = assert.rejects(catalog, { code: 'CONNECTION_CHANGED' })
  const rejectedAuth = assert.rejects(auth, { code: 'CONNECTION_CHANGED' })
  await f.backend.clearConnection()
  replies.get('catalog')({ status: 'ok', models: [] })
  replies.get('planUsage')(planUsageSnapshot({ rate_limits_available: true,
    rate_limits: { five_hour: { utilization: 88, resets_at: null } } }))
  replies.get('authStatus')({ loggedIn: true })
  await rejectedCatalog; await rejectedAuth
  assert.equal((await usage).code, 'CONNECTION_CHANGED')
  assert.equal(f.backend.catalogCache, undefined); assert.equal(f.backend.planUsageCache, undefined)
  assert.equal(f.backend.authentication, 'unknown')
})

test('WebSocket 关闭超时仍保存本机台账和诊断，重复卸载不再执行清理', async () => {
  const saved = []
  const backend = Object.assign(Object.create(BridgeBackend.prototype), { lifetime: new AbortController(), runs: new Map(),
    connection: { async close() { saved.push('close'); throw Object.assign(new Error('关闭超时'), { code: 'CLOSE_TIMEOUT' }) } },
    state: { async flush() { saved.push('state') } }, diagnostics: { async flush() { saved.push('diagnostics') } } })
  await assert.rejects(backend.dispose(), { code: 'CLOSE_TIMEOUT' })
  await assert.rejects(backend.dispose(), { code: 'CLOSE_TIMEOUT' })
  assert.deepEqual(saved, ['close', 'state', 'diagnostics'])
})

test('账号额度请求去重并短缓存，显式刷新可重读，不创建模型会话', async t => {
  let reads = 0
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, capabilities: { planUsage: true } }
    assert.equal(method, 'planUsage')
    reads++
    return planUsageSnapshot({ rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 88, resets_at: null } } })
  } }, async close() {} }))
  const [first, second] = await Promise.all([f.backend.planUsage(), f.backend.planUsage()])
  assert.deepEqual(first, second)
  assert.equal(reads, 1)
  first.windows[0].usedPercent = 1
  assert.equal((await f.backend.planUsage()).windows[0].usedPercent, 88)
  assert.equal(reads, 1)
  await f.backend.planUsage(true)
  assert.equal(reads, 2)
  f.backend.initialized.capabilities.planUsage = false
  assert.equal((await f.backend.planUsage(true)).status, 'unavailable')
  assert.equal(reads, 2)
  await f.backend.state.ready
  assert.deepEqual(Object.keys(f.backend.state.value.sessions), [])
})

async function prepareCompact(f) {
  f.agent.phase = { kind: 'idle' }
  f.agent.runMaintenance = async job => job(new AbortController().signal)
  const binding = await f.backend.state.binding(f.agent.id, f.agent.session.header.cwd)
  await f.backend.state.markStarted(f.agent.id)
  return binding
}

test('/compact 使用维护门禁和已有绑定，不发送 DSH 历史，成功后更新 SDK 快照', async t => {
  let outcome = 'compacted'
  const requests = []
  const f = await fixture(t, async () => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true, capabilities: { manualCompact: true } }
    assert.equal(method, 'query'); requests.push(params)
    return { status: 'completed', compaction: { status: outcome, preTokens: 100 },
      metrics: { context: { source: 'sdk-summary-approximate', totalTokens: 20, maxTokens: 1000 } } }
  } }, async close() {} }))
  const binding = await prepareCompact(f)
  const signal = new AbortController().signal
  assert.match((await f.backend.compact(f.agent, signal)).text, /已压缩远端/)
  assert.equal(f.agent._bridgeStatus.context.totalTokens, 20)
  assert.equal(requests[0].sessionId, binding.sdkSessionId)
  assert.equal(requests[0].resume, true)
  assert.equal(requests[0].action, 'compact')
  assert.equal(Object.hasOwn(requests[0], 'prompt'), false)
  assert.equal(Object.hasOwn(requests[0], 'systemPrompt'), false)
  assert.equal(Object.hasOwn(requests[0], 'tools'), false)
  assert.equal(f.records.some(record => ['assistant/message', 'user/message', 'compaction/summary'].includes(record.type)), false)
  outcome = 'unchanged'
  assert.match((await f.backend.compact(f.agent, signal)).text, /未执行压缩/)
  assert.equal(f.backend.runs.size, 0)
})

test('/compact 忙碌、缺少原生绑定或服务器能力时不发压缩请求', async t => {
  let queries = 0
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    queries++; throw new Error('不应发压缩请求')
  } }, async close() {} }))
  const signal = new AbortController().signal
  assert.match((await f.backend.compact(f.agent, signal)).text, /等待当前运行/)
  f.agent.phase = { kind: 'idle' }
  f.agent.runMaintenance = async job => job(new AbortController().signal)
  assert.match((await f.backend.compact(f.agent, signal)).text, /尚未建立/)
  await prepareCompact(f)
  assert.match((await f.backend.compact(f.agent, signal)).text, /尚未提供/)
  assert.equal(queries, 0)
})

test('/compact 取消后迟到成功不覆盖未知状态，不自动重试或声称撤销压缩', async t => {
  const controller = new AbortController()
  let queries = 0, settlements = 0
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true, capabilities: { manualCompact: true } }
    if (method === 'settle') { settlements++; return { status: 'completed' } }
    queries++
    controller.abort()
    return { status: 'completed', compaction: { status: 'compacted' } }
  } }, async close() {} }))
  await prepareCompact(f)
  assert.equal((await f.backend.compact(f.agent, controller.signal)).kind, 'error')
  assert.equal(f.agent._bridgeStatus.phase, 'unknown')
  assert.deepEqual(f.agent._bridgeStatus.context, { status: 'unknown' })
  assert.equal(queries, 1)
  assert.equal(settlements, 1)
  assert.equal(f.backend.runs.size, 0)
})

test('已确认视觉型号开放原生 read_image，并把校验后的图片工具结果送到 MCP', async (t) => {
  const data = Buffer.from('verified-image')
  const ref = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: data.length, width: 1, height: 1 }
  let called = 0
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    if (method === 'catalog') return { status: 'ok', models: [{ value: 'chosen-model', resolvedModel: 'claude-haiku-5-5' }] }
    assert.equal(method, 'query')
    assert.ok(params.tools.some(tool => tool.name === 'read_image'))
    f.backend.runs.get(params.runId).projection.committedToolCalls.set('image-call', {
      name: 'read_image', arguments: '{"path":"local.png"}',
    })
    const result = await handlers.handlers['tool.execute']({ runId: params.runId, callId: 'image-call',
      name: 'read_image', arguments: { path: 'local.png' } }, { signal: new AbortController().signal })
    assert.deepEqual(result.content, [{ type: 'image', mimeType: 'image/png', data: data.toString('base64') }])
    return { status: 'completed' }
  } }, async close() {} }), async ({ name }) => {
    assert.equal(name, 'read_image'); called++
    return { content: [{ type: 'image', attachment: ref }] }
  })
  f.ctx.attachments.readImage = async image => ({ ref: image, data })
  f.decision.assembly.tools.push({ name: 'read_image', description: '读取本机图片',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } })
  await f.backend.runStep(f.agent, f.decision)
  assert.equal(called, 1)
  assert.equal(f.agent._bridgeStatus.compatibility.model, 'chosen-model')
  assert.equal(f.agent._bridgeStatus.compatibility.tools.find(tool => tool.name === 'read_image').status, 'preserved')
  f.backend.catalogCache.reply.models[0].resolvedModel = 'unknown-model'
  const denied = await f.backend.convertTools(f.decision.assembly, f.selection)
  assert.equal(denied.tools.some(tool => tool.name === 'read_image'), false)
  assert.equal(denied.compatibility.find(tool => tool.name === 'read_image').status, 'disabled')
})

test('成功结果消费 SDK context，累计 usage 不冒充当前占用，换型号清除旧报告', async (t) => {
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    return { status: 'completed', metrics: { context: { source: 'sdk-summary-approximate', totalTokens: 123, maxTokens: 1000 } } }
  } }, async close() {} }))
  await f.backend.runStep(f.agent, f.decision)
  assert.equal(f.agent._bridgeStatus.context.totalTokens, 123)
  assert.equal(f.agent._bridgeStatus.context.percentage, 12.3)
  const captured = structuredClone(f.agent._bridgeStatus)
  f.backend.sessionStatus(f.agent, { model: 'another-model' })
  assert.deepEqual(f.agent._bridgeStatus.context, { status: 'unknown' })
  assert.equal(f.agent._bridgeStatus.compatibility, null)
  assert.equal(captured.context.totalTokens, 123)
})

test('整轮停止后冻结晚到文字，迟来的成功不能覆盖停止状态，已结束事件不污染新运行', async (t) => {
  let runId
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    if (method === 'settle') return { status: 'cancelled' }
    runId = params.runId
    f.phaseAbort.abort()
    assert.equal(f.agent._bridgeStatus.phase, 'stopping')
    await handlers.onNotification('sdk.message', { runId, message: { type: 'assistant', message: {
      id: 'late-message', content: [{ type: 'text', text: '停止后的额外说明' }],
    } } })
    return { status: 'completed' }
  }, async drainNotifications() {} }, async close() {} }))
  await assert.rejects(f.backend.runStep(f.agent, f.decision), { name: 'AbortError' })
  assert.equal(f.agent._bridgeStatus.phase, 'stopped')
  assert.equal(f.records.some(record => record.type === 'assistant/message'), false)
  await f.backend.notification('sdk.message', { runId, message: { type: 'assistant' } })
})

test('成功结果落盘期间停止，也不能被随后完成状态覆盖', async t => {
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    if (method === 'settle') return { status: 'cancelled' }
    return { status: 'completed' }
  } }, async close() {} }))
  const markStarted = f.backend.state.markStarted.bind(f.backend.state)
  f.backend.state.markStarted = async id => { await markStarted(id); f.phaseAbort.abort() }
  await assert.rejects(f.backend.runStep(f.agent, f.decision), { name: 'AbortError' })
  assert.equal(f.agent._bridgeStatus.phase, 'stopped')
})

test('工具派发后抛错会登记未知结果，不被恢复层误记为尚未执行', async (t) => {
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    f.backend.runs.get(params.runId).projection.committedToolCalls.set('unknown-call', {
      name: 'local_command', arguments: '{"command":"task"}',
    })
    return handlers.handlers['tool.execute']({ runId: params.runId, callId: 'unknown-call', name: 'local_command',
      arguments: { command: 'task' } }, { signal: new AbortController().signal })
  } }, async close() {} }), async () => { throw new Error('工具进程结果未返回') })
  await assert.rejects(f.backend.runStep(f.agent, f.decision), /工具进程结果未返回/)
  const result = f.records.find(record => record.type === 'tool/result')
  assert.ok(result)
  assert.match(result.data.message.content[0].text, /可能已产生副作用/)
  assert.equal(f.agent._bridgeStatus.toolMayHaveExecuted, true)
})

test('显示偏好默认三种 5.5，保存后可清空且不会删除完整目录', async (t) => {
  const models = [
    { value: 'o55', displayName: 'Opus 5.5' }, { value: 'h55', displayName: 'Haiku 5.5' },
    { value: 's55', displayName: 'Sonnet 5.5' }, { value: 'legacy', displayName: 'Haiku 4.5' },
  ]
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    assert.equal(method, 'catalog'); return { status: 'ok', models }
  } }, async close() {} }))
  assert.deepEqual((await f.backend.listModelPreferences()).enabledIds, ['o55', 'h55', 's55'])
  await f.backend.saveModelPreferences({ enabledIds: ['legacy'] })
  assert.deepEqual((await f.backend.visibleCatalog()).models.map(model => model.value), ['legacy'])
  assert.equal((await f.backend.catalog()).models.length, 4)
  const persisted = new BridgeState(f.backend.directory)
  await persisted.ready
  assert.deepEqual(persisted.value.modelPreferences.enabledIds, ['legacy'])
  await assert.rejects(f.backend.saveModelPreferences({ enabledIds: ['missing'] }), { code: 'MODEL_CATALOG_CHANGED' })
  await f.backend.saveModelPreferences({ enabledIds: [] })
  assert.deepEqual((await f.backend.visibleCatalog()).models, [])
})

test('目录解析并发与短期重复读取只请求一次，手动刷新另行验证登录', async (t) => {
  let catalogs = 0
  let auth = 0
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    if (method === 'authStatus') { auth++; return { loggedIn: true } }
    assert.equal(method, 'catalog'); catalogs++
    await new Promise(resolve => setTimeout(resolve, 10))
    return { status: 'ok', models: [{ value: 'test', displayName: 'Test' }] }
  } }, async close() {} }))
  await Promise.all(Array.from({ length: 20 }, () => f.backend.catalog()))
  await f.backend.catalog()
  assert.equal(catalogs, 1); assert.equal(auth, 0)
  await f.backend.catalog({ refresh: true })
  assert.equal(catalogs, 2); assert.equal(auth, 1)
})

test('用量按轮次累加 token，SDK 累计费用每会话只取最近一次', () => {
  const backend = Object.create(BridgeBackend.prototype)
  backend.state = { value: { sessions: {
    a: { usage: { first: { usage: { input_tokens: 2, output_tokens: 3 }, total_cost_usd: 0.1 },
      second: { usage: { input_tokens: 5, cache_read_input_tokens: 7 }, total_cost_usd: 0.15 } } },
    b: { usage: { third: { usage: { input_tokens: 11, cache_creation_input_tokens: 13 }, total_cost_usd: 0.2 } } },
  } } }
  assert.deepEqual(backend.usageSummary(), { sessions: 2, runs: 3, inputTokens: 18, outputTokens: 3,
    cacheReadTokens: 7, cacheWriteTokens: 13, estimatedCostUsd: 0.35, costKind: 'sdk-estimate' })
})

test('主动认证检查会更新长连接旧登录状态', async (t) => {
  let loggedIn = true
  let checks = 0
  const f = await fixture(t, async () => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    assert.equal(method, 'authStatus'); assert.equal(params.refresh, true); checks++
    return { loggedIn }
  } }, async close() {} }))
  await f.backend.refreshAuthentication()
  assert.equal(f.backend.authentication, 'logged-in')
  loggedIn = false
  await assert.rejects(f.backend.refreshAuthentication(), { code: 'AUTH_REQUIRED' })
  assert.equal(f.backend.authentication, 'login-required')
  assert.equal(checks, 2)
})

test('认证状态网络错误保留原错误，不误报账号已退出', async (t) => {
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    return { status: 'failed', code: 'NETWORK', message: '连接认证服务失败' }
  } }, async close() {} }))
  await assert.rejects(f.backend.refreshAuthentication(), { code: 'NETWORK' })
  assert.equal(f.backend.authentication, 'verification-failed')
})

test('SDK 工具批次之间运行 DSH preStep，下一模型响应复用已准备步骤', async (t) => {
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    assert.equal(method, 'query')
    const run = f.backend.runs.get(params.runId)
    await run.projection.modelStart('model-first')
    const reply = await handlers.handlers['step.prepare']({ runId: params.runId }, { signal: new AbortController().signal })
    assert.deepEqual(reply.additionalContexts, ['嵌套目录的指令'])
    await run.projection.modelStart('model-second')
    assert.equal(run.step, 2)
    assert.equal(f.agent.phase.step, 2)
    return { status: 'completed' }
  } }, async close() {} }))
  f.agent.inbox = { nextStep: [], splice() { throw new Error('不应恢复已投递上下文') } }
  f.agent.preStep = async (target, position) => {
    assert.equal(target, 'next-step'); assert.equal(position.step, 2)
    assert.equal(f.records.findLast(record => record.type === 'step/end').data.step, 1)
    return { ...f.decision, messages: [{ id: 'nested-instruction', role: 'user', source: { kind: 'agent-instructions' },
      content: [{ type: 'text', text: '嵌套目录的指令' }] }] }
  }
  await f.backend.runStep(f.agent, f.decision)
  assert.equal(f.records.filter(record => record.type === 'step/start').length, 1)
  assert.equal(f.records.filter(record => record.type === 'step/end').length, 1)
})

test('普通工具批次没有新上下文时仍允许进入下一步骤', async (t) => {
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    assert.equal(method, 'query')
    const run = f.backend.runs.get(params.runId)
    await run.projection.modelStart('model-first')
    assert.deepEqual(await handlers.handlers['step.prepare']({ runId: params.runId }, { signal: new AbortController().signal }), {})
    await run.projection.modelStart('model-second')
    assert.equal(run.step, 2)
    return { status: 'completed' }
  } }, async close() {} }))
  f.agent.inbox = { nextStep: [], splice() { throw new Error('无需恢复消息') } }
  f.agent.preStep = async () => ({ ...f.decision, messages: [] })
  assert.deepEqual(await f.backend.runStep(f.agent, f.decision), { kind: 'completed' })
})

test('批次准备拒绝变化配置时恢复已认领消息，防止指令丢失', async (t) => {
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    assert.equal(method, 'query')
    await assert.rejects(handlers.handlers['step.prepare']({ runId: params.runId },
      { signal: new AbortController().signal }), { code: 'QUERY_CONFIGURATION_CHANGED' })
    assert.deepEqual(f.agent.inbox.nextStep.map(message => message.id), ['pending-note', 'nested-note'])
    return { status: 'completed' }
  } }, async close() {} }))
  const note = id => ({ id, role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: id }] })
  f.agent.inbox = { nextStep: [note('pending-note')], splice(_target, at, count, messages) { this.nextStep.splice(at, count, ...messages) } }
  f.agent.preStep = async () => {
    f.agent.inbox.nextStep = []
    return { ...f.decision, assembly: { tools: [] }, messages: [note('pending-note'), note('nested-note')] }
  }
  await f.backend.runStep(f.agent, f.decision)
})

async function fixture(t, makeTransport, execute) {
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, 'dsh-bridge-backend-'))
  t.after(async () => {
    if (dirname(resolve(directory)) !== parent || !directory.startsWith(join(parent, 'dsh-bridge-backend-'))) throw new Error('测试目录无效')
    await rm(directory, { recursive: true, force: true })
  })
  const records = []
  const phaseAbort = new AbortController()
  const selection = { provider, model: 'chosen-model', reasoningEffort: 'low' }
  const ctx = {
    sessionProjections: { stateOf() { return { pending: selection } } },
    systemPrompt: { refreshContext() { return [] } },
    fs: { processPathFromHostPath(path) { return path } }, attachments: {},
    tools: { execute }, agents: { withInitiator(_agent, operation) { return operation() } },
    sessions: { async flush() { return true } },
  }
  const helpers = {
    resolveDshHome() { return directory },
    appendPluginRecord(session, type, data) { return session.append(type, data).seq },
    renderPrompt() { return 'DSH 测试预设' },
    createToolResultMessage({ callId, content, isError }) {
      return { id: 'synthetic-result', role: 'tool', source: { kind: 'tool-result', callId }, content, isError }
    },
    // Used by newer backend revisions to mirror rc.5 runtime-context projection.
    assembleContextFor() { return {} }, renderContextSections() { return [] }, joinContextSections() { return '' },
  }
  const session = {
    header: { agentPreset: provider, cwd: 'D:\\project' },
    requestHeader() { return { config: { provider, model: 'previous-model' } } },
    append(type, data, intent) { records.push({ type, data, intent }); return { seq: records.length } },
  }
  const agent = {
    id: 'session-a', phase: { kind: 'running', turn: 1, step: 1, abort: phaseAbort },
    session, options: { provider, model: 'previous-model' },
    systemPrompt: { project() { return [] } },
    runtimeContext: { project() { return undefined } },
    loopCtx: { systemPrompt: { refreshContext() { return [] } } },
    dispatch: { emit() {} },
  }
  const decision = {
    assembly: { tools: [{ name: 'local_command', description: '执行本机命令', parameters: {
      type: 'object', additionalProperties: false, properties: { command: { type: 'string' } }, required: ['command'],
    } }] },
    messages: [{ id: 'user-1', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: '测试' }] }],
  }
  const backend = new BridgeBackend(ctx, { stateDirectory: directory }, { helpers, createTransport: makeTransport })
  t.after(() => backend.dispose())
  return { backend, agent, decision, records, phaseAbort, ctx, helpers, selection }
}

test('pending 模型优先，重复 callId 只执行一次并记录关联结果', async (t) => {
  let count = 0
  let request
  const f = await fixture(t, async (handlers) => ({
    peer: {
      async request(method, params) {
        if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
        if (method !== 'query') throw new Error('unexpected method')
        request = params
        const call = { runId: params.runId, callId: 'toolu_test', name: 'local_command', arguments: { command: 'pwd' } }
        f.backend.runs.get(params.runId).projection.committedToolCalls.set(call.callId, {
          name: call.name, arguments: '{\n  "command": "pwd"\n}',
        })
        const signal = new AbortController().signal
        const first = await handlers.handlers['tool.execute'](call, { signal })
        const second = await handlers.handlers['tool.execute'](call, { signal })
        assert.deepEqual(first, second)
        await assert.rejects(handlers.handlers['tool.execute']({ ...call, arguments: { command: 'different' } }, { signal }),
          { code: 'TOOL_ARGUMENTS_MISMATCH' })
        return { status: 'completed' }
      },
      async drainNotifications() {},
    }, async close() {},
  }), async () => { count++; return { content: [{ type: 'text', text: '完成' }], isError: false } })
  assert.deepEqual(await f.backend.runStep(f.agent, f.decision), { kind: 'completed' })
  assert.equal(request.model, 'chosen-model')
  assert.equal(request.effort, 'low')
  assert.equal(count, 1)
  const callIndex = f.records.findIndex((entry) => entry.type === 'tool/call')
  const result = f.records.find((entry) => entry.type === 'tool/result')
  assert.ok(callIndex >= 0)
  assert.equal(f.records[callIndex].data.arguments, '{\n  "command": "pwd"\n}')
  assert.equal(result.data.message.source.callId, 'toolu_test')
  assert.deepEqual(result.intent.sourceEventSeqs, [callIndex + 1])
})

test('取消后等待远端 settle 与已启动的本机工具 drain', async (t) => {
  let started, finishTool, settled
  const ready = new Promise((resolveStarted) => { started = resolveStarted })
  const pendingTool = new Promise((resolveFinish) => { finishTool = resolveFinish })
  const stopObserved = new Promise(resolve => { settled = resolve })
  let settleRequested = false
  const f = await fixture(t, async (handlers) => ({
    peer: {
      async request(method, params, options = {}) {
        if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
        if (method === 'settle') { settleRequested = true; settled(); return { status: 'cancelled', toolMayHaveExecuted: true } }
        if (method !== 'query') throw new Error('unexpected method')
        f.backend.runs.get(params.runId).projection.committedToolCalls.set('toolu_delayed', {
          name: 'local_command', arguments: '{"command":"pwd"}',
        })
        void handlers.handlers['tool.execute']({ runId: params.runId, callId: 'toolu_delayed', name: 'local_command', arguments: { command: 'pwd' } },
          { signal: new AbortController().signal }).catch(() => {})
        await new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => {
            assert.ok(f.backend.state.value.sessions[f.agent.id].runs[params.runId].stopRequestedAt)
            reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
          }, { once: true })
        })
      },
      async drainNotifications() {},
    }, async close() {},
  }), async () => { started(); await pendingTool; return { content: [{ type: 'text', text: '完成' }], isError: false } })
  let ended = false
  const running = f.backend.runStep(f.agent, f.decision).finally(() => { ended = true })
  await ready
  f.phaseAbort.abort()
  await stopObserved
  assert.equal(settleRequested, true)
  assert.equal(ended, false)
  finishTool()
  await assert.rejects(running, { name: 'AbortError' })
  assert.ok(f.records.some((entry) => entry.type === 'tool/result'))
})

test('DSH 调用事件不能可靠落盘时，不执行本机工具', async t => {
  let count = 0
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    f.backend.runs.get(params.runId).projection.committedToolCalls.set('blocked-call', {
      name: 'local_command', arguments: '{"command":"private-side-effect"}',
    })
    f.ctx.sessions.flush = async () => false
    await assert.rejects(handlers.handlers['tool.execute']({ runId: params.runId, callId: 'blocked-call',
      name: 'local_command', arguments: { command: 'private-side-effect' } }, { signal: new AbortController().signal }),
    { code: 'DURABILITY_UNAVAILABLE' })
    f.ctx.sessions.flush = async () => true
    return { status: 'failed', code: 'TOOL_FAILED' }
  } }, async close() {} }), async () => { count++; return { content: [] } })
  await assert.rejects(f.backend.runStep(f.agent, f.decision), { code: 'TOOL_FAILED' })
  assert.equal(count, 0)
  const run = Object.values(f.backend.state.value.sessions[f.agent.id].runs)[0]
  assert.equal(run.tools['blocked-call'].status, 'not-sent')
  assert.equal(JSON.stringify(run).includes('private-side-effect'), false)
})

test('旧运行状态不明确时阻止新 query，用户核实命令只解锁后续对话', async t => {
  let queries = 0
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    queries++; return { status: 'completed' }
  } }, async close() {} }))
  await f.backend.state.binding(f.agent.id, f.agent.session.header.cwd)
  await f.backend.state.beginRun(f.agent.id, 'old-run')
  await f.backend.state.markRunSent(f.agent.id, 'old-run')
  f.backend.state = new BridgeState(f.backend.directory)
  await assert.rejects(f.backend.runStep(f.agent, f.decision), { code: 'RECOVERY_REQUIRED' })
  assert.equal(queries, 0)
  f.agent.phase = { kind: 'idle' }
  f.agent.runMaintenance = job => job(new AbortController().signal)
  assert.match((await f.backend.recover(f.agent, false, new AbortController().signal)).text, /1 轮/)
  await f.backend.recover(f.agent, true, new AbortController().signal)
  assert.equal(f.backend.state.value.sessions[f.agent.id].runs['old-run'].status, 'sent')
  f.agent.phase = { kind: 'running', turn: 2, step: 1, abort: new AbortController() }
  await f.backend.runStep(f.agent, f.decision)
  assert.equal(queries, 1)
})

test('动态运行上下文使用本轮刷新值并替换旧快照一次', async (t) => {
  let request
  const f = await fixture(t, async () => ({
    peer: {
      async request(method, params) {
        if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
        if (method === 'query') { request = params; return { status: 'completed' } }
        throw new Error('unexpected method')
      }, async drainNotifications() {},
    }, async close() {},
  }), async () => ({ content: [] }))
  const fresh = { id: 'fresh', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '新上下文' }] }
  f.ctx.systemPrompt.refreshContext = () => ['fresh-section']
  f.helpers.renderContextSections = (value) => value
  f.helpers.joinContextSections = (value) => value.join('')
  f.agent.runtimeContext.project = (text) => text === 'fresh-section' ? fresh : undefined
  f.decision.messages.unshift({ id: 'stale', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '旧上下文' }] })
  assert.deepEqual(await f.backend.runStep(f.agent, f.decision), { kind: 'completed' })
  assert.equal(request.prompt.filter((block) => block.text === '新上下文').length, 1)
  assert.equal(request.prompt.some((block) => block.text === '旧上下文'), false)
  assert.equal(f.records.filter((record) => record.type === 'user/message' && record.data.id === 'fresh').length, 1)
})

test('工具附加文本与结束标记以独立字段传给远端 hook', async (t) => {
  const outputs = []
  const f = await fixture(t, async (handlers) => ({
    peer: {
      async request(method, params) {
        if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
        if (method !== 'query') throw new Error('unexpected method')
        for (const id of ['toolu_context', 'toolu_stop']) {
          f.backend.runs.get(params.runId).projection.committedToolCalls.set(id, {
            name: 'local_command', arguments: '{"command":"pwd"}',
          })
          outputs.push(await handlers.handlers['tool.execute']({ runId: params.runId, callId: id,
            name: 'local_command', arguments: { command: 'pwd' } }, { signal: new AbortController().signal }))
        }
        return { status: 'completed' }
      }, async drainNotifications() {},
    }, async close() {},
  }), async ({ callId }) => callId === 'toolu_context'
    ? { content: [{ type: 'text', text: '工具输出' }], additionalContexts: [{
        id: 'tool-context', role: 'user', source: { kind: 'tool' }, content: [{ type: 'text', text: '补充上下文' }],
      }] }
    : { content: [{ type: 'text', text: '完成' }], concludesTurn: true })
  assert.equal((await f.backend.runStep(f.agent, f.decision)).kind, 'completed')
  assert.deepEqual(outputs[0].additionalContexts, ['补充上下文'])
  assert.deepEqual(outputs[0].content, [{ type: 'text', text: '工具输出' }])
  assert.equal(outputs[1].concludesTurn, true)
  assert.deepEqual(outputs[1].content, [{ type: 'text', text: '完成' }])
  assert.equal(f.records.filter((record) => record.type === 'user/message' && record.data.id === 'tool-context').length, 1)
})

function recoveryEvents(f) {
  f.agent.session.append = (type, data, intent) => {
    const event = { seq: f.records.length, type, data, ...intent }; f.records.push(event); return event
  }
  Object.defineProperty(f.agent.session, 'seq', { get: () => f.records.length })
  f.agent.session.eventAt = seq => f.records[seq]
  f.helpers.createAssistantMessage = ({ content, source }) => ({ id: 'generated', role: 'assistant', source: { kind: 'model', ...source }, content })
  f.agent.phase = { kind: 'idle' }
  f.agent.runMaintenance = operation => operation(new AbortController().signal)
}

async function interruptedTool(f, { result = false } = {}) {
  recoveryEvents(f)
  const binding = await f.backend.state.binding(f.agent.id, f.agent.session.header.cwd)
  await f.backend.state.markStarted(f.agent.id)
  await f.backend.state.beginRun(f.agent.id, 'interrupted-run', 'query', { turn: 1, step: 1 })
  await f.backend.state.markRunSent(f.agent.id, 'interrupted-run')
  const argumentsText = '{"command":"synthetic-once"}'
  const content = [{ type: 'text', text: '合成输出开头' }, { type: 'tool-call', id: 'old-call', name: 'local_command', arguments: argumentsText }]
  f.agent.session.append('assistant/message', { turn: 1, step: 1, interrupted: true,
    message: { id: assistantIdentity('old-api', content), content } }, { surfaceOp: 'append' })
  const call = f.agent.session.append('tool/call', { turn: 1, step: 1, callId: 'old-call', name: 'local_command', arguments: argumentsText })
  await f.backend.state.beginTool(f.agent.id, 'interrupted-run', 'old-call', 'local_command', createHash('sha256').update(argumentsText).digest('hex'))
  await f.backend.state.markToolDispatched(f.agent.id, 'interrupted-run', 'old-call', call.seq)
  const saved = f.agent.session.append('tool/result', { turn: 1, step: 1,
    message: f.helpers.createToolResultMessage({ callId: 'old-call', content: [{ type: 'text', text: result ? '真实已落盘的合成结果' : UNKNOWN_TOOL_TEXT }], isError: !result }),
    ...(result ? {} : { meta: { claudeBridgeOutcome: 'unknown' } }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  return { ...binding, content, resultSeq: saved.seq, argumentsText }
}

test('Host 崩溃窗口自动核实本机已落盘结果，补齐云端尾部，重复同步不重跑工具', async t => {
  let binding, queries = 0, executed = 0
  const f = await fixture(t, async () => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, capabilities: { historySync: true } }
    if (method === 'history') return { status: 'ok', sessionId: binding.sdkSessionId,
      records: params.offset ? [] : [{ type: 'assistant', uuid: 'cloud-answer', apiId: 'old-api', model: 'fixture',
        content: [{ type: 'text', text: '合成输出开头以及漏收尾部' }, binding.content[1]] }],
      runs: { 'interrupted-run': { status: 'completed', tools: {} } }, nextOffset: 1, lastUuid: 'cloud-answer', done: true }
    queries++; throw new Error('同步不发 query')
  } }, async close() {} }), async () => { executed++; return { content: [] } })
  binding = await interruptedTool(f, { result: true })
  assert.equal((await f.backend.syncSession(f.agent)).added, 1)
  assert.equal((await f.backend.syncSession(f.agent)).added, 0)
  assert.equal(f.records.filter(item => item.type === 'assistant/message').length, 2)
  assert.equal((await f.backend.state.recoveryStatus(f.agent.id)).length, 0)
  assert.equal(f.backend.state.value.sessions[f.agent.id].runs['interrupted-run'].tools['old-call'].resultSeq, binding.resultSeq)
  assert.equal(queries, 0); assert.equal(executed, 0)
})

test('未知工具仅用匹配的云端回执核实，未核实说明随下一条用户输入送达原生会话', async t => {
  let binding, verified = false, captured, executed = 0
  const f = await fixture(t, async () => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, capabilities: { historySync: true } }
    if (method === 'history') return { status: 'ok', sessionId: binding.sdkSessionId,
      records: [{ type: 'tool-result', uuid: 'cloud-result', callId: 'old-call', isError: false, content: [{ type: 'text', text: '合成回执结果' }] }],
      runs: { 'interrupted-run': { status: 'failed', tools: verified ? { 'old-call': {
        name: 'local_command', argumentsSha256: createHash('sha256').update(binding.argumentsText).digest('hex') } } : {} } },
      nextOffset: 1, lastUuid: 'cloud-result', done: true }
    assert.equal(method, 'query'); captured = params; return { status: 'completed' }
  } }, async close() {} }), async () => { executed++; return { content: [] } })
  binding = await interruptedTool(f)
  assert.equal((await f.backend.syncSession(f.agent)).unresolvedTools, 1)
  f.agent.phase = { kind: 'running', turn: 2, step: 1, abort: new AbortController() }
  await f.backend.runStep(f.agent, f.decision)
  assert.equal(captured.sessionId, binding.sdkSessionId); assert.equal(captured.resume, true)
  assert.match(captured.prompt[0].text, /只读检查核实/)
  assert.equal(executed, 0)
  f.agent.phase = { kind: 'running', turn: 3, step: 1, abort: new AbortController() }
  await f.backend.runStep(f.agent, f.decision)
  assert.equal(captured.prompt.some(block => block.type === 'text' && block.text.includes('[桥接插件运行说明')), false)
  f.agent.phase = { kind: 'idle' }; verified = true
  assert.equal((await f.backend.syncSession(f.agent)).unresolvedTools, 0)
  assert.equal(f.records.filter(item => item.type === 'tool/result' && item.data.meta?.claudeBridgeRecovered === true).length, 1)
})

test('云端原运行仍在收尾时保留新输入等待，用户停止能中断等待且不发送 query', async t => {
  let binding, queried = 0
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, capabilities: { historySync: true } }
    if (method === 'history') { setTimeout(() => f.phaseAbort.abort(), 10); return { status: 'busy' } }
    queried++; return { status: 'completed' }
  } }, async close() {} }))
  binding = await interruptedTool(f)
  f.agent.phase = { kind: 'running', turn: 2, step: 1, abort: f.phaseAbort }
  await assert.rejects(f.backend.runStep(f.agent, f.decision), { name: 'AbortError' })
  assert.equal(queried, 0); assert.ok(binding.sdkSessionId)
})

test('历史核对按原生响应分配步骤，旧版游标先完整修复且不覆盖新一轮', async t => {
  let binding
  const offsets = []
  const toolContent = [{ type: 'text', text: '工具前说明' }]
  const answer = [{ type: 'text', text: '工具后的完整最终答复' }]
  const f = await fixture(t, async () => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, capabilities: { historySync: true } }
    assert.equal(method, 'history')
    offsets.push(params.offset)
    return { status: 'ok', sessionId: binding.sdkSessionId, records: params.offset ? [] : [
      { type: 'prompt', uuid: 'mapped-run' },
      { type: 'assistant', uuid: 'tool-answer', apiId: 'tool-api', content: toolContent },
      { type: 'assistant', uuid: 'final-answer', apiId: 'final-api', content: answer },
    ], runs: {}, nextOffset: 3, lastUuid: 'final-answer', done: true }
  } }, async close() {} }))
  recoveryEvents(f)
  binding = await f.backend.state.binding(f.agent.id, f.agent.session.header.cwd)
  await f.backend.state.markStarted(f.agent.id)
  await f.backend.state.beginRun(f.agent.id, 'mapped-run', 'query', { turn: 2, step: 1 })
  await f.backend.state.finishRun(f.agent.id, 'mapped-run', 'completed')
  await f.backend.state.reconcileRecovery(f.agent.id, [], { offset: 3, lastUuid: 'final-answer' })
  f.agent.session.append('assistant/message', { turn: 2, step: 1,
    message: { id: assistantIdentity('tool-api', toolContent), content: toolContent } })
  f.agent.session.append('step/start', { turn: 3, step: 1 })
  f.agent.phase = { kind: 'running', turn: 3, step: 1, abort: new AbortController() }
  assert.equal((await f.backend.syncSession(f.agent, { withinRun: true })).added, 1)
  const restored = f.records.filter(event => event.type === 'assistant/message').at(-1)
  assert.equal(restored.data.turn, 2)
  assert.equal(restored.data.step, 2)
  assert.deepEqual(restored.data.message.content, answer)
  f.agent.phase = { kind: 'idle' }
  assert.equal((await f.backend.syncSession(f.agent)).added, 0)
  assert.deepEqual(offsets, [0, 3])
})
