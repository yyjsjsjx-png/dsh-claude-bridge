import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createClientReceiveTiming } from '../plugin/ui/client/client-receive-timing.mjs'
import { createClient } from '../plugin/ui/client/entry.mjs'

// Execute the shipped rc.5 Session and AssistantStream methods, without Host,
// renderer, accounts, persistence or a model. Delegation must preserve their fold.
const source = await readFile(new URL('../plugin/session-client/client.js', import.meta.url), 'utf8')
const streamStart = source.indexOf('var ClientAssistantStream = class {')
const streamEnd = source.indexOf('//#endregion', streamStart)
const sessionStart = source.indexOf('var Session = class {')
const sessionEnd = source.indexOf('/** Run one callback on the next animation frame', sessionStart)
assert.ok(streamStart >= 0 && streamEnd > streamStart && sessionStart >= 0 && sessionEnd > sessionStart)
const { NativeSession, NativeAssistantStream } = vm.runInNewContext([
  source.slice(streamStart, streamEnd), source.slice(sessionStart, sessionEnd),
  '({NativeSession:Session, NativeAssistantStream:ClientAssistantStream})',
].join('\n'), { randomUUID, queueMicrotask, attachmentRefsIn: () => [], scheduleFrame: fn => fn(),
  SessionLogOffset: value => value, SessionSeq: value => value, expandAssistantStream: () => [] })

function fixture({ remote: initialRemote = true, report: reporter, modelSelection, sessionId = 'synthetic/root' } = {}) {
  let time = 100, timerId = 0, remote = initialRemote, seq = 0, turn = 0
  const rows = [], timers = new Map(), listeners = new Set(), docListeners = new Map(), scopeDisposers = []
  const accepted = []
  const face = { getSnapshot: () => remote ? {} : null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } }
  const selectionFace = { getSnapshot: () => modelSelection, subscribe() { return () => {} } }
  const scope = { effect(fn) { const dispose = fn(); scopeDisposers.push(dispose); return dispose } }
  const session = Object.assign(Object.create(NativeSession.prototype), {
    sessionId, running: false, openState: 'open', openGeneration: 0,
    pendingSubmissions: [], submissionSettlements: new Map(), firstPromptPendingTurn: false, pendingHistory: null,
    assistantStream: new NativeAssistantStream(), actx: scope, stopObservingInbox() {},
    projections: { faceOf: key => key === 'modelSelection' ? selectionFace : face, seqOf: () => 100, seed() {} },
    notifier: { markDirty() {} },
    eventSource: { append: entry => accepted.push(entry), replace: entries => accepted.push(...entries),
      prepend() {}, settleAssistant() {} },
  })
  const originals = Object.fromEntries(['beginSubmission', 'acceptEventChange', 'publishAssistantEntry',
    'installWindow', 'retireFailedSubmission', 'resync', 'dispose'].map(name => [name, session[name]]))
  const doc = { hidden: false, addEventListener: (name, fn) => docListeners.set(name, fn),
    removeEventListener: name => docListeners.delete(name) }
  const tracker = createClientReceiveTiming({ now: () => time, document: doc,
    report(row) { rows.push(row); return reporter?.(row) },
    setTimer(fn) { timers.set(++timerId, fn); return timerId }, clearTimer: id => timers.delete(id) })
  tracker.bind(session.sessionId, session, scope)
  const receive = change => session.acceptEventChange(change)
  const append = (type, data, extra = {}) => {
    const event = { type, data, seq: seq++, ...extra }
    receive({ type: 'append', entry: { type: 'durable', event } }); return event.seq
  }
  const submit = (mode = 'queue') => session.beginSubmission({ mode, text: '合成私密输入', attachments: [] })
  const startTurn = () => {
    turn++; append('turn/start', { turn }); append('step/start', { turn, step: 1 });
    return turn
  }
  const associate = request => append('user/message', { source: { kind: 'user', rpcId: request.requestId }, content: [] })
  const endTurn = (number = turn) => { append('turn/end', { turn: number }); session.running = false }
  const stream = (type, fields = {}) => receive({ type: 'assistant-stream', frame: { type, ...fields } })
  const startAttempt = (id = `attempt-${turn}`, step = 1) => {
    stream('start', { attemptId: id, startedAfterSeq: seq - 1, turn, step });
    return (chunk, index = 0) => stream('chunk', { attemptId: id, index, time, chunk })
  }
  const full = (step = 1, content = [{ type: 'text', text: '合成私密输出' }], number = turn) => append('assistant/message',
    { turn: number, step, message: { content }, stream: [] }, { surfaceOp: 'append' })
  const replace = (entries = [], assistantStream) => {
    seq = entries.reduce((last, entry) => Math.max(last, entry.event.seq + 1), seq)
    return receive({ type: 'replace', entries, hasMore: false, page: { assistantStream } })
  }
  return { tracker, session, scope, originals, rows, timers, accepted, submit, receive, append, startTurn,
    associate, startAttempt, full, replace, endTurn, stream, doc, scopeDisposers,
    tick(ms) { time += ms }, setTime(value) { time = value },
    hidden(value) { doc.hidden = value; docListeners.get('visibilitychange')?.() },
    setRemote(value) { remote = value; for (const fn of listeners) fn() },
    expire() { const batch = [...timers.values()]; timers.clear(); batch.forEach(fn => fn()) },
    snapshot: () => tracker.getSnapshot(session.sessionId),
    outputRows: () => rows.filter(row => row.metric === 'first-output'),
  }
}

