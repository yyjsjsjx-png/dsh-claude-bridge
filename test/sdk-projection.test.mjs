import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { RESPONSE_USAGE_RECORD, RUN_USAGE_RECORD, initialResponseUsage,
  applyResponseUsage, responseUsageView, createResponseUsageProjection } from '../src/response-usage.mjs'
import { strictSession } from './fixtures/native-persistence.mjs'
import { SdkProjection } from '../src/sdk-projection.mjs'
import { HISTORY_ASSISTANT } from '../src/history-records.mjs'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { RESPONSE_TIMING_RECORD, createResponseTimingProjection } from '../src/response-timing.mjs'
import { MODEL_OBSERVATION_RECORD, createModelObservationProjection } from '../src/model-observation.mjs'

// Run in the installed DSH Electron executable with ELECTRON_RUN_AS_NODE=1.
// The ordinary Node test suite skips these cases if its ASAR reader is absent.
const available = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)

test('实际 rc5 follow：原生 Agent 全局事件经 Host 基线和实时订阅逐增量抵达客户端', { skip: !available, timeout: 5000 }, async t => {
  const f = await fixture()
  const controllerUrl = resolveDshModule('@deepseek-ai/dsh-api-session-controller')
  const require = createRequire(controllerUrl)
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const [{ Context }, { agentEvents }, { createScope }, sessionModule, { Deque }, { SessionQueryError }]
    = await Promise.all([load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-agent'),
      load('@deepseek-ai/dsh-scope'), load('@deepseek-ai/dsh-session'),
      load('@deepseek-ai/dsh-deque'), load('@deepseek-ai/dsh-session-query')])
  const ctx = new Context()
  const source = await readFile(new URL(controllerUrl), 'utf8')
  const region = name => {
    const start = source.indexOf(`//#region ${name}`), end = source.indexOf('//#endregion', start)
    assert.ok(start >= 0 && end > start)
    return source.slice(start, end)
  }
  // Execute the installed private follow implementation, with its real Cordis
  // event routing; no Host, persistence, auth or model service is started.
  const { SessionHistoryController } = vm.runInNewContext([
    region('lib/types/assistant-stream.js'), region('lib/types/history.js'),
    '({ SessionHistoryController })',
  ].join('\n'), { AssistantStreamAccumulator: f.helpers.AssistantStreamAccumulator,
    ...sessionModule, Deque, SessionQueryError, RemoteError: f.helpers.RemoteError, Symbol })
  const id = 'native-follow-projection'
  const session = sessionModule.Session.create(id, undefined, { id, version: sessionModule.SESSION_FORMAT_VERSION,
    createdAt: 0, delegationDepth: 0, isSeeded: false, agentPreset: 'claude-sdk-remote', cwd: process.cwd() })
  const append = session.append.bind(session)
  session.append = (...args) => {
    const event = append(...args)
    ctx.emit('session/event', session, event)
    return event
  }
  ctx.sessionQuery = { async observeSession() { return { header: session.header,
    events: session.snapshotEvents(), cursor: session.seq - 1, inheritedEventCount: 0,
    source: 'attached', [Symbol.dispose]() {} } } }
  const history = new SessionHistoryController(ctx, () => { throw new Error('不得激活会话') })
  const abort = new AbortController()
  const followed = history.follow({ address: { kind: 'session', sessionId: id }, assistantStream: true }, abort.signal)
  t.after(async () => { abort.abort(); await followed.return(); await ctx.fiber.dispose() })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const opening = (await followed.next()).value
  assert.equal(opening.type, 'snapshot')
  assert.equal(opening.assistantStream.revision, 0)
  const clientSource = await readFile(new URL('../plugin/session-client/client.js', import.meta.url), 'utf8')
  const start = clientSource.indexOf('var ClientAssistantStream = class')
  const end = clientSource.indexOf('//#endregion', start)
  const client = vm.runInNewContext(`${clientSource.slice(start, end)}; new ClientAssistantStream()`)
  client.replace(opening.records.map(record => ({ type: 'durable', event: record.event })), opening.assistantStream)
  const agent = { id, session, assistantStreamRevision: 0 }
  agent.dispatch = agentEvents(ctx, agent)
  agent.scope = createScope(ctx, agent)
  agent.ctx = agent.scope.ctx
  t.after(() => agent.scope.dispose())
  const helpers = { ...f.helpers, appendPluginRecord(target, type, data) {
    const seq = sessionModule.appendPluginRecord(target, type, data)
    ctx.emit('session/event', target, target.eventAt(seq))
    return seq
  } }
  const projection = new SdkProjection({ agent, helpers, turn: 1, step: 1, model: 'fixture' })
  const stream = event => projection.accept({ type: 'stream_event', event })
  let cursor = opening.cursor
  let revision = opening.assistantStream.revision
  let metadataEvents = 0
  const nextFrame = async () => {
    for (;;) {
      const result = await followed.next()
      assert.equal(result.done, false)
      if (result.value.type === 'event') {
        const event = result.value.event
        assert.equal(event.seq, cursor + 1)
        assert.ok([RESPONSE_TIMING_RECORD, MODEL_OBSERVATION_RECORD].includes(event.type))
        assert.equal(event.ignorable, true)
        cursor = event.seq
        const decision = client.acceptDurable(result.value)
        assert.notEqual(decision?.type, 'rebaseline')
        metadataEvents++
        continue
      }
      assert.equal(result.value.type, 'assistant-stream')
      assert.equal(result.value.frame.revision, ++revision)
      if (result.value.frame.type === 'start') assert.equal(result.value.frame.startedAfterSeq, cursor)
      const decision = client.acceptFrame(result.value.frame)
      assert.notEqual(decision?.type, 'rebaseline')
      return { frame: result.value.frame, decision }
    }
  }
  await stream({ type: 'message_start', message: { id: 'native-follow-api' } })
  await stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
  const first = await nextFrame()
  assert.equal(first.frame.type, 'start')
  assert.equal(first.frame.startedAfterSeq, cursor)
  assert.equal(metadataEvents, 2)
  await nextFrame()
  for (const text of ['合成第一段', '合成第二段']) {
    await stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
    const delivered = await nextFrame()
    assert.equal(delivered.decision.type, 'transient')
    assert.equal(delivered.decision.entry.event.data.chunk.type, 'text-delta')
    assert.equal(delivered.decision.entry.event.data.chunk.text, text)
    assert.equal(session.snapshotEvents().some(event => event.type === 'assistant/message'), false)
  }
})

