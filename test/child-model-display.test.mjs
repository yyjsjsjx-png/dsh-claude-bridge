import test from 'node:test'
import assert from 'node:assert/strict'
import { createMeterViews } from '../plugin/ui/client/meter-views.mjs'

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
