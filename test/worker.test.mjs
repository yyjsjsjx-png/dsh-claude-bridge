import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createWorkerHandlers, parseServiceBudget } from '../remote/runtime.mjs'
import { createAuthReader } from '../remote/auth.mjs'
import { setImmediate as tick } from 'node:timers/promises'

const SESSION = '7d04801d-7b17-4c52-9535-e10a9cc9358a'
const DEVICE = '36da88e2-bac2-4d4e-95b4-e688e7382724'
const OTHER_DEVICE = 'a4270ab7-90c7-440c-8fdc-5601b47dd29b'

test('版本协商默认报告服务端版本，无最低要求时允许旧客户端且不启动 SDK', async t => {
  const f = await fixture(t, async function* () { throw new Error('不能发起模型推理') })
  const manifest = JSON.parse(await readFile(new URL('../remote/package.json', import.meta.url), 'utf8'))
  const initialized = await f.worker.handlers.initialize({ protocolVersion: 1 })
  assert.equal(initialized.serverVersion, manifest.version)
  assert.equal(initialized.minimumClientVersion, manifest.bridge?.minimumClientVersion ?? null)
  assert.equal(initialized.clientCompatible, true)
  assert.equal(initialized.authenticated, true)
  assert.equal(initialized.capabilities.localMcpTools, true)
  assert.equal((await f.worker.handlers.initialize({ protocolVersion: 1, clientVersion: '0.0.1' })).clientCompatible, true)
  assert.equal(f.state.authReads, 2)
  assert.equal(f.state.queries.length, 0)
  assert.equal(f.state.catalogQueries.length, 0)
})

test('版本门禁在初始化缺失或客户端过旧时先于参数解析阻止全部 SDK 操作', async t => {
  const f = await fixture(t, async function* () { throw new Error('不能发起模型推理') }, {
    bridgeRelease: { serverVersion: '0.3.0', minimumClientVersion: '0.2.3' },
  })
  const blockedOperations = async expected => {
    for (const name of ['catalog', 'planUsage', 'history', 'query']) {
      const result = await f.worker.handlers[name](null, f.context)
      assert.equal(result.status, 'failed', name)
      assert.equal(result.code, expected, name)
      assert.match(result.message, /0\.2\.3/)
    }
  }
  await blockedOperations('CLIENT_UPDATE_REQUIRED')
  for (const clientVersion of [undefined, '0.2.2', 'invalid-client']) {
    const initialized = await f.worker.handlers.initialize({ protocolVersion: 1,
      ...(clientVersion === undefined ? {} : { clientVersion }) })
    assert.equal(initialized.serverVersion, '0.3.0')
    assert.equal(initialized.minimumClientVersion, '0.2.3')
    assert.equal(initialized.clientCompatible, false)
    assert.equal(initialized.code, 'CLIENT_UPDATE_REQUIRED')
    assert.equal(initialized.authenticated, null)
    assert.deepEqual(initialized.capabilities, {})
    await blockedOperations('CLIENT_UPDATE_REQUIRED')
  }
  assert.equal(f.state.authReads, 0)
  assert.equal(f.state.queries.length, 0)
  assert.equal(f.state.catalogQueries.length, 0)
  assert.equal(f.state.info.length, 0)
  assert.equal(f.state.requests.length, 0)
  const accepted = await f.worker.handlers.initialize({ protocolVersion: 1, clientVersion: '0.2.3' })
  assert.equal(accepted.clientCompatible, true)
  assert.equal(accepted.authenticated, true)
  assert.equal((await f.worker.handlers.catalog({}, f.context)).status, 'ok')
  assert.equal(f.state.catalogQueries.length, 1)
})

test('非法服务端版本声明关闭执行能力，仍保留 settle 与 close 清理', async t => {
  for (const bridgeRelease of [
    { serverVersion: 'invalid-server', minimumClientVersion: null },
    { serverVersion: '0.2.3', minimumClientVersion: 'invalid-minimum' },
  ]) {
    const f = await fixture(t, async function* () { throw new Error('不能发起模型推理') }, { bridgeRelease })
    const initialized = await f.worker.handlers.initialize({ protocolVersion: 1, clientVersion: '0.2.3' })
    assert.equal(initialized.clientCompatible, false)
    assert.equal(initialized.code, 'SERVER_COMPATIBILITY_INVALID')
    assert.equal(initialized.authenticated, null)
    assert.deepEqual(initialized.capabilities, {})
    for (const name of ['catalog', 'planUsage', 'history', 'query']) {
      const result = await f.worker.handlers[name](null, f.context)
      assert.equal(result.status, 'failed', name)
      assert.equal(result.code, 'SERVER_COMPATIBILITY_INVALID', name)
    }
    assert.equal(f.state.authReads, 0)
    assert.equal(f.state.queries.length, 0)
    assert.equal(f.state.catalogQueries.length, 0)
    assert.equal(f.state.info.length, 0)
    assert.equal((await f.worker.handlers.settle({ runId: 'not-started' })).code, 'RUN_UNKNOWN')
    await f.worker.close()
  }
})

test('重新协商为旧客户端不阻塞已有执行的 settle 或清理，也不自动重发', async t => {
  let began, release
  const started = new Promise(resolveStarted => { began = resolveStarted })
  const allowedToFinish = new Promise(resolveFinish => { release = resolveFinish })
  const f = await fixture(t, async function* ({ prompt }, state) {
    await prompt.next(); state.exists = true; began()
    await allowedToFinish
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  }, { bridgeRelease: { serverVersion: '0.2.3', minimumClientVersion: '0.2.3' } })
  await f.worker.handlers.initialize({ protocolVersion: 1, clientVersion: '0.2.3' })
  const running = f.worker.handlers.query(f.params, f.context)
  await started
  assert.equal((await f.worker.handlers.initialize({ protocolVersion: 1, clientVersion: '0.2.2' })).clientCompatible, false)
  const settled = f.worker.handlers.settle({ runId: f.params.runId }, f.context)
  release()
  assert.equal((await running).status, 'completed')
  assert.equal((await settled).status, 'completed')
  assert.equal(f.state.queries.length, 1)
  await f.worker.close()
})

test('自动压缩窗口按本轮设置注入 CLI，恢复默认不继承上轮或其他会话设置', async t => {
  const f = await fixture(t, async function* ({ prompt }, state) {
    await prompt.next(); state.exists = true
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  assert.equal((await f.worker.handlers.initialize({ protocolVersion: 1 })).capabilities.autoCompactWindow, true)
  const custom = await f.worker.handlers.query({ ...f.params, contextPreferences: { autoCompactWindowTokens: 200000 } }, f.context)
  assert.equal(custom.status, 'completed')
  const resumed = { ...f.params, runId: 'context-default', resume: true }
  assert.equal((await f.worker.handlers.query(resumed, f.context)).status, 'completed')
  assert.equal(f.state.queries[0].options.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000')
  assert.equal(Object.hasOwn(f.state.queries[1].options.env, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'), false)
  const bad = await f.worker.handlers.query({ ...resumed, runId: 'context-invalid', contextPreferences: { autoCompactWindowTokens: '200000' } }, f.context)
  assert.equal(bad.code, 'INVALID_CONTEXT_PREFERENCES')
  const extra = await f.worker.handlers.query({ ...resumed, runId: 'context-extra', contextPreferences: { autoCompactWindowTokens: 200000, env: {} } }, f.context)
  assert.equal(extra.code, 'INVALID_CONTEXT_PREFERENCES')
  assert.equal(f.state.queries.length, 2)
})

test('云端性能日志独立落盘，区分思考与正文并仅保存白名单耗时', async t => {
  const f = await fixture(t, async function* ({ prompt }, state) {
    await prompt.next(); state.exists = true
    yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'performance-test' } } }
    yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING' } } }
    yield { type: 'assistant', message: { id: 'performance-test', content: [{ type: 'text', text: 'PRIVATE_ANSWER' }] } }
    yield { type: 'result', subtype: 'success', ttft_stream_ms: 120, first_content_frame_ms: 125,
      duration_api_ms: 9000, unknown_duration_ms: 123, result: 'PRIVATE_ANSWER' }
  })
  const result = await f.worker.handlers.query(f.params, f.context)
  assert.equal(result.status, 'completed')
  const body = await readFile(join(f.config.sessionRoot, '_diagnostics', DEVICE, 'bridge.jsonl'), 'utf8')
  assert.doesNotMatch(body, /PRIVATE_|unknown_duration_ms|prompt|account/)
  const rows = body.trim().split('\n').map(JSON.parse)
  const marks = rows.filter(row => row.event === 'perf.remote').map(row => row.stage)
  assert.deepEqual(marks, ['start', 'hooks_verified', 'toolset_verified', 'first_model_event', 'first_token', 'first_text', 'completed'])
  assert.equal(rows.find(row => row.event === 'perf.sdk' && row.stage === 'ttft_stream_ms').durationMs, 120)
  assert.equal(rows.find(row => row.event === 'perf.sdk' && row.stage === 'duration_api_ms').durationMs, 9000)
})

test('额度 RPC 不发提示词或扫描聊天，只回传窗口并声明能力', async t => {
  const f = await fixture(t, async function* () { throw new Error('不能发起模型推理') })
  f.state.planUsage = { rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 88, resets_at: null },
    model_scoped: [{ display_name: 'Fable', utilization: 40, resets_at: null }],
  }, behaviors: { private: 'transcript' }, session: { private: 'account' } }
  assert.equal((await f.worker.handlers.initialize({ protocolVersion: 1 })).capabilities.planUsage, true)
  const result = await f.worker.handlers.planUsage({}, f.context)
  assert.equal(result.status, 'available')
  assert.deepEqual(f.state.planUsageOptions, { skipBehaviors: true })
  assert.equal(f.state.queries.length, 0)
  assert.equal(f.state.catalogQueries.length, 1)
  assert.equal(f.state.catalogQueries[0].options.persistSession, false)
  assert.equal(result.windows[1].name, 'Fable')
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal((await f.worker.handlers.planUsage({ prompt: '拒绝夹带' }, f.context)).status, 'unavailable')
  assert.equal(f.state.catalogQueries.length, 1)
})
const assistantTool = (id, input) => ({ type: 'assistant', session_id: SESSION,
  message: { content: [{ type: 'tool_use', id, name: 'mcp__dsh__local_command', input }] } })