test('实际 rc5 helper：工具使用最终 SDK 参数登记，Unicode 流式差异不进入执行历史', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  const streamed = { command: String.raw`'\ufeff'` }
  const canonical = { command: "'\ufeff'" }
  await projection.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'canonical-tool' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'toolu_unicode', name: 'mcp__dsh__local_command', input: {} } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(streamed) } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await projection.accept({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 12 } } })
  await projection.accept({ type: 'stream_event', event: { type: 'message_stop' } })
  assert.equal(projection.getCommittedToolCall('toolu_unicode'), undefined)
  assert.equal(records.filter(record => record.type === 'assistant/message').length, 0)
  await projection.accept({ type: 'assistant', message: { id: 'canonical-tool', content: [
    { type: 'tool_use', id: 'toolu_unicode', name: 'mcp__dsh__local_command', input: canonical },
  ] } })
  assert.deepEqual(JSON.parse(projection.getCommittedToolCall('toolu_unicode').arguments), canonical)
  const committed = records.find(record => record.type === 'assistant/message')
  assert.deepEqual(JSON.parse(committed.data.message.content[0].arguments), canonical)
  assert.deepEqual(committed.data.stream, [])
})

async function fixture() {
  const helpers = { ...await import('../plugin/compat/runtime.mjs'),
    appendPluginRecord(session, type, data) { return session.append(type, data, { ignorable: true }).seq } }
  const records = []
  const frames = []
  const agent = {
    id: 'projection-test',
    session: { eventAt: seq => records[seq - 1],
      append(type, data, intent) { records.push({ type, data, ...intent, intent }); return { seq: records.length } } },
    dispatch: { emit(type, value) { frames.push({ type, ...value }) } },
  }
  const projection = new SdkProjection({ agent, helpers, turn: 1, step: 1, model: 'haiku', async onUsage() {} })
  return { records, frames, projection, agent, helpers }
}

test('实际rc5型号归属：message_stop提前落盘使用本响应型号，缺失不沿用，独立观察可严格重放',
  { skip: !available }, async () => {
    const native = await import(resolveDshModule('@deepseek-ai/dsh-session'))
    const { z } = await import(resolveDshModule('zod'))
    const helpers = { ...await import('../plugin/compat/runtime.mjs'), appendPluginRecord: native.appendPluginRecord }
    const id = 'model-observation-native'
    const session = native.Session.create(id, undefined, { version: native.SESSION_FORMAT_VERSION,
      id, createdAt: 0, delegationDepth: 0, isSeeded: false, agentPreset: 'claude-sdk-remote' })
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    const request = { type: 'request/header', data: { reason: 'initial', header: {
      config: { provider: 'claude-sdk-remote', model: 'haiku', reasoningEffort: 'high' } } } }
    session.append(request.type, request.data)
    const projection = new SdkProjection({ agent: { id, session, dispatch: { emit() {} } },
      helpers, turn: 1, step: 1, model: 'haiku', runId: 'model-run' })
    const stream = event => projection.accept({ type: 'stream_event', event })
    const beginText = async (id, model, text) => {
      await stream({ type: 'message_start', message: { id, ...(model ? { model } : {}), usage: { input_tokens: 1 } } })
      await stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
      await stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
      await stream({ type: 'content_block_stop', index: 0 })
    }
    const stop = async () => {
      await stream({ type: 'message_delta', usage: { output_tokens: 1 } })
      await stream({ type: 'message_stop' })
    }
    const models = () => session.snapshotEvents().filter(e => e.type === 'assistant/message').map(e => e.data.message.source.model)
    const evidence = () => session.snapshotEvents().filter(e => e.type === MODEL_OBSERVATION_RECORD).map(e => e.data)
    await projection.accept({ type: 'system', subtype: 'init', model: 'init-is-not-evidence' })
    await projection.accept({ type: 'assistant', message: { id: 'synthetic', model: '<synthetic>',
      content: [{ type: 'text', text: 'No response requested.' }] } })
    assert.equal(evidence().length, 0)
    await beginText('response-a', 'wire-a', '合成A'); await stop()
    assert.deepEqual(models(), ['wire-a']) // Already durable before final assistant.
    await projection.accept({ type: 'assistant', message: { id: 'response-a', content: [{ type: 'text', text: '合成A' }] } })
    assert.equal(evidence().length, 1) // Missing field on same response retains its evidence.
    await beginText('response-b', undefined, '合成B'); await stop()
    assert.deepEqual(models(), ['wire-a', 'haiku']) // Native mandatory source uses requested fallback, never wire-a.
    assert.equal(evidence().at(-1).actualModel, null)
    await projection.accept({ type: 'assistant', message: { id: 'response-b', model: 'wire-b', content: [{ type: 'text', text: '合成B' }] } })
    assert.equal(evidence().at(-1).actualModel, 'wire-b') // Late evidence is independent of already-committed text.
    await beginText('response-c', 'wire-c', '合成C')
    await projection.accept({ type: 'assistant', message: { id: 'response-d', model: 'wire-d', content: [{ type: 'text', text: '合成D' }] } })
    await projection.accept({ type: 'result' })
    assert.deepEqual(models(), ['wire-a', 'haiku', 'wire-c', 'wire-d'])
    session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1 })
    await strictSession(session)
    const restored = native.Session.create(id, session.snapshotEvents(), session.header)
    const observer = createModelObservationProjection(z)
    const state = restored.snapshotEvents().reduce(observer.apply, observer.init(restored.header))
    observer.stateSchema.parse(state); observer.wire.viewSchema.parse(observer.wire.view(state))
    assert.equal(state.current.actualModel, 'wire-d')
    assert.equal(state.current.requestedModel, 'haiku')
    assert.equal(state.current.source, 'sdk-assistant')
    assert.equal(observer.apply(state, request).current, null) // Same requested alias, new run: no stale actual.
    assert.equal(observer.init({ agentPreset: 'standard' }), null)
    assert.equal(observer.apply(null, { type: MODEL_OBSERVATION_RECORD, ignorable: true, data: {} }), null)
  })

