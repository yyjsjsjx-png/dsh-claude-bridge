import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { BridgeBackend } from '../src/backend.mjs'
import { ConnectionContext } from '../src/connection-context.mjs'
import { planUsageSnapshot } from '../src/plan-usage.mjs'
import { BridgeState } from '../src/state.mjs'
import { assistantIdentity, UNKNOWN_TOOL_TEXT } from '../src/history-sync.mjs'
import { HISTORY_ASSISTANT, HISTORY_TOOL_RESULT } from '../src/history-records.mjs'
import { createHash } from 'node:crypto'
import { requiredShellName } from '../src/remote-capabilities.mjs'
import { prepareRequestMessages } from '../src/request-preparation.mjs'

const provider = 'claude-sdk-remote'
const currentClientVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
const nextClientVersion = `${BigInt(currentClientVersion.split('.')[0]) + 1n}.0.0`

test('启动诊断保留 Host 证据分级，记录未自动实测项且不连接服务器', async t => {
  const checks = [
    { id: 'host-interfaces', evidence: 'interface', status: 'passed' },
    { id: 'session-restore', evidence: 'synthetic', status: 'passed' },
    { id: 'desktop-acceptance', evidence: 'desktop', status: 'not-run' },
    { id: 'remote-sdk', evidence: 'real-sdk', status: 'not-run' },
  ]
  const f = await fixture(t, async () => { throw new Error('启动探针不应连接服务器') }, undefined, { checks })
  await f.backend.diagnostics.flush()
  const records = (await readFile(f.backend.diagnostics.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(records.map(({ event, stage, evidence, status }) => ({ event, stage, evidence, status })),
    checks.map(({ id, ...check }) => ({ event: 'host.compatibility', stage: id, ...check })))
  assert.equal(f.backend.connection, undefined)
})

test('握手发送插件版本，服务端仅升级不强制客户端更新，旧服务端仍按协议连接', async t => {
  for (const declaration of [undefined, { serverVersion: nextClientVersion, minimumClientVersion: null },
    { serverVersion: nextClientVersion, minimumClientVersion: currentClientVersion }]) {
    const requests = []
    const f = await fixture(t, async () => ({ peer: { async request(method, params) {
      requests.push({ method, params })
      return { protocolVersion: 1, authenticated: true, ...declaration }
    } }, async close() {} }))
    f.backend.connectionSettings = { async read() { return { configured: true } } }
    await f.backend.connect()
    assert.equal(requests[0].method, 'initialize')
    assert.equal(requests[0].params.clientVersion, currentClientVersion)
    const status = await f.backend.status()
    assert.equal(status.bridgeCompatibility.status, declaration ? 'compatible' : 'legacy')
    assert.equal(status.bridgeCompatibility.clientVersion, currentClientVersion)
  }
})

test('服务端要求更新时保留明确版本提示，发送 query 和运行日志前停止，换连接清除旧报告', async t => {
  const methods = []; let closed = 0
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    methods.push(method)
    return { protocolVersion: 1, serverVersion: nextClientVersion, minimumClientVersion: nextClientVersion, clientCompatible: false,
      authenticated: null, capabilities: {} }
  } }, async close() { closed++ } }))
  f.backend.connectionSettings = { async read() { return { configured: true } } }
  await assert.rejects(f.backend.runStep(f.agent, f.decision), error => {
    assert.equal(error.code, 'CLIENT_UPDATE_REQUIRED'); assert.ok(error.message.includes(nextClientVersion)); return true
  })
  assert.deepEqual(methods, ['initialize']); assert.equal(closed, 1)
  assert.equal(f.backend.state.value.sessions[f.agent.id].runs, undefined)
  const status = await f.backend.status()
  assert.equal(status.connected, false)
  assert.equal(status.bridgeCompatibility.status, 'update-required')
  assert.equal(status.bridgeCompatibility.minimumClientVersion, nextClientVersion)
  const quota = await f.backend.planUsage(true)
  assert.equal(quota.code, 'CLIENT_UPDATE_REQUIRED')
  assert.equal(quota.minimumClientVersion, nextClientVersion)
  f.backend.connectionSettings = { async clear() { return { configured: false, status: 'missing' } } }
  await f.backend.clearConnection()
  assert.equal(f.backend.bridgeCompatibility.status, 'unchecked')
})

test('无效服务端要求或明确拒绝不能被当成旧版兼容而继续执行', async t => {
  for (const declaration of [{ serverVersion: '0.3.0', minimumClientVersion: 'invalid' },
    { clientCompatible: false }]) {
    let closed = 0
    const f = await fixture(t, async () => ({ peer: { async request() {
      return { protocolVersion: 1, authenticated: true, ...declaration }
    } }, async close() { closed++ } }))
    await assert.rejects(f.backend.connect(), { code: 'SERVER_COMPATIBILITY_INVALID' })
    assert.equal(closed, 1)
    assert.equal(f.backend.bridgeCompatibility.status, 'invalid')
  }
})