test('原生连续六次提交全覆盖：每次自身rpcId、新turn及首有效模型接收只计一次', () => {
  const f = fixture()
  let notifications = 0
  const store = f.tracker.getStore(f.session.sessionId)
  const unsubscribe = store.subscribe(() => notifications++)
  for (let index = 0; index < 6; index++) {
    const request = f.submit(); f.startTurn(); f.associate(request)
    const chunk = f.startAttempt()
    chunk({ type: 'block-start', index: 0, blockType: 'text' })
    chunk({ type: 'text-delta', index: 0, text: '' }, 1)
    f.tick(50 + index)
    chunk({ type: 'text-delta', index: 0, text: '合成私密首段' }, 2)
    chunk({ type: 'text-delta', index: 0, text: '合成后续' }, 3)
    const committed = f.full()
    f.stream('end', { attemptId: `attempt-${index + 1}`, index: 4,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: committed } })
    f.append('step/end', { turn: index + 1, step: 1 }); f.endTurn()
  }
  assert.deepEqual(f.snapshot(), { submissions: 6, samples: 6, totalMs: 315, unknown: 0, pending: 0, reasonCounts: {} })
  assert.equal(notifications, 12)
  assert.equal(f.rows.length, 12)
  assert.equal(new Set(f.outputRows().map(row => row.requestId)).size, 6)
  assert.ok(f.outputRows().every(row => row.quality === 'precise' && row.condition === 'foreground'))
  assert.equal(f.accepted.filter(entry => entry.event.type === 'assistant/live-chunk').length, 24)
  assert.doesNotMatch(JSON.stringify(f.rows), /合成|私密|text|content|arguments/)
  for (const row of f.rows) assert.deepEqual(Object.keys(row).sort(), [
    'clock', 'condition', 'durationMs', 'metric', 'quality', 'requestId', 'sessionId', 'source', 'version'].sort())
  unsubscribe(); f.tracker.dispose()
})