test('实际 rc5 Backend：批次预准备步骤复用同 ID 流和完整快照，最终步骤由原生循环闭合后可严格重载',
  { skip: !available }, async t => {
    const [{ BridgeBackend }, { requiredShellName }, native, runtime] = await Promise.all([
      import('../src/backend.mjs'), import('../src/remote-capabilities.mjs'),
      import(resolveDshModule('@deepseek-ai/dsh-session')), import('../plugin/compat/runtime.mjs'),
    ])
    const parent = resolve(tmpdir())
    const directory = await mkdtemp(join(parent, 'dsh-native-backend-step-'))
    let backend
    t.after(async () => {
      await backend?.dispose()
      assert.equal(dirname(resolve(directory)), parent)
      assert.ok(basename(directory).startsWith('dsh-native-backend-step-'))
      await rm(directory, { recursive: true, force: true })
    })
    const provider = 'claude-sdk-remote', id = 'native-backend-step'
    const session = native.Session.create(id, undefined, { version: native.SESSION_FORMAT_VERSION,
      id, createdAt: 0, delegationDepth: 0, isSeeded: false, agentPreset: provider, cwd: directory })
    // The native loop owns the initial opening and final closing; Backend only
    // moves the intermediate response/preparation boundary.
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const frames = [], selection = { provider, model: 'fixture' }
    const agent = { id, session, phase: { kind: 'running', turn: 1, step: 1, abort: new AbortController() },
      _bridgeStepOpen: true, options: selection,
      dispatch: { emit(_type, value) { frames.push(value.frame) } },
      systemPrompt: { project() { return [] } }, runtimeContext: { project() { return undefined } },
      inbox: { nextStep: [], splice() { assert.fail('成功准备不应回填消息') } } }
    const ctx = { sessionProjections: { stateOf(_session, name) { return name === 'modelSelection' ? { pending: selection } : null } },
      systemPrompt: { refreshContext() { return [] } }, attachments: {},
      fs: { processPathFromHostPath(path) { return path } },
      tools: { execute() { assert.fail('原生步骤验收不执行命令') } },
      approval: { request() { assert.fail('原生步骤验收不请求审批') } },
      agents: { withInitiator(_agent, operation) { return operation() } }, sessions: { async flush() { return true } } }
    const helpers = { ...runtime, appendPluginRecord: native.appendPluginRecord, resolveDshHome() { return directory },
      // Prompt/context assembly is unrelated to the native step seam. Keep the
      // same narrow substitutes as Backend's existing offline fixture.
      renderPrompt() { return '合成原生步骤验收' }, assembleContextFor() { return {} },
      renderContextSections() { return [] }, joinContextSections() { return '' } }
    const decision = { assembly: { tools: [{ name: requiredShellName(), description: '仅声明，不执行',
      parameters: { type: 'object', additionalProperties: false, properties: {
        command: { type: 'string' }, workdir: { type: 'string' }, timeoutMs: { type: 'number' },
      }, required: ['command'] } }] }, messages: [{ id: 'native-step-user', role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '合成步骤输入' }] }] }
    let preparations = 0, queries = 0
    agent.preStep = async (target, position) => {
      preparations++
      assert.equal(target, 'next-step')
      assert.deepEqual(position, { turn: 1, step: 2 })
      assert.equal(agent._bridgeStepOpen, false)
      assert.deepEqual(session.snapshotEvents().filter(event => event.type === 'step/end').map(event => event.data.step), [1])
      return { ...decision, messages: [] }
    }
    backend = new BridgeBackend(ctx, { stateDirectory: directory }, { helpers,
      createTransport: async options => ({ peer: { async request(method, params) {
        if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
        assert.equal(method, 'query')
        queries++
        const notify = message => options.onNotification('sdk.message', { runId: params.runId, message })
        const response = async (responseId, text) => {
          const stream = event => notify({ type: 'stream_event', event })
          await stream({ type: 'message_start', message: { id: responseId } })
          await stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
          await stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
          await notify({ type: 'assistant', message: { id: responseId, model: 'fixture', content: [{ type: 'text', text }] } })
          await stream({ type: 'content_block_stop', index: 0 })
          await stream({ type: 'message_delta', usage: { output_tokens: 1 } })
          await stream({ type: 'message_stop' })
        }
        await response('native-first', '合成首响应')
        assert.deepEqual(await options.handlers['step.prepare']({ runId: params.runId },
          { signal: new AbortController().signal }), {})
        await response('native-second', '合成最终响应')
        assert.equal(agent.phase.step, 2)
        assert.equal(agent._bridgeStepOpen, true)
        await notify({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 2 } })
        return { status: 'completed' }
      }, async drainNotifications() {} }, async close() {} }) })
    let outcome
    try { outcome = await backend.runStep(agent, decision) }
    finally {
      // Mirror the shipped loop's _bridgeStepOpen guard, using its current
      // phase rather than the initial step captured by the native loop.
      if (agent._bridgeStepOpen !== false) {
        session.append('step/end', { turn: 1, step: agent.phase.step })
        agent._bridgeStepOpen = false
      }
    }
    assert.deepEqual(outcome, { kind: 'completed' })
    assert.equal(queries, 1)
    assert.equal(preparations, 1)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const events = session.snapshotEvents()
    for (const type of ['step/start', 'step/end']) {
      assert.deepEqual(events.filter(event => event.type === type).map(event => event.data.step), [1, 2])
    }
    assert.deepEqual(events.filter(event => event.type === 'assistant/message').map(event => ({
      step: event.data.step, text: event.data.message.content[0].text,
    })), [{ step: 1, text: '合成首响应' }, { step: 2, text: '合成最终响应' }])
    assert.deepEqual(frames.filter(frame => frame.type === 'start').map(frame => frame.step), [1, 2])
    const artifact = await strictSession(session)
    const restored = native.Session.create(id, artifact.events, artifact.header)
    assert.equal(restored.firstLiveSeq, session.seq)
  })

