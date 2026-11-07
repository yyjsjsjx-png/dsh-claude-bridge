import test from 'node:test'
import assert from 'node:assert/strict'
import { SdkProjection } from '../src/sdk-projection.mjs'
import { MODEL_ROUTE_RECORD, MODEL_ROUTE_PROJECTION, applyModelRoute, createModelRouteProjection,
  createModelRouteTracker, initialModelRoute, modelRouteVerdict, sameModel } from '../src/model-route.mjs'
import { createModelRouteDisplay } from '../plugin/ui/client/model-route-display.mjs'
import { assistantIdentity } from '../src/history-sync.mjs'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { nativeChat } from './fixtures/native-chat.mjs'
import { strictSession } from './fixtures/native-persistence.mjs'

const OPUS = 'claude-opus-5-5', OLD = 'claude-opus-4-8'
const position = { turn: 1, step: 1 }

function tracker(open) {
  const records = []
  const route = createModelRouteTracker({ runId: 'run', open, now: () => 5, append: (type, data) => {
    assert.equal(type, MODEL_ROUTE_RECORD)
    records.push(data)
  } })
  return { route, records, kinds: () => records.map(record => record.kind) }
}
const answer = (actualModel, requestedModel = OPUS) => ({ requestedModel, actualModel, responseId: 'msg' })
const fallback = (fields = {}) => ({ type: 'system', subtype: 'model_refusal_fallback', direction: 'retry', trigger: 'refusal',
  scope: 'session', original_model: OPUS, fallback_model: OLD, api_refusal_category: 'cyber', uuid: 'notice', ...fields })
const replay = records => records.reduce((state, data) =>
  applyModelRoute(state, { type: MODEL_ROUTE_RECORD, ignorable: true, data }), initialModelRoute())

test('型号判定：相同、日期或窗口后缀、同族别名都不算不一致，未知别名不下结论', () => {
  assert.equal(modelRouteVerdict(OPUS, OPUS), true)
  assert.equal(modelRouteVerdict(OPUS, `${OPUS}-20261001`), true)
  assert.equal(modelRouteVerdict(`${OPUS}[1m]`, OPUS), true)
  assert.equal(modelRouteVerdict('opus', OPUS), true)
  assert.equal(modelRouteVerdict(OPUS, OLD), false)
  assert.equal(modelRouteVerdict('sonnet', OPUS), false)
  assert.equal(modelRouteVerdict('best', OPUS), null)
  assert.equal(modelRouteVerdict(OPUS, 'us.anthropic.custom'), null)
  assert.equal(modelRouteVerdict(undefined, OPUS), null)
  assert.equal(modelRouteVerdict(OPUS, '<synthetic>'), null)
  assert.equal(sameModel(OPUS, `${OPUS}-20261001`), true)
})

test('一致时不产生任何记录', () => {
  const f = tracker()
  f.route.response(answer(OPUS), position)
  f.route.response(answer(OPUS, 'opus'), position)
  f.route.response(answer('whatever', 'best'), position)
  assert.deepEqual(f.records, [])
})

test('接手响应先到、回合末通知后到：同一张卡片补原因，只说明一次', () => {
  const f = tracker()
  f.route.response(answer(OLD), position)
  f.route.response(answer(OLD), { turn: 1, step: 2 })
  assert.deepEqual(f.kinds(), ['mismatch'])
  const { routeId } = f.records[0]
  f.route.notice(fallback(), { requestedModel: OPUS }, { turn: 1, step: 3 })
  f.route.notice(fallback(), { requestedModel: OPUS }, { turn: 1, step: 3 })
  assert.deepEqual(f.kinds(), ['mismatch', 'refusal-fallback'])
  assert.equal(f.records[1].routeId, routeId)
  assert.equal(f.records[1].category, 'cyber')
  assert.equal(replay(f.records).open.kind, 'refusal-fallback')
})

test('通知先到：后续接手响应不再开第二张卡片', () => {
  const f = tracker()
  f.route.notice(fallback(), { requestedModel: OPUS }, position)
  f.route.response(answer(OLD), position)
  assert.deepEqual(f.kinds(), ['refusal-fallback'])
})

test('没有事件的不一致只说实际模型，不猜原因', () => {
  const f = tracker()
  f.route.response(answer(OLD), position)
  assert.equal(f.records[0].kind, 'mismatch')
  assert.equal('category' in f.records[0], false)
  assert.equal('explanation' in f.records[0], false)
})

