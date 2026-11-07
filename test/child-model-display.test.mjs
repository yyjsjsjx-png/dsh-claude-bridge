import test from 'node:test'
import assert from 'node:assert/strict'
import { createMeterViews } from '../plugin/ui/client/meter-views.mjs'
import { createClient } from '../plugin/ui/client/entry.mjs'

const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
const { SessionModelBadge } = createMeterViews({ React })
const hook = value => select => select(value)
const props = (selection, bridge = {}, origin = 'subagent', observation = null) => ({ sessionId: 'child',
  useProjection: key => ({ claudeBridge: bridge, modelSelection: selection,
    claudeBridgeModelObservation: observation })[key], useSession: hook({}),
  useSessions: hook({ byId: { child: { origin } } }),
  useModelDirectory: hook({ groups: [{ id: 'claude-sdk-remote', models: [
    { id: 'sonnet', name: 'Sonnet 5.5', reasoning: { defaultEffort: 'high' } },
  ] }] }),
})

test('子代理标签只展示本会话lastUsed请求配置，目录仅作名称，不把pending或父状态当实际选型', () => {
  const selected = { provider: 'claude-sdk-remote', model: 'sonnet', reasoningEffort: 'high' }
  const view = SessionModelBadge(props({ lastUsed: selected,
    next: { provider: 'claude-sdk-remote', model: 'haiku', reasoningEffort: 'low' } }, { model: 'parent-model' }))
  assert.deepEqual(view.children, ['Sonnet 5.5 · high'])
  assert.match(view.props.title, /request\/header/)
  assert.match(view.props.title, /不代表 SDK 解析型号回执/)
  const defaults = SessionModelBadge(props({ lastUsed: { ...selected, reasoningEffort: undefined } }))
  assert.deepEqual(defaults.children, ['Sonnet 5.5 · 模型默认'])
  assert.match(defaults.props.title, /未指定具体等级/)
  const pending = SessionModelBadge(props({ lastUsed: null, next: selected }))
  assert.deepEqual(pending.children, ['型号待确认 · 强度待确认'])
  const noCatalog = props({ lastUsed: selected }); noCatalog.useModelDirectory = hook(undefined)
  assert.deepEqual(SessionModelBadge(noCatalog).children, ['sonnet · high'])
})

test('普通child与远程root不显示子代理标签，避免更改普通路径或重复主会话选择器', () => {
  const selected = { lastUsed: { provider: 'claude-sdk-remote', model: 'sonnet' } }
  assert.equal(SessionModelBadge(props(selected, null)), null)
  assert.equal(SessionModelBadge(props(selected, {}, null)), null)
  const nativeAddress = props(selected, {}, null)
  nativeAddress.useSession = hook({ subagent: { address: { childSessionId: 'child' } } })
  assert.deepEqual(SessionModelBadge(nativeAddress).children, ['Sonnet 5.5 · 模型默认'])
})

test('只有远程子页显示请求配置与SDK返回事实，主会话即使有actual也不显示标签', () => {
  const selected = { lastUsed: { provider: 'claude-sdk-remote', model: 'sonnet', reasoningEffort: 'high' } }
  const observation = { current: { requestedModel: 'sonnet', actualModel: 'claude-sonnet-wire',
    responseId: 'response-a', source: 'sdk-message-start' } }
  const child = SessionModelBadge(props(selected, {}, 'subagent', observation))
  assert.deepEqual(child.children, ['Sonnet 5.5 · high ｜ SDK 返回：claude-sonnet-wire'])
  assert.match(child.props.title, /不等于降级/)
  assert.match(child.props.title, /未报告实际思考等级/)
  const root = SessionModelBadge(props(selected, {}, null, observation))
  assert.equal(root, null)
  assert.equal(SessionModelBadge(props(selected, null, 'subagent', observation)), null)
  assert.equal(SessionModelBadge(props(selected, null, null, observation)), null)
  assert.equal(SessionModelBadge(props(selected, {}, null, { current: { ...observation.current, requestedModel: 'haiku' } })), null)
  assert.equal(SessionModelBadge(props(selected, {}, null, { current: { ...observation.current, actualModel: null } })), null)
  assert.deepEqual(SessionModelBadge(props(selected, {}, 'subagent', {
    current: { ...observation.current, requestedModel: 'haiku' } })).children, ['Sonnet 5.5 · high'])
})

test('唯一dock标签复用实际pane标准hooks，不依赖header/root binding或替换factory且不加载目录', async () => {
  const store = { getSnapshot: () => ({}), subscribe: () => () => {} }
  const client = createClient({ React, createUsageProjectionBridge: () => () => {}, createMeterViews,
    createModelRouteDisplay: () => Object.assign(() => () => {}, { Marker: () => null }),
    createSettingsController: () => ({ store, models: {}, async readStatus() {} }),
    createQuotaController: () => ({ store }), createPickerController: () => ({ store }),
    createFormViews: () => ({}) })
  const entries = []
  let loads = 0
  const directory = { getSnapshot: () => ({ groups: [{ id: 'claude-sdk-remote', models: [{ id: 'sonnet', name: 'Sonnet 5.5' }] }] }),
    subscribe: () => () => {} }
  const ctx = { sessions: {}, remote: { session: {}, claudeBridge: {}, $mount: async () => () => {} },
    effect() {}, inject: (_services, callback) => callback(ctx), get: name => {
    assert.equal(name, 'modelDirectories')
    return { directoryFor: id => { assert.equal(id, 'child'); return { store: directory, load: () => { loads++ } } } }
  }, slots: {
    inject: (_name, callback) => callback(),
    register: (options, component) => { entries.push({ options, component }); return () => {} },
  } }
  await client.apply(ctx)
  const labels = entries.filter(entry => entry.options.id === 'dsh-claude-child-model')
  assert.equal(labels.length, 1)
  const label = labels[0], injected = label.options.inject('child')
  assert.equal(label.options.name, 'conversation.composer.dock')
  assert.equal(injected.hooks.modelDirectory, directory); assert.equal(loads, 0)
  assert.equal(entries.some(entry => entry.options.name === 'conversation.view'
    || entry.options.name === 'conversation.session.header.utilities'), false)
  const pane = { sessionId: 'child', useSession: select => select({ subagent: { address: { childSessionId: 'child' } } }),
    useSessions: select => select({ byId: {} }),
    useProjection: key => {
      const value = { claudeBridge: {}, modelSelection: { lastUsed: {
        provider: 'claude-sdk-remote', model: 'sonnet', reasoningEffort: 'high' } }, claudeBridgeModelObservation: null }[key]
      return value
    }, useModelDirectory: select => select(directory.getSnapshot()),
  }
  for (const occurrence of ['sidepane', 'full-page']) {
    assert.deepEqual(label.component({ ...pane, occurrence }).children, ['Sonnet 5.5 · high'])
  }
  assert.equal(label.component({ ...pane, useProjection: () => null }), null)
  assert.equal(label.component({ ...pane, useSession: select => select({}) }), null)
})
