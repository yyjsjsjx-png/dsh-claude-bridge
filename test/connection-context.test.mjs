import test from 'node:test'
import assert from 'node:assert/strict'
import { ConnectionContext } from '../src/connection-context.mjs'

test('配置失效取消旧初始化，迟到结果和旧清理不能替换新连接', () => {
  const context = new ConnectionContext()
  const old = context.capture(), oldPending = Promise.resolve()
  let acceptedDuringAbort
  old.signal.addEventListener('abort', () => { acceptedDuringAbort = context.bind(old, {}) })
  context.track(oldPending)
  const previous = context.invalidate()
  assert.equal(previous.pending, oldPending)
  assert.equal(old.signal.aborted, true)
  assert.equal(acceptedDuringAbort, false)
  const current = context.capture(), transport = {}
  const newPending = Promise.resolve()
  context.track(newPending)
  context.completeInitialization(current, { capabilities: { historySync: true } })
  context.bind(current, transport)
  context.untrack(oldPending)
  assert.equal(context.pending, newPending)
  assert.equal(context.completeInitialization(old, { capabilities: {} }), false)
  assert.equal(context.bind(old, {}), false)
  assert.equal(context.disconnected(old, {}), false)
  assert.equal(context.transport, transport)
  assert.equal(context.initialized.capabilities.historySync, true)
})

test('同配置的新连接不接受旧 transport 关闭，关闭后初始化信息仍可用于状态展示', () => {
  const context = new ConnectionContext(), identity = context.capture()
  const old = {}, current = {}, initialized = { authenticated: true }
  context.completeInitialization(identity, initialized)
  context.bind(identity, old)
  assert.equal(context.disconnected(identity, old), true)
  context.bind(identity, current)
  assert.equal(context.disconnected(identity, old), false)
  assert.equal(context.current(identity, current), true)
  assert.equal(context.disconnected(identity, current), true)
  assert.equal(context.initialized, initialized)
  context.retire()
  assert.equal(identity.signal.aborted, true)
  assert.equal(context.bind(identity, old), false)
})
