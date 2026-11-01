import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { SdkProjection } from '../src/sdk-projection.mjs'
import { HISTORY_ASSISTANT } from '../src/history-records.mjs'
import { strictSession } from './fixtures/native-persistence.mjs'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'

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
  const projection = new SdkProjection({ agent, helpers: f.helpers, turn: 1, step: 1, model: 'fixture' })
  const stream = event => projection.accept({ type: 'stream_event', event })
  const nextFrame = async () => {
    const result = await followed.next()
    assert.equal(result.value.type, 'assistant-stream')
    const decision = client.acceptFrame(result.value.frame)
    assert.notEqual(decision?.type, 'rebaseline')
    return { frame: result.value.frame, decision }
  }
  await stream({ type: 'message_start', message: { id: 'native-follow-api' } })
  await stream({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
  const first = await nextFrame()
  assert.equal(first.frame.type, 'start')
  assert.equal(first.frame.startedAfterSeq, opening.cursor)
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
  assert.equal(projection.committedToolCalls.has('toolu_unicode'), false)
  assert.equal(records.length, 0)
  await projection.accept({ type: 'assistant', message: { id: 'canonical-tool', content: [
    { type: 'tool_use', id: 'toolu_unicode', name: 'mcp__dsh__local_command', input: canonical },
  ] } })
  assert.deepEqual(JSON.parse(projection.committedToolCalls.get('toolu_unicode').arguments), canonical)
  assert.deepEqual(JSON.parse(records[0].data.message.content[0].arguments), canonical)
  assert.deepEqual(records[0].data.stream, [])
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
  assert.equal(records.length, 1)
  assert.equal(records[0].data.interrupted, true)
  assert.deepEqual(records[0].data.message.content, [{ type: 'text', text: '停止前文本' }])
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
  assert.equal(records.length, 0)
  await stream({ type: 'content_block_start', index: 1, content_block: { type: 'text' } })
  const textFrames = () => frames.filter(value => value.frame.type === 'chunk'
    && value.frame.chunk.type === 'text-delta').map(value => value.frame.chunk.text)
  for (const [index, text] of parts.entries()) {
    await stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } })
    // Assert delivery before either the full text message or query result exists.
    assert.deepEqual(textFrames(), parts.slice(0, index + 1))
    assert.equal(records.length, 0)
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
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await projection.accept({ type: 'assistant', message: { model: 'model-a', content: [{ type: 'text', text: '你好' }] } })
  await projection.accept({ type: 'result', subtype: 'success', usage: {
    input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
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
  assert.deepEqual(projection.committedToolCalls.get('toolu_test'), { name: 'local_smoke', arguments: call.arguments })
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
  const before = records.length
  await projection.accept({ type: 'result', usage: { output_tokens: 3 } })
  assert.equal(records.length, before)
  assert.deepEqual(records.at(-1).data.message.content.map(block => block.text ?? block.id), ['工具前文本', 'one', '第二段说明', 'two'])
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
    helpers, turn: 1, step: 1, model: 'fixture' })
  for (const callId of ['a', 'b']) {
    await projection.accept({ type: 'assistant', message: { id: 'same-api', content: [
      { type: 'text', text: `合成说明-${callId}` }, { type: 'tool_use', id: callId, name: 'mcp__dsh__local_wait', input: {} },
    ] } })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'local_wait', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1,
      message: helpers.createToolResultMessage({ callId, content: [{ type: 'text', text: '合成结果' }], isError: false }) }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1 })
  await strictSession(session)
  assert.deepEqual(session.snapshotEvents().filter(event => event.type === 'assistant/message')
    .flatMap(event => event.data.message.content.filter(block => block.type === 'tool-call').map(block => block.id)), ['a', 'b'])
  assert.deepEqual(session.snapshotEvents().findLast(event => event.type === HISTORY_ASSISTANT)
    .data.message.content.map(block => block.text ?? block.id), ['合成说明-a', 'a', '合成说明-b', 'b'])
})
