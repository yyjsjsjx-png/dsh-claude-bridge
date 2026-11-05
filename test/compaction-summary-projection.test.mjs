import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompactionSummaryRules, createCompactionSummaryProjection } from '../src/compaction-summary-projection.mjs'
import { COMPACTION_SUMMARY_RECORD, MAX_COMPACTION_SUMMARY_BYTES } from '../src/compaction-summary.mjs'
import { createCompactionHistory } from '../plugin/ui/client/compaction-history.mjs'
import { nativeChat } from './fixtures/native-chat.mjs'
import { strictSession } from './fixtures/native-persistence.mjs'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'

const rules = createCompactionSummaryRules()
const summaryRecord = (boundaryUuid, summary, extra = {}) => ({ type: COMPACTION_SUMMARY_RECORD, ignorable: true,
  data: { version: 1, boundaryUuid, trigger: 'auto', summary, ...extra } })
const available = text => ({ status: 'available', text })
const card = { boundaryUuid: 'boundary-a', runId: 'run', completedAt: 100, seq: 4, trigger: 'auto' }
const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)

test('摘要只按精确UUID或可信旧卡三元定位关联，不按token/时间近似配对', () => {
  const record = summaryRecord('boundary-a', available('## 合成原生摘要\n保留正文'))
  const state = rules.apply(rules.initial(), record)
  assert.deepEqual(rules.lookup(state, card), record.data.summary)
  assert.equal(rules.lookup(state, { ...card, boundaryUuid: 'boundary-b' }), undefined)
  assert.equal(rules.lookup(state, { ...card, boundaryUuid: undefined }), undefined)
  const linked = rules.apply(state, summaryRecord('boundary-a', record.data.summary,
    { runId: 'run', completedAt: 100, anchorSeq: 4 }))
  assert.deepEqual(rules.lookup(linked, { ...card, boundaryUuid: undefined }), record.data.summary)
  assert.equal(rules.lookup(linked, { ...card, boundaryUuid: undefined, seq: 5 }), undefined)
  assert.equal(rules.lookup(linked, { ...card, boundaryUuid: undefined, completedAt: 101 }), undefined)
  assert.equal(rules.lookup(linked, { ...card, boundaryUuid: undefined, runId: 'other' }), undefined)
})

test('重复摘要幂等，可用正文不被普通读取失败覆盖，冲突记录或定位明确拒绝', () => {
  const record = summaryRecord('boundary-a', available('同一份摘要'))
  const first = rules.apply(rules.initial(), record)
  assert.deepEqual(rules.apply(first, record), first)
  const failed = rules.apply(first, summaryRecord('boundary-a', { status: 'unavailable', code: 'SUMMARY_UNAVAILABLE' }))
  assert.deepEqual(rules.lookup(failed, card), record.data.summary)
  const conflict = rules.apply(first, summaryRecord('boundary-a', available('另一份摘要')))
  assert.deepEqual(rules.lookup(conflict, card), { status: 'unavailable', code: 'SUMMARY_CONFLICT' })
  const declaredConflict = rules.apply(first, summaryRecord('boundary-a', { status: 'unavailable', code: 'SUMMARY_CONFLICT' }))
  assert.deepEqual(rules.lookup(declaredConflict, card), { status: 'unavailable', code: 'SUMMARY_CONFLICT' })
  const locator = { runId: 'run', completedAt: 100, anchorSeq: 4 }
  const linked = rules.apply(first, summaryRecord('boundary-a', record.data.summary, locator))
  const wrong = rules.apply(linked, summaryRecord('boundary-b', available('不能混入另一边界'), locator))
  assert.deepEqual(rules.lookup(wrong, { ...card, boundaryUuid: undefined }), { status: 'unavailable', code: 'SUMMARY_CONFLICT' })
})

test('客户端按共享1MiB UTF8上限完整保留正文，超限/空白/异常事件不渲染私有内容', () => {
  const exact = 'a'.repeat(MAX_COMPACTION_SUMMARY_BYTES)
  assert.equal(rules.normalize(available(exact)).text, exact)
  assert.deepEqual(rules.normalize(available('文'.repeat(Math.floor(MAX_COMPACTION_SUMMARY_BYTES / 3) + 1))),
    { status: 'unavailable', code: 'SUMMARY_TOO_LARGE' })
  assert.deepEqual(rules.normalize(available(' \n')), { status: 'unavailable', code: 'SUMMARY_EMPTY' })
  const initial = rules.initial()
  assert.equal(rules.apply(initial, { ...summaryRecord('boundary-a', available('不得进入')), ignorable: false }), initial)
  assert.equal(rules.apply(initial, summaryRecord('__proto__', available('不得进入'))), initial)
  assert.deepEqual(rules.normalize({ status: 'unavailable', code: '私有正文' }), { status: 'unavailable', code: 'SUMMARY_UNAVAILABLE' })
})