test('恢复：跨运行读回未关闭路由，回到所选模型时再出一次卡片并只出一次', () => {
  const first = tracker()
  first.route.notice(fallback(), { requestedModel: OPUS }, position)
  const open = replay(first.records).open
  const next = tracker(open)
  next.route.response(answer(OLD), position)
  assert.deepEqual(next.records, [], '接手模型继续回答时不重复说明')
  next.route.response(answer(OPUS), { turn: 2, step: 1 })
  next.route.response(answer(OPUS), { turn: 2, step: 2 })
  assert.deepEqual(next.kinds(), ['recovered'])
  assert.equal(next.records[0].previousModel, OLD)
  assert.equal(next.records[0].actualModel, OPUS)
  assert.equal(replay([...first.records, ...next.records]).open, null)
})

test('别名不能把同族回退模型误判为恢复；改选后才关闭', () => {
  const f = tracker()
  f.route.notice(fallback(), { requestedModel: 'opus' }, position)
  f.route.response(answer(OLD, 'opus'), position)
  assert.deepEqual(f.kinds(), ['refusal-fallback'])
  f.route.response(answer(OPUS, 'opus'), position)
  assert.deepEqual(f.kinds(), ['refusal-fallback', 'recovered'])
  const reselect = tracker({ routeId: 'r', runId: 'old', kind: 'refusal-fallback', requestedModel: OPUS, originalModel: OPUS, actualModel: OLD })
  reselect.route.response(answer(OLD, OLD), position)
  assert.deepEqual(reselect.kinds(), ['recovered'])
})

test('路由未关闭时证据不足不判恢复；又换成第三个模型才开新卡片', () => {
  const open = { routeId: 'r', runId: 'old', kind: 'mismatch', requestedModel: OPUS, originalModel: OPUS, actualModel: OLD }
  const unknown = tracker(open)
  unknown.route.response(answer('us.anthropic.custom'), position)
  assert.deepEqual(unknown.records, [])
  const third = tracker(open)
  third.route.response(answer('claude-haiku-5-5'), position)
  assert.deepEqual(third.kinds(), ['mismatch'])
})

test('局部回退不改会话路由；未回退的拒绝只说明一次且不开路由', () => {
  const local = tracker()
  local.route.notice(fallback({ scope: 'local' }), { requestedModel: OPUS }, position)
  assert.deepEqual(local.records, [])
  const refused = tracker()
  const notice = { type: 'system', subtype: 'model_refusal_no_fallback', original_model: OPUS, uuid: 'n', api_refusal_category: null }
  refused.route.notice(notice, { requestedModel: OPUS }, position)
  refused.route.notice(notice, { requestedModel: OPUS }, position)
  assert.deepEqual(refused.kinds(), ['refusal-no-fallback'])
  assert.equal(replay(refused.records).open, null)
})

test('撤回只计数：supersedes 与通知幂等，工具结果单独计，流式拒绝也算，说明有界', () => {
  const f = tracker()
  f.route.frame({ uuid: 'text', responseId: 'msg_a', toolCalls: 0 })
  f.route.frame({ uuid: 'tool', responseId: 'msg_a', toolCalls: 2 })
  f.route.refusalStop('msg_stream')
  f.route.frame({ uuid: 'takeover', responseId: 'msg_b', supersedes: ['text', 'tool'] })
  assert.deepEqual(f.records, [], '撤回本身不产生记录')
  f.route.notice(fallback({ retracted_message_uuids: ['text', 'tool', 'tombstone', 'unknown'],
    api_refusal_explanation: `第一行\n${'长'.repeat(900)}` }), { requestedModel: OPUS }, position)
  assert.deepEqual(f.kinds(), ['refusal-fallback'])
  const card = f.records[0]
  assert.equal(card.retractedResponseCount, 2)
  assert.equal(card.retractedOtherCount, 2)
  assert.equal(card.retractedToolCallCount, 2)
  assert.equal(card.explanation.length, 500)
  assert.equal(card.explanation.includes('\n'), false)
})

test('未回退的拒绝不撤回；旧 CLI 缺字段仍按会话回退处理', () => {
  const f = tracker()
  f.route.refusalStop('msg')
  f.route.notice({ subtype: 'model_refusal_no_fallback', original_model: OPUS }, { requestedModel: OPUS }, position)
  assert.deepEqual(f.kinds(), ['refusal-no-fallback'])
  const older = tracker()
  const { scope: _scope, uuid: _uuid, ...notice } = fallback()
  older.route.notice(notice, { requestedModel: OPUS }, position)
  assert.equal(older.records[0].kind, 'refusal-fallback')
  assert.equal(older.records[0].category, 'cyber')
})