test('实际 rc5 helper：整轮停止保留已收到文本，冻结后续流和完整消息', { skip: !available }, async () => {
  const { records, frames, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
    content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text: '停止前文本' } } })
  projection.interrupt()
  const count = frames.length
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text: '晚到文字' } } })
  await projection.accept({ type: 'assistant', message: { id: 'late', content: [{ type: 'text', text: '停止后的说明' }] } })
  let reports = 0
  let started = 0
  projection.onUsage = async () => { reports++ }
  projection.onStarted = async () => { started++ }
  await projection.accept({ type: 'system', subtype: 'init' })
  await projection.accept({ type: 'result', usage: { input_tokens: 1, output_tokens: 2 } })
  assert.equal(frames.length, count)
  const assistants = records.filter(record => record.type === 'assistant/message')
  assert.equal(assistants.length, 1)
  assert.equal(assistants[0].data.interrupted, true)
  assert.deepEqual(assistants[0].data.message.content, [{ type: 'text', text: '停止前文本' }])
  assert.equal(reports, 1)
  assert.equal(started, 1)
})

test('实际 rc5 helper：流式 thinking 作为 reasoning 展示并持久记录', { skip: !available }, async () => {
  const { records, frames, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'thinking-test' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
    content_block: { type: 'thinking', thinking: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
    delta: { type: 'thinking_delta', thinking: '分析样本' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 1,
    content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 1,
    delta: { type: 'text_delta', text: '最终答复' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
  await projection.accept({ type: 'assistant', message: { id: 'thinking-test', content: [
    { type: 'thinking', thinking: '分析样本' }, { type: 'text', text: '最终答复' },
  ] } })
  await projection.accept({ type: 'result', subtype: 'success' })
  const blocks = records.filter(record => record.type === 'assistant/message').flatMap(record => record.data.message.content)
  assert.deepEqual(blocks, [{ type: 'reasoning', text: '分析样本' }, { type: 'text', text: '最终答复' }])
  assert.equal(frames.some(frame => frame.frame.type === 'chunk'
    && frame.frame.chunk.type === 'reasoning-delta' && frame.frame.chunk.text === '分析样本'), true)
})

test('实际 rc5 helper：thinking 分块的完整消息不结算流，同 ID 正文增量在最终消息前持续送达', { skip: !available }, async () => {
  const { records, frames, projection } = await fixture()
  const id = 'same-api-thinking-text'
  const thinking = '合成分析片段'
  const parts = ['合成正文第一段', '合成正文第二段']
  const stream = event => projection.accept({ type: 'stream_event', event })
  await stream({ type: 'message_start', message: { id } })
  await stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } })
  await stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } })
  await stream({ type: 'content_block_stop', index: 0 })
  await projection.accept({ type: 'assistant', message: { id, content: [{ type: 'thinking', thinking }] } })
  assert.equal(records.filter(record => record.type === 'assistant/message').length, 0)
  await stream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } })
  const textFrames = () => frames.filter(value => value.frame.type === 'chunk'
    && value.frame.chunk.type === 'text-delta').map(value => value.frame.chunk.text)
  for (const [index, text] of parts.entries()) {
    await stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } })
    // Assert delivery before either the full text message or query result exists.
    assert.deepEqual(textFrames(), parts.slice(0, index + 1))
    assert.equal(records.filter(record => record.type === 'assistant/message').length, 0)
  }
  await stream({ type: 'content_block_stop', index: 1 })
  await projection.accept({ type: 'assistant', message: { id, content: [
    { type: 'thinking', thinking }, { type: 'text', text: parts.join('') },
  ] } })
  await stream({ type: 'message_delta', usage: { output_tokens: 8 } })
  await stream({ type: 'message_stop' })
  await projection.accept({ type: 'result', usage: { output_tokens: 8 } })
  assert.deepEqual(textFrames(), parts)
  assert.equal(frames.filter(value => value.frame.type === 'start').length, 1)
  const messages = records.filter(record => record.type === 'assistant/message')
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].data.message.content,
    [{ type: 'reasoning', text: thinking }, { type: 'text', text: parts.join('') }])
})

test('实际 rc5 helper：partial 流省略 thinking 时保留完整消息中的 thinking', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'thinking-partial' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 1,
    content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 1,
    delta: { type: 'text_delta', text: '最终答复' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
  await projection.accept({ type: 'assistant', message: { id: 'thinking-partial', content: [
    { type: 'thinking', thinking: '分析样本' }, { type: 'text', text: '最终答复' },
  ] } })
  await projection.accept({ type: 'result', subtype: 'success' })
  const blocks = records.filter(record => record.type === 'assistant/message').flatMap(record => record.data.message.content)
  assert.equal(blocks.filter(block => block.type === 'reasoning' && block.text === '分析样本').length, 1)
  assert.equal(blocks.filter(block => block.type === 'text' && block.text === '最终答复').length, 1)
  assert.deepEqual(blocks.map(block => block.type), ['reasoning', 'text'])
})

test('实际 rc5 helper：多个 SDK 响应分别记录步骤和真实流式用量', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  let nextStep = 0
  projection.onModelStart = async () => ++nextStep
  for (const [id, text, tokens] of [['first', '先检查', 4], ['second', '已完成', 6]]) {
    await projection.accept({ type: 'stream_event', event: { type: 'message_start', message: { id,
      usage: { input_tokens: 3, cache_read_input_tokens: 5 } } } })
    await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' } } })
    await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text } } })
    await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    await projection.accept({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: tokens } } })
    await projection.accept({ type: 'assistant', message: { id, model: 'model-a', content: [{ type: 'text', text }] } })
  }
  await projection.accept({ type: 'result', usage: { input_tokens: 100, output_tokens: 100 } })
  const messages = records.filter(record => record.type === 'assistant/message')
  assert.deepEqual(messages.map(record => record.data.step), [1, 2])
  // Aggregate result usage must not be added to the last per-response count.
  assert.equal(messages[1].data.usage.outputTokens, 6)
  assert.equal(messages[1].data.usage.cacheReadTokens, 5)
})