test('上下文默认值仅本设备持久保存，下轮透传且旧服务器明确拒绝自定义值', async t => {
  const requests = []
  const f = await fixture(t, async () => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true, capabilities: { autoCompactWindow: true } }
    requests.push(params)
    return { sessionId: params.sessionId, status: 'completed' }
  } }, async close() {} }))
  await f.backend.state.ready
  assert.deepEqual(f.backend.contextPreferences(), { autoCompactWindowTokens: null })
  await f.backend.saveContextPreferences({ autoCompactWindowTokens: 200000 })
  const restored = new BridgeState(f.backend.directory)
  await restored.ready
  assert.equal(restored.value.contextPreferences.autoCompactWindowTokens, 200000)
  const other = await fixture(t, async () => { throw new Error('不需要连接') })
  await other.backend.state.ready
  assert.equal(other.backend.contextPreferences().autoCompactWindowTokens, null)
  await assert.rejects(f.backend.saveContextPreferences({ autoCompactWindowTokens: 99999 }), { code: 'INVALID_CONTEXT_PREFERENCES' })
  await f.backend.runStep(f.agent, f.decision)
  assert.deepEqual(requests[0].contextPreferences, { autoCompactWindowTokens: 200000 })
  f.backend.initialized.capabilities.autoCompactWindow = false
  assert.throws(() => f.backend.contextRequestPreferences(), { code: 'CONTEXT_SETTINGS_UNSUPPORTED' })
  await f.backend.saveContextPreferences({ autoCompactWindowTokens: null })
  assert.deepEqual(f.backend.contextRequestPreferences(), {})
})

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
  const connectionContext = new ConnectionContext()
  connectionContext.bind(connectionContext.capture(), {
    async close() { saved.push('close'); throw Object.assign(new Error('关闭超时'), { code: 'CLOSE_TIMEOUT' }) },
  })
  const backend = Object.assign(Object.create(BridgeBackend.prototype), { lifetime: new AbortController(), runs: new Map(),
    connectionContext,
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

test('运行中采样与自动压缩更新展示，最终summary覆盖且晚到通知不污染', async t => {
  let runId
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    runId = params.runId
    const notify = message => handlers.onNotification('sdk.message', { runId, message })
    await notify({ type: 'bridge_context', observedAt: 1,
      context: { source: 'sdk-summary-approximate', totalTokens: 365000, maxTokens: 400000 } })
    assert.equal(f.agent._bridgeStatus.phase, 'running')
    assert.equal(f.agent._bridgeStatus.context.totalTokens, 365000)
    await notify({ type: 'system', subtype: 'status', status: 'compacting' })
    assert.equal(f.agent._bridgeStatus.phase, 'compacting')
    await notify({ type: 'system', subtype: 'compact_boundary', compact_metadata: {
      trigger: 'auto', pre_tokens: 368207, post_tokens: 3380, duration_ms: 61876 } })
    assert.equal(f.agent._bridgeStatus.phase, 'running')
    await notify({ type: 'bridge_context', observedAt: 2, context: { status: 'unknown' }, code: 'CONTEXT_SUMMARY_TIMEOUT' })
    assert.equal(f.agent._bridgeStatus.context.totalTokens, 365000)
    await notify({ type: 'bridge_context', observedAt: 3,
      context: { source: 'sdk-summary-approximate', totalTokens: 21000, maxTokens: 400000 } })
    assert.equal(f.agent._bridgeStatus.context.totalTokens, 21000)
    return { status: 'completed', metrics: { context: { source: 'sdk-summary-approximate', totalTokens: 21973, maxTokens: 400000 } } }
  }, async drainNotifications() {} }, async close() {} }))
  await f.backend.runStep(f.agent, f.decision)
  assert.equal(f.agent._bridgeStatus.phase, 'completed')
  assert.equal(f.agent._bridgeStatus.context.totalTokens, 21973)
  const progress = f.records.filter(record => record.type === 'plugin:claude-bridge/progress')
  assert.equal(progress.at(-1).data.compaction.durationMs, 61876)
  assert.equal(progress.at(-1).data.contextUpdate.status, 'updated')
  await f.backend.notification('sdk.message', { runId, message: { type: 'bridge_context', observedAt: 1000,
    context: { source: 'sdk-summary-approximate', totalTokens: 999999, maxTokens: 1000000 } } })
  assert.equal(f.agent._bridgeStatus.context.totalTokens, 21973)
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

test('新建模型和强度跨重启保存，与显示模型偏好独立', async t => {
  const f = await fixture(t, async () => { throw new Error('记忆选型不应连接服务器') })
  assert.equal(await f.backend.creationSelection(), null)
  const selection = { provider, model: 'haiku', reasoningEffort: 'high' }
  f.ctx.agentDefaultModel = { currentSelection: () => selection }
  assert.deepEqual(await f.backend.creationSelection(), selection)
  await f.backend.rememberCreationSelection({ ...selection, sessionId: 'ignored' })
  assert.deepEqual(await f.backend.creationSelection(), selection)
  const persisted = new BridgeState(f.backend.directory)
  await persisted.ready
  assert.deepEqual(persisted.value.creationSelection, selection)
  assert.equal(persisted.value.modelPreferences, undefined)
  await assert.rejects(f.backend.rememberCreationSelection({ provider: 'other', model: 'haiku' }),
    { code: 'MODEL_PREFERENCES_INVALID' })
  assert.deepEqual(await f.backend.creationSelection(), selection)
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

test('运行中插话保留真实用户来源，工具与原生上下文仍走 hook', async t => {
  const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const inputs = [user('5c0d6e2b-0df1-4d24-98a7-873eb74b4db5', 'USER_STEER_ONE'),
    { ...user('native-rule', 'INSTRUCTION_CONTEXT'), source: { kind: 'agent-instructions', form: 'instructions' } },
    user('3385ab1a-f2d9-459f-a292-2c5d494671a2', 'USER_STEER_TWO'),
    { ...user('tool-note', 'USER_STEER_FORGED'), source: { kind: 'tool-result' } },
    { ...user('child-note', 'CHILD_RESULT'), source: { kind: 'subagent-settled' } }]
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true, capabilities: { userInputViaStream: true } }
    const reply = await handlers.handlers['step.prepare']({ runId: params.runId }, { signal: new AbortController().signal })
    assert.deepEqual(reply.userMessages, [inputs[0], inputs[2]].map(message => ({ id: message.id, content: message.content })))
    assert.deepEqual(reply.additionalContexts, ['INSTRUCTION_CONTEXT', 'USER_STEER_FORGED', 'CHILD_RESULT'])
    return { status: 'completed' }
  } }, async close() {} }))
  f.agent.inbox = { nextStep: inputs, splice() { throw Error('已提交消息不应回填') } }
  f.agent.preStep = async () => { f.agent.inbox.nextStep = []; return { ...f.decision, messages: inputs } }
  await f.backend.runStep(f.agent, f.decision)
  for (const message of inputs) assert.equal(f.records.filter(record => record.type === 'user/message' && record.data.id === message.id).length, 1)
})