function ui({ expanded = false } = {}) {
  let definition, component, toggled
  const MarkdownText = () => undefined
  createCompactionHistory({ React: { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => [expanded, value => { toggled = value }] }, MarkdownText, summaryRules: rules })({
    uiConversation: { events: { register(value) { definition = value; return () => {} } } },
    slots: { register(_options, value) { component = value; return () => {} } },
  })
  return { definition, component, MarkdownText, get toggled() { return toggled } }
}

test('摘要默认折叠且展开时交给原生安全MarkdownText，缺失状态给具体原因', () => {
  const state = rules.apply(rules.initial(), summaryRecord('boundary-a', available('## 原生摘要\n逐字正文')))
  const closed = ui()
  const result = closed.component({ node: { data: card }, useProjection: () => state })
  assert.equal(result.type, 'details'); assert.equal(result.props.open, undefined)
  assert.equal(result.children[2]?.props?.text, undefined)
  assert.equal(JSON.stringify(result).includes('逐字正文'), false)
  result.props.onToggle({ currentTarget: { open: true } }); assert.equal(closed.toggled, true)
  const open = ui({ expanded: true })
  const expanded = open.component({ node: { data: card }, useProjection: () => state })
  const markdown = expanded.children[1].children[1]
  assert.equal(markdown.type, open.MarkdownText)
  assert.equal(markdown.props.text, '## 原生摘要\n逐字正文')
  const unavailable = rules.apply(rules.initial(), summaryRecord('boundary-a', { status: 'unavailable', code: 'SUMMARY_UNPAIRED' }))
  assert.ok(JSON.stringify(open.component({ node: { data: card }, useProjection: () => unavailable })).includes('未能与本次压缩边界可靠对应'))
  assert.ok(JSON.stringify(open.component({ node: { data: { ...card, recovered: true } }, useProjection: () => state })).includes('历史补录'))
})

test('实际原生：摘要先后到达、重复边界和旧卡补摘要均可严格回放，缺边界不造卡', { skip: !native }, async () => {
  const { Session, SESSION_FORMAT_VERSION, appendPluginRecord } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const { z } = await import(resolveDshModule('zod'))
  const projection = createCompactionSummaryProjection(z)
  for (const ordering of ['summary-first', 'boundary-first', 'legacy']) {
    const id = `summary-ui-${ordering}`
    const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION,
      id, createdAt: 0, delegationDepth: 0, isSeeded: false, agentPreset: 'claude-sdk-remote' })
    const chat = await nativeChat()
    createCompactionHistory({ React: {}, summaryRules: rules })({ ...chat.ctx, slots: { register: () => () => {} } })
    const addBoundary = () => {
      const data = { version: 1, runId: card.runId, completedAt: card.completedAt, trigger: 'auto', preTokens: 900 }
      return ordering === 'legacy' ? appendPluginRecord(session, 'plugin:claude-bridge/progress',
        { ...data, compaction: { status: 'completed', completedAt: 100, preTokens: 900, trigger: 'auto' } })
        : appendPluginRecord(session, 'plugin:claude-bridge/compaction', { ...data, boundaryUuid: 'boundary-a' })
    }
    let markerSeq
    if (ordering !== 'summary-first') markerSeq = addBoundary()
    const data = summaryRecord('boundary-a', available('## 合成原生摘要'), ordering === 'legacy'
      ? { runId: card.runId, completedAt: card.completedAt, anchorSeq: markerSeq } : {}).data
    appendPluginRecord(session, COMPACTION_SUMMARY_RECORD, data)
    if (ordering === 'summary-first') {
      chat.replace(session.snapshotEvents()); assert.equal(chat.order().filter(node => node.kind === 'claude-bridge-compaction').length, 0)
      markerSeq = addBoundary()
    }
    // Replayed summary and repeated old progress observations must not duplicate the card.
    appendPluginRecord(session, COMPACTION_SUMMARY_RECORD, data)
    addBoundary()
    chat.replace(session.snapshotEvents())
    const cards = chat.order().filter(node => node.kind === 'claude-bridge-compaction')
    assert.equal(cards.length, 1)
    let state = session.snapshotEvents().reduce(projection.apply, projection.init(session.header))
    projection.stateSchema.parse(state); projection.wire.viewSchema.parse(state)
    assert.equal(rules.lookup(state, cards[0].data).text, '## 合成原生摘要')
    assert.equal(cards[0].anchorSeq, markerSeq)
    const restored = await strictSession(session)
    chat.replace(restored.events)
    assert.equal(chat.order().filter(node => node.kind === 'claude-bridge-compaction').length, 1)
    state = restored.events.reduce(projection.apply, projection.init(restored.header))
    assert.equal(rules.lookup(state, cards[0].data).text, '## 合成原生摘要')
    assert.deepEqual(Session.create(id, restored.events, restored.header).surface.nodes, [])
  }
})