test('SdkProjection：合成回退全程只写忽略型记录，子代理帧和停止后事件不影响路由', async () => {
  const records = []
  const projection = new SdkProjection({ agent: { session: {} }, runId: 'run', turn: 1, step: 1, model: OPUS,
    helpers: { appendPluginRecord: (_session, type, data) => records.push({ type, data }) } })
  const start = (id, model, parent = null) => ({ type: 'stream_event', parent_tool_use_id: parent,
    event: { type: 'message_start', message: { id, model, usage: {} } } })
  const routes = () => records.filter(record => record.type === MODEL_ROUTE_RECORD).map(record => record.data)
  await projection.accept(start('msg_a', OPUS))
  await projection.accept({ type: 'stream_event', parent_tool_use_id: null,
    event: { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: {} } })
  assert.deepEqual(routes(), [])
  await projection.accept(start('msg_child', OLD, 'tool-1'))
  assert.deepEqual(routes(), [], '子代理帧不是主模型证据')
  await projection.accept(start('msg_b', OLD))
  assert.deepEqual(routes().map(data => data.kind), ['mismatch'])
  await projection.accept(fallback({ retracted_message_uuids: [] }))
  assert.deepEqual(routes().map(data => data.kind), ['mismatch', 'refusal-fallback'])
  assert.equal(routes()[1].retractedResponseCount, 1)
  projection.interrupt()
  await projection.accept(fallback({ uuid: 'late' }))
  assert.equal(routes().length, 2)
})

function display() {
  const slots = new Map()
  let definition
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const ctx = {
    uiConversation: { events: { register(value) { definition = value; return () => { definition = undefined } } } },
    slots: { register(options, component) {
        slots.set(options.key, component)
        return () => slots.delete(options.key)
      } },
  }
  const install = createModelRouteDisplay({ React })
  const dispose = install(ctx)
  return { slots, dispose, install, definition: () => definition }
}
const card = data => ({ type: MODEL_ROUTE_RECORD, ignorable: true, seq: 7,
  data: { version: 1, kind: 'mismatch', routeId: 'run:1', runId: 'run', turn: 1, step: 1, at: 1,
    requestedModel: OPUS, originalModel: OPUS, actualModel: OLD, ...data } })
const render = (f, data) => f.slots.get('claude-bridge-model-route')({ node: { data } })
const texts = element => JSON.stringify(element)

test('卡片：折叠不弹窗，通知更新同一节点，恢复另成一张卡片，未知记录不生成卡片，不包裹原生回复', () => {
  const f = display(), definition = f.definition()
  assert.equal(definition.match(card({ kind: 'other' })), null)
  assert.equal(definition.match({ ...card({}), ignorable: false }), null)
  assert.deepEqual([...f.slots.keys()], ['claude-bridge-model-route'], '已输出的正文保持原生显示')
  assert.deepEqual(definition.match(card({})), { id: 'run:1', role: 'start' })
  const first = definition.start(null, { event: card({}) })
  const mismatch = render(f, first)
  assert.equal(mismatch.type, 'details')
  assert.equal(mismatch.props.open, undefined)
  assert.equal(mismatch.children[0].children[0], '实际由 Opus 4.8 回答，与所选 Opus 5.5 不同')
  assert.ok(texts(mismatch).includes('SDK 未报告'))
  const updated = definition.update({ state: first }, { event: card({ kind: 'refusal-fallback', category: 'cyber',
    explanation: '合成说明', retractedResponseCount: 1, retractedOtherCount: 0, retractedToolCallCount: 2 }) })
  assert.equal(updated.seq, 7, '位置留在发生处')
  const explained = render(f, updated)
  assert.equal(explained.children[0].children[0], '本轮改由 Opus 4.8 回答 · Opus 5.5 被安全机制拦截（网络安全，cyber）')
  for (const part of ['合成说明', '已撤回 1 条回复', '没有作为最终回答', '2 个工具调用', '恢复时会再显示']) assert.ok(texts(explained).includes(part), part)
  assert.equal(texts(explained).includes('折叠保留'), false)
  const recovered = render(f, { kind: 'recovered', actualModel: OPUS, previousModel: OLD })
  assert.equal(recovered.children[0].children[0], '已恢复所选模型 Opus 5.5')
  const node = definition.buildViewNode({ key: 'k', id: 'run:1', state: first, matches: [], start: { location: { kind: 'session' } } })
  assert.equal(node.groupTree, 'turn')
  assert.equal(node.anchorSeq, 7)
})

test('输入区标记只在路由未关闭时显示，且跟随投影', () => {
  const { install } = display()
  const Marker = install.Marker
  assert.equal(Marker({ useProjection: () => null }), null)
  assert.equal(Marker({ useProjection: () => ({ open: null }) }), null)
  const marker = Marker({ useProjection: key => {
    assert.equal(key, MODEL_ROUTE_PROJECTION)
    return { open: { requestedModel: OPUS, originalModel: OPUS, actualModel: OLD } }
  } })
  assert.equal(marker.children[0], '实际 Opus 4.8')
  assert.ok(marker.props.title.includes('所选 Opus 5.5'))
})

test('卸载释放卡片注册', () => {
  const f = display()
  f.dispose()
  assert.equal(f.slots.size, 0)
  assert.equal(f.definition(), undefined)
})

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)