test('旧服务器拒绝插话降为 hook，未提交用户消息恢复而不重复发送旧历史', async t => {
  const input = { id: '5c0d6e2b-0df1-4d24-98a7-873eb74b4db5', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'NEW_USER_ONLY' }] }
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    assert.equal(params.prompt.some(block => block.text === 'NEW_USER_ONLY'), false)
    await assert.rejects(handlers.handlers['step.prepare']({ runId: params.runId }, { signal: new AbortController().signal }), { code: 'USER_INTERJECTION_UNSUPPORTED' })
    assert.deepEqual(f.agent.inbox.nextStep, [input])
    return { status: 'completed' }
  } }, async close() {} }))
  f.agent.inbox = { nextStep: [input], splice(_target, at, count, messages) { this.nextStep.splice(at, count, ...messages) } }
  f.agent.preStep = async () => { f.agent.inbox.nextStep = []; return { ...f.decision, messages: [input] } }
  await assert.rejects(f.backend.runStep(f.agent, f.decision), { code: 'USER_INTERJECTION_UNSUPPORTED' })
  assert.equal(f.records.some(record => record.type === 'user/message' && record.data.id === input.id), false)
})

test('准备插话时取消或已完成，不提交晚到消息且保留原生队列边界', async t => {
  for (const mode of ['cancel', 'finished']) {
    const input = { id: '5c0d6e2b-0df1-4d24-98a7-873eb74b4db5', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'LATE_USER' }] }
    const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
      if (method === 'initialize') return { protocolVersion: 1, authenticated: true, capabilities: { userInputViaStream: true } }
      if (method === 'settle') return { status: 'cancelled' }
      await assert.rejects(handlers.handlers['step.prepare']({ runId: params.runId }, { signal: new AbortController().signal }),
        mode === 'finished' ? { code: 'USER_INPUT_CLOSED' } : { name: 'AbortError' })
      assert.deepEqual(f.agent.inbox.nextStep, [input])
      return { status: 'completed' }
    } }, async close() {} }))
    f.agent.inbox = { nextStep: [input], splice(_target, at, count, messages) { this.nextStep.splice(at, count, ...messages) } }
    f.agent.preStep = async () => {
      f.agent.inbox.nextStep = []
      if (mode === 'cancel') f.phaseAbort.abort()
      else [...f.backend.runs.values()][0].inputClosed = true
      return { ...f.decision, messages: [input] }
    }
    await assert.rejects(f.backend.runStep(f.agent, f.decision), mode === 'finished' ? { code: 'USER_INPUT_CLOSED' } : { name: 'AbortError' })
    assert.equal(f.records.some(record => record.type === 'user/message' && record.data.id === input.id), false)
  }
})

test('批次准备拒绝变化配置时恢复已认领消息，防止指令丢失', async (t) => {
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    assert.equal(method, 'query')
    await assert.rejects(handlers.handlers['step.prepare']({ runId: params.runId },
      { signal: new AbortController().signal }), error => error.code === 'QUERY_CONFIGURATION_CHANGED'
        && /工具集合已更新.*保留当前对话/.test(error.message) && !/新建会话/.test(error.message))
    assert.deepEqual(f.agent.inbox.nextStep.map(message => message.id), ['pending-note', 'nested-note'])
    return { status: 'completed' }
  } }, async close() {} }))
  const note = id => ({ id, role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: id }] })
  f.agent.inbox = { nextStep: [note('pending-note')], splice(_target, at, count, messages) { this.nextStep.splice(at, count, ...messages) } }
  f.agent.preStep = async () => {
    f.agent.inbox.nextStep = []
    return { ...f.decision, assembly: { tools: f.decision.assembly.tools.filter(tool => tool.name === requiredShellName()) },
      messages: [note('pending-note'), note('nested-note')] }
  }
  await assert.rejects(f.backend.runStep(f.agent, f.decision), { code: 'QUERY_CONFIGURATION_CHANGED' })
})