const compactRequest = (params, runId) => ({ action: 'compact', runId, deviceId: params.deviceId,
  dshSessionId: params.dshSessionId, sessionId: params.sessionId, projectPath: params.projectPath,
  resume: true, model: 'model-a', effort: 'low' })

test('主动压缩复用原生绑定，仅发官方命令并以手动 boundary 确认，不回传摘要正文', async t => {
  let compactInput
  const f = await fixture(t, async function* ({ prompt, options }, state) {
    const input = (await prompt.next()).value
    if (!options.verbatimPrompts) {
      compactInput = input
      yield { type: 'system', subtype: 'compact_boundary', session_id: SESSION,
        compact_metadata: { trigger: 'manual', pre_tokens: 64000 } }
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '私有会话摘要' }] } }
    }
    state.exists = true
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  f.state.commands = [{ name: 'compact' }]
  assert.equal((await f.worker.handlers.initialize({ protocolVersion: 1 })).capabilities.manualCompact, true)
  assert.equal((await f.worker.handlers.query(f.params, f.context)).status, 'completed')
  const cwd = f.state.queries[0].options.cwd
  const baseline = await readFile(join(cwd, 'bridge-session.json'), 'utf8')
  f.state.contextSummary = { totalTokens: 1200, maxTokens: 200000 }
  const result = await f.worker.handlers.query(compactRequest(f.params, 'compact-1'), f.context)
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.compaction, { status: 'compacted', preTokens: 64000 })
  assert.equal(result.metrics.context.totalTokens, 1200)
  assert.equal(compactInput.message.content, '/compact')
  const options = f.state.queries[1].options
  assert.equal(options.resume, SESSION)
  assert.equal(options.cwd, cwd)
  assert.equal(options.verbatimPrompts, false)
  assert.equal(options.maxTurns, 1)
  assert.equal(Object.hasOwn(options, 'systemPrompt'), false)
  assert.deepEqual(options.tools, [])
  assert.deepEqual(options.allowedTools, [])
  assert.deepEqual(options.mcpServers.dsh.instance.tools, [])
  assert.equal(await readFile(join(cwd, 'bridge-session.json'), 'utf8'), baseline)
  assert.equal(f.state.notifications.some(event => event.method === 'sdk.message' && event.params.runId === 'compact-1'), false)
  assert.equal(JSON.stringify(f.state.notifications).includes('私有会话摘要'), false)
})

