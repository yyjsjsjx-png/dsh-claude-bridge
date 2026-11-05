import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompactionSummaries } from '../remote/compaction-summaries.mjs'
import { MAX_COMPACTION_SUMMARY_BYTES } from '../src/compaction-summary.mjs'
import { createQueryTools } from '../remote/query-tools.mjs'
import { createQueryStream } from '../remote/query-stream.mjs'

const sessionId = '12345678-1234-4234-8234-123456789012'
const hook = (text = '合成原生摘要', trigger = 'auto') => ({ hook_event_name: 'PostCompact', session_id: sessionId, trigger, compact_summary: text })
const boundary = (uuid = 'boundary-a', trigger = 'auto') => ({ type: 'system', subtype: 'compact_boundary', session_id: sessionId,
  uuid, compact_metadata: { trigger, pre_tokens: 1000 } })
const status = value => ({ type: 'system', subtype: 'status', session_id: sessionId, status: value })
function fixture(enabled = true, withCycle = true) {
  const messages = [], diagnostics = [], controller = new AbortController()
  const summaries = createCompactionSummaries({ sessionId, enabled, signal: controller.signal,
    publish: value => messages.push(structuredClone(value)), diagnose: (...args) => diagnostics.push(args) })
  if (withCycle) summaries.status(status('compacting'))
  return { summaries, messages, diagnostics, controller }
}

test('PostCompact与边界双向到达均正确关联，未确认边界绝不发布正文', () => {
  for (const first of ['hook', 'boundary']) {
    const f = fixture()
    if (first === 'hook') f.summaries.postCompact(hook())
    else f.summaries.boundary(boundary())
    assert.deepEqual(f.messages, [])
    if (first === 'hook') f.summaries.boundary(boundary())
    else f.summaries.postCompact(hook())
    assert.deepEqual(f.messages, [{ type: 'bridge_compaction_summary', boundaryUuid: 'boundary-a', trigger: 'auto',
      summary: { status: 'available', text: '合成原生摘要' }, source: 'sdk-postcompact' }])
    assert.deepEqual(f.summaries.summaryFor('boundary-a'), f.messages[0].summary)
    assert.deepEqual(f.diagnostics, [])
  }
})

test('多次压缩按query与trigger顺序配对，重复UUID或重复hook不制造第二条摘要', () => {
  const f = fixture()
  f.summaries.boundary(boundary()); f.summaries.boundary(boundary())
  f.summaries.postCompact(hook('first')); f.summaries.postCompact(hook('first'))
  assert.equal(f.messages.length, 1)
  f.summaries.postCompact(hook('manual', 'manual'))
  f.summaries.postCompact(hook('second'))
  f.summaries.boundary(boundary('boundary-b'))
  f.summaries.boundary(boundary('boundary-c', 'manual'))
  assert.deepEqual(f.messages.map(message => [message.boundaryUuid, message.summary.text]),
    [['boundary-a', 'first'], ['boundary-b', 'second'], ['boundary-c', 'manual']])
  f.summaries.finish()
  assert.equal(f.messages.length, 3)
})

test('相同UUID的边界证据冲突保留不可用标记，不让后续hook覆盖冲突', () => {
  const f = fixture()
  f.summaries.boundary(boundary())
  f.summaries.boundary({ ...boundary(), compact_metadata: { trigger: 'auto', pre_tokens: 2000 } })
  f.summaries.postCompact(hook('must not attach'))
  f.summaries.finish()
  assert.equal(f.messages.length, 1)
  assert.deepEqual(f.messages[0].summary, { status: 'unavailable', code: 'SUMMARY_CONFLICT' })
})

test('空、超限与错误输入保留稳定不可用状态，不截断正文、不抛错改变压缩', () => {
  for (const [text, code] of [[' ', 'SUMMARY_EMPTY'], ['中'.repeat(Math.floor(MAX_COMPACTION_SUMMARY_BYTES / 3) + 1), 'SUMMARY_TOO_LARGE'],
    [undefined, 'SUMMARY_MISSING']]) {
    const f = fixture()
    f.summaries.boundary(boundary()); f.summaries.postCompact({ ...hook(), compact_summary: text })
    assert.deepEqual(f.messages[0].summary, { status: 'unavailable', code })
    assert.equal(JSON.stringify(f.messages).includes('compact_summary'), false)
  }
  const f = fixture()
  f.summaries.boundary(boundary())
  assert.deepEqual(f.summaries.postCompact({ ...hook(), get compact_summary() { throw new Error('private-body') } }), {})
  assert.deepEqual(f.messages[0].summary, { status: 'unavailable', code: 'SUMMARY_UNAVAILABLE' })
  assert.equal(JSON.stringify(f.diagnostics).includes('private-body'), false)
  const exact = fixture(), text = ` \n${'x'.repeat(MAX_COMPACTION_SUMMARY_BYTES - 3)}\n`
  exact.summaries.postCompact(hook(text)); exact.summaries.boundary(boundary())
  assert.equal(Buffer.byteLength(text, 'utf8'), MAX_COMPACTION_SUMMARY_BYTES)
  assert.equal(exact.messages[0].summary.text, text)
})