async function fixture(t, makeTransport, execute, hostCompatibility) {
  const parent = resolve(tmpdir())
  const directory = await mkdtemp(join(parent, 'dsh-bridge-backend-'))
  t.after(async () => {
    await backend.dispose()
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
    tools: { execute: execute ?? (async () => { throw new Error('该用例不应执行工具') }) },
    approval: { async request() { throw new Error('该用例不应直接请求审批') } },
    agents: { withInitiator(_agent, operation) { return operation() } },
    sessions: { async flush() { return true } },
  }
  const helpers = {
    resolveDshHome() { return directory },
    appendPluginRecord(session, type, data) { return session.append(type, data, { ignorable: true }).seq },
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
    assembly: { tools: [{ name: requiredShellName(), description: '执行基础命令', parameters: {
      type: 'object', additionalProperties: false, properties: {
        command: { type: 'string' }, workdir: { type: 'string' }, timeoutMs: { type: 'number' },
      }, required: ['command'],
    } }, { name: 'local_command', description: '执行本机命令', parameters: {
      type: 'object', additionalProperties: false, properties: { command: { type: 'string' } }, required: ['command'],
    } }] },
    messages: [{ id: 'user-1', role: 'user', source: { kind: 'human' }, content: [{ type: 'text', text: '测试' }] }],
  }
  const backend = new BridgeBackend(ctx, { stateDirectory: directory }, { helpers, createTransport: makeTransport, hostCompatibility })
  return { backend, agent, decision, records, phaseAbort, ctx, helpers, selection }
}

test('基础 shell 缺失、不可转换或审批执行记录接口缺失时不连接也不发送 query', async t => {
  let connections = 0
  const f = await fixture(t, async () => { connections++; throw new Error('不应连接') })
  const original = f.decision.assembly.tools
  f.decision.assembly.tools = original.filter(tool => tool.name !== requiredShellName())
  await assert.rejects(f.backend.runStep(f.agent, f.decision), { code: 'REMOTE_SHELL_UNAVAILABLE' })
  assert.equal(f.backend.remoteCapabilities.status, 'unavailable')
  assert.equal(f.agent._bridgeStatus.phase, 'failed')
  f.decision.assembly.tools = original.map(tool => tool.name === requiredShellName()
    ? { ...tool, parameters: { $ref: '#/unsupported' } } : tool)
  await assert.rejects(f.backend.runStep(f.agent, f.decision), /无法转换/)
  f.decision.assembly.tools = original
  for (const [service, method] of [['tools', 'execute'], ['approval', 'request'], ['sessions', 'flush']]) {
    const saved = f.ctx[service][method]; delete f.ctx[service][method]
    await assert.rejects(f.backend.runStep(f.agent, f.decision), { code: 'REMOTE_SHELL_UNAVAILABLE' })
    f.ctx[service][method] = saved
  }
  assert.equal(connections, 0)
  assert.equal(f.records.some(record => record.type === 'request/header'), false)
})

test('高级工具转换失败时提示词、请求头和实际工具集合一致，后续步骤沿用降级状态', async t => {
  let request
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    request = params
    assert.deepEqual(await handlers.handlers['step.prepare']({ runId: params.runId },
      { signal: new AbortController().signal }), {})
    return { status: 'completed' }
  } }, async close() {} }))
  f.decision.assembly.tools.push({ name: 'advanced', description: '高级工具', parameters: { $ref: '#/unsupported' } })
  f.decision.assembly.sections = [{ name: 'tool:advanced', text: '过期高级工具说明。' },
    { name: 'user:instructions', text: '用户指令保持完整。' }]
  f.helpers.renderPrompt = assembly => assembly.sections.map(section => section.text).join('\n')
  f.agent.inbox = { nextStep: [], splice() { throw new Error('无需恢复消息') } }
  f.agent.preStep = async () => ({ ...f.decision, messages: [] })
  await f.backend.runStep(f.agent, f.decision)
  assert.equal(request.tools.some(tool => tool.name === 'advanced'), false)
  assert.equal(request.systemPrompt.includes('过期高级工具说明。'), false)
  assert.match(request.systemPrompt, /用户指令保持完整。[\s\S]*advanced：/)
  const header = f.records.find(record => record.type === 'request/header').data.header
  assert.equal(header.tools.some(tool => tool.name === 'advanced'), false)
  assert.equal(f.backend.remoteCapabilities.status, 'ready')
  assert.equal(f.agent._bridgeStatus.compatibility.tools.find(tool => tool.name === 'advanced').status, 'disabled')
})

test('完整工具转换达到数量上限挤掉基础 shell 时仍阻止 query', async t => {
  let queries = 0
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    queries++; return { status: 'completed' }
  } }, async close() {} }))
  const shell = f.decision.assembly.tools.find(tool => tool.name === requiredShellName())
  f.decision.assembly.tools = [...Array.from({ length: 80 }, (_, i) => ({
    name: `extra_${i}`, description: '附加工具', parameters: { type: 'object', properties: {}, additionalProperties: false },
  })), shell]
  await assert.rejects(f.backend.runStep(f.agent, f.decision), { code: 'REMOTE_SHELL_UNAVAILABLE' })
  assert.equal(queries, 0)
  assert.match(f.backend.remoteCapabilities.reason, /超过远程工具数量限制/)
  assert.equal(f.records.some(record => record.type === 'request/header'), false)
})

test('基础 shell 注册消失时保留失败结果、停止后续推理并拒绝再次运行，不自动重试', async t => {
  let queries = 0, executions = 0
  const f = await fixture(t, async handlers => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    assert.equal(method, 'query'); queries++
    const run = f.backend.runs.get(params.runId)
    run.projection.committedToolCalls.set('missing-shell', { name: requiredShellName(), arguments: '{"command":"pwd"}' })
    // Another concurrent session can replace the Host's latest report. This
    // failure must still project only the current run's admitted collection.
    f.backend.compatibility = [{ name: 'foreign-session-tool', status: 'preserved', reason: '' }]
    await assert.rejects(handlers.handlers['tool.execute']({ runId: params.runId, callId: 'missing-shell',
      name: requiredShellName(), arguments: { command: 'pwd' } }, { signal: new AbortController().signal }),
    { code: 'REMOTE_SHELL_UNAVAILABLE' })
    await assert.rejects(handlers.handlers['step.prepare']({ runId: params.runId },
      { signal: new AbortController().signal }), { code: 'REMOTE_SHELL_UNAVAILABLE' })
    return { status: 'completed' }
  } }, async close() {} }), async () => {
    executions++
    return { content: [{ type: 'text', text: '原生 shell 注册已消失。' }], isError: true,
      error: { info: { code: 'UNKNOWN_TOOL' } } }
  })
  await assert.rejects(f.backend.runStep(f.agent, f.decision), { code: 'REMOTE_SHELL_UNAVAILABLE' })
  assert.equal(f.records.filter(record => record.type === 'tool/result').length, 1)
  assert.equal(f.backend.remoteCapabilities.status, 'unavailable')
  assert.equal(f.agent._bridgeStatus.compatibility.tools.find(tool => tool.name === requiredShellName()).status, 'disabled')
  assert.equal(f.agent._bridgeStatus.compatibility.tools.some(tool => tool.name === 'foreign-session-tool'), false)
  assert.equal(f.agent._bridgeStatus.compatibility.tools.some(tool => tool.name === 'local_command'), true)
  f.agent.phase = { kind: 'running', turn: 2, step: 1, abort: new AbortController() }
  await assert.rejects(f.backend.runStep(f.agent, f.decision), { code: 'REMOTE_SHELL_UNAVAILABLE' })
  assert.equal(queries, 1); assert.equal(executions, 1)
})

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

