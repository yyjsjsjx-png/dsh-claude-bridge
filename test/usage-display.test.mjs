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

test('只在原生TTFT行采用客户端接收均值，覆盖清晰且不混SDK，TPS和普通会话保留', () => {
  const entries = [], listeners = new Map(), Native = () => {}, Assistant = () => {};
  const inject = sessionId => ({ hooks: { performanceUsage: 'kept' }, nativeIdentity: sessionId });
  entries.push({ slot: 'conversation.composer.dock', options: { id: 'activity' }, component: Native, locale: 'chat', inject },
    { slot: 'conversation.chat.node', options: { key: 'assistant-step' }, component: Assistant, locale: 'chat', inject });
  const ctx = { slots: {
    entries: key => entries.filter(row => row.slot === key),
    subscribe(key, fn) { listeners.set(key, fn); return () => listeners.delete(key); },
    register(options, component) {
      const entry = { slot: options.name, options, component, inject: options.inject, locale: options.locale };
      entries.push(entry); listeners.get(options.name)?.();
      return () => { entries.splice(entries.indexOf(entry), 1); listeners.get(options.name)?.(); };
    },
  } };
  let client = { submissions: 0, samples: 0, totalMs: 0, unknown: 0, pending: 0 };
  const store = { subscribe: () => () => {}, getSnapshot: () => client };
  const React = { createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
  const dispose = createUsageProjectionBridge({ React, getClientTiming: () => ({ getStore: id => {
    assert.equal(id, 's'); return store;
  } }) })(ctx);
  const wrapper = entries.find(row => row.slot === 'conversation.composer.dock' && row.component !== Native);
  assert.deepEqual(wrapper.inject('s'), { hooks: { performanceUsage: 'kept' }, nativeIdentity: 's', clientTimingSessionId: 's' });
  assert.equal(entries.filter(row => row.options.key === 'assistant-step').length, 1);
  assert.equal(entries.find(row => row.options.key === 'assistant-step').component, Assistant);
  const native = { turns: 7, steps: 17, llmMs: 3000, toolMs: 1000, ttftMs: 99999, ttftSteps: 7 };
  let remote = true, sdk = { ttftMs: 5000, ttftSteps: 2, responseCount: 3, decodeTokens: 1200, decodeMs: 6000, tpsSamples: 2 };
  const props = { clientTimingSessionId: 's', t: key => key, useProjection(key, selector) {
    const value = key === 'claudeBridge' ? remote ? {} : null
      : key === 'claudeBridgeResponseStats' ? sdk : native;
    return typeof selector === 'function' ? selector(value) : value;
  } };
  let view = wrapper.component(props);
  assert.equal(view.type, Native); assert.deepEqual(view.children, []);
  assert.equal(view.props.useProjection('sessionStats').ttftSteps, 0);
  assert.equal(view.props.useProjection('sessionStats').ttftMs, 0);
  assert.match(view.props.t('stats.dialog.ttft').props.title, /当前窗口提交 0 次.*SDK 估算仍单独保留.*2\/3/);
  client = { submissions: 6, samples: 6, totalMs: 21000, unknown: 0, pending: 0 };
  view = wrapper.component(props);
  assert.deepEqual(view.props.useProjection('sessionStats'), { turns: 7, steps: 17, llmMs: 3000, toolMs: 1000,
    ttftMs: 21000, ttftSteps: 6, decodeTokens: 1200, decodeMs: 6000 });
  assert.equal(view.props.useProjection('sessionStats', row => row.ttftMs / row.ttftSteps), 3500);
  const label = view.props.t('stats.dialog.ttft');
  assert.equal(label.type, 'span'); assert.equal(label.children[0], '首 Token 平均（TTFT）');
  assert.match(label.props.title, /客户端提交.*ClientSession 接收处理.*不是像素绘制/);
  assert.match(label.props.title, /提交 6 次，有效 6 次.*不混入 SDK/);
  assert.match(view.props.t('stats.dialog.speed').props.title, /2\/3/);
  assert.equal(view.props.t('stats.dialog.title'), 'stats.dialog.title');
  client = { ...client, submissions: 8, unknown: 1, pending: 1 };
  sdk = { responseCount: 9, ttftMs: 30000, ttftSteps: 8 };
  view = wrapper.component(props);
  assert.equal(view.props.useProjection('sessionStats').ttftMs, 21000);
  assert.equal(view.props.useProjection('sessionStats').decodeTokens, 0);
  assert.match(view.props.t('stats.dialog.ttft').props.title, /提交 8 次，有效 6 次，不可测 1 次，待完成 1 次/);
  assert.match(view.props.t('stats.dialog.speed').props.title, /0\/9/);
  remote = false;
  assert.equal(wrapper.component(props).props, props);
  dispose(); assert.equal(entries.length, 2);
});