test('同trigger多个候选无法确认对应关系时不按猜测贴摘要，后续迟到内容也不串位', () => {
  const f = fixture()
  f.summaries.boundary(boundary('missing-first'))
  f.summaries.boundary(boundary('second-boundary'))
  f.summaries.postCompact(hook('second-summary'))
  f.summaries.boundary(boundary('later-boundary'))
  f.summaries.postCompact(hook('late-summary'))
  f.summaries.finish()
  assert.equal(f.messages.length, 3)
  assert.ok(f.messages.every(message => message.summary.code === 'SUMMARY_UNPAIRED'))
  assert.equal(JSON.stringify(f.messages).includes('second-summary'), false)
  const g = fixture()
  g.summaries.postCompact(hook('missing-first-boundary'))
  g.summaries.postCompact(hook('second-summary'))
  g.summaries.boundary(boundary())
  assert.deepEqual(g.messages[0].summary, { status: 'unavailable', code: 'SUMMARY_UNPAIRED' })
})

test('外会话、未知trigger和无UUID都不能借用摘要，无hook时明确缺失', () => {
  const f = fixture()
  f.summaries.postCompact({ ...hook('foreign'), session_id: 'another-session' })
  f.summaries.boundary({ ...boundary(), session_id: 'another-session' })
  f.summaries.boundary({ ...boundary(''), uuid: undefined })
  assert.deepEqual(f.messages, [])
  f.summaries.boundary(boundary())
  f.summaries.finish()
  assert.deepEqual(f.messages[0].summary, { status: 'unavailable', code: 'SUMMARY_MISSING' })
  const g = fixture()
  g.summaries.postCompact(hook('manual-only', 'manual'))
  g.summaries.boundary(boundary('auto-only'))
  g.summaries.finish()
  assert.deepEqual(g.messages[0].summary, { status: 'unavailable', code: 'SUMMARY_UNPAIRED' })
  assert.equal(JSON.stringify(g.messages).includes('manual-only'), false)
})

test('取消、结束和旧客户端拒绝迟到正文，只有hook无边界不伪造卡片', () => {
  for (const end of [f => f.controller.abort(), f => f.summaries.finish(), f => f.summaries.stop()]) {
    const f = fixture()
    f.summaries.postCompact(hook('unpaired'))
    end(f)
    f.summaries.boundary(boundary())
    f.summaries.postCompact({ get hook_event_name() { assert.fail('结束后不得读取正文') } })
    assert.deepEqual(f.messages, [])
  }
  const f = fixture(false)
  f.summaries.postCompact({ get hook_event_name() { assert.fail('旧客户端不得读取摘要') } })
  f.summaries.boundary(boundary()); f.summaries.finish()
  assert.deepEqual(f.messages, [])
})

test('摘要传输失败仅记录稳定code，不抛出正文或干扰原生压缩', () => {
  const diagnostics = []
  const f = createCompactionSummaries({ sessionId, enabled: true,
    publish() { throw new Error('private summary network failure') }, diagnose: (...args) => diagnostics.push(args) })
  f.status(status('compacting'))
  f.boundary(boundary())
  assert.deepEqual(f.postCompact(hook()), {})
  assert.deepEqual(f.summaryFor('boundary-a'), { status: 'unavailable', code: 'SUMMARY_UNAVAILABLE' })
  assert.deepEqual(diagnostics, [['compact-summary', 'unavailable', 'SUMMARY_UNAVAILABLE']])
})

test('新压缩周期隔离缺hook的旧边界，hook先到新边界也不会贴到旧卡片', () => {
  const f = fixture()
  f.summaries.boundary(boundary('old-missing'))
  f.summaries.status(status(null))
  f.summaries.status(status('compacting'))
  f.summaries.postCompact(hook('new-only'))
  f.summaries.boundary(boundary('new-boundary'))
  assert.deepEqual(f.messages.map(message => [message.boundaryUuid, message.summary]), [
    ['old-missing', { status: 'unavailable', code: 'SUMMARY_UNPAIRED' }],
    ['new-boundary', { status: 'available', text: 'new-only' }],
  ])
})

test('同一周期重复compacting或status:null不清配对，新周期允许正文恰好相同', () => {
  const f = fixture()
  f.summaries.postCompact(hook('same'))
  f.summaries.status(status('compacting'))
  f.summaries.status(status(null))
  f.summaries.boundary(boundary('first'))
  f.summaries.status(status('compacting'))
  f.summaries.postCompact(hook('same'))
  f.summaries.boundary(boundary('second'))
  assert.deepEqual(f.messages.map(message => [message.boundaryUuid, message.summary.text]), [['first', 'same'], ['second', 'same']])
})