test('原生指令预算省略或截断头在首次和续步均阻止，用户消息与文件正文引用不误报', () => {
  const ordinary = 'Workspace instruction budget 65536 bytes: omitted AGENTS.md'
  const truncated = 'Workspace instruction budget 65536 bytes: truncated AGENTS.md from 70000 to 65000 bytes'
  const compact = 'Workspace instructions were omitted or truncated to fit the configured byte budget.'
  const source = { kind: 'agent-instructions', form: 'instructions', changes: [] }
  const prepare = (text, continuation, from = source) => {
    const message = { id: 'synthetic-instruction', role: 'user', source: from, content: [{ type: 'text', text }] }
    return prepareRequestMessages({ assembly: {}, messages: [message], context: {},
      refreshContext: value => value, renderContextSections: () => [],
      joinContextSections: () => '', projectContext: () => undefined, continuation })
  }
  for (const continuation of [false, true]) {
    for (const header of [ordinary, truncated, compact]) {
      for (const text of [header, `<system-reminder>\n${header}\n\nInstructions from: AGENTS.md\n</system-reminder>`]) {
        assert.throws(() => prepare(text, continuation), error => error.code === 'INSTRUCTION_BUDGET_EXCEEDED'
          && error.message.includes(continuation ? '已停止后续推理' : '已停止本轮推理'))
      }
    }
    assert.equal(prepare(ordinary, continuation, { kind: 'user' }).length, 1)
    assert.equal(prepare(compact, continuation, { kind: 'user' }).length, 1)
    assert.equal(prepare(ordinary, continuation, { kind: 'agent-instructions', form: 'reference' }).length, 1)
    const quoted = `<system-reminder>\nThe following workspace instructions may be relevant to your work.\n\nInstructions from: AGENTS.md\n\n${ordinary}\n${truncated}\n${compact}\n</system-reminder>`
    assert.equal(prepare(quoted, continuation).length, 1)
  }
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
  assert.equal(f.records.filter(item => item.type === HISTORY_ASSISTANT).length, 1)
  assert.equal((await f.backend.state.recoveryStatus(f.agent.id)).length, 0)
  assert.equal(f.backend.state.value.sessions[f.agent.id].runs['interrupted-run'].tools['old-call'].resultSeq, binding.resultSeq)
  assert.equal(queries, 0); assert.equal(executed, 0)
})

