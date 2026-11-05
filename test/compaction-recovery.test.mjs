import test from 'node:test'
import assert from 'node:assert/strict'
import { appendCompactionSummary, restoreCompactionSummaries, createCompactionRecovery } from '../src/compaction-recovery.mjs'
import { COMPACTION_RECORD, COMPACTION_SUMMARY_RECORD } from '../src/compaction-summary.mjs'
import { SdkProjection } from '../src/sdk-projection.mjs'

function fixture() {
  const events = []
  const session = { id: 'local-session', snapshotEvents: () => events }
  const helpers = { appendPluginRecord(_session, type, data) {
    const seq = events.length; events.push({ type, data: structuredClone(data), seq, time: 100, ignorable: true }); return seq
  } }
  return { session, events, helpers, add: (type, data) => helpers.appendPluginRecord(session, type, data) }
}
const cloud = (boundaryUuid = 'boundary-a', preTokens = 900) => ({ boundaryUuid, trigger: 'auto', preTokens,
  completedAt: 100, summary: { status: 'available', text: '真实合成摘要\n# 保留格式' } })
const legacy = { version: 1, runId: 'old-run', compaction: { status: 'completed', trigger: 'auto', preTokens: 900, completedAt: 88 } }

test('老进度按同绑定会话内唯一完整数值证据链接摘要，旧记录原字节不变且重放不重复', () => {
  const f = fixture(); f.add('plugin:claude-bridge/progress', legacy); f.add('plugin:claude-bridge/progress', legacy)
  const before = JSON.stringify(f.events)
  assert.equal(restoreCompactionSummaries(f.session, [cloud()], f.helpers), 1)
  assert.equal(JSON.stringify(f.events.slice(0, 2)), before)
  assert.deepEqual(f.events[2].data, { version: 1, boundaryUuid: 'boundary-a', trigger: 'auto', source: 'native-transcript', summary: cloud().summary,
    runId: 'old-run', completedAt: 88, anchorSeq: 0 })
  assert.equal(restoreCompactionSummaries(f.session, [cloud()], f.helpers), 0)
})

test('没有marker或同数值有歧义时不向旧卡乱贴，真实边界单独标明历史补录', () => {
  const f = fixture()
  f.add('plugin:claude-bridge/progress', legacy)
  f.add('plugin:claude-bridge/progress', { ...legacy, runId: 'another-run' })
  restoreCompactionSummaries(f.session, [cloud('a'), cloud('b')], f.helpers)
  const markers = f.events.filter(event => event.type === COMPACTION_RECORD)
  assert.equal(markers.length, 2)
  assert.ok(markers.every(event => event.data.recovered === true))
  assert.ok(f.events.filter(event => event.type === COMPACTION_SUMMARY_RECORD).every(event => event.data.runId.startsWith('history:')))
  assert.equal(restoreCompactionSummaries(f.session, [cloud('a'), cloud('b')], f.helpers), 0)
})

test('旧卡已持久关联的边界不因后来同数值压缩而重复补录，错误定位不被复用', () => {
  const f = fixture(); f.add('plugin:claude-bridge/progress', legacy)
  assert.equal(restoreCompactionSummaries(f.session, [cloud()], f.helpers), 1)
  assert.equal(restoreCompactionSummaries(f.session, [cloud(), cloud('later')], f.helpers), 2)
  assert.deepEqual(f.events.filter(event => event.type === COMPACTION_RECORD).map(event => event.data.boundaryUuid), ['later'])
  assert.equal(restoreCompactionSummaries(f.session, [cloud(), cloud('later')], f.helpers), 0)
  const wrong = fixture(); wrong.add('plugin:claude-bridge/progress', legacy)
  wrong.add(COMPACTION_SUMMARY_RECORD, { ...f.events[1].data, anchorSeq: 999 })
  restoreCompactionSummaries(wrong.session, [cloud(), cloud('later')], wrong.helpers)
  assert.equal(wrong.events.filter(event => event.type === COMPACTION_RECORD).length, 2)
})

test('缺失状态不能覆盖已知正文，但同UUID不同正文或明确冲突必须隐藏正文', () => {
  const f = fixture()
  appendCompactionSummary(f.session, cloud(), f.helpers)
  assert.equal(appendCompactionSummary(f.session, { ...cloud(), summary: { status: 'unavailable', code: 'SUMMARY_MISSING' } }, f.helpers), 0)
  assert.equal(appendCompactionSummary(f.session, { ...cloud(), summary: { status: 'available', text: '另一份摘要' } }, f.helpers), 1)
  assert.deepEqual(f.events.at(-1).data.summary, { status: 'unavailable', code: 'SUMMARY_CONFLICT' })
  assert.equal(appendCompactionSummary(f.session, cloud(), f.helpers), 0)
})