test('主动压缩成功但没有手动 boundary 时报告未压缩，普通输入仍逐字传递', async t => {
  const inputs = []
  const f = await fixture(t, async function* ({ prompt, options }, state) {
    inputs.push((await prompt.next()).value.message.content)
    if (!options.verbatimPrompts) yield { type: 'system', subtype: 'compact_boundary',
      compact_metadata: { trigger: 'auto', pre_tokens: 100 } }
    state.exists = true
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  f.state.commands = [{ name: 'compact' }]
  f.params.prompt = '/compact 此处是普通用户文字'
  await f.worker.handlers.query(f.params, f.context)
  const result = await f.worker.handlers.query(compactRequest(f.params, 'compact-unchanged'), f.context)
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.compaction, { status: 'unchanged' })
  assert.equal(inputs[0], f.params.prompt)
  assert.equal(f.state.queries[0].options.verbatimPrompts, true)
})

test('主动压缩拒绝新建、夹带自定义输入和未提供官方命令的 SDK，拒绝时不发出提示词', async t => {
  let prompts = 0
  const f = await fixture(t, async function* ({ prompt }, state) {
    await prompt.next(); prompts++
    state.exists = true
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  const compact = compactRequest(f.params, 'compact-invalid')
  for (const patch of [{ resume: false }, { prompt: '自定义指令' }, { tools: [] }, { systemPrompt: '替代系统提示' }]) {
    const result = await f.worker.handlers.query({ ...compact, ...patch }, f.context)
    assert.equal(result.code, 'INVALID_COMPACT_REQUEST')
  }
  assert.equal(f.state.queries.length, 0)
  assert.equal((await f.worker.handlers.query(f.params, f.context)).status, 'completed')
  const result = await f.worker.handlers.query(compactRequest(f.params, 'compact-unavailable'), f.context)
  assert.equal(result.code, 'COMPACT_UNAVAILABLE')
  assert.equal(prompts, 1)
})

test('主动压缩取消后不接受晚到 boundary，不自动重发', async t => {
  const controller = new AbortController()
  const f = await fixture(t, async function* ({ prompt, options }, state) {
    await prompt.next()
    state.exists = true
    if (!options.verbatimPrompts) {
      controller.abort()
      yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 100 } }
    }
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  f.state.commands = [{ name: 'compact' }]
  await f.worker.handlers.query(f.params, f.context)
  const result = await f.worker.handlers.query(compactRequest(f.params, 'compact-cancelled'), { ...f.context, signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.equal(result.compaction, undefined)
  assert.equal(f.state.queries.length, 2)
})

async function fixture(t, queryImplementation, overrides = {}) {
  const tempParent = resolve(tmpdir())
  const root = await mkdtemp(join(tempParent, 'dsh-claude-worker-'))
  t.after(async () => {
    if (dirname(resolve(root)) !== tempParent || !root.startsWith(join(tempParent, 'dsh-claude-worker-'))) {
      throw new Error('测试目录不在预期位置')
    }
    await rm(root, { recursive: true, force: true })
  })
  const state = {
    queries: [], catalogQueries: [], catalogCloses: 0, info: [], requests: [], notifications: [], exists: false, authReads: 0,
    models: [
      { value: 'default', resolvedModel: 'model-a', displayName: '账号默认', supportedEffortLevels: ['low', 'medium', 'high'] },
      { value: 'model-a', displayName: '模型甲', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
      { value: 'model-b', displayName: '模型乙', supportsEffort: true, supportedEffortLevels: ['medium', 'max'] },
    ],
  }
  const sdk = {
    tool(name, description, shape, handler) { return { name, description, shape, handler } },
    createSdkMcpServer({ name, tools }) { return { type: 'sdk', name, instance: { tools } } },
    async getSessionInfo(sessionId, options) { state.info.push({ sessionId, options }); return state.exists ? { sessionId } : undefined },
    query(request) {
      if (request.options.persistSession === false) {
        state.catalogQueries.push(request)
        return {
          async initializationResult() { return { models: state.models, account: { email: 'private@example.invalid' } } },
          async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options) {
            state.planUsageOptions = options; return state.planUsage
          },
          close() { state.catalogCloses++ },
        }
      }
      state.queries.push(request)
      const inner = queryImplementation(request, state)
      const generator = (async function* () {
        const names = request.options.mcpServers.dsh.instance.tools.map((tool) => `mcp__dsh__${tool.name}`)
        yield { type: 'system', subtype: 'init', session_id: request.options.sessionId ?? request.options.resume ?? SESSION, tools: state.initTools ?? names }
        yield* inner
      })()
      generator.initializationResult = async () => ({ hooks_applied: state.hooksApplied ?? true, commands: state.commands ?? [] })
      if (state.contextSummary !== undefined || typeof state.contextReader === 'function') {
        generator.getContextUsage = async (options) => {
          state.contextRequest = options
          return state.contextReader ? state.contextReader(options) : state.contextSummary
        }
      }
      return generator
    },
  }
  const zod = { fromJSONSchema(schema) { return { shape: schema.properties } } }
  const heldLocks = new Set()
  const acquireLock = async (path) => {
    if (heldLocks.has(path)) throw Object.assign(new Error('此会话正在其他进程中运行'), { code: 'SESSION_BUSY' })
    heldLocks.add(path)
    let held = true
    let releaseLost
    const lost = new Promise((resolveLost) => { releaseLost = resolveLost })
    return {
      lost,
      get held() { return held },
      async release() { held = false; heldLocks.delete(path); releaseLost(undefined) },
    }
  }
  const config = {
    sdk, zod, sessionRoot: join(root, 'sessions'), configDir: '/isolated/claude-config',
    cliPath: '/desktop/.local/share/claude/versions/2.1.314', homeDir: '/desktop',
    sdkVersion: '0.3.314', cliVersion: '2.1.314', acquireLock,
    authReader: { async read() { state.authReads++; return { loggedIn: true, authMethod: 'claude.ai' } } },
    ...overrides,
  }
  const worker = createWorkerHandlers(config)
  const peer = {
    notify(method, params) { state.notifications.push({ method, params }) },
    async request(method, params, options) {
      state.requests.push({ method, params, options })
      if (method === 'tool.execute') return { content: [{ type: 'text', text: '完成' }] }
      if (method === 'approval.request') return { behavior: 'deny', message: '未批准' }
      if (method === 'step.prepare') return {}
      throw new Error('unexpected method')
    },
  }
  return {
    root, sdk, state, worker, peer, config,
    context: { peer, signal: new AbortController().signal },
    params: {
      runId: 'run-1', deviceId: DEVICE, dshSessionId: 'dsh-session-1', sessionId: SESSION, resume: false,
      prompt: '检查项目', projectPath: 'D:\\project',
      systemPrompt: 'DSH 专属预设提示词',
      tools: [{ name: 'local_command', description: '执行本机命令', inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'],
      } }],
    },
  }
}

test('流式输入、DSH 提示词、工具 ID、审批和诊断保留边界', async (t) => {
  let calledInput
  let blocked
  let duplicate
  let approval
  const f = await fixture(t, async function* ({ prompt, options }, state) {
    const messages = []
    messages.push((await prompt.next()).value)
    calledInput = messages
    const pre = options.hooks.PreToolUse[0].hooks[0]
    blocked = await pre({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'id' }, tool_use_id: 'blocked' })
    const toolInput = { command: 'Get-Location', cwd: 'D:\\project' }
    assert.deepEqual(await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command', tool_input: toolInput, tool_use_id: 'toolu_1' }), {})
    duplicate = await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command', tool_input: toolInput, tool_use_id: 'toolu_2' })
    yield assistantTool('toolu_1', toolInput)
    // Different property ordering must not lose the SDK tool-use identity.
    const result = await options.mcpServers.dsh.instance.tools[0].handler({ cwd: 'D:\\project', command: 'Get-Location' })
    assert.deepEqual(result, { content: [{ type: 'text', text: '完成' }] })
    await options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch', tool_calls: [{ tool_use_id: 'toolu_1' }] })
    approval = await options.canUseTool('AskUserQuestion', { questions: [] }, { toolUseID: 'toolu_question' })
    yield { type: 'auth_status', isAuthenticating: true, output: ['秘密认证链接'], session_id: SESSION }
    state.exists = true
    yield { type: 'result', subtype: 'success', is_error: false, session_id: SESSION }
  })
  f.params.prompt = [
    { type: 'text', text: '看这张图片' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
  ]
  assert.equal((await f.worker.handlers.initialize({ protocolVersion: 1 })).capabilities.nativeFileAndShellTools, false)
  const result = await f.worker.handlers.query(f.params, f.context)
  assert.deepEqual(result, { sessionId: SESSION, status: 'completed' })
  assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(duplicate.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(approval.behavior, 'deny')
  assert.deepEqual(calledInput[0].message.content, f.params.prompt)
  const options = f.state.queries[0].options
  assert.equal(typeof options.systemPrompt, 'string')
  assert.ok(options.systemPrompt.startsWith(f.params.systemPrompt))
  assert.equal(options.systemPrompt.includes('claude_code'), false)
  assert.deepEqual(options.settingSources, [])
  assert.equal(options.strictMcpConfig, true)
  assert.equal(options.verbatimPrompts, true)
  assert.deepEqual(options.tools, [])
  assert.deepEqual(options.allowedTools, ['mcp__dsh__local_command'])
  assert.equal(options.env.CLAUDE_CONFIG_DIR, '/isolated/claude-config')
  assert.equal(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, '1')
  assert.equal(Object.hasOwn(options.env, 'ANTHROPIC_API_KEY'), false)
  assert.equal(options.sessionId, SESSION)
  assert.equal(Object.hasOwn(options, 'model'), false)
  assert.equal(Object.hasOwn(options, 'maxBudgetUsd'), false)
  assert.equal(Object.hasOwn(options, 'maxTurns'), false)
  assert.equal(f.state.requests[0].params.callId, 'toolu_1')
  assert.deepEqual(f.state.requests[0].params.arguments, { cwd: 'D:\\project', command: 'Get-Location' })
  assert.equal(f.state.requests.some((request) => request.method === 'approval.request'), false)
  assert.equal(JSON.stringify(f.state.notifications).includes('秘密认证链接'), false)
  const diagnostics = f.state.notifications.filter((event) => event.method === 'diagnostic')
  assert.ok(diagnostics.length > 0)
  assert.equal(JSON.stringify(diagnostics).includes('DSH 专属预设提示词'), false)
  assert.equal(JSON.stringify(diagnostics).includes('Get-Location'), false)
})

test('恢复要求设备和会话归属一致，Claude 模型可按目录切换', async (t) => {
  const f = await fixture(t, async function* (_request, state) {
    state.exists = true
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  assert.equal((await f.worker.handlers.query(f.params, f.context)).status, 'completed')
  const other = await f.worker.handlers.query({ ...f.params, runId: 'run-2', deviceId: OTHER_DEVICE, resume: true }, f.context)
  assert.equal(other.code, 'SESSION_BINDING_MISMATCH')
  const wrongDsh = await f.worker.handlers.query({ ...f.params, runId: 'run-2b', dshSessionId: 'different-session', resume: true }, f.context)
  assert.equal(wrongDsh.code, 'SESSION_BINDING_MISMATCH')
  assert.equal(f.state.queries.length, 1)
  f.state.exists = false
  const missing = await f.worker.handlers.query({ ...f.params, runId: 'run-3', resume: true }, f.context)
  assert.equal(missing.code, 'NATIVE_CONTEXT_MISSING')
  assert.equal(f.state.queries.length, 1)
  f.state.exists = true
  const resumed = await f.worker.handlers.query({ ...f.params, runId: 'run-4', resume: true, model: 'model-b', effort: 'max' }, f.context)
  assert.equal(resumed.status, 'completed')
  assert.equal(f.state.queries[1].options.resume, SESSION)
  assert.equal(Object.hasOwn(f.state.queries[1].options, 'sessionId'), false)
  assert.equal(f.state.queries[1].options.model, 'model-b')
  assert.equal(f.state.queries[1].options.effort, 'max')
  const invalid = await f.worker.handlers.query({ ...f.params, runId: 'run-5', resume: true, model: 'model-b', effort: 'high' }, f.context)
  assert.equal(invalid.code, 'EFFORT_UNSUPPORTED')
  assert.equal(f.state.queries.length, 2)
})

test('未取得 SDK 工具标识时不会调用本机工具', async (t) => {
  const f = await fixture(t, async function* ({ options }) {
    try { await options.mcpServers.dsh.instance.tools[0].handler({ command: 'Get-Location' }) } catch { /* worker records the error */ }
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  const result = await f.worker.handlers.query(f.params, f.context)
  assert.equal(result.status, 'failed')
  assert.equal(result.code, 'TOOL_ID_UNAVAILABLE')
  assert.equal(f.state.requests.length, 0)
})

test('工具已执行但附带不支持的上下文时停止，报告结果不可自动重试', async (t) => {
  const f = await fixture(t, async function* ({ options }) {
    const input = { command: 'Get-Location' }
    await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command', tool_input: input, tool_use_id: 'toolu_1' })
    yield assistantTool('toolu_1', input)
    try { await options.mcpServers.dsh.instance.tools[0].handler(input) } catch { /* worker records the error */ }
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  f.peer.request = async (method, params) => {
    f.state.requests.push({ method, params })
    return { content: [{ type: 'text', text: '已执行' }], additionalContexts: [{ type: 'text', text: '额外上下文' }] }
  }
  const result = await f.worker.handlers.query(f.params, f.context)
  assert.equal(result.code, 'UNSUPPORTED_TOOL_EFFECT')
  assert.equal(result.toolMayHaveExecuted, true)
  assert.equal(f.state.requests.length, 1)
})

test('取消传播给 SDK，并在工作完成后返回', async (t) => {
  let startSdk
  const started = new Promise((resolveStarted) => { startSdk = resolveStarted })
  const f = await fixture(t, async function* ({ options }) {
    startSdk()
    if (!options.abortController.signal.aborted) {
      await new Promise((resolveAbort) => options.abortController.signal.addEventListener('abort', resolveAbort, { once: true }))
    }
  })
  const cancellation = new AbortController()
  const query = f.worker.handlers.query(f.params, { peer: f.peer, signal: cancellation.signal })
  await started
  cancellation.abort()
  const result = await query
  assert.equal(result.status, 'cancelled')
  assert.equal(f.state.queries[0].options.abortController.signal.aborted, true)
})

test('不支持的附件和重复注入在创建会话前明确拒绝', async (t) => {
  const f = await fixture(t, async function* () { throw new Error('should not run') })
  const unsupported = await f.worker.handlers.query({
    ...f.params, prompt: [{ type: 'document', source: { type: 'base64', data: 'aGVsbG8=' } }],
  }, f.context)
  assert.equal(unsupported.code, 'UNSUPPORTED_ATTACHMENT')
  const duplicate = await f.worker.handlers.query({ ...f.params, runId: 'run-duplicate', instructions: f.params.systemPrompt }, f.context)
  assert.equal(duplicate.code, 'DUPLICATE_INSTRUCTIONS')
  assert.equal(f.state.queries.length, 0)
  assert.deepEqual(await readdir(f.root), [])
})

test('模型目录只读取初始化结果，严格检查模型和推理档位', async (t) => {
  const f = await fixture(t, async function* () { yield { type: 'result', subtype: 'success', session_id: SESSION } })
  f.state.models[0].unexpectedSecret = '不转发'
  const catalog = await f.worker.handlers.catalog({}, f.context)
  assert.equal(catalog.status, 'ok')
  assert.deepEqual(catalog.models.map((model) => model.value), ['default', 'model-a', 'model-b'])
  assert.equal(JSON.stringify(catalog).includes('private@example.invalid'), false)
  assert.equal(JSON.stringify(catalog).includes('不转发'), false)
  assert.equal(f.state.catalogQueries.length, 1)
  assert.equal(f.state.catalogQueries[0].options.strictMcpConfig, true)
  assert.equal(f.state.catalogCloses, 1)
  assert.equal((await f.state.catalogQueries[0].prompt.next()).done, true)
  const invalid = await f.worker.handlers.query({ ...f.params, model: 'model-a', effort: 'max' }, f.context)
  assert.equal(invalid.code, 'EFFORT_UNSUPPORTED')
  const missing = await f.worker.handlers.query({ ...f.params, runId: 'run-missing', model: 'not-in-list' }, f.context)
  assert.equal(missing.code, 'MODEL_UNAVAILABLE')
  assert.equal(f.state.queries.length, 0)
  assert.equal(f.state.catalogQueries.length, 1)
})

test('明确配置预算后越限或默认模型无法确认时不发推理请求', async (t) => {
  const f = await fixture(t, async function* () { throw new Error('should not run') })
  const capped = createWorkerHandlers({ ...f.config, maxBudgetUsd: 0.15 })
  const overBudget = await capped.handlers.query({ ...f.params, maxBudgetUsd: 0.2 }, f.context)
  assert.equal(overBudget.code, 'BUDGET_LIMIT_EXCEEDED')
  delete f.state.models[0].resolvedModel
  const unknown = await f.worker.handlers.query({ ...f.params, runId: 'run-unknown' }, f.context)
  assert.equal(unknown.code, 'DEFAULT_MODEL_UNRESOLVED')
  assert.equal(f.state.queries.length, 0)
})

test('未配置美元预算时不广告或传递上限，超过旧测试值的成功结果仍正常完成', async t => {
  const f = await fixture(t, async function* (_request, state) {
    state.exists = true
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '合成完整答复' }] } }
    yield { type: 'result', subtype: 'success', session_id: SESSION, total_cost_usd: 3.5 }
  })
  const initialized = await f.worker.handlers.initialize({ protocolVersion: 1 })
  assert.equal(Object.hasOwn(initialized.capabilities, 'maxBudgetUsd'), false)
  const result = await f.worker.handlers.query(f.params, f.context)
  assert.equal(result.status, 'completed')
  assert.equal(result.metrics.cost.usd, 3.5)
  assert.equal(Object.hasOwn(f.state.queries[0].options, 'maxBudgetUsd'), false)
  assert.equal(Object.hasOwn(f.state.queries[0].options, 'maxTurns'), false)
  const requested = await f.worker.handlers.query({ ...f.params, runId: 'explicit-budget', resume: true, maxBudgetUsd: 2 }, f.context)
  assert.equal(requested.status, 'completed')
  assert.equal(f.state.queries[1].options.maxBudgetUsd, 2)
})

test('服务预算仅接受显式正数配置，空配置不恢复测试默认值', () => {
  for (const value of [undefined, '', '  ']) assert.equal(parseServiceBudget(value), undefined)
  assert.equal(parseServiceBudget('2.5'), 2.5)
  for (const value of ['0', '-1', 'NaN', 'Infinity', 'bad', null]) assert.throws(() => parseServiceBudget(value), TypeError)
})

test('明确配置预算后SDK在正文后返回预算错误仍如实报告，不把失败伪装成成功', async t => {
  const f = await fixture(t, async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '合成已输出正文' }] } }
    yield { type: 'result', subtype: 'error_max_budget_usd', session_id: SESSION }
  })
  const capped = createWorkerHandlers({ ...f.config, maxBudgetUsd: 1 })
  assert.equal((await capped.handlers.initialize({ protocolVersion: 1 })).capabilities.maxBudgetUsd, 1)
  const result = await capped.handlers.query(f.params, f.context)
  assert.equal(result.status, 'failed')
  assert.equal(result.code, 'BUDGET_EXHAUSTED')
  assert.equal(f.state.queries[0].options.maxBudgetUsd, 1)
  assert.ok(f.state.notifications.some(item => item.method === 'sdk.message' && item.params.message.type === 'assistant'))
})

test('同一 SDK 会话下一轮可增删工具并更新 Schema，保留提示基线且拒绝旧清单', async t => {
  const f = await fixture(t, async function* ({ prompt, options }, state) {
    await prompt.next()
    const tools = options.mcpServers.dsh.instance.tools
    const pre = options.hooks.PreToolUse[0].hooks[0]
    if (state.queries.length === 1) {
      assert.deepEqual(tools.map(tool => tool.name), ['local_command', 'obsolete_tool'])
      const input = { command: 'synthetic-old' }
      assert.deepEqual(await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command',
        tool_input: input, tool_use_id: 'toolu_original' }), {})
      yield assistantTool('toolu_original', input)
      await tools[0].handler(input)
      await options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_use_id: 'toolu_original' }] })
    } else {
      assert.deepEqual(tools.map(tool => tool.name), ['local_command', 'new_tool'])
      assert.deepEqual(tools[0].shape, { script: { type: 'string' } })
      assert.equal(tools[0].description, '更新后的合成工具')
      const removed = await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__obsolete_tool',
        tool_input: { value: 'stale' }, tool_use_id: 'toolu_removed' })
      assert.equal(removed.hookSpecificOutput.permissionDecision, 'deny')
      assert.equal((await options.canUseTool('mcp__dsh__obsolete_tool', { value: 'stale' },
        { toolUseID: 'toolu_removed' })).behavior, 'deny')
      const staleSchema = await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command',
        tool_input: { command: 'stale-argument' }, tool_use_id: 'toolu_stale_schema' })
      assert.equal(staleSchema.hookSpecificOutput.permissionDecision, 'deny')
      const changed = { script: 'synthetic-updated' }
      assert.deepEqual(await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command',
        tool_input: changed, tool_use_id: 'toolu_changed' }), {})
      yield assistantTool('toolu_changed', changed)
      await tools[0].handler(changed)
      const added = { value: 'synthetic-new' }
      assert.deepEqual(await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__new_tool',
        tool_input: added, tool_use_id: 'toolu_added' }), {})
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_added',
        name: 'mcp__dsh__new_tool', input: added }] } }
      await tools[1].handler(added)
      await options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch',
        tool_calls: [{ tool_use_id: 'toolu_changed' }, { tool_use_id: 'toolu_added' }] })
    }
    state.exists = true
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  f.params.tools = [...f.params.tools, { name: 'obsolete_tool', description: '将被移除的合成工具',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { value: { type: 'string' } }, required: ['value'] } }]
  const capability = await f.worker.handlers.initialize({ protocolVersion: 1 })
  assert.equal(capability.capabilities.localMcpTools, true)
  assert.equal(capability.capabilities.nativeFileAndShellTools, false)
  assert.deepEqual(await f.worker.handlers.query(f.params, f.context), { sessionId: SESSION, status: 'completed' })
  const metadataPath = join(f.root, 'sessions', 'devices', DEVICE, SESSION, 'bridge-session.json')
  const originalMetadata = await readFile(metadataPath)
  const nextTools = [
    { name: 'local_command', description: '更新后的合成工具', inputSchema: {
      type: 'object', additionalProperties: false, properties: { script: { type: 'string' } }, required: ['script'],
    } },
    { name: 'new_tool', description: '新增的合成工具', inputSchema: {
      type: 'object', additionalProperties: false, properties: { value: { type: 'string' } }, required: ['value'],
    } },
  ]
  assert.deepEqual(await f.worker.handlers.query({ ...f.params, runId: 'run-new-toolset', resume: true, tools: nextTools },
    f.context), { sessionId: SESSION, status: 'completed' })
  assert.equal(f.state.queries.length, 2)
  const [first, resumed] = f.state.queries.map(query => query.options)
  assert.equal(first.sessionId, SESSION)
  assert.equal(resumed.resume, SESSION)
  assert.equal(Object.hasOwn(resumed, 'sessionId'), false)
  assert.equal(first.systemPrompt, resumed.systemPrompt)
  assert.equal(JSON.parse(originalMetadata).systemPromptSha256,
    createHash('sha256').update(first.systemPrompt, 'utf8').digest('hex'))
  assert.deepEqual(await readFile(metadataPath), originalMetadata)
  assert.notEqual(first.mcpServers.dsh.instance, resumed.mcpServers.dsh.instance)
  assert.deepEqual(first.allowedTools, ['mcp__dsh__local_command', 'mcp__dsh__obsolete_tool'])
  assert.deepEqual(resumed.allowedTools, ['mcp__dsh__local_command', 'mcp__dsh__new_tool'])
  for (const options of [first, resumed]) {
    assert.deepEqual(options.tools, [])
    assert.deepEqual(options.settingSources, [])
    assert.equal(options.strictMcpConfig, true)
    assert.equal(options.persistSession, true)
    assert.equal(typeof options.hooks.PreToolUse[0].hooks[0], 'function')
    assert.equal(typeof options.hooks.PostToolBatch[0].hooks[0], 'function')
  }
  assert.deepEqual(f.state.notifications.filter(item => item.method === 'sdk.message'
    && item.params.message.subtype === 'init').map(item => item.params.message.tools),
  [first.allowedTools, resumed.allowedTools])
  const executed = f.state.requests.filter(item => item.method === 'tool.execute')
  assert.deepEqual(executed.map(item => [item.params.name, item.params.arguments]), [
    ['local_command', { command: 'synthetic-old' }],
    ['local_command', { script: 'synthetic-updated' }],
    ['new_tool', { value: 'synthetic-new' }],
  ])
})