test('恢复历史已checkpoint而台账提交失败后，重入不重复投影或云端工具结果', async t => {
  let binding, executed = 0
  const f = await fixture(t, async () => ({ peer: { async request(method) {
    if (method === 'initialize') return { protocolVersion: 1, capabilities: { historySync: true } }
    assert.equal(method, 'history')
    return { status: 'ok', sessionId: binding.sdkSessionId, records: [
      { type: 'assistant', uuid: 'cloud-answer', apiId: 'old-api', model: 'fixture',
        content: [{ type: 'text', text: '合成输出开头以及漏收尾部' }, binding.content[1]] },
      { type: 'tool-result', uuid: 'cloud-result', callId: 'old-call', isError: false,
        content: [{ type: 'text', text: '合成工具回执' }] },
    ], runs: { 'interrupted-run': { status: 'completed', tools: { 'old-call': {
      name: 'local_command', argumentsSha256: createHash('sha256').update(binding.argumentsText).digest('hex'),
    } } } }, nextOffset: 2, lastUuid: 'cloud-result', done: true }
  } }, async close() {} }), async () => { executed++; return { content: [] } })
  binding = await interruptedTool(f)
  let checkpointed = false, failCommit = true
  f.ctx.sessions.flush = async () => { checkpointed = true; return true }
  const reconcile = f.backend.state.reconcileRecovery.bind(f.backend.state)
  f.backend.state.reconcileRecovery = async (...args) => {
    assert.equal(checkpointed, true)
    if (failCommit) {
      failCommit = false
      throw Object.assign(new Error('合成台账提交失败'), { code: 'FIXTURE_COMMIT_FAILED' })
    }
    return reconcile(...args)
  }
  await assert.rejects(f.backend.syncSession(f.agent), { code: 'FIXTURE_COMMIT_FAILED' })
  assert.equal(f.backend.verifiedHistory.has(f.agent.session), false)
  assert.equal(f.backend.state.value.sessions[f.agent.id].historyCursor, undefined)
  assert.equal(f.records.filter(record => record.type === HISTORY_ASSISTANT).length, 1)
  assert.equal(f.records.filter(record => record.type === HISTORY_TOOL_RESULT).length, 1)
  assert.equal((await f.backend.syncSession(f.agent)).added, 0)
  assert.equal(f.records.filter(record => record.type === HISTORY_ASSISTANT).length, 1)
  assert.equal(f.records.filter(record => record.type === HISTORY_TOOL_RESULT).length, 1)
  assert.equal(f.backend.state.value.sessions[f.agent.id].historyCursor.offset, 2)
  assert.equal((await f.backend.state.recoveryStatus(f.agent.id)).length, 0)
  assert.equal(executed, 0)
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
    assert.equal(method, 'query'); captured = params; return { status: 'completed', metrics: {
      context: { source: 'sdk-summary-approximate', totalTokens: 123, maxTokens: 1000 } } }
  } }, async close() {} }), async () => { executed++; return { content: [] } })
  binding = await interruptedTool(f)
  assert.equal((await f.backend.syncSession(f.agent)).unresolvedTools, 1)
  assert.equal(f.agent._bridgeStatus.phase, 'stopped')
  assert.equal(f.agent._bridgeStatus.recovery.interrupted, true)
  f.agent.phase = { kind: 'running', turn: 2, step: 1, abort: new AbortController() }
  await f.backend.runStep(f.agent, f.decision)
  assert.equal(captured.sessionId, binding.sdkSessionId); assert.equal(captured.resume, true)
  assert.match(captured.prompt[0].text, /只读检查核实/)
  assert.equal(executed, 0)
  assert.equal(f.agent._bridgeStatus.phase, 'completed')
  assert.equal(f.agent._bridgeStatus.context.totalTokens, 123)
  assert.equal(Object.hasOwn(f.agent._bridgeStatus, 'recovery'), false)
  f.agent.phase = { kind: 'idle' }
  assert.equal((await f.backend.syncSession(f.agent)).unresolvedTools, 1)
  assert.equal(f.agent._bridgeStatus.phase, 'completed')
  assert.equal(f.agent._bridgeStatus.context.totalTokens, 123)
  assert.equal(f.agent._bridgeStatus.recovery.interrupted, false)
  assert.equal(f.agent._bridgeStatus.toolMayHaveExecuted, false)
  assert.equal((await f.backend.state.recoveryStatus(f.agent.id))[0].tools['old-call'].status, 'unknown')
  f.agent.phase = { kind: 'running', turn: 3, step: 1, abort: new AbortController() }
  await f.backend.runStep(f.agent, f.decision)
  assert.equal(captured.prompt.some(block => block.type === 'text' && block.text.includes('[桥接插件运行说明')), false)
  f.agent.phase = { kind: 'idle' }; verified = true
  assert.equal((await f.backend.syncSession(f.agent)).unresolvedTools, 0)
  assert.equal(f.records.filter(item => item.type === HISTORY_TOOL_RESULT && item.data.meta?.claudeBridgeRecovered === true).length, 1)
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
  const restored = f.records.filter(event => event.type === HISTORY_ASSISTANT).at(-1)
  assert.equal(restored.data.turn, 2)
  assert.equal(restored.data.step, 2)
  assert.deepEqual(restored.data.message.content, answer)
  f.agent.phase = { kind: 'idle' }
  assert.equal((await f.backend.syncSession(f.agent)).added, 0)
  // Small histories replay their last response's page rather than resuming in
  // the middle of a possibly split API message.
  assert.deepEqual(offsets, [0, 0])
  assert.equal(f.backend.state.value.sessions[f.agent.id].historyCursor?.projectionVersion, 3)
})

test('分页历史重读最后响应的起始页，补全跨页片段且保持幂等', async t => {
  let binding, expanded = false
  const cursors = []
  const reasoning = { type: 'reasoning', text: '先核对已有状态。' }
  const text = { type: 'text', text: '开始检查。' }
  const tool = { type: 'tool-call', id: 'paged-call', name: 'local_command', arguments: '{"command":"pwd"}' }
  const f = await fixture(t, async () => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, capabilities: { historySync: true } }
    assert.equal(method, 'history')
    cursors.push({ offset: params.offset, afterUuid: params.afterUuid })
    const page = params.offset === 0
      ? { records: [{ type: 'prompt', uuid: 'mapped-run' },
          { type: 'assistant', uuid: 'old-body', apiId: 'old-api', content: [{ type: 'text', text: '上个响应' }] }],
        nextOffset: 2, lastUuid: 'old-body', done: false }
      : params.offset === 2
        ? { records: [{ type: 'assistant', uuid: 'a-reasoning', apiId: 'paged-api', content: [reasoning] }],
          nextOffset: 3, lastUuid: 'a-reasoning', done: false }
        : { records: [{ type: 'assistant', uuid: 'a-text', apiId: 'paged-api', content: [text] },
            ...(expanded ? [{ type: 'assistant', uuid: 'a-tool', apiId: 'paged-api', content: [tool] }] : [])],
          nextOffset: expanded ? 5 : 4, lastUuid: expanded ? 'a-tool' : 'a-text', done: true }
    return { status: 'ok', sessionId: binding.sdkSessionId, runs: {}, ...page }
  } }, async close() {} }))
  recoveryEvents(f)
  binding = await f.backend.state.binding(f.agent.id, f.agent.session.header.cwd)
  await f.backend.state.markStarted(f.agent.id)
  assert.equal((await f.backend.syncSession(f.agent)).added, 2)
  expanded = true
  assert.equal((await f.backend.syncSession(f.agent)).added, 1)
  assert.deepEqual(f.records.filter(event => event.type === HISTORY_ASSISTANT).at(-1).data.message.content,
    [reasoning, text, tool])
  assert.equal((await f.backend.syncSession(f.agent)).added, 0)
  assert.deepEqual(cursors, [
    { offset: 0, afterUuid: undefined }, { offset: 2, afterUuid: 'old-body' }, { offset: 3, afterUuid: 'a-reasoning' },
    { offset: 2, afterUuid: 'old-body' }, { offset: 3, afterUuid: 'a-reasoning' },
    { offset: 2, afterUuid: 'old-body' }, { offset: 3, afterUuid: 'a-reasoning' },
  ])
  assert.deepEqual(f.backend.state.value.sessions[f.agent.id].historyCursor.replay, { offset: 2, lastUuid: 'old-body' })
})