test('child手动提交、背景接收、思考及工具参数均有独立有效样本，工具结果与不完整工具名不计', () => {
  for (const kind of ['reasoning-delta', 'tool-call-delta']) {
    const f = fixture({ sessionId: 'synthetic/child' })
    f.session.address = { parentSessionId: 'synthetic/parent', childSessionId: 'synthetic/child' }
    const request = f.submit(); f.startTurn(); f.associate(request)
    const chunk = f.startAttempt()
    f.hidden(true); f.tick(80)
    f.append('tool/result', { turn: 1, step: 1, content: [{ type: 'text', text: '合成工具结果' }] })
    chunk({ type: 'tool-call-delta', index: 0, name: 'synthetic-tool', argumentsDelta: '' })
    assert.equal(f.snapshot().samples, 0)
    chunk(kind === 'reasoning-delta' ? { type: kind, index: 0, text: '合成思考' }
      : { type: kind, index: 0, id: 'tool', argumentsDelta: '{' }, 1)
    assert.equal(f.snapshot().samples, 1)
    assert.equal(f.outputRows()[0].durationMs, 80)
    assert.equal(f.outputRows()[0].sessionId, 'synthetic/child')
    assert.equal(f.outputRows()[0].condition, 'background')
    f.tracker.dispose()
  }
})

test('排队request等待各自新turn，先前/另一turn输出不能认领，包含实际等待时间', () => {
  const f = fixture()
  f.startTurn(); f.session.running = true
  const first = f.submit(), second = f.submit()
  f.tick(20); f.full(); f.endTurn()
  assert.equal(f.snapshot().samples, 0)
  f.startTurn(); f.associate(first); f.tick(80); f.full(); f.endTurn()
  assert.equal(f.snapshot().samples, 1)
  f.startTurn(); f.associate(second); f.tick(100); f.full(); f.endTurn()
  assert.deepEqual(f.outputRows().map(({ requestId, durationMs, condition }) => ({ requestId, durationMs, condition })), [
    { requestId: first.requestId, durationMs: 100, condition: 'queued' },
    { requestId: second.requestId, durationMs: 200, condition: 'queued' },
  ])
  assert.equal(f.snapshot().pending, 0)
  f.tracker.dispose()
})

test('同turn插话不接旧attempt尾流，新step之后的输出才归属该request', () => {
  const f = fixture()
  f.startTurn(); f.session.running = true
  const oldChunk = f.startAttempt('old-attempt')
  const request = f.submit('steer'); f.associate(request)
  f.tick(20); oldChunk({ type: 'text-delta', index: 0, text: '旧响应' })
  const committed = f.full(); assert.equal(f.snapshot().samples, 0)
  f.stream('end', { attemptId: 'old-attempt', index: 1,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: committed } })
  // Native remote prepare writes admitted user messages before opening step+1.
  f.append('step/end', { turn: 1, step: 1 }); f.append('step/start', { turn: 1, step: 2 })
  const next = f.startAttempt('next-attempt', 2)
  f.tick(80); next({ type: 'reasoning-delta', index: 0, text: '新响应' })
  assert.deepEqual(f.outputRows().map(row => [row.quality, row.durationMs, row.condition]), [['precise', 100, 'steering']])
  f.tracker.dispose()
})

test('late attach没有见旧start时，steer也不能把旧完整快照冒充新响应', () => {
  const f = fixture()
  f.replace([
    { event: { seq: 0, type: 'turn/start', data: { turn: 1 } } },
    { event: { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } } },
  ])
  f.session.running = true
  const request = f.submit('steer'); f.associate(request)
  f.tick(25); f.full(1, undefined, 1)
  assert.equal(f.snapshot().samples, 0)
  f.append('step/start', { turn: 1, step: 2 }); f.tick(75); f.full(2, undefined, 1)
  assert.equal(f.outputRows()[0].durationMs, 100)
  assert.equal(f.outputRows()[0].condition, 'steering')
  f.tracker.dispose()
})

test('完整assistant正文/思考/工具参数可作接收后备，No response requested占位不可', () => {
  for (const content of [[{ type: 'text', text: '合成正文' }], [{ type: 'reasoning', text: '合成思考' }],
    [{ type: 'tool-call', name: 'synthetic', arguments: '{}' }]]) {
    const f = fixture(), request = f.submit()
    f.startTurn(); f.associate(request)
    f.full(1, [{ type: 'text', text: 'No response requested.' }])
    f.full(1, [{ type: 'tool-call', name: 'synthetic', arguments: '' }])
    assert.equal(f.snapshot().samples, 0)
    f.tick(60); f.full(1, content); assert.equal(f.outputRows()[0].durationMs, 60)
    f.tracker.dispose()
  }
})