test('恢复会话必须匹配系统提示基线；旧基线缺失不猜测', async (t) => {
  const f = await fixture(t, async function* (_request, state) {
    state.exists = true
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  assert.equal((await f.worker.handlers.query(f.params, f.context)).status, 'completed')
  const path = join(f.root, 'sessions', 'devices', DEVICE, SESSION, 'bridge-session.json')
  const metadata = JSON.parse(await readFile(path, 'utf8'))
  assert.match(metadata.systemPromptSha256, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(metadata).includes(f.params.systemPrompt), false)
  const changed = await f.worker.handlers.query({ ...f.params, runId: 'run-changed', resume: true,
    systemPrompt: `${f.params.systemPrompt} 新规则` }, f.context)
  assert.equal(changed.code, 'SYSTEM_PROMPT_CHANGED')
  assert.equal(f.state.queries.length, 1)
  delete metadata.systemPromptSha256
  await writeFile(path, JSON.stringify(metadata), 'utf8')
  const legacy = await f.worker.handlers.query({ ...f.params, runId: 'run-legacy', resume: true }, f.context)
  assert.equal(legacy.code, 'SYSTEM_PROMPT_BASELINE_MISSING')
  assert.equal(f.state.queries.length, 1)
})

test('同一设备的不同会话可以同时执行且分别持有会话锁', { timeout: 3000 }, async t => {
  let release, started, count = 0
  const blocked = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { started = resolve })
  t.after(() => release())
  const f = await fixture(t, async function* ({ prompt, options }) {
    await prompt.next()
    if (++count === 2) started()
    await blocked
    yield { type: 'result', subtype: 'success', session_id: options.sessionId }
  })
  const first = f.worker.handlers.query(f.params, f.context)
  const second = f.worker.handlers.query({ ...f.params, runId: 'run-2',
    sessionId: '8d04801d-7b17-4c52-9535-e10a9cc9358a', dshSessionId: 'dsh-session-2' }, f.context)
  await ready
  assert.equal(count, 2)
  release()
  assert.deepEqual((await Promise.all([first, second])).map(result => result.status), ['completed', 'completed'])
})

test('两个独立 worker 不能同时写入同一 SDK 会话', async (t) => {
  let started
  let finish
  const ready = new Promise((resolveReady) => { started = resolveReady })
  const blocked = new Promise((resolveFinish) => { finish = resolveFinish })
  const f = await fixture(t, async function* (_request, state) {
    started()
    await blocked
    state.exists = true
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  const first = f.worker.handlers.query(f.params, f.context)
  await ready
  const otherWorker = createWorkerHandlers(f.config)
  const second = await otherWorker.handlers.query({ ...f.params, runId: 'run-2', resume: true }, f.context)
  assert.equal(second.code, 'SESSION_BUSY')
  finish()
  assert.equal((await first).status, 'completed')
})

test('已认证连接不能冒用其他设备的会话', async (t) => {
  const f = await fixture(t, async function* () { throw new Error('should not run') })
  const bound = createWorkerHandlers({ ...f.config, authorizedDeviceId: DEVICE })
  const result = await bound.handlers.query({ ...f.params, deviceId: OTHER_DEVICE }, f.context)
  assert.equal(result.code, 'DEVICE_MISMATCH')
  assert.equal(f.state.queries.length, 0)
  assert.deepEqual(await readdir(f.root), [])
})

test('用量保留本轮与会话累计语义，上下文只请求本地估算', async (t) => {
  const f = await fixture(t, async function* () {
    yield {
      type: 'result', subtype: 'success', session_id: SESSION, uuid: 'result-uuid',
      usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 20,
        output_tokens_details: { thinking_tokens: 3 } },
      modelUsage: { 'model-a': { inputTokens: 42, outputTokens: 16, costUSD: 0.2, contextWindow: 1000 } },
      total_cost_usd: 0.2,
    }
  })
  f.state.contextSummary = { totalTokens: 100, maxTokens: 1000, percentage: 10, memoryFiles: [{ path: '不转发' }],
    categories: [{ id: 'messages', name: '不转发', tokens: 90, kind: 'used', path: '不转发' }] }
  const result = await f.worker.handlers.query(f.params, f.context)
  assert.equal(result.status, 'completed')
  assert.equal(result.metrics.dedupeKey, 'result-uuid')
  assert.equal(result.metrics.usage.scope, 'current-turn-main-agent')
  assert.equal(result.metrics.usage.thinking_tokens, 3)
  assert.equal(result.metrics.modelUsage.scope, 'session-cumulative-includes-subagents')
  assert.equal(result.metrics.modelUsage.models['model-a'].inputTokens, 42)
  assert.equal(result.metrics.cost.scope, 'session-cumulative-estimate')
  assert.equal(result.metrics.context.source, 'sdk-summary-approximate')
  assert.deepEqual(result.metrics.context.categories, [{ id: 'messages', name: '会话消息', tokens: 90, kind: 'used' }])
  assert.deepEqual(f.state.contextRequest, { detail: 'summary' })
  assert.equal(JSON.stringify(result.metrics).includes('不转发'), false)
})

test('运行中上下文沿原 RPC 转发，压缩前慢采样失效，最终 summary 保持权威', async t => {
  let releaseOld, reads = 0
  const old = new Promise(resolve => { releaseOld = resolve })
  const f = await fixture(t, async function* (_request, state) {
    yield { type: 'stream_event', session_id: SESSION, event: { type: 'message_stop' } }
    yield { type: 'system', subtype: 'status', status: 'compacting', session_id: SESSION, text: '不得传输的摘要' }
    yield { type: 'system', subtype: 'compact_boundary', session_id: SESSION, summary: '不得传输的摘要',
      compact_metadata: { trigger: 'auto', pre_tokens: 900, post_tokens: 100, duration_ms: 20, content: '不得传输的摘要' } }
    releaseOld({ totalTokens: 900, maxTokens: 1000 })
    await tick()
    assert.equal(state.notifications.filter(x => x.params.message?.type === 'bridge_context').length, 0)
    yield { type: 'stream_event', session_id: SESSION, event: { type: 'message_stop' } }
    await tick()
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  f.state.contextReader = () => ++reads === 1 ? old : { totalTokens: reads === 2 ? 100 : 120, maxTokens: 1000 }
  const result = await f.worker.handlers.query(f.params, f.context)
  assert.equal(result.status, 'completed')
  assert.equal(result.metrics.context.totalTokens, 120)
  const events = f.state.notifications.filter(x => x.method === 'sdk.message').map(x => x.params.message)
  const samples = events.filter(x => x.type === 'bridge_context')
  assert.equal(samples.length, 1)
  assert.equal(samples[0].context.totalTokens, 100)
  assert.ok(Number.isSafeInteger(samples[0].observedAt))
  assert.equal(Object.hasOwn(samples[0], 'code'), false)
  assert.deepEqual(events.find(x => x.subtype === 'compact_boundary').compact_metadata,
    { trigger: 'auto', pre_tokens: 900, post_tokens: 100, duration_ms: 20 })
  assert.equal(JSON.stringify(events).includes('不得传输'), false)
  assert.equal(f.state.queries.length, 1)
})

test('工具批次后采样不等待控制请求，也不加入执行收尾队列', async t => {
  let release, reads = 0
  const pending = new Promise(resolve => { release = resolve })
  const f = await fixture(t, async function* ({ options }, state) {
    const batch = options.hooks.PostToolBatch[0].hooks[0]
    assert.deepEqual(await batch({ hook_event_name: 'PostToolBatch', tool_calls: [] }), {})
    await tick()
    assert.equal(reads, 1)
    // The SDK callback completed while the optional context read is still pending.
    release({ totalTokens: 50, maxTokens: 1000 })
    await tick()
    assert.equal(state.notifications.filter(x => x.params.message?.type === 'bridge_context').length, 1)
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  f.state.contextReader = () => ++reads === 1 ? pending : { totalTokens: 60, maxTokens: 1000 }
  const result = await f.worker.handlers.query(f.params, f.context)
  assert.equal(result.status, 'completed')
  assert.equal(result.metrics.context.totalTokens, 60)
  assert.equal(reads, 2)
})

test('登录状态只返回安全字段，未登录时禁止启动 SDK', async (t) => {
  const reader = createAuthReader({ cliPath: '/fake/claude', childEnv: {}, exec: async (_file, args) => {
    assert.deepEqual(args, ['auth', 'status', '--json'])
    throw Object.assign(new Error('do not expose'), { stdout: JSON.stringify({ loggedIn: false, email: 'secret@example.invalid', token: 'secret-token' }) })
  } })
  assert.deepEqual(await reader.read(), { loggedIn: false })
  const f = await fixture(t, async function* () { throw new Error('must not run') })
  const worker = createWorkerHandlers({ ...f.config, authReader: reader })
  assert.equal((await worker.handlers.initialize({ protocolVersion: 1 })).authenticated, false)
  assert.deepEqual(await worker.handlers.authStatus(), { loggedIn: false })
  assert.equal((await worker.handlers.catalog({}, f.context)).code, 'AUTH_REQUIRED')
  assert.equal((await worker.handlers.planUsage({}, f.context)).code, 'AUTH_REQUIRED')
  assert.equal((await worker.handlers.query(f.params, f.context)).code, 'AUTH_REQUIRED')
  assert.equal(f.state.catalogQueries.length, 0)
  assert.equal(f.state.queries.length, 0)
})

test('手动额度刷新重新验证登录且不触发模型', async t => {
  const f = await fixture(t, async function* () { throw new Error('不能发起模型推理') })
  const checks = []
  const worker = createWorkerHandlers({ ...f.config, authReader: { async read(options) {
    checks.push(options.refresh)
    return { loggedIn: false }
  } } })
  assert.equal((await worker.handlers.planUsage({ refresh: true }, f.context)).code, 'AUTH_REQUIRED')
  assert.deepEqual(checks, [true])
  assert.equal(f.state.queries.length + f.state.catalogQueries.length, 0)
  await worker.close()
})

test('目录新增的思考档位按实际值通过，不预置档位清单', async (t) => {
  const f = await fixture(t, async function* () { yield { type: 'result', subtype: 'success', session_id: SESSION } })
  f.state.models[1].supportedEffortLevels.push('future-level')
  const catalog = await f.worker.handlers.catalog({}, f.context)
  assert.ok(catalog.models[1].supportedEffortLevels.includes('future-level'))
  const result = await f.worker.handlers.query({ ...f.params, model: 'model-a', effort: 'future-level' }, f.context)
  assert.equal(result.status, 'completed')
  assert.equal(f.state.queries[0].options.effort, 'future-level')
})

test('仅目录确认支持自适应思考时请求官方思考摘要', async (t) => {
  const f = await fixture(t, async function* (_request, state) {
    state.exists = true
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  f.state.models[1].supportsAdaptiveThinking = true
  f.state.models[2].supportsAdaptiveThinking = false
  const first = await f.worker.handlers.query({ ...f.params, model: 'model-a', effort: 'low' }, f.context)
  assert.equal(first.status, 'completed')
  assert.deepEqual(f.state.queries[0].options.thinking, { type: 'adaptive', display: 'summarized' })
  assert.equal(f.state.queries[0].options.effort, 'low')
  const second = await f.worker.handlers.query({ ...f.params, runId: 'run-no-adaptive', resume: true, model: 'model-b', effort: 'medium' }, f.context)
  assert.equal(second.status, 'completed')
  assert.equal(Object.hasOwn(f.state.queries[1].options, 'thinking'), false)
  const third = await f.worker.handlers.query({ ...f.params, runId: 'run-unknown-adaptive', resume: true }, f.context)
  assert.equal(third.status, 'completed')
  assert.equal(Object.hasOwn(f.state.queries[2].options, 'thinking'), false)
})

test('SDK 结构化鉴权失败分类并脱敏，即使结果后抛异常', async (t) => {
  const f = await fixture(t, async function* () {
    yield { type: 'assistant', session_id: SESSION, error: 'authentication_failed', message: { content: [{ type: 'text', text: 'SECRET LOGIN URL' }] } }
    yield { type: 'result', subtype: 'error_during_execution', session_id: SESSION, api_error_status: 401, errors: ['SECRET LOGIN URL'] }
    throw new Error('SECRET LOGIN URL')
  })
  const result = await f.worker.handlers.query(f.params, f.context)
  assert.equal(result.code, 'AUTH_EXPIRED')
  assert.equal(result.apiErrorStatus, 401)
  assert.equal(JSON.stringify(f.state.notifications).includes('SECRET LOGIN URL'), false)
  assert.equal((await f.worker.handlers.settle({ runId: f.params.runId })).code, 'AUTH_EXPIRED')
})

test('SDK 认证流程报错不泄露认证链接，也不猜测具体原因', async (t) => {
  const f = await fixture(t, async function* () {
    yield { type: 'auth_status', session_id: SESSION, isAuthenticating: false, error: 'PRIVATE AUTH URL' }
    yield { type: 'result', subtype: 'error_during_execution', session_id: SESSION, errors: ['PRIVATE AUTH URL'] }
  })
  const result = await f.worker.handlers.query(f.params, f.context)
  assert.equal(result.code, 'AUTH_FLOW_FAILED')
  assert.equal(JSON.stringify(f.state.notifications).includes('PRIVATE AUTH URL'), false)
  const auth = f.state.notifications.find((entry) => entry.method === 'sdk.message' && entry.params.message.type === 'auth_status')
  assert.equal(auth.params.message.errorCode, 'AUTH_FLOW_FAILED')
})

test('取消后 settle 等待 SDK 和回调实际收尾', async (t) => {
  let started, finish
  const ready = new Promise((resolveReady) => { started = resolveReady })
  const blocked = new Promise((resolveFinish) => { finish = resolveFinish })
  const f = await fixture(t, async function* ({ options }) {
    started()
    await new Promise((resolveAbort) => options.abortController.signal.addEventListener('abort', resolveAbort, { once: true }))
    await blocked
    yield { type: 'assistant', session_id: SESSION, message: { content: [{ type: 'text', text: '晚到文字' }] } }
  })
  const cancellation = new AbortController()
  const query = f.worker.handlers.query(f.params, { peer: f.peer, signal: cancellation.signal })
  await ready
  let settled = false
  const waiting = f.worker.handlers.settle({ runId: f.params.runId }).then((value) => { settled = true; return value })
  cancellation.abort()
  await Promise.resolve()
  assert.equal(settled, false)
  finish()
  assert.equal((await query).status, 'cancelled')
  assert.equal((await waiting).status, 'cancelled')
  assert.equal((await f.worker.handlers.settle({ runId: f.params.runId })).status, 'cancelled')
  assert.equal((await f.worker.handlers.settle({ runId: 'never-seen' })).code, 'RUN_UNKNOWN')
  assert.equal(JSON.stringify(f.state.notifications).includes('晚到文字'), false)
})

test('工具和审批修改后的未知参数在 SDK 清理前拒绝', async (t) => {
  let originalDenied, editedDenied
  const f = await fixture(t, async function* ({ options }) {
    const pre = options.hooks.PreToolUse[0].hooks[0]
    originalDenied = await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command', tool_input: { command: 'pwd', unexpected: 1 }, tool_use_id: 'bad' })
    await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command', tool_input: { command: 'pwd' }, tool_use_id: 'ok' })
    editedDenied = await options.canUseTool('mcp__dsh__local_command', { command: 'pwd' }, { toolUseID: 'ok' })
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  f.peer.request = async () => ({ behavior: 'allow', updatedInput: { command: 'pwd', unexpected: 1 } })
  assert.equal((await f.worker.handlers.query(f.params, f.context)).status, 'completed')
  assert.equal(originalDenied.hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(editedDenied.behavior, 'deny')
})

test('文本附加上下文在工具执行后由对应 callId 的 SDK hook 接收', async (t) => {
  const outputs = []
  const f = await fixture(t, async function* ({ options }) {
    const name = 'mcp__dsh__local_command'
    const pre = options.hooks.PreToolUse[0].hooks[0]
    const call = options.mcpServers.dsh.instance.tools[0].handler
    for (const [id, command, hookEvent] of [
      ['toolu_ok', 'one', 'PostToolUse'], ['toolu_error', 'two', 'PostToolUseFailure'],
    ]) {
      const input = { command }
      await pre({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id })
      yield assistantTool(id, input)
      const result = await call(input)
      assert.equal(Object.hasOwn(result, 'additionalContexts'), false)
      outputs.push(await options.hooks[hookEvent][0].hooks[0]({ hook_event_name: hookEvent, tool_use_id: id }))
    }
    await options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch', tool_calls: [
      { tool_use_id: 'toolu_ok' }, { tool_use_id: 'toolu_error' },
    ] })
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  f.peer.request = async (method, params) => method === 'step.prepare' ? {} : ({
    content: [{ type: 'text', text: '已执行' }],
    isError: params.callId === 'toolu_error', additionalContexts: [`上下文:${params.callId}`],
  })
  assert.equal((await f.worker.handlers.query(f.params, f.context)).status, 'completed')
  assert.deepEqual(outputs, [
    { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '上下文:toolu_ok' } },
    { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: '上下文:toolu_error' } },
  ])
})

test('工具结束本轮使用 SDK 后置 hook，并要求 SDK 确认停止', async (t) => {
  let hookOutput
  const f = await fixture(t, async function* ({ options }) {
    const input = { command: 'one' }
    await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command', tool_input: input, tool_use_id: 'toolu_stop' })
    yield assistantTool('toolu_stop', input)
    const result = await options.mcpServers.dsh.instance.tools[0].handler(input)
    assert.equal(Object.hasOwn(result, 'concludesTurn'), false)
    hookOutput = await options.hooks.PostToolUse[0].hooks[0]({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_stop' })
    yield { type: 'result', subtype: 'success', session_id: SESSION, terminal_reason: 'hook_stopped' }
  })
  f.peer.request = async () => ({ content: [{ type: 'text', text: '结束' }], concludesTurn: true })
  assert.equal((await f.worker.handlers.query(f.params, f.context)).status, 'completed')
  assert.deepEqual(hookOutput, { continue: false, stopReason: 'DSH 工具已结束本轮。' })
})

test('后置 hook 缺失、停止未确认以及效果组合不静默通过', async (t) => {
  const f = await fixture(t, async function* ({ options }) {
    const input = { command: 'one' }
    await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command', tool_input: input, tool_use_id: 'toolu_unconfirmed' })
    yield assistantTool('toolu_unconfirmed', input)
    try { await options.mcpServers.dsh.instance.tools[0].handler(input) } catch { /* worker records the effect error */ }
    if (f.state.mode === 'no-stop') await options.hooks.PostToolUse[0].hooks[0]({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_unconfirmed' })
    yield { type: 'result', subtype: 'success', session_id: SESSION, terminal_reason: 'completed' }
  })
  f.peer.request = async () => f.state.mode === 'combined'
    ? { content: [], concludesTurn: true, additionalContexts: ['内容'] }
    : { content: [], concludesTurn: true }
  const missing = await f.worker.handlers.query(f.params, f.context)
  assert.equal(missing.code, 'TOOL_EFFECT_UNCONFIRMED')
  assert.equal(missing.toolMayHaveExecuted, true)
  f.state.exists = true
  f.state.mode = 'no-stop'
  const notStopped = await f.worker.handlers.query({ ...f.params, runId: 'run-no-stop', resume: true }, f.context)
  assert.equal(notStopped.code, 'TOOL_CONCLUSION_UNCONFIRMED')
  f.state.mode = 'combined'
  const combined = await f.worker.handlers.query({ ...f.params, runId: 'run-combined', resume: true }, f.context)
  assert.equal(combined.code, 'UNSUPPORTED_TOOL_EFFECT_COMBINATION')
  assert.equal(combined.toolMayHaveExecuted, true)
})

test('SDK 工具回调提前到达时，先转发对应 assistant 再执行本机工具', async (t) => {
  const order = []
  const f = await fixture(t, async function* ({ options }) {
    const input = { command: 'pwd' }
    await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command', tool_input: input, tool_use_id: 'toolu_race' })
    const pending = options.mcpServers.dsh.instance.tools[0].handler(input)
    await Promise.resolve()
    assert.equal(order.includes('execute'), false)
    yield assistantTool('toolu_race', input)
    await pending
    await options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch', tool_calls: [{ tool_use_id: 'toolu_race' }] })
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  f.peer.notify = (method, params) => {
    if (method === 'sdk.message' && params.message.type === 'assistant') order.push('assistant')
  }
  f.peer.request = async (method) => {
    if (method === 'step.prepare') return {}
    order.push('execute')
    return { content: [{ type: 'text', text: '完成' }] }
  }
  assert.equal((await f.worker.handlers.query(f.params, f.context)).status, 'completed')
  assert.deepEqual(order, ['assistant', 'execute'])
})

test('SDK 工具消息缺失或取消时不派发本机工具', async (t) => {
  const f = await fixture(t, async function* ({ options }) {
    const input = { command: 'pwd' }
    await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command', tool_input: input, tool_use_id: 'toolu_missing' })
    try { await options.mcpServers.dsh.instance.tools[0].handler(input) } catch { /* worker retains failure */ }
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  const worker = createWorkerHandlers({ ...f.config, toolEventTimeoutMs: 30 })
  const missing = await worker.handlers.query(f.params, f.context)
  assert.equal(missing.code, 'TOOL_EVENT_ORDER_UNAVAILABLE')
  assert.equal(f.state.requests.length, 0)
  f.state.exists = true
  const abort = new AbortController()
  let started
  const ready = new Promise((resolveStarted) => { started = resolveStarted })
  const originalTool = f.sdk.tool
  f.sdk.tool = (...args) => {
    const tool = originalTool(...args)
    return { ...tool, handler(input) { const pending = tool.handler(input); started(); return pending } }
  }
  const pending = worker.handlers.query({ ...f.params, runId: 'run-cancel-wait', resume: true }, { peer: f.peer, signal: abort.signal })
  await ready
  abort.abort()
  assert.equal((await pending).status, 'cancelled')
  assert.equal(f.state.requests.length, 0)
})

test('工具批次结束后等待本机 step.prepare 并注入新增上下文', async (t) => {
  let hookOutput
  const f = await fixture(t, async function* ({ options }) {
    const input = { command: 'pwd' }
    await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command', tool_input: input, tool_use_id: 'toolu_batch' })
    yield assistantTool('toolu_batch', input)
    await options.mcpServers.dsh.instance.tools[0].handler(input)
    await options.hooks.PostToolUse[0].hooks[0]({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_batch' })
    hookOutput = await options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch', tool_calls: [
      { tool_use_id: 'toolu_batch', tool_name: 'mcp__dsh__local_command', tool_input: input },
    ] }, undefined, { signal: new AbortController().signal })
    yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  f.peer.request = async (method, params) => {
    f.state.requests.push({ method, params })
    if (method === 'tool.execute') return { content: [{ type: 'text', text: '完成' }] }
    if (method === 'step.prepare') return { additionalContexts: ['子目录规则', '新运行上下文'] }
    throw new Error('unexpected method')
  }
  assert.equal((await f.worker.handlers.query(f.params, f.context)).status, 'completed')
  assert.deepEqual(f.state.requests.map((item) => item.method), ['tool.execute', 'step.prepare'])
  assert.deepEqual(f.state.requests[1].params, { runId: f.params.runId })
  assert.deepEqual(hookOutput, { hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: '子目录规则\n\n新运行上下文' } })
})

test('批次后本机要求结束或准备失败时不会静默继续', async (t) => {
  let output
  const f = await fixture(t, async function* ({ options }) {
    try {
      output = await options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch', tool_calls: [] },
        undefined, { signal: new AbortController().signal })
    } catch { /* worker records the prepare failure */ }
    yield { type: 'result', subtype: 'success', session_id: SESSION, terminal_reason: f.state.failure ? 'completed' : 'hook_stopped' }
  })
  f.peer.request = async () => {
    if (f.state.failure) throw new Error('must not leak')
    return { continue: false }
  }
  assert.equal((await f.worker.handlers.query(f.params, f.context)).status, 'completed')
  assert.deepEqual(output, { continue: false, stopReason: 'DSH 已结束本轮。' })
  f.state.exists = true
  f.state.failure = true
  const failed = await f.worker.handlers.query({ ...f.params, runId: 'run-prepare-failed', resume: true }, f.context)
  assert.equal(failed.code, 'STEP_PREPARE_FAILED')
  assert.equal(failed.toolMayHaveExecuted, true)
})

test('必要 hooks 未获 SDK 确认时不发送用户消息', async (t) => {
  const f = await fixture(t, async function* () { throw new Error('must not consume prompt') })
  f.state.hooksApplied = false
  const result = await f.worker.handlers.query(f.params, f.context)
  assert.equal(result.code, 'HOOKS_NOT_APPLIED')
  assert.equal((await f.state.queries[0].prompt.next()).done, true)
})

test('远端实际工具清单与本机不符时明确失败且不派发工具', async (t) => {
  const f = await fixture(t, async function* () { throw new Error('must not reach query body') })
  f.state.initTools = ['mcp__dsh__local_command', 'UnexpectedNativeTool']
  const result = await f.worker.handlers.query(f.params, f.context)
  assert.equal(result.code, 'SDK_TOOLSET_MISMATCH')
  assert.equal((await f.state.queries[0].prompt.next()).done, true)
  assert.equal(f.state.requests.length, 0)
})

test('工具已执行但批次 hook 未确认时明确失败', async (t) => {
  const f = await fixture(t, async function* ({ options }, state) {
    const input = { command: 'pwd' }
    await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'mcp__dsh__local_command', tool_input: input, tool_use_id: 'toolu_no_batch' })
    yield assistantTool('toolu_no_batch', input)
    await options.mcpServers.dsh.instance.tools[0].handler(input)
    if (state.mode === 'next') yield { type: 'stream_event', session_id: SESSION, event: { type: 'message_start' } }
    else yield { type: 'result', subtype: 'success', session_id: SESSION }
  })
  const first = await f.worker.handlers.query(f.params, f.context)
  assert.equal(first.code, 'STEP_BOUNDARY_UNCONFIRMED')
  assert.equal(first.toolMayHaveExecuted, true)
  f.state.exists = true
  f.state.mode = 'next'
  const next = await f.worker.handlers.query({ ...f.params, runId: 'run-no-batch-next', resume: true }, f.context)
  assert.equal(next.code, 'STEP_BOUNDARY_UNCONFIRMED')
  assert.equal(next.toolMayHaveExecuted, true)
})

function gateCatalogInitialization(f) {
  const requests = []
  let changed
  const query = f.sdk.query.bind(f.sdk)
  f.sdk.query = request => {
    const result = query(request)
    if (request.options.persistSession === false) {
      let resolve, reject
      const initialization = new Promise((accept, fail) => { resolve = accept; reject = fail })
      result.initializationResult = () => initialization
      requests.push({ request, resolve, reject })
      changed?.()
    }
    return result
  }
  return { requests, async waitFor(count) {
    while (requests.length < count) await new Promise(resolve => { changed = resolve })
  } }
}

test('普通目录冷读共享一次初始化，首个和后续调用者取消不影响其他等待者', async t => {
  const f = await fixture(t, async function* () { throw new Error('不能发起模型推理') })
  const gate = gateCatalogInitialization(f)
  const first = new AbortController(), second = new AbortController()
  const reads = [f.worker.handlers.catalog({}, { signal: first.signal }),
    f.worker.handlers.catalog({}, { signal: second.signal }), f.worker.handlers.catalog({}, f.context)]
  await gate.waitFor(1)
  first.abort(); second.abort()
  assert.deepEqual((await Promise.all(reads.slice(0, 2))).map(reply => reply.code), ['CANCELLED', 'CANCELLED'])
  assert.equal(f.state.authReads, 3)
  assert.equal(gate.requests.length, 1)
  assert.equal(gate.requests[0].request.options.abortController.signal.aborted, false)
  gate.requests[0].resolve({ models: f.state.models })
  assert.equal((await reads[2]).status, 'ok')
  assert.equal(f.state.catalogCloses, 1)
  assert.equal(f.state.queries.length, 0)
})

test('目录共享结果独立复制，三十秒有效期和预先取消仍生效', async t => {
  const f = await fixture(t, async function* () { throw new Error('不能发起模型推理') })
  f.state.models[1].inputModalities = ['text', 'image']
  const { createCatalogReader } = await import('../remote/catalog.mjs')
  let time = 100
  const reader = createCatalogReader({ ...f.config, now: () => time })
  const [first, second] = await Promise.all([reader.read(), reader.read()])
  first[1].inputModalities.push('changed')
  first[1].supportedEffortLevels.push('changed')
  assert.deepEqual(second[1].inputModalities, ['text', 'image'])
  assert.deepEqual(second[1].supportedEffortLevels, ['low', 'high'])
  assert.equal(f.state.catalogQueries.length, 1)
  time = 30_099
  assert.deepEqual((await reader.read())[1].inputModalities, ['text', 'image'])
  assert.equal(f.state.catalogQueries.length, 1)
  time = 30_100
  await reader.read()
  assert.equal(f.state.catalogQueries.length, 2)
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(reader.read({ signal: cancelled.signal }), { code: 'CANCELLED' })
  assert.equal(f.state.catalogQueries.length, 2)
})

test('显式目录刷新独立发起，旧共享冷读晚到不覆盖刷新后的缓存', async t => {
  const f = await fixture(t, async function* () { throw new Error('不能发起模型推理') })
  const gate = gateCatalogInitialization(f)
  const { createCatalogReader } = await import('../remote/catalog.mjs')
  const reader = createCatalogReader(f.config)
  const old = reader.read()
  await gate.waitFor(1)
  const fresh = reader.read({ refresh: true })
  await gate.waitFor(2)
  const models = label => [{ value: label, displayName: label }]
  gate.requests[1].resolve({ models: models('fresh') })
  assert.equal((await fresh)[0].value, 'fresh')
  gate.requests[0].resolve({ models: models('old') })
  assert.equal((await old)[0].value, 'old')
  assert.equal((await reader.read())[0].value, 'fresh')
  assert.equal(gate.requests.length, 2)
})

test('共享目录查询失败后清除等待项，下次请求可重新读取', async t => {
  const f = await fixture(t, async function* () { throw new Error('不能发起模型推理') })
  const gate = gateCatalogInitialization(f)
  const { createCatalogReader } = await import('../remote/catalog.mjs')
  const reader = createCatalogReader(f.config)
  const failed = [reader.read(), reader.read()]
  const rejected = failed.map(read => assert.rejects(read, { code: 'CATALOG_UNAVAILABLE' }))
  await gate.waitFor(1)
  gate.requests[0].reject(new Error('合成目录初始化失败'))
  await Promise.all(rejected)
  const retry = reader.read()
  await gate.waitFor(2)
  gate.requests[1].resolve({ models: f.state.models })
  assert.equal((await retry)[1].value, 'model-a')
  assert.equal(f.state.catalogCloses, 2)
})