test('增量片段缺失本地内容时完整重读一次，不用片段覆盖思考和正文', async t => {
  let binding
  const offsets = []
  const reasoning = { type: 'reasoning', text: '已有思考。' }
  const text = { type: 'text', text: '已有正文。' }
  const tool = { type: 'tool-call', id: 'fallback-call', name: 'local_command', arguments: '{"command":"pwd"}' }
  const f = await fixture(t, async () => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, capabilities: { historySync: true } }
    assert.equal(method, 'history')
    offsets.push(params.offset)
    return { status: 'ok', sessionId: binding.sdkSessionId, records: [
      ...(params.offset === 0 ? [{ type: 'assistant', uuid: 'a-head', apiId: 'fallback-api', content: [reasoning] }] : []),
      { type: 'assistant', uuid: 'a-tail', apiId: 'fallback-api', content: [text, tool] },
    ], runs: {}, nextOffset: 4, lastUuid: 'a-tail', done: true }
  } }, async close() {} }))
  recoveryEvents(f)
  binding = await f.backend.state.binding(f.agent.id, f.agent.session.header.cwd)
  await f.backend.state.markStarted(f.agent.id)
  await f.backend.state.reconcileRecovery(f.agent.id, [], { offset: 3, lastUuid: 'a-old-tail',
    projectionVersion: 3, replay: { offset: 2, lastUuid: 'a-head' } })
  f.agent.session.append('assistant/message', { turn: 1, step: 1,
    message: { id: assistantIdentity('fallback-api', [reasoning, text]), content: [reasoning, text] } })
  assert.equal((await f.backend.syncSession(f.agent)).added, 1)
  assert.deepEqual(offsets, [2, 0])
  assert.deepEqual(f.records.filter(event => event.type === HISTORY_ASSISTANT).at(-1).data.message.content,
    [reasoning, text, tool])
  assert.equal(f.backend.state.value.sessions[f.agent.id].historyCursor.replay.offset, 0)
})

async function historyFastPathFixture(t) {
  const counters = { history: 0, query: 0 }
  const connections = []
  let beforeHistory, beforeQuery
  const f = await fixture(t, async options => {
    connections.push(options)
    return { peer: { async request(method, params) {
      if (method === 'initialize') return { protocolVersion: 1, capabilities: { historySync: true } }
      if (method === 'history') {
        counters.history++
        const override = await beforeHistory?.(options)
        if (override) return override
        return { status: 'ok', sessionId: params.sessionId, records: [], runs: {},
          nextOffset: 0, lastUuid: null, done: true }
      }
      if (method === 'settle') return { status: 'cancelled', toolMayHaveExecuted: false }
      assert.equal(method, 'query'); counters.query++
      await beforeQuery?.(options)
      return { status: 'completed' }
    }, async drainNotifications() {} }, async close() {} }
  })
  recoveryEvents(f)
  let turn = 0
  return Object.assign(f, { counters, connections,
    historyAction(action) { beforeHistory = action }, queryAction(action) { beforeQuery = action },
    nextRun() {
      f.currentAbort = new AbortController()
      f.agent.phase = { kind: 'running', turn: ++turn, step: 1, abort: f.currentAbort }
      return f.backend.runStep(f.agent, f.decision)
    },
  })
}

test('可靠完成和显式同步可复用同连接历史证明，短断及新连接仍重新核对', async t => {
  const f = await historyFastPathFixture(t)
  await f.nextRun(); await f.nextRun()
  assert.deepEqual(f.counters, { history: 0, query: 2 })
  f.agent.phase = { kind: 'idle' }
  await f.backend.syncSession(f.agent)
  assert.equal(f.counters.history, 1)
  await f.nextRun()
  assert.deepEqual(f.counters, { history: 1, query: 3 })
  f.connections[0].onConnectionState('reconnecting')
  f.connections[0].onConnectionState('connected')
  await f.nextRun()
  assert.deepEqual(f.counters, { history: 2, query: 4 })
  f.connections[0].onClose()
  await f.nextRun()
  assert.equal(f.connections.length, 2)
  assert.deepEqual(f.counters, { history: 3, query: 5 })
})

test('正在进行的显式同步先于新轮完成，失败同步不留下可复用证明', async t => {
  const f = await historyFastPathFixture(t)
  await f.nextRun()
  let release, entered
  const started = new Promise(resolve => { entered = resolve })
  f.historyAction(async () => { entered(); await new Promise(resolve => { release = resolve }) })
  f.agent.phase = { kind: 'idle' }
  const sync = f.backend.syncSession(f.agent)
  await started
  const next = f.nextRun()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.counters.query, 1)
  release(); await sync; await next
  assert.deepEqual(f.counters, { history: 1, query: 2 })
  f.historyAction(() => { throw Object.assign(new Error('合成读取失败'), { code: 'FIXTURE_HISTORY_FAILED' }) })
  f.agent.phase = { kind: 'idle' }
  await assert.rejects(f.backend.syncSession(f.agent), { code: 'FIXTURE_HISTORY_FAILED' })
  f.historyAction(undefined)
  await f.nextRun()
  assert.deepEqual(f.counters, { history: 3, query: 3 })
})

