import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageProjectionBridge } from '../plugin/ui/client/usage-projection.mjs'

test('复用原生用量与轮末组件，仅远程映射数值，卸载和原生热更恢复正确', () => {
  const slots = new Map(), listeners = new Map()
  const emit = name => { for (const callback of listeners.get(name) ?? []) callback() }
  const register = (options, component) => {
    const entry = { options, component, locale: options.locale, inject: options.inject }
    const list = slots.get(options.name) ?? []
    slots.set(options.name, [...list, entry]); emit(options.name)
    return () => { slots.set(options.name, slots.get(options.name).filter(value => value !== entry)); emit(options.name) }
  }
  const ctx = { slots: { entries: name => slots.get(name) ?? [], register,
    subscribe(name, callback) {
      const list = listeners.get(name) ?? new Set(); list.add(callback); listeners.set(name, list)
      return () => list.delete(callback)
    } } }
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const dispose = createUsageProjectionBridge({ React })(ctx)
  const inject = () => ({ hooks: { performanceUsage: 'preserved' } })
  const nativeUsage = () => {}, nativeTail = () => {}
  let removeNative = register({ name: 'conversation.composer.dock', id: 'usage', order: 1, locale: 'chat', inject }, nativeUsage)
  register({ name: 'conversation.chat.node', key: 'turn-tail', locale: 'chat', inject,
    children: { 'conversation.chat.turnTail': { kind: 'list', scope: 'session' } } }, nativeTail)
  const winner = (name, field, id) => ctx.slots.entries(name).filter(e => e.options[field] === id)
    .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]
  const original = { uncachedInputTokens: 10, outputTokens: 20 }
  const turn = { uncachedInputTokens: 330, outputTokens: 120075, cacheReadTokens: 31324396, cacheWriteTokens: 364916, coverage: 'complete' }
  const remoteUsage = { ...turn, turns: { 5: turn } }
  let remote = true
  const props = { useProjection(key) {
    if (key === 'claudeBridge') return remote ? {} : null
    if (key === 'claudeBridgeUsage') return remote ? remoteUsage : null
    return original
  }, node: { data: { turn: 5, tokenUsage: original }, anchorSeq: 10 } }
  let entry = winner('conversation.composer.dock', 'id', 'usage')
  assert.equal(entry.inject, inject)
  assert.equal(entry.locale, 'chat')
  const view = entry.component(props)
  assert.equal(view.type, nativeUsage)
  assert.equal(view.props.useProjection('tokenUsage'), remoteUsage)
  assert.equal(view.props.useProjection('sessionStats'), original)
  remoteUsage.coverage = 'partial'
  const partial = entry.component(props)
  assert.equal(partial.type, 'span')
  assert.match(partial.props.title, /已报告用量.*可能尚未完整/)
  assert.equal(partial.children.length, 1)
  assert.equal(partial.children[0].type, nativeUsage)
  assert.equal(partial.children[0].props.useProjection('tokenUsage'), remoteUsage)
  remoteUsage.coverage = 'legacy'
  const legacy = entry.component(props)
  assert.match(legacy.props.title, /旧记录用量不完整/)
  assert.equal(legacy.children.length, 1)
  remoteUsage.coverage = 'complete'
  const tail = winner('conversation.chat.node', 'key', 'turn-tail')
  const tailView = tail.component(props)
  assert.equal(tailView.type, nativeTail)
  assert.equal(tailView.props.node.data.tokenUsage.totalTokens, 31809717)
  assert.equal(props.node.data.tokenUsage, original)
  assert.deepEqual(tail.options.children, { 'conversation.chat.turnTail': { kind: 'list', scope: 'session' } })
  remote = false
  assert.equal(entry.component(props).props.useProjection('tokenUsage'), original)
  assert.equal(tail.component(props).props.node, props.node)
  removeNative()
  assert.equal(ctx.slots.entries('conversation.composer.dock').length, 0)
  const replacement = () => {}
  removeNative = register({ name: 'conversation.composer.dock', id: 'usage', locale: 'chat', inject }, replacement)
  entry = winner('conversation.composer.dock', 'id', 'usage')
  assert.equal(entry.component(props).type, replacement)
  dispose()
  assert.equal(winner('conversation.composer.dock', 'id', 'usage').component, replacement)
  assert.ok([...listeners.values()].every(list => list.size === 0))
  removeNative()
})

