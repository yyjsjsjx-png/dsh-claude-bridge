import test from 'node:test'
import assert from 'node:assert/strict'
import { createMeterViews } from '../plugin/ui/client/meter-views.mjs'
import { createClient } from '../plugin/ui/client/entry.mjs'

const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
const { ChildModelBadge } = createMeterViews({ React })
const hook = value => select => select(value)
const props = (selection, bridge = {}, origin = 'subagent') => ({ sessionId: 'child',
  useBridgeStatus: hook(bridge), useModelSelection: hook(selection),
  useSessionList: hook({ byId: { child: { origin } } }),
  useModelDirectory: hook({ groups: [{ id: 'claude-sdk-remote', models: [
    { id: 'sonnet', name: 'Sonnet 5.5', reasoning: { defaultEffort: 'high' } },
  ] }] }),
})

test('子代理标签只展示本会话lastUsed请求配置，目录仅作名称，不把pending或父状态当实际选型', () => {
  const selected = { provider: 'claude-sdk-remote', model: 'sonnet', reasoningEffort: 'high' }
  const view = ChildModelBadge(props({ lastUsed: selected,
    next: { provider: 'claude-sdk-remote', model: 'haiku', reasoningEffort: 'low' } }, { model: 'parent-model' }))
  assert.deepEqual(view.children, ['Sonnet 5.5 · high'])
  assert.match(view.props.title, /request\/header/)
  assert.match(view.props.title, /不代表 SDK 解析型号回执/)
  const defaults = ChildModelBadge(props({ lastUsed: { ...selected, reasoningEffort: undefined } }))
  assert.deepEqual(defaults.children, ['Sonnet 5.5 · 模型默认'])
  assert.match(defaults.props.title, /未指定具体等级/)
  const pending = ChildModelBadge(props({ lastUsed: null, next: selected }))
  assert.deepEqual(pending.children, ['型号待确认 · 强度待确认'])
  const noCatalog = props({ lastUsed: selected }); noCatalog.useModelDirectory = hook(undefined)
  assert.deepEqual(ChildModelBadge(noCatalog).children, ['sonnet · high'])
})

test('普通child与远程root不显示子代理标签，避免更改普通路径或重复主会话选择器', () => {
  const selected = { lastUsed: { provider: 'claude-sdk-remote', model: 'sonnet' } }
  assert.equal(ChildModelBadge(props(selected, null)), null)
  assert.equal(ChildModelBadge(props(selected, {}, null)), null)
  const nativeAddress = props(selected, {}, null)
  nativeAddress.isSubagent = true
  assert.deepEqual(ChildModelBadge(nativeAddress).children, ['Sonnet 5.5 · 模型默认'])
})

test('共有ChatView使用当前pane原生binding，侧栏无header和root binding也只显示一个标签', () => {
  const client = createClient({ React, createUsageProjectionBridge: () => () => {} })
  const NativeChat = () => null, nativeHooks = { chat: 'native-chat-hook' }
  const native = { options: { name: 'conversation.view', id: 'chat', order: 0 }, locale: 'chat', component: NativeChat,
    inject: id => ({ sessionId: id, hooks: nativeHooks, nativeMarker: true }) }
  const entries = [native]
  let listener, loads = 0
  const directory = { getSnapshot: () => ({ groups: [{ id: 'claude-sdk-remote', models: [{ id: 'sonnet', name: 'Sonnet 5.5' }] }] }),
    subscribe: () => () => {} }
  const ctx = { get: name => {
    assert.equal(name, 'modelDirectories')
    return { directoryFor: id => { assert.equal(id, 'child'); return { store: directory, load: () => { loads++ } } } }
  }, slots: {
    entries: name => { assert.equal(name, 'conversation.view'); return entries },
    subscribe: (_name, callback) => { listener = callback; return () => { listener = undefined } },
    register(options, component) {
      const entry = { options, component, locale: options.locale, inject: options.inject }
      entries.push(entry); listener?.()
      return () => { entries.splice(entries.indexOf(entry), 1) }
    },
  } }
  const dispose = client.installChildModelView(ctx, ChildModelBadge)
  const wrapped = entries.find(entry => entry !== native)
  const injected = wrapped.inject('child')
  assert.equal(injected.nativeMarker, true); assert.equal(injected.hooks.chat, nativeHooks.chat)
  assert.equal(injected.hooks.childModelDirectory, directory); assert.equal(loads, 0)
  const props = { sessionId: 'child', useSession: select => select({ subagent: { address: { childSessionId: 'child' } } }),
    useSessions: select => select({ byId: {} }),
    useProjection: (key, select) => {
      const value = key === 'claudeBridge' ? {} : { lastUsed: { provider: 'claude-sdk-remote', model: 'sonnet', reasoningEffort: 'high' } }
      return select ? select(value) : value
    }, useChildModelDirectory: select => select(directory.getSnapshot()),
  }
  for (const occurrence of ['sidepane', 'full-page']) {
    const view = wrapped.component({ ...props, occurrence })
    const badge = view.children[0].children[0]
    assert.equal(badge.type, ChildModelBadge)
    assert.deepEqual(badge.type(badge.props).children, ['Sonnet 5.5 · high'])
    assert.equal(view.children[1].children[0].type, NativeChat)
  }
  const ordinary = { ...props, useProjection: () => null }
  const ordinaryView = wrapped.component(ordinary)
  assert.equal(ordinaryView.type, NativeChat); assert.equal(ordinaryView.props, ordinary)
  const root = { ...props, useSession: select => select({}) }
  assert.equal(wrapped.component(root).type, NativeChat)
  dispose()
  assert.deepEqual(entries, [native])
})