test('历史replace/prepend不造样本；关联缺失、失败、无输出、重建与超时都保留覆盖原因', () => {
  const scenarios = [
    ['HISTORY_REPLACED', f => f.replace()],
    ['STREAM_REBASELINE', f => { const chunk = f.startAttempt(); chunk({ type: 'text-delta', text: '跳号' }, 3) }],
    ['TURN_ENDED_WITHOUT_OUTPUT', f => f.endTurn()],
    ['TIMING_TIMEOUT', f => f.expire()],
    ['OBSERVER_DISPOSED', f => f.tracker.dispose()],
    ['SESSION_DISPOSED', f => f.scopeDisposers.forEach(fn => fn())],
  ]
  for (const [reason, fail] of scenarios) {
    const f = fixture(), request = f.submit()
    f.startTurn(); f.associate(request); fail(f)
    assert.equal(f.outputRows().length, 1, reason)
    assert.equal(f.outputRows()[0].reason, reason)
    assert.deepEqual(f.snapshot(), { submissions: 1, samples: 0, totalMs: 0, unknown: 1, pending: 0,
      reasonCounts: { [reason]: 1 } })
    f.tracker.dispose()
  }
  const failed = fixture(), request = failed.submit()
  request.abandon()
  assert.equal(failed.outputRows()[0].reason, 'SUBMISSION_FAILED')
  failed.tracker.dispose()
  const f = fixture()
  f.replace([{ event: { seq: 0, type: 'assistant/message', data: { turn: 1, step: 1,
    message: { content: [{ type: 'text', text: '旧历史' }] } } } }])
  f.receive({ type: 'prepend', entries: [], hasMore: false })
  assert.equal(f.snapshot().submissions, 0)
  const uncorrelated = f.submit(); f.startTurn()
  f.associate({ requestId: 'another-request' }); f.full(); assert.equal(f.snapshot().samples, 0)
  f.expire(); assert.equal(f.outputRows()[0].requestId, uncorrelated.requestId)
  assert.equal(f.outputRows()[0].reason, 'TIMING_TIMEOUT')
  f.tracker.dispose()
})

test('普通路径不改Session方法；安装只借现有scope，新generation及卸载恢复且不retain', () => {
  const ordinary = fixture({ remote: false })
  for (const [name, original] of Object.entries(ordinary.originals)) assert.equal(ordinary.session[name], original)
  ordinary.submit(); assert.equal(ordinary.rows.length, 0)
  ordinary.setRemote(true)
  assert.notEqual(ordinary.session.beginSubmission, ordinary.originals.beginSubmission)
  ordinary.setRemote(false)
  for (const [name, original] of Object.entries(ordinary.originals)) assert.equal(ordinary.session[name], original)
  ordinary.tracker.dispose()
  const f = fixture()
  f.tracker.dispose()
  const rows = []
  const tracker = createClientReceiveTiming({ report: row => rows.push(row) })
  let created = 0
  const manager = { scopes: new Map(), materializeScope(id) {
    created++
    const record = { session: f.session, ctx: f.scope }
    this.scopes.set(id, record); return record
  }, retainAgentScope() { assert.fail('禁止retain/激活') } }
  const original = manager.materializeScope
  tracker.install(manager)
  assert.equal(created, 0)
  const record = manager.materializeScope('synthetic/root')
  assert.equal(created, 1); assert.equal(record.session, f.session)
  const request = f.submit(); assert.equal(rows[0].requestId, request.requestId)
  const store = tracker.getStore('synthetic/root')
  f.scopeDisposers.forEach(fn => fn())
  assert.equal(store.getSnapshot().unknown, 1)
  assert.equal(store, tracker.getStore('synthetic/root'))
  tracker.dispose()
  assert.equal(manager.materializeScope, original)
  for (const [name, method] of Object.entries(f.originals)) assert.equal(f.session[name], method)
})