test('实际 rc5 helper：一次流式文本和最终用量只提交一条 assistant 消息', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'one-response',
    usage: { input_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await projection.accept({ type: 'assistant', message: { model: 'model-a', content: [{ type: 'text', text: '你好' }] } })
  // A query aggregate is not the last response's usage. Confirm the API stream
  // separately; a terminal result is persisted in its own numerical record.
  await projection.accept({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 2 } } })
  await projection.accept({ type: 'result', subtype: 'success', usage: {
    input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 400,
  } })
  const messages = records.filter((record) => record.type === 'assistant/message')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].data.message.content[0].text, '你好')
  assert.deepEqual(messages[0].data.usage, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })
})

test('实际 rc5 helper：SDK tool_use 投影为可关联的 assistant tool-call', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  await projection.accept({ type: 'assistant', message: { model: 'model-a', content: [
    { type: 'tool_use', id: 'toolu_test', name: 'mcp__dsh__local_smoke', input: { command: 'pwd' } },
  ] } })
  const message = records.find((record) => record.type === 'assistant/message')?.data.message
  const call = message?.content.find((block) => block.type === 'tool-call')
  assert.equal(call?.id, 'toolu_test')
  assert.equal(call?.name, 'local_smoke')
  assert.deepEqual(JSON.parse(call.arguments), { command: 'pwd' })
  assert.deepEqual(projection.getCommittedToolCall('toolu_test'), { name: 'local_smoke', arguments: call.arguments })
})

test('实际 rc5 helper：流式文本与工具参数共同形成有序 assistant 块', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '检查中' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 1,
    content_block: { type: 'tool_use', id: 'toolu_stream', name: 'mcp__dsh__local_smoke', input: {} } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
  await projection.accept({ type: 'assistant', message: { model: 'model-a', content: [
    { type: 'text', text: '检查中' },
    { type: 'tool_use', id: 'toolu_stream', name: 'mcp__dsh__local_smoke', input: { command: 'pwd' } },
  ] } })
  const message = records.find((record) => record.type === 'assistant/message')?.data.message
  assert.deepEqual(message?.content.map((block) => block.type), ['text', 'tool-call'])
  assert.equal(message.content[1].id, 'toolu_stream')
  assert.equal(message.content[1].name, 'local_smoke')
  assert.deepEqual(JSON.parse(message.content[1].arguments), { command: 'pwd' })
})

test('实际 rc5 helper：相同 SDK message ID 的已流式输出片段不重复提交', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '检查中' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 1,
    content_block: { type: 'tool_use', id: 'toolu_same', name: 'mcp__dsh__local_smoke', input: {} } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
  await projection.accept({ type: 'assistant', message: { id: 'msg_same', model: 'model-a', content: [{ type: 'text', text: '检查中' }] } })
  await projection.accept({ type: 'assistant', message: { id: 'msg_same', model: 'model-a', content: [
    { type: 'tool_use', id: 'toolu_same', name: 'mcp__dsh__local_smoke', input: {} },
  ] } })
  const blocks = records.filter((record) => record.type === 'assistant/message').flatMap((record) => record.data.message.content)
  assert.equal(blocks.filter((block) => block.type === 'tool-call' && block.id === 'toolu_same').length, 1)
  assert.equal(blocks.filter((block) => block.type === 'text' && block.text === '检查中').length, 1)
})

test('实际 rc5 helper：相同 SDK message ID 的不同工具块均保留', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  for (const id of ['toolu_one', 'toolu_two']) {
    await projection.accept({ type: 'assistant', message: { id: 'msg_same', model: 'model-a', content: [
      { type: 'tool_use', id, name: 'mcp__dsh__local_smoke', input: {} },
    ] } })
  }
  const blocks = records.filter((record) => record.type === HISTORY_ASSISTANT).at(-1).data.message.content
  assert.deepEqual(blocks.filter((block) => block.type === 'tool-call').map((block) => block.id), ['toolu_one', 'toolu_two'])
})

test('实际原生客户端：停止后两次续聊 revision 连续，完整答复从流式结算后不消失', { skip: !available }, async () => {
  const f = await fixture()
  const source = await readFile(new URL('../plugin/session-client/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('var ClientAssistantStream = class')
  const end = source.indexOf('//#endregion', start)
  assert.ok(start > 0 && end > start)
  // Run the shipped native fold without modifying the vendored module.
  const fold = vm.runInNewContext(`${source.slice(start, end)}; new ClientAssistantStream()`)
  fold.replace([])
  const visible = []
  let seq = 0
  const decision = result => {
    assert.notEqual(result?.type, 'rebaseline')
    if (result?.entry?.event.type === 'assistant/message') visible.push(result.entry.event)
  }
  f.agent.session.append = (type, data, intent) => {
    const event = { seq: seq++, time: Date.now(), type, data, ...intent }
    f.records.push(event)
    decision(fold.acceptDurable({ type: 'durable', event }))
    return event
  }
  f.agent.dispatch.emit = (type, value) => {
    const frame = { ...value.frame, ...(value.frame.type === 'start' ? { startedAfterSeq: seq - 1 } : {}) }
    f.frames.push(frame)
    decision(fold.acceptFrame(frame))
  }
  const stream = async (projection, id, text) => {
    await projection.accept({ type: 'stream_event', event: { type: 'message_start', message: { id, model: 'haiku' } } })
    await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } })
    await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
  }
  await stream(f.projection, 'stopped', '停止前输出')
  f.projection.interrupt()
  f.agent.session.append('step/end', { turn: 1, step: 1 })
  for (const turn of [2, 3]) {
    const projection = new SdkProjection({ agent: f.agent, helpers: f.helpers, turn, step: 1, model: 'haiku' })
    const text = `续聊完整回复-${turn}`
    await projection.accept({ type: 'assistant', message: { id: 'synthetic', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } })
    await stream(projection, `answer-${turn}`, text)
    // Actual CLI emits the full text before its content_block_stop.
    await projection.accept({ type: 'assistant', message: { id: `answer-${turn}`, model: 'haiku', content: [{ type: 'text', text }] } })
    await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    await projection.accept({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 4 } } })
    await projection.accept({ type: 'stream_event', event: { type: 'message_stop' } })
    assert.equal(visible.at(-1).data.message.content[0].text, text)
    const settled = visible.length
    await projection.accept({ type: 'assistant', message: { id: 'late-synthetic', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } })
    await projection.accept({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 4 } })
    assert.equal(visible.length, settled)
    f.agent.session.append('step/end', { turn, step: 1 })
  }
  assert.equal(visible.length, 3)
  assert.deepEqual(f.frames.map(frame => frame.revision), f.frames.map((_, index) => index + 1))
})

