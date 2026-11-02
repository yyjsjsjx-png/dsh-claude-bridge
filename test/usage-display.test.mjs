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

test('始终委托原生统计使用SDK计时，不读取旧客户端观察器或包装助手视图', () => {
  const Native = () => {}, Assistant = () => {}, entries = [], callbacks = new Map()
  const inject = () => ({ native: true })
  entries.push({ slot: 'conversation.composer.dock', options: { id: 'activity' }, locale: 'chat', inject, component: Native },
    { slot: 'conversation.chat.node', options: { key: 'assistant-step' }, locale: 'chat', inject, component: Assistant })
  const ctx = { slots: {
    entries: name => entries.filter(entry => entry.slot === name),
    subscribe(name, fn) { callbacks.set(name, fn); return () => callbacks.delete(name) },
    register(options, component) {
      const entry = { slot: options.name, options, component, locale: options.locale, inject: options.inject }
      entries.push(entry); callbacks.get(options.name)?.()
      return () => { entries.splice(entries.indexOf(entry), 1); callbacks.get(options.name)?.() }
    },
  } }
  const dispose = createUsageProjectionBridge({
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    createClientFirstOutput: () => assert.fail('不再创建客户端计时观察器'),
  })(ctx)
  const wrapper = entries.find(entry => entry.slot === 'conversation.composer.dock' && entry.component !== Native)
  assert.equal(wrapper.inject, inject)
  assert.equal(entries.filter(entry => entry.options.key === 'assistant-step').length, 1)
  assert.equal(entries.find(entry => entry.options.key === 'assistant-step').component, Assistant)
  const measured = { ttftMs: 148, ttftSteps: 4, responseCount: 17, decodeMs: 1000, decodeTokens: 20, tpsSamples: 4 }
  let remote = true
  const props = { t: key => key, clientFirstOutput: {
    subscribe: () => assert.fail('不再订阅旧客户端计时'), getSnapshot: () => assert.fail('不再读取旧客户端计时'),
  }, useProjection(key) {
    if (key === 'claudeBridge') return remote ? {} : null
    if (key === 'claudeBridgeResponseStats') return measured
    return { turns: 7, steps: 17, llmMs: 3000, toolMs: 1000, ttftMs: 6103, ttftSteps: 1, decodeMs: 250, decodeTokens: 500 }
  } }
  const view = wrapper.component(props)
  assert.equal(view.type, Native)
  assert.deepEqual(view.children, [])
  assert.deepEqual(view.props.useProjection('sessionStats'), { turns: 7, steps: 17, llmMs: 3000, toolMs: 1000,
    ttftMs: 148, ttftSteps: 4, decodeMs: 1000, decodeTokens: 20 })
  assert.equal(view.props.useProjection('sessionStats').ttftMs / view.props.useProjection('sessionStats').ttftSteps, 37)
  assert.match(view.props.t('stats.dialog.ttft').props.title, /SDK 首帧时长.*4\/17/)
  assert.doesNotMatch(view.props.t('stats.dialog.ttft').props.title, /客户端|双帧/)
  remote = false
  assert.equal(wrapper.component(props).props, props)
  dispose()
  assert.equal(entries.length, 2)
})
