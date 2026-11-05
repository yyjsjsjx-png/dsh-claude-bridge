import test from 'node:test'
import assert from 'node:assert/strict'
import { SdkProjection } from '../src/sdk-projection.mjs'
import { createCompactionHistory } from '../plugin/ui/client/compaction-history.mjs'
import { nativeChat } from './fixtures/native-chat.mjs'
import { strictSession } from './fixtures/native-persistence.mjs'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { createRunProgressReporter } from '../src/run-progress.mjs'

const record = 'plugin:claude-bridge/compaction'
const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
function fixture() {
  const records = [], slots = new Map()
  const projection = new SdkProjection({ agent: { session: {} }, runId: 'run-1', turn: 1, step: 1,
    helpers: { appendPluginRecord(_session, type, data) {
      records.push({ type, data, seq: records.length, time: 100, ignorable: true })
    } } })
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const install = createCompactionHistory({ React })
  return { projection, records, install, slots, slotContext: {
    slots: { register(options, component) { slots.set(options.key, component); return () => slots.delete(options.key) } },
  } }
}
const boundary = (uuid = 'boundary-1') => ({ type: 'system', subtype: 'compact_boundary', uuid,
  summary: '不得读取的正文', compact_metadata: { trigger: 'auto', pre_tokens: 900, post_tokens: 100,
    duration_ms: 1234, summary: '不得读取的正文' } })

test('只有确认边界才追加展示记录，同UUID去重，多次压缩保留，取消后不追加', async () => {
  const f = fixture()
  await f.projection.accept({ type: 'system', subtype: 'status', status: 'compacting' })
  await f.projection.accept({ type: 'system', subtype: 'status', status: null })
  assert.equal(f.records.length, 0)
  await f.projection.accept(boundary()); await f.projection.accept(boundary())
  assert.equal(f.records.length, 1)
  assert.ok(Number.isSafeInteger(f.records[0].data.completedAt))
  assert.deepEqual(f.records[0].data, { version: 1, runId: 'run-1', turn: 1, step: 1, completedAt: f.records[0].data.completedAt,
    trigger: 'auto', preTokens: 900, postTokens: 100, durationMs: 1234 })
  await f.projection.accept(boundary('boundary-2'))
  assert.equal(f.records.length, 2)
  f.projection.interrupt()
  await f.projection.accept(boundary('boundary-3'))
  assert.equal(f.records.length, 2)
  assert.equal(JSON.stringify(f.records).includes('不得读取'), false)
})

test('折叠卡片走原生节点注册，固定位置不进入过程折叠，未知数值不猜，卸载释放', async () => {
  const f = fixture()
  let definition, removed = false
  const dispose = f.install({ ...f.slotContext, uiConversation: { events: {
    register(value) { definition = value; return () => { removed = true } },
  } } })
  await f.projection.accept(boundary())
  const event = f.records[0]
  assert.equal(definition.match({ ...event, ignorable: false }), null)
  assert.equal(definition.match({ ...event, type: 'compaction/end' }), null)
  assert.equal(definition.match({ ...event, data: { ...event.data, preTokens: -1 } }), null)
  const context = { key: 'test', id: '0', start: { event, location: { kind: 'session' } }, matches: [],
    state: definition.start(null, { event }) }
  const node = definition.buildViewNode(context)
  assert.equal(node.groupTree, 'turn')
  assert.equal(node.anchorSeq, event.seq)
  const component = f.slots.get(node.kind)
  const card = component({ node })
  assert.equal(card.type, 'details')
  assert.equal(card.props.open, undefined)
  assert.equal(card.children[0].children[0], '自动压缩已完成')
  assert.ok(JSON.stringify(card).includes('当前接口未提供压缩摘要正文'))
  const unknown = component({ node: { data: { trigger: 'unknown' } } })
  assert.equal(JSON.stringify(unknown).includes('tokens'), false)
  dispose(); assert.equal(removed, true); assert.equal(f.slots.size, 0)
})

test('实际rc5：压缩卡片实时追加与严格重载一致，日志不改变模型surface', { skip: !native }, async () => {
  const { Session, SESSION_FORMAT_VERSION, appendPluginRecord } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const session = Session.create('compact-card', undefined, { version: SESSION_FORMAT_VERSION,
    id: 'compact-card', createdAt: 0, delegationDepth: 0, isSeeded: false, agentPreset: 'claude-sdk-remote' })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const f = fixture(), chat = await nativeChat()
  f.install({ ...chat.ctx, ...f.slotContext })
  chat.replace(session.snapshotEvents())
  await f.projection.accept(boundary())
  appendPluginRecord(session, record, f.records[0].data)
  chat.append(session.snapshotEvents().at(-1))
  const cards = () => chat.order().filter(node => node.kind === 'claude-bridge-compaction')
  assert.equal(cards().length, 1)
  assert.equal(cards()[0].visibility, 'visible')
  assert.equal(chat.seat(cards()[0])['data-turn-process-hidden'], undefined)
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const restored = await strictSession(session)
  chat.replace(restored.events)
  assert.equal(cards().length, 1)
  assert.equal(cards()[0].data.preTokens, 900)
  assert.equal(chat.seat(cards()[0])['data-turn-process-hidden'], undefined)
  assert.deepEqual(Session.create(session.id, restored.events, restored.header).surface.nodes, [])
})

test('实际rc5：老进度重复采样去重，新旧标记共存不重复，跨轮及多次压缩均可回放', { skip: !native }, async () => {
  const f = fixture(), chat = await nativeChat()
  f.install({ ...chat.ctx, ...f.slotContext })
  let time = 100, status = { runId: 'run-1', model: 'haiku', phase: 'running' }
  const events = []
  const reporter = createRunProgressReporter({ runId: 'run-1', model: 'haiku', isActive: () => true,
    readStatus: () => status, writeStatus: patch => { status = { ...status, ...patch } },
    writeProgress: data => events.push({ type: 'plugin:claude-bridge/progress', ignorable: true,
      seq: events.length, time: 100, data }), now: () => time++ })
  reporter.start()
  reporter.accept({ type: 'status', status: 'compacting' })
  reporter.accept({ type: 'status', status: null })
  chat.replace(events)
  const cards = () => chat.order().filter(node => node.kind === 'claude-bridge-compaction')
  assert.equal(cards().length, 0)
  f.projection.onProgress = event => reporter.accept(event)
  await f.projection.accept(boundary())
  await f.projection.accept(boundary())
  events.push({ ...f.records[0], seq: events.length })
  reporter.accept({ type: 'context', code: 'CONTEXT_SUMMARY_TIMEOUT' })
  chat.replace(events)
  assert.equal(cards().length, 1)
  assert.equal(cards()[0].anchorSeq, 3)
  await f.projection.accept(boundary('second'))
  events.push({ ...f.records[1], seq: events.length })
  chat.replace(events)
  assert.equal(cards().length, 2)
  // A legacy file needs only its existing records, with no rewrite/backfill RPC.
  chat.replace(events.filter(event => event.type !== record))
  assert.equal(cards().length, 2)
  const otherRun = { ...f.records[0], seq: events.length,
    data: { ...f.records[0].data, runId: 'run-2' } }
  chat.append(otherRun)
  assert.equal(cards().length, 3)
})