test('原生回补与Hook可有不同包装，Hook优先，同源冲突仍拒绝', () => {
  for (const order of ['history-first', 'hook-first']) {
    const f = fixture()
    const native = { ...cloud(), source: 'native-transcript', summary: { status: 'available', text: '原生摘要核心' } }
    const hook = { ...cloud(), source: 'sdk-postcompact', summary: { status: 'available', text: '续聊包装\n原生摘要核心' } }
    for (const value of order === 'history-first' ? [native, hook] : [hook, native]) appendCompactionSummary(f.session, value, f.helpers)
    assert.deepEqual(f.events.at(-1).data.summary, hook.summary)
    assert.equal(f.events.at(-1).data.source, 'sdk-postcompact')
  }
})

test('同源同边界触发类型矛盾时隐藏摘要而不静默去重', () => {
  const f = fixture(); appendCompactionSummary(f.session, cloud(), f.helpers)
  assert.equal(appendCompactionSummary(f.session, { ...cloud(), trigger: 'manual' }, f.helpers), 1)
  assert.equal(f.events.at(-1).data.summary.code, 'SUMMARY_CONFLICT')
})

test('Hook缺失可由原生正文补回，但原生缺失或Hook缺失都不能清除有效正文', () => {
  const f = fixture(), missing = { status: 'unavailable', code: 'SUMMARY_MISSING' }
  appendCompactionSummary(f.session, { ...cloud(), source: 'sdk-postcompact', summary: missing }, f.helpers)
  appendCompactionSummary(f.session, { ...cloud(), source: 'native-transcript' }, f.helpers)
  assert.equal(f.events.at(-1).data.summary.status, 'available')
  assert.equal(appendCompactionSummary(f.session, { ...cloud(), source: 'sdk-postcompact', summary: missing }, f.helpers), 0)
})

test('SDK摘要先后均可持久化，仅展示record且取消后不接受迟到摘要', async () => {
  const f = fixture()
  const projection = new SdkProjection({ agent: { session: f.session }, helpers: f.helpers, runId: 'run', turn: 1, step: 1 })
  const summary = { type: 'bridge_compaction_summary', ...cloud() }
  await projection.accept(summary)
  await projection.accept({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary-a', compact_metadata: { trigger: 'auto', pre_tokens: 900 } })
  await projection.accept(summary)
  assert.equal(f.events.length, 2)
  assert.deepEqual(f.events.map(event => event.type), [COMPACTION_SUMMARY_RECORD, COMPACTION_RECORD])
  projection.interrupt(); await projection.accept({ ...summary, boundaryUuid: 'late' })
  assert.equal(f.events.length, 2)
})

test('历史读取只用协商RPC游标，快照变更清重启，重复页不污染本地记录', async () => {
  const f = fixture(), requests = []
  const binding = { deviceId: 'device', sdkSessionId: 'sdk-session', projectPath: 'project' }
  const responses = [
    { status: 'ok', sessionId: binding.sdkSessionId, records: [cloud()], done: true, nextCursor: { fingerprint: 'a', offset: 1, done: true } },
    { status: 'cursor-reset' },
    { status: 'ok', sessionId: binding.sdkSessionId, records: [cloud(), cloud('new', 901)], done: true,
      nextCursor: { fingerprint: 'b', offset: 2, done: true } },
  ]
  const transport = { peer: { async request(method, params) { requests.push({ method, params }); return responses.shift() } } }
  const recovery = createCompactionRecovery(f.helpers), signal = new AbortController().signal
  assert.equal(await recovery.sync({ session: f.session, binding, transport, signal }), 2)
  assert.equal(await recovery.sync({ session: f.session, binding, transport, signal }), 2)
  assert.equal(requests[1].params.cursor.fingerprint, 'a')
  assert.equal(requests[2].params.cursor, undefined)
  assert.ok(requests.every(request => request.method === 'compaction.history'))
  const abort = new AbortController(); abort.abort()
  await assert.rejects(recovery.sync({ session: f.session, binding, transport, signal: abort.signal }), { name: 'AbortError' })
  assert.equal(requests.length, 3)
})