test('速度复用原生统计组件，运行中采样即更新，旧会话缺数据不回退旧TPS', () => {
  const entries = [], listeners = new Map()
  const Native = () => {}
  const inject = () => ({ hooks: { performanceUsage: 'kept' } })
  entries.push({ options: { id: 'activity', order: 0 }, component: Native, locale: 'chat', inject })
  const ctx = { slots: {
    entries: key => key === 'conversation.composer.dock' ? entries : [],
    subscribe(key, callback) { listeners.set(key, callback); return () => listeners.delete(key) },
    register(options, component) {
      const entry = { options, component, inject: options.inject, locale: options.locale }
      entries.push(entry); listeners.get(options.name)?.()
      return () => { entries.splice(entries.indexOf(entry), 1); listeners.get(options.name)?.() }
    },
  } }
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const dispose = createUsageProjectionBridge({ React })(ctx)
  const wrapper = entries.find(entry => entry.component !== Native)
  assert.equal(wrapper.inject, inject)
  const native = { turns: 2, steps: 21, llmMs: 136685, toolMs: 189731,
    ttftMs: 7104, ttftSteps: 1, decodeTokens: 689, decodeMs: 362 }
  let remote = true, timing = null
  const props = { t: key => key, useProjection(key, selector) {
    const value = key === 'claudeBridge' ? remote ? {} : null
      : key === 'claudeBridgeResponseStats' ? timing : native
    return typeof selector === 'function' ? selector(value) : value
  } }
  const empty = wrapper.component(props)
  assert.equal(empty.type, Native)
  assert.deepEqual(empty.children, [])
  const zero = empty.props.useProjection('sessionStats')
  assert.deepEqual(zero, { turns: 2, steps: 21, llmMs: native.llmMs, toolMs: native.toolMs,
    ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 })
  timing = { ttftMs: 5000, ttftSteps: 2, decodeTokens: 1200, decodeMs: 6000,
    responseCount: 2, tpsSamples: 2 }
  const active = wrapper.component(props)
  assert.equal(active.props.useProjection('sessionStats').ttftMs, 5000)
  assert.equal(active.props.useProjection('sessionStats', state => state.decodeTokens), 1200)
  const ttftLabel = active.props.t('stats.dialog.ttft'), tpsLabel = active.props.t('stats.dialog.speed')
  assert.equal(ttftLabel.type, 'span')
  assert.equal(ttftLabel.children[0], '首 Token 平均（TTFT）')
  assert.equal(tpsLabel.children[0], '接收速度（TPS）')
  assert.match(ttftLabel.props.title, /SDK 首帧时长.*远端同机.*首个有效输出.*平均/)
  assert.match(ttftLabel.props.title, /非空正文、思考和工具参数 JSON 增量.*排除开始帧、心跳、签名和工具名/)
  assert.match(ttftLabel.props.title, /SDK 缓冲与调度误差.*非精确上游计时.*2\/2/)
  assert.match(tpsLabel.props.title, /同一完整响应的输出 Token.*原始 SDK message_start.*最后有效内容帧/)
  assert.match(tpsLabel.props.title, /汇总后计算接收速度.*本机观察窗口.*思考阶段和缓冲影响.*不代表上游生成测速.*2\/2/)
  assert.equal(active.props.t('stats.dialog.title'), 'stats.dialog.title')
  // Each metric reports its own coverage; an absent channel cannot revive native values.
  timing = { ttftMs: 2500, ttftSteps: 1, responseCount: 3 }
  const ttftOnly = wrapper.component(props)
  assert.equal(ttftOnly.type, Native)
  assert.deepEqual(ttftOnly.children, [])
  assert.equal(ttftOnly.props.useProjection('sessionStats').decodeTokens, 0)
  assert.match(ttftOnly.props.t('stats.dialog.ttft').props.title, /1\/3/)
  assert.match(ttftOnly.props.t('stats.dialog.speed').props.title, /0\/3/)
  timing = { decodeTokens: 1200, decodeMs: 6000, tpsSamples: 2, responseCount: 3 }
  const tpsOnly = wrapper.component(props)
  assert.equal(tpsOnly.props.useProjection('sessionStats').ttftMs, 0)
  assert.equal(tpsOnly.props.useProjection('sessionStats').ttftSteps, 0)
  assert.match(tpsOnly.props.t('stats.dialog.ttft').props.title, /0\/3/)
  assert.match(tpsOnly.props.t('stats.dialog.speed').props.title, /2\/3/)
  remote = false
  assert.equal(wrapper.component(props).props, props)
  dispose()
  assert.equal(entries.length, 1)
})