test('实际 rc5 helper：同一步多个工具片段结算为累计快照，后续 usage 不创建空回复', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  for (const [id, text] of [['one', '工具前文本'], ['two', '第二段说明']]) {
    await projection.accept({ type: 'assistant', message: { id: 'shared-api', model: 'haiku', content: [
      { type: 'text', text }, { type: 'tool_use', id, name: 'mcp__dsh__local_smoke', input: {} },
    ] } })
  }
  const assistantRecords = () => records.filter(record => ['assistant/message', HISTORY_ASSISTANT].includes(record.type))
  const before = structuredClone(assistantRecords())
  await projection.accept({ type: 'result', usage: { output_tokens: 3 } })
  assert.deepEqual(assistantRecords(), before)
  assert.deepEqual(assistantRecords().at(-1).data.message.content.map(block => block.text ?? block.id), ['工具前文本', 'one', '第二段说明', 'two'])
})

test('实际原生客户端：同一响应的多个工具片段不重开流、不触发历史重建', { skip: !available }, async () => {
  const f = await fixture()
  const source = await readFile(new URL('../plugin/session-client/client.js', import.meta.url), 'utf8')
  const start = source.indexOf('var ClientAssistantStream = class'), end = source.indexOf('//#endregion', start)
  const fold = vm.runInNewContext(`${source.slice(start, end)}; new ClientAssistantStream()`)
  fold.replace([])
  let seq = 0
  const check = decision => assert.notEqual(decision?.type, 'rebaseline')
  f.agent.session.append = (type, data, intent) => {
    const event = { seq: seq++, time: Date.now(), type, data, ...intent }
    f.records.push(event)
    check(fold.acceptDurable({ type: 'durable', event }))
    return event
  }
  f.agent.dispatch.emit = (_name, value) => {
    const frame = { ...value.frame, ...(value.frame.type === 'start' ? { startedAfterSeq: seq - 1 } : {}) }
    f.frames.push(frame); check(fold.acceptFrame(frame))
  }
  await f.projection.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'multi-tool' } } })
  for (const id of ['a', 'b']) await f.projection.accept({ type: 'assistant', message: { id: 'multi-tool', content: [
    { type: 'tool_use', id, name: 'mcp__dsh__local_wait', input: {} },
  ] } })
  f.agent.session.append('step/end', { turn: 1, step: 1 })
  assert.deepEqual(f.records.filter(event => event.type === HISTORY_ASSISTANT).at(-1).data.message.content.map(block => block.id), ['a', 'b'])
  assert.equal(f.frames.filter(frame => frame.type === 'start').length, 1)
})

test('实际 rc5 helper：首 token 和首正文分开计时，每轮只各报告一次', { skip: !available }, async () => {
  const { projection } = await fixture()
  const times = []
  projection.onFirstToken = type => times.push(type)
  projection.onFirstText = () => times.push('body')
  await projection.accept({ type: 'assistant', message: { id: 'timed', content: [{ type: 'thinking', thinking: '合成分析' }] } })
  await projection.accept({ type: 'assistant', message: { id: 'timed', content: [{ type: 'text', text: '合成正文' }] } })
  await projection.accept({ type: 'result' })
  assert.deepEqual(times, ['reasoning-delta', 'body'])
})

test('实际 rc5 helper：部分流只有文本时仍补全完整消息里的工具块', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '检查中' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await projection.accept({ type: 'assistant', message: { id: 'msg_partial', model: 'model-a', content: [
    { type: 'text', text: '检查中' },
    { type: 'tool_use', id: 'toolu_unstreamed', name: 'mcp__dsh__local_smoke', input: {} },
  ] } })
  const blocks = records.filter((record) => record.type === 'assistant/message').flatMap((record) => record.data.message.content)
  assert.equal(blocks.filter((block) => block.type === 'text' && block.text === '检查中').length, 1)
  assert.equal(blocks.filter((block) => block.type === 'tool-call' && block.id === 'toolu_unstreamed').length, 1)
})

