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
