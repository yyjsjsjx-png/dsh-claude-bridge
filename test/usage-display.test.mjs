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
  assert.equal(ttftLabel.children[0], 'stats.dialog.ttft')
  assert.equal(tpsLabel.children[0], '接收速度（TPS）')
  assert.match(ttftLabel.props.title, /客户端观察不可用或暂无样本，当前显示 SDK 首有效输出/)
  assert.match(ttftLabel.props.title, /独立 SDK 首有效输出均值：2.5 s，2\/2/)
  assert.match(ttftLabel.props.title, /包含缓冲与调度误差.*非精确上游计时.*两套分母独立.*不混合平均/)
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

test('原生TTFT只映射客户端均值，无样本明确回退SDK，原生布局及其它数字源保留', () => {
  const Native = () => {}, NativeAssistant = () => {}, entries = [], callbacks = new Map(), calls = []
  const nativeInject = id => ({ nativeSession: id })
  entries.push({ options: { id: 'activity' }, locale: 'chat', inject: nativeInject, component: Native, slot: 'conversation.composer.dock' },
    { options: { key: 'assistant-step' }, locale: 'chat', inject: nativeInject, component: NativeAssistant, slot: 'conversation.chat.node' })
  const session = {}, scope = {}
  let snapshot = { version: 1, submissions: 3, samples: 2, totalMs: 440 }, disposed = false
  const observer = { subscribe: () => () => {}, getSnapshot: () => snapshot }
  const ctx = { sessions: { binding: id => id === 'session' ? { session, ctx: scope } : undefined }, slots: {
    entries: name => entries.filter(entry => entry.slot === name),
    subscribe(name, fn) { callbacks.set(name, fn); return () => callbacks.delete(name) },
    register(options, component) {
      const entry = { options, component, inject: options.inject, locale: options.locale, slot: options.name }
      entries.push(entry); callbacks.get(options.name)?.()
      return () => { entries.splice(entries.indexOf(entry), 1); callbacks.get(options.name)?.() }
    },
  } }
  const React = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useSyncExternalStore: (_subscribe, get) => get() }
  const dispose = createUsageProjectionBridge({ React,
    createPortal: () => assert.fail('统计界面必须由NativeUsage绘制'),
    useAnchoredPosition: () => assert.fail('不得自制浮层'), useDismissOnOutsidePointer: () => assert.fail('不得自制浮层'),
    createClientFirstOutput: () => ({ bind(...args) { calls.push(args); return observer }, dispose() { disposed = true } }),
  })(ctx)
  try {
    const activity = entries.find(entry => entry.slot === 'conversation.composer.dock' && entry.component !== Native)
    const injection = activity.inject('session')
    assert.equal(injection.nativeSession, 'session')
    assert.equal(injection.clientFirstOutput, observer)
    assert.deepEqual(calls[0], ['session', session, scope])
    let remote = true, mode = 'standard'
    let measured = { responseCount: 5, ttftMs: 148, ttftSteps: 4, decodeMs: 1000, decodeTokens: 20, tpsSamples: 3 }
    const props = { ...injection, usePerformanceUsage: () => mode, t: key => key,
      useProjection(key) {
        if (key === 'claudeBridge') return remote ? {} : null
        if (key === 'claudeBridgeResponseStats') return measured
        return { turns: 2, steps: 7, llmMs: 3000, toolMs: 1000, ttftMs: 9999, ttftSteps: 9,
          decodeMs: 250, decodeTokens: 500 }
      },
    }
    const render = () => {
      const view = activity.component(props)
      assert.equal(view.type, Native)
      assert.deepEqual(view.children, []) // No bridge button, portal, icon or layout.
      assert.equal(view.props.usePerformanceUsage, props.usePerformanceUsage)
      assert.equal(view.props.t('stats.dialog.title'), 'stats.dialog.title')
      return view
    }
    let view = render(), stats = view.props.useProjection('sessionStats')
    assert.deepEqual(stats, { turns: 2, steps: 7, llmMs: 3000, toolMs: 1000,
      ttftMs: 440, ttftSteps: 2, decodeMs: 1000, decodeTokens: 20 })
    assert.equal(stats.ttftMs / stats.ttftSteps, 220)
    assert.equal(view.props.useProjection('sessionStats', value => value.ttftMs), 440)
    assert.equal(view.props.useProjection('claudeBridgeResponseStats'), measured)
    let label = view.props.t('stats.dialog.ttft')
    assert.equal(label.children[0], 'stats.dialog.ttft') // Original native locale text.
    assert.match(label.props.title, /当前显示客户端首字显示（观察）.*客户端 2\/3/)
    assert.match(label.props.title, /独立 SDK 首有效输出均值：37 ms，4\/5.*两套分母独立/)
    snapshot = { version: 1, submissions: 1, samples: 0, totalMs: 0 }
    view = render(); stats = view.props.useProjection('sessionStats')
    assert.equal(stats.ttftMs, 148)
    assert.equal(stats.ttftSteps, 4)
    assert.match(view.props.t('stats.dialog.ttft').props.title, /暂无样本，当前显示 SDK.*客户端 0\/1/)
    measured = null
    view = render(); stats = view.props.useProjection('sessionStats')
    assert.equal(stats.ttftMs, 0)
    assert.equal(stats.ttftSteps, 0) // No fake divisor; native rc5 omits an unknown row.
    assert.match(view.props.t('stats.dialog.ttft').props.title, /SDK 首有效输出均值：未知.*均无证据时为未知/)
    measured = { responseCount: 5, ttftMs: 148, ttftSteps: 4, decodeMs: 1000, decodeTokens: 20, tpsSamples: 3 }
    delete props.clientFirstOutput
    assert.equal(render().props.useProjection('sessionStats').ttftMs, 148)
    assert.match(render().props.t('stats.dialog.ttft').props.title, /当前显示 SDK.*客户端 0\/0/)
    mode = 'compact'
    assert.equal(render().type, Native)
    remote = false
    assert.equal(activity.component(props).type, Native)
    assert.equal(activity.component(props).props, props)
    const assistant = entries.find(entry => entry.slot === 'conversation.chat.node' && entry.component !== NativeAssistant)
    assert.equal(assistant.component(props).type, NativeAssistant)
    assert.equal(assistant.component(props).props, props)
  } finally { dispose() }
  assert.equal(disposed, true)
  assert.equal(entries.length, 2)
})