test('缺少周期status时不把下一次hook贴给旧边界，显式新周期可恢复配对', () => {
  const f = fixture(true, false)
  f.summaries.boundary(boundary('old-without-hook'))
  f.summaries.postCompact(hook('belongs-to-next'))
  f.summaries.boundary(boundary('next-without-status'))
  assert.ok(f.messages.every(message => message.summary.code === 'SUMMARY_UNPAIRED'))
  assert.equal(JSON.stringify(f.messages).includes('belongs-to-next'), false)
  f.summaries.status(status('compacting'))
  f.summaries.postCompact(hook('recovered'))
  f.summaries.boundary(boundary('anchored'))
  assert.equal(f.messages.at(-1).summary.text, 'recovered')
  const g = fixture(true, false)
  g.summaries.postCompact(hook('first-hook'))
  g.summaries.boundary(boundary())
  assert.equal(g.messages[0].summary.text, 'first-hook')
})

function streamFixture({ enabled = true, compact = false } = {}) {
  const notifications = [], controller = new AbortController(), io = { pendingUserInputs: new Set(), submittedUserInputs: new Set() }
  const query = { params: { ...(enabled ? { compactionSummaries: true } : {}), ...(compact ? { action: 'compact' } : {}) },
    sessionId, runId: 'run-a', run: { controller }, diagnose() {}, timing() {}, startPhase: () => () => {}, settlement: { track: promise => promise },
    context: { peer: { notify(method, value) { notifications.push({ method, ...structuredClone(value) }) } } } }
  const toolCalls = { assertComplete() {}, concluded: false, hasUnconfirmedBatch: false }
  const tools = createQueryTools({ sdk: {}, query, io, toolCalls, definitions: [], convertedDefinitions: [] })
  const stream = createQueryStream({ query, compact, prompt: 'fixture', tools, io, toolCalls, inputConfirmationTimeoutMs: 1000 })
  stream.attach({})
  stream.accept({ type: 'system', subtype: 'init', session_id: sessionId, tools: [] })
  return { notifications, tools, stream, query, controller }
}

test('实际hook装配在权威边界之后发送摘要，旧客户端不注册，手动压缩以result返回', async () => {
  const f = streamFixture()
  const post = f.tools.hooks.PostCompact[0].hooks[0]
  assert.deepEqual(await post(hook()), {})
  f.stream.accept(boundary())
  const messages = f.notifications.filter(item => item.method === 'sdk.message').map(item => item.message)
  assert.equal(messages.at(-2).subtype, 'compact_boundary')
  assert.equal(messages.at(-1).type, 'bridge_compaction_summary')
  f.stream.releaseInput()
  const legacy = streamFixture({ enabled: false })
  assert.equal(legacy.tools.hooks.PostCompact, undefined)
  legacy.stream.releaseInput()
  const manual = streamFixture({ compact: true })
  manual.stream.accept({ ...boundary('manual-a', 'manual'), compact_metadata: {
    trigger: 'manual', pre_tokens: 1000, post_tokens: 100, duration_ms: 20,
  } })
  await manual.tools.hooks.PostCompact[0].hooks[0](hook('manual summary', 'manual'))
  manual.stream.recordResult({ type: 'result', subtype: 'success', session_id: sessionId })
  manual.stream.releaseInput()
  const outcome = manual.stream.outcome()
  assert.deepEqual(outcome.compaction, { status: 'compacted', preTokens: 1000, trigger: 'manual', boundaryUuid: 'manual-a', postTokens: 100, durationMs: 20,
    summary: { status: 'available', text: 'manual summary' } })
  assert.equal(manual.notifications.some(item => item.method === 'sdk.message'), false)
})

test('新旧普通流都不转发原生摘要user事件，普通用户文字不按内容误判', () => {
  for (const enabled of [false, true]) {
    const f = streamFixture({ enabled })
    for (const flag of ['is_compact_summary', 'isCompactSummary']) {
      f.stream.accept({ type: 'user', session_id: sessionId, [flag]: true,
        get message() { assert.fail('原生摘要正文不应被转发或读取') } })
    }
    const ordinary = { type: 'user', session_id: sessionId, is_compact_summary: false, isCompactSummary: false,
      message: { role: 'user', content: 'This session is being continued. Summary: 普通用户文字' } }
    f.stream.accept(ordinary)
    assert.deepEqual(f.notifications.filter(item => item.message?.type === 'user').map(item => item.message), [ordinary])
    f.stream.releaseInput()
  }
})

test('流式status接线隔离前周期缺失hook，保留新周期的同文本摘要', async () => {
  const f = streamFixture(), post = f.tools.hooks.PostCompact[0].hooks[0]
  f.stream.accept(status('compacting'))
  f.stream.accept(boundary('old-cycle'))
  f.stream.accept(status(null))
  f.stream.accept(status('compacting'))
  await post(hook('same-native-text'))
  f.stream.accept(boundary('new-cycle'))
  f.stream.accept(status(null))
  f.stream.accept(status('compacting'))
  await post(hook('same-native-text'))
  f.stream.accept(boundary('third-cycle'))
  f.stream.releaseInput()
  const summaries = f.notifications.filter(item => item.message?.type === 'bridge_compaction_summary')
    .map(item => [item.message.boundaryUuid, item.message.summary])
  assert.deepEqual(summaries, [
    ['old-cycle', { status: 'unavailable', code: 'SUMMARY_UNPAIRED' }],
    ['new-cycle', { status: 'available', text: 'same-native-text' }],
    ['third-cycle', { status: 'available', text: 'same-native-text' }],
  ])
})