test('原生持久化：同一响应多个工具片段只广告一次，累计展示可严格重载', { skip: !available }, async () => {
  const native = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const helpers = { ...await import('../plugin/compat/runtime.mjs'), appendPluginRecord: native.appendPluginRecord }
  const id = 'strict-multi-tool'
  const session = native.Session.create(id, undefined, { version: native.SESSION_FORMAT_VERSION,
    id, createdAt: 0, delegationDepth: 0, isSeeded: false, agentPreset: 'claude-sdk-remote' })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  const projection = new SdkProjection({ agent: { id, session, dispatch: { emit() {} } },
    helpers, turn: 1, step: 1, model: 'fixture', runId: 'strict-run' })
  await projection.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'same-api',
    usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } } })
  for (const callId of ['a', 'b']) {
    await projection.accept({ type: 'assistant', message: { id: 'same-api', content: [
      { type: 'text', text: `合成说明-${callId}` }, { type: 'tool_use', id: callId, name: 'mcp__dsh__local_wait', input: {} },
    ] } })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'local_wait', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1,
      message: helpers.createToolResultMessage({ callId, content: [{ type: 'text', text: '合成结果' }], isError: false }) }, { surfaceOp: 'append' })
  }
  await projection.accept({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 7 } } })
  await projection.accept({ type: 'stream_event', event: { type: 'message_stop' } })
  await projection.accept({ type: 'result', usage: { input_tokens: 2, cache_read_input_tokens: 100,
    cache_creation_input_tokens: 10, output_tokens: 7 } })
  session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1 })
  await strictSession(session)
  const { z } = await import(resolveDshModule('zod'))
  const usageProjection = createResponseUsageProjection(z)
  const usageState = session.snapshotEvents().reduce((state, event) => usageProjection.apply(state, event), usageProjection.init(session.header))
  usageProjection.stateSchema.parse(usageState)
  const projectedUsage = usageProjection.wire.viewSchema.parse(usageProjection.wire.view(usageState))
  assert.deepEqual(projectedUsage.turns['1'], {
    uncachedInputTokens: 2, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 10, coverage: 'complete',
  })
  assert.equal(usageProjection.init({ agentPreset: 'standard' }), null)
  assert.equal(session.snapshotEvents().some(event => event.type === 'assistant/attempt'), false)
  assert.deepEqual(session.snapshotEvents().filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content.filter(block => block.type === 'tool-call').map(block => block.id)), ['a', 'b'])
  assert.deepEqual(session.snapshotEvents().findLast(event => event.type === HISTORY_ASSISTANT)
    .data.message.content.map(block => block.text ?? block.id), ['合成说明-a', 'a', '合成说明-b', 'b'])
})

test('实际 rc5 helper：工具提交后的晚到累计 usage 独立持久化，重复分块与整轮不叠加', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  let reports = 0, nextStep = 0
  projection.onUsage = async () => { reports++ }
  projection.onModelStart = async () => ++nextStep
  const stream = event => projection.accept({ type: 'stream_event', event })
  await stream({ type: 'message_start', message: { id: 'late-tool', usage: { input_tokens: 2,
    cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } })
  const assistant = { type: 'assistant', message: { id: 'late-tool', usage: { input_tokens: 2, output_tokens: 1 },
    content: [{ type: 'tool_use', id: 'once', name: 'mcp__dsh__local_wait', input: {} }] } }
  await projection.accept(assistant)
  await projection.accept(assistant)
  assert.equal(records.filter(e => e.type === 'assistant/message').length, 1)
  assert.equal(records.some(e => e.type === RESPONSE_USAGE_RECORD), false)
  for (const output_tokens of [7, 7, 8, 7]) await stream({ type: 'message_delta', usage: { output_tokens } })
  await stream({ type: 'message_stop' })
  const partial = responseUsageView(records.reduce(applyResponseUsage, initialResponseUsage()))
  assert.deepEqual(partial.turns['1'], { uncachedInputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 10, outputTokens: 8, coverage: 'partial' })
  assert.equal(records.filter(e => e.type === RESPONSE_USAGE_RECORD).length, 2)
  await stream({ type: 'message_start', message: { id: 'final-answer', usage: { input_tokens: 2,
    cache_read_input_tokens: 120, cache_creation_input_tokens: 5 } } })
  await projection.accept({ type: 'assistant', message: { id: 'final-answer', content: [{ type: 'text', text: '合成完成' }] } })
  await stream({ type: 'message_delta', usage: { output_tokens: 4 } })
  await stream({ type: 'message_stop' })
  const result = { type: 'result', usage: { input_tokens: 4, cache_read_input_tokens: 220,
    cache_creation_input_tokens: 15, output_tokens: 12 } }
  await projection.accept(result); await projection.accept(result)
  assert.equal(reports, 1)
  assert.equal(records.filter(e => e.type === RUN_USAGE_RECORD).length, 1)
  assert.equal(records.filter(e => e.type === 'assistant/message').length, 2)
  assert.equal(records.some(e => e.type === 'assistant/attempt'), false)
  assert.deepEqual(responseUsageView(records.reduce(applyResponseUsage, initialResponseUsage())).turns['1'], {
    uncachedInputTokens: 4, outputTokens: 12, cacheReadTokens: 220, cacheWriteTokens: 15, coverage: 'complete',
  })
})

test('进度仅转发固定压缩和上下文字段，停止后不接纳迟到进度', { skip: !available }, async () => {
  const { projection } = await fixture()
  const progress = []
  projection.onProgress = event => { progress.push(event) }
  await projection.accept({ type: 'system', subtype: 'status', status: 'compacting', secret: '不转发' })
  await projection.accept({ type: 'system', subtype: 'compact_boundary', compact_metadata: {
    trigger: 'auto', pre_tokens: 100, post_tokens: 20, duration_ms: 8, summary: '不转发',
  } })
  await projection.accept({ type: 'bridge_context', context: { source: 'sdk-summary-approximate',
    totalTokens: 20, maxTokens: 100, categories: [], arbitrary: '不转发' }, observedAt: 100 })
  await projection.accept({ type: 'bridge_context', context: { status: 'unknown' },
    code: 'CONTEXT_SUMMARY_TIMEOUT', observedAt: 101 })
  assert.deepEqual(progress.slice(0, 2), [{ type: 'status', status: 'compacting' },
    { type: 'compact-boundary', trigger: 'auto', preTokens: 100, postTokens: 20, durationMs: 8 }])
  assert.equal(progress[2].context.totalTokens, 20)
  assert.equal(progress[2].observedAt, 100)
  assert.equal(progress[3].code, 'CONTEXT_SUMMARY_TIMEOUT')
  assert.equal(JSON.stringify(progress).includes('不转发'), false)
  projection.interrupt()
  await projection.accept({ type: 'system', subtype: 'status', status: null })
  assert.equal(progress.length, 4)
})