test('新remote首提交无status projection：成功create的明确preset在open前识别，普通仍不装', async () => {
  const f = fixture({ remote: false })
  f.tracker.dispose()
  const rows = [], calls = [], manager = { scopes: new Map(),
    async create(options) { calls.push(options); return 'synthetic/root' },
    materializeScope(id) {
      const record = { session: f.session, ctx: f.scope }; this.scopes.set(id, record); return record
    } }
  const originalCreate = manager.create
  const tracker = createClientReceiveTiming({ now: () => 100, report: row => rows.push(row),
    setTimer: () => undefined, clearTimer() {} })
  tracker.install(manager)
  const options = { agentPreset: 'claude-sdk-remote+model-v1:%7B%22model%22%3A%22haiku%22%7D' }
  assert.equal(await manager.create(options), 'synthetic/root')
  assert.equal(calls[0], options)
  manager.materializeScope('synthetic/root')
  const request = f.submit(); f.startTurn(); f.associate(request); f.full()
  assert.equal(rows.filter(row => row.metric === 'submission').length, 1)
  assert.equal(rows.filter(row => row.metric === 'first-output' && row.quality === 'precise').length, 1)
  tracker.dispose(); assert.equal(manager.create, originalCreate)
  const selection = fixture({ remote: false, modelSelection: { pending: { provider: 'claude-sdk-remote' } } })
  const first = selection.submit(); selection.startTurn(); selection.associate(first); selection.full()
  assert.equal(selection.snapshot().samples, 1)
  selection.tracker.dispose()
})

test('诊断上报失败和异常单调时钟不影响原生提交，只有unknown且不生成负样本', () => {
  const f = fixture({ report() { throw new Error('合成诊断故障') } })
  const request = f.submit(); assert.equal(typeof request.abandon, 'function')
  f.startTurn(); f.associate(request); f.setTime(0); f.full()
  assert.equal(f.snapshot().unknown, 1)
  assert.equal(f.outputRows()[0].reason, 'TIMING_UNAVAILABLE')
  assert.equal('durationMs' in f.outputRows()[0], false)
  f.tracker.dispose()
})

test('客户端在RPC挂载后安装唯一观察器，严格descriptor保留wire value且effect卸载', async () => {
  const effects = [], order = [], store = { getSnapshot: () => ({}), subscribe: () => () => {} }
  let descriptors, disposed = 0
  const tracker = { install(sessions) { assert.equal(sessions, ctx.sessions); order.push('install') },
    dispose() { disposed++ } }
  const client = createClient({ React: {}, createUsageProjectionBridge: () => () => () => {},
    createClientReceiveTiming({ report }) { order.push('create'); report({ version: 1 }); return tracker },
    createSettingsController: () => ({ store, models: {}, readStatus() {} }),
    createQuotaController: () => ({ store }), createPickerController: () => ({ store }),
    createMeterViews: () => ({}), createFormViews: () => ({}) })
  const ctx = { sessions: {}, remote: { claudeBridge: { recordClientTiming(row) {
    assert.deepEqual(row, { version: 1 }); order.push('report'); return Promise.resolve({ ok: false })
  } }, $mount: async value => { descriptors = value.descriptors; order.push('mount'); return () => {} } },
  slots: { inject() {} }, inject: (_services, callback) => callback(ctx), effect(fn) { effects.push(fn()) } }
  await client.apply(ctx)
  assert.deepEqual(order, ['mount', 'create', 'report', 'install'])
  const descriptor = descriptors.find(item => item.method === 'recordClientTiming')
  assert.equal(descriptor.parameters[0].wire, 'value')
  assert.equal(descriptor.parameters[0].codec.mode, 'strict')
  assert.equal(client.clientReceiveTiming, tracker)
  effects.filter(fn => typeof fn === 'function').slice(0, 2).forEach(fn => fn())
  assert.equal(disposed, 1)
  assert.equal(client.clientReceiveTiming, undefined)
})