test('实际 zod：普通会话为空，真实记录全部过校验，坏记录不破坏回放', { skip: !native }, async () => {
  const { z } = await import(resolveDshModule('zod'))
  const projection = createModelRouteProjection(z)
  assert.equal(projection.init({ agentPreset: 'other' }), null)
  assert.equal(projection.apply(null, card({})), null)
  const start = projection.init({ agentPreset: 'claude-sdk-remote' })
  assert.deepEqual(start, initialModelRoute())
  assert.deepEqual(projection.apply(start, { type: MODEL_ROUTE_RECORD, ignorable: true, data: { kind: 'mismatch' } }), start)
  const f = tracker()
  f.route.frame({ uuid: 'text', responseId: 'msg_a' })
  f.route.response(answer(OLD), position)
  f.route.notice(fallback({ retracted_message_uuids: ['text', 'tombstone'], api_refusal_explanation: '合成说明' }), { requestedModel: OPUS }, position)
  f.route.response(answer(OPUS), position)
  f.route.notice({ subtype: 'model_refusal_no_fallback', original_model: OPUS, uuid: 'n' }, { requestedModel: OPUS }, position)
  assert.deepEqual(f.kinds(), ['mismatch', 'refusal-fallback', 'recovered', 'refusal-no-fallback'])
  let state = start
  for (const [index, data] of f.records.entries()) {
    state = projection.apply(state, { type: MODEL_ROUTE_RECORD, ignorable: true, data })
    if (index === 1) assert.equal(state.open.kind, 'refusal-fallback', '通知记录过校验')
  }
  assert.equal(state.open, null, '恢复记录过校验')
  assert.equal(projection.stateSchema.safeParse(state).success, true)
})

test('实际原生：接手先到再通知、恢复，实时与冷回放节点一致且日志不改模型 surface', { skip: !native }, async () => {
  const { Session, SESSION_FORMAT_VERSION, appendPluginRecord } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const llm = await import(resolveDshModule('@deepseek-ai/dsh-llm'))
  const session = Session.create('route-card', undefined, { version: SESSION_FORMAT_VERSION, id: 'route-card',
    createdAt: 0, delegationDepth: 0, isSeeded: false, agentPreset: 'claude-sdk-remote' })
  const reply = (step, id, text, model) => {
    const content = [{ type: 'text', text }]
    session.append('step/start', { turn: 1, step })
    session.append('assistant/message', { turn: 1, step, stream: [], message: {
      ...llm.createAssistantMessage({ content, source: { provider: 'claude-sdk-remote', model } }),
      id: assistantIdentity(id, content) } }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step })
  }
  const write = data => appendPluginRecord(session, MODEL_ROUTE_RECORD, data)
  session.append('turn/start', { turn: 1 })
  const f = tracker()
  f.route.frame({ uuid: 'refused', responseId: 'msg_a' })
  reply(1, 'msg_a', '合成被撤回文字', OPUS)
  f.route.response(answer(OLD), { turn: 1, step: 2 })
  for (const data of f.records.splice(0)) write(data)
  reply(2, 'msg_b', '合成接手文字', OLD)
  f.route.notice(fallback({ retracted_message_uuids: ['refused'] }), { requestedModel: OPUS }, { turn: 1, step: 2 })
  for (const data of f.records.splice(0)) write(data)
  f.route.response(answer(OPUS), { turn: 1, step: 3 })
  for (const data of f.records.splice(0)) write(data)
  reply(3, 'msg_c', '合成恢复文字', OPUS)
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const surfaceBefore = JSON.stringify(session.surface.nodes)
  const restored = await strictSession(session)
  for (const lifecycle of ['cold', 'live']) {
    const chat = await nativeChat()
    const slots = new Map()
    createModelRouteDisplay({ React: { createElement: () => null, useState: value => [value, () => {}] } })({ ...chat.ctx,
      slots: { register(options, component) { slots.set(options.key, component); return () => slots.delete(options.key) } } })
    if (lifecycle === 'cold') chat.replace(restored.events)
    else for (const event of session.snapshotEvents()) chat.append(event)
    const order = chat.order().filter(node => ['assistant-step', 'claude-bridge-model-route'].includes(node.kind))
    assert.deepEqual(Array.from(order, node => node.kind), ['assistant-step', 'claude-bridge-model-route', 'assistant-step',
      'claude-bridge-model-route', 'assistant-step'], lifecycle)
    assert.equal(order[1].data.kind, 'refusal-fallback', '同一张卡片已补原因')
    assert.equal(order[3].data.kind, 'recovered')
  }
  assert.equal(JSON.stringify(Session.create(session.id, restored.events, restored.header).surface.nodes), surfaceBefore)
})