test('实际rc5：工具规范化与晚到usage不丢逐响应计时，未结束整轮即可刷新', { skip: !available }, async () => {
  const f = await fixture()
  let clock = 0, step = 0, frame = 0
  const projection = new SdkProjection({ agent: f.agent, helpers: f.helpers, turn: 1, step: 1,
    runId: 'timing-tool-round', model: 'haiku', timingNow: () => clock, onModelStart: () => ++step })
  const stream = (event, ttft_ms, bridge_first_output) => projection.accept({ type: 'stream_event', uuid: `frame-${++frame}`,
    parent_tool_use_id: null, event, ...(ttft_ms !== undefined ? { ttft_ms } : {}),
    ...(bridge_first_output ? { bridge_first_output } : {}) })
  const { z } = await import(resolveDshModule('zod'))
  const definition = createResponseTimingProjection(z)
  const view = () => {
    const state = f.records.reduce(definition.apply, definition.init({ agentPreset: 'claude-sdk-remote' }))
    definition.stateSchema.parse(state)
    return definition.wire.viewSchema.parse(definition.wire.view(state))
  }
  await stream({ type: 'message_start', message: { id: 'timed-tool', usage: { input_tokens: 2 } } }, 400)
  assert.equal(view().ttftSteps, 0) // An SDK header is not the first output token.
  clock = 1000
  await stream({ type: 'content_block_start', index: 0,
    content_block: { type: 'tool_use', id: 'timed-call', name: 'mcp__dsh__local_command', input: {} } })
  clock = 2000
  await stream({ type: 'content_block_delta', index: 0,
    delta: { type: 'input_json_delta', partial_json: String.raw`{"command":"\u4e2d"}` } }, undefined,
  { version: 1, responseId: 'timed-tool', ms: 450, kind: 'tool-input', source: 'sdk-first-output-estimate' })
  assert.equal(view().ttftSteps, 1)
  assert.equal(view().ttftMs, 450)
  await stream({ type: 'content_block_stop', index: 0 })
  await projection.accept({ type: 'assistant', message: { id: 'timed-tool', content: [
    { type: 'tool_use', id: 'timed-call', name: 'mcp__dsh__local_command', input: { command: '中' } },
  ] } })
  assert.deepEqual(f.records.find(e => e.type === 'assistant/message').data.stream, [])
  clock = 10000 // Local tool or callback waiting is outside the receive-rate window.
  await stream({ type: 'message_delta', usage: { output_tokens: 200 } })
  await stream({ type: 'message_stop' })
  assert.equal(view().decodeTokens, 200)
  assert.equal(view().decodeMs, 2000)
  assert.equal(view().tpsSamples, 1)
  assert.equal(f.records.some(e => e.type === 'turn/end'), false)
  clock = 12000
  await stream({ type: 'message_start', message: { id: 'timed-final', usage: { input_tokens: 2 } } }, 600)
  await stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
  clock = 13000
  await stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '第一段' } }, undefined,
    { version: 1, responseId: 'timed-final', ms: 650, kind: 'text', source: 'sdk-first-output-estimate' })
  clock = 15000
  await stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '第二段' } })
  await stream({ type: 'content_block_stop', index: 0 })
  clock = 16000
  await stream({ type: 'message_delta', usage: { output_tokens: 300 } })
  await stream({ type: 'message_stop' })
  assert.equal(view().ttftMs / view().ttftSteps, 550)
  assert.equal(view().tpsSamples, 2)
  assert.equal(view().decodeTokens, 500)
  assert.equal(view().decodeMs, 5000)
  await projection.accept({ type: 'result', usage: { input_tokens: 4, output_tokens: 500 } })
  const result = view()
  const records = f.records.filter(e => e.type === RESPONSE_TIMING_RECORD).length
  await stream({ type: 'message_delta', usage: { output_tokens: 9000 } })
  assert.deepEqual(view(), result)
  assert.equal(f.records.filter(e => e.type === RESPONSE_TIMING_RECORD).length, records)
})

test('实际rc5：权威工具消息补齐残缺或改变的原始参数时，保留工具且接收速度未知', { skip: !available }, async () => {
  const { z } = await import(resolveDshModule('zod'))
  const definition = createResponseTimingProjection(z)
  for (const partial_json of ['{"command":', '{"command":"partial"}']) {
    const f = await fixture()
    let clock = 0, frame = 0
    const projection = new SdkProjection({ agent: f.agent, helpers: f.helpers, turn: 1, step: 1,
      runId: 'incomplete-tool-input', model: 'haiku', timingNow: () => clock })
    const stream = (event, ttft_ms, bridge_first_output) => projection.accept({ type: 'stream_event', uuid: `raw-${++frame}`,
      event, ...(ttft_ms === undefined ? {} : { ttft_ms }), ...(bridge_first_output ? { bridge_first_output } : {}) })
    await stream({ type: 'message_start', message: { id: 'incomplete-tool', usage: { input_tokens: 2 } } }, 400)
    clock = 1000
    await stream({ type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'input-call', name: 'mcp__dsh__local_command', input: {} } })
    clock = 2000
    await stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } }, undefined,
      { version: 1, responseId: 'incomplete-tool', ms: 450, kind: 'tool-input', source: 'sdk-first-output-estimate' })
    await stream({ type: 'content_block_stop', index: 0 })
    await projection.accept({ type: 'assistant', message: { id: 'incomplete-tool', content: [
      { type: 'tool_use', id: 'input-call', name: 'mcp__dsh__local_command', input: { command: 'complete' } },
    ] } })
    await stream({ type: 'message_delta', usage: { output_tokens: 200 } })
    await stream({ type: 'message_stop' })
    const state = f.records.reduce(definition.apply, definition.init({ agentPreset: 'claude-sdk-remote' }))
    definition.stateSchema.parse(state)
    const view = definition.wire.viewSchema.parse(definition.wire.view(state))
    assert.equal(view.ttftSteps, 1)
    assert.equal(view.tpsSamples, 0)
    assert.equal(view.incompleteCaptures, 1)
    assert.equal(f.records.filter(e => e.type === 'assistant/message').length, 1)
    assert.deepEqual(JSON.parse(projection.getCommittedToolCall('input-call').arguments), { command: 'complete' })
  }
})