test('同步或运行期间发生短断时，迟到成功不能标记新代次历史已经核对', async t => {
  const f = await historyFastPathFixture(t)
  await f.nextRun()
  f.historyAction(options => {
    options.onConnectionState('reconnecting'); options.onConnectionState('connected')
  })
  f.agent.phase = { kind: 'idle' }
  await f.backend.syncSession(f.agent)
  f.historyAction(undefined)
  await f.nextRun()
  assert.deepEqual(f.counters, { history: 2, query: 2 })
  f.queryAction(options => {
    options.onConnectionState('reconnecting'); options.onConnectionState('connected')
  })
  await f.nextRun()
  f.queryAction(undefined)
  await f.nextRun()
  assert.deepEqual(f.counters, { history: 3, query: 4 })
})

test('干净证明不能跳过新出现的未核对运行，云端忙碌和取消时不发送新 query', async t => {
  const f = await historyFastPathFixture(t)
  await f.nextRun()
  await f.backend.state.beginRun(f.agent.id, 'new-interrupted', 'query', { turn: 2, step: 1 })
  await f.backend.state.markRunSent(f.agent.id, 'new-interrupted')
  await f.backend.state.finishRun(f.agent.id, 'new-interrupted', 'unknown')
  f.historyAction(() => { setTimeout(() => f.currentAbort.abort(), 0); return { status: 'busy' } })
  await assert.rejects(f.nextRun(), { name: 'AbortError' })
  assert.deepEqual(f.counters, { history: 1, query: 1 })
})

test('失败和取消后必须核对历史，已收到 completed 但通知 drain 失败也不能复用', async t => {
  const f = await historyFastPathFixture(t)
  await f.nextRun()
  f.queryAction(() => { throw Object.assign(new Error('合成执行失败'), { code: 'FIXTURE_QUERY_FAILED' }) })
  await assert.rejects(f.nextRun(), { code: 'FIXTURE_QUERY_FAILED' })
  f.queryAction(undefined)
  await f.nextRun()
  assert.deepEqual(f.counters, { history: 1, query: 3 })
  f.queryAction(() => { f.currentAbort.abort() })
  await assert.rejects(f.nextRun(), { name: 'AbortError' })
  f.queryAction(undefined)
  await f.nextRun()
  assert.deepEqual(f.counters, { history: 2, query: 5 })
  let failDrain = true
  f.backend.connection.peer.drainNotifications = async () => {
    if (failDrain) throw Object.assign(new Error('合成通知失败'), { code: 'RPC_NOTIFICATION_FAILED' })
  }
  await assert.rejects(f.nextRun(), { code: 'RPC_NOTIFICATION_FAILED' })
  failDrain = false
  await f.nextRun()
  assert.deepEqual(f.counters, { history: 3, query: 7 })
})

test('步骤复用当轮图片能力快照，目录超过30秒只在下一轮重新读取', async t => {
  let catalogs = 0, queries = 0
  const f = await fixture(t, async options => ({ peer: { async request(method, params) {
    if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
    if (method === 'catalog') return { status: 'ok', models: [{ value: 'chosen-model',
      inputModalities: ++catalogs === 1 ? ['text', 'image'] : ['text'] }] }
    assert.equal(method, 'query'); queries++
    assert.equal(params.tools.some(tool => tool.name === 'read_image'), queries === 1)
    if (queries === 1) {
      f.backend.catalogCache.time = Date.now() - 31_000
      f.backend.catalogCache.reply.models[0].inputModalities = ['text']
      assert.deepEqual(await options.handlers['step.prepare']({ runId: params.runId },
        { signal: new AbortController().signal }), {})
      assert.equal(catalogs, 1)
    }
    return { status: 'completed' }
  } }, async close() {} }))
  f.agent.inbox = { nextStep: [], splice() { throw new Error('无需恢复消息') } }
  f.agent.preStep = async () => ({ ...f.decision, messages: [] })
  f.decision.assembly.tools.push({ name: 'read_image', description: '读取本机图片',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } })
  await f.backend.runStep(f.agent, f.decision)
  f.agent.phase = { kind: 'running', turn: 2, step: 1, abort: new AbortController() }
  await f.backend.runStep(f.agent, f.decision)
  assert.equal(catalogs, 2)
})

test('纯流通知不重复 flush，新持久记录仍等待落盘，缺少序号或落盘失败保守处理', async t => {
  const f = await fixture(t, async () => ({ peer: {}, async close() {} }))
  await f.backend.state.ready
  let seq = 0, flushes = 0, release
  Object.defineProperty(f.agent.session, 'seq', { configurable: true, get: () => seq })
  const runId = 'notification-sequence-test'
  f.backend.runs.set(runId, { agent: f.agent, timing() {}, projection: {
    async accept(message) { if (message.durable) seq++ },
  } })
  t.after(() => f.backend.runs.delete(runId))
  f.ctx.sessions.flush = async () => { flushes++; return true }
  await f.backend.notification('sdk.message', { runId, message: { type: 'stream_event' } })
  assert.equal(flushes, 0)
  f.ctx.sessions.flush = async () => { flushes++; await new Promise(resolve => { release = resolve }); return true }
  let finished = false
  const saved = f.backend.notification('sdk.message', { runId, message: { type: 'assistant', durable: true } })
    .then(() => { finished = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(flushes, 1); assert.equal(finished, false)
  release(); await saved
  delete f.agent.session.seq
  f.ctx.sessions.flush = async () => { flushes++; return true }
  await f.backend.notification('sdk.message', { runId, message: { type: 'stream_event' } })
  assert.equal(flushes, 2)
  Object.defineProperty(f.agent.session, 'seq', { configurable: true, get: () => seq })
  f.ctx.sessions.flush = async () => false
  await assert.rejects(f.backend.notification('sdk.message', { runId, message: { type: 'assistant', durable: true } }),
    { code: 'DURABILITY_UNAVAILABLE' })
})
