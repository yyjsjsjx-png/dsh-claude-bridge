import test from 'node:test'
import assert from 'node:assert/strict'
import { SocketAttempt, WorkerSocketLease } from '../remote/socket-lifecycle.mjs'

// Retain callbacks after clear to exercise timers that were already queued.
function scheduledCallbacks(t) {
  const scheduled = []
  const schedule = callback => {
    const handle = { unref() {} }
    scheduled.push(callback)
    return handle
  }
  t.mock.method(globalThis, 'setTimeout', schedule)
  t.mock.method(globalThis, 'setInterval', schedule)
  t.mock.method(globalThis, 'clearTimeout', () => {})
  t.mock.method(globalThis, 'clearInterval', () => {})
  return scheduled
}

test('认证和恢复计时器取消后排队回调无效，心跳只使用当前尝试的活动时间', t => {
  const scheduled = scheduledCallbacks(t), events = []
  let now = 100
  t.mock.method(Date, 'now', () => now)
  const attempt = new SocketAttempt({}, 'loopback')
  attempt.authenticateWithin(10, () => events.push('auth'))
  const auth = scheduled.at(-1)
  attempt.authenticated()
  auth()
  attempt.recoverWithin(10, () => events.push('recovery'))
  const recovery = scheduled.at(-1)
  attempt.recoveryReady({ intervalMs: 10, timeoutMs: 30, onTimeout: () => events.push('heartbeat') })
  const heartbeat = scheduled.at(-1)
  recovery()
  now = 120; heartbeat()
  attempt.heard()
  now = 140; heartbeat()
  assert.deepEqual(events, [])
  now = 150; heartbeat()
  assert.deepEqual(events, ['heartbeat'])
  attempt.dispose(); attempt.dispose()
  now = 200; auth(); recovery(); heartbeat()
  assert.deepEqual(events, ['heartbeat'])
})

test('换绑及转移使旧尝试和旧保留回调失效，不关闭新尝试', t => {
  const scheduled = scheduledCallbacks(t), events = []
  const lease = new WorkerSocketLease(), donor = new WorkerSocketLease()
  const oldSocket = {}, old = new SocketAttempt(oldSocket, 'old')
  lease.bind(old)
  old.recoverWithin(10, () => events.push('old-handshake'))
  const oldHandshake = scheduled.at(-1)
  assert.equal(lease.detach(old), true)
  lease.retain(10, () => events.push('old-retention'))
  const oldRetention = scheduled.at(-1)
  const nextSocket = {}, next = new SocketAttempt(nextSocket, 'next')
  donor.bind(next)
  assert.equal(lease.bind(next), oldSocket)
  assert.equal(donor.attempt, undefined)
  assert.equal(lease.socket, nextSocket)
  assert.equal(lease.isCurrent(old), false)
  assert.equal(lease.isCurrent(next), true)
  assert.equal(lease.detach(old), false)
  oldHandshake(); oldRetention()
  assert.deepEqual(events, [])
  assert.equal(next.active, true)
  lease.dispose()
})

test('断开尝试虽已失效，原租约仍按首个保留窗口到期且清理幂等', t => {
  const scheduled = scheduledCallbacks(t), events = []
  const lease = new WorkerSocketLease(), attempt = new SocketAttempt({}, 'loopback')
  lease.bind(attempt)
  assert.equal(lease.detach(attempt), true)
  assert.equal(lease.isCurrent(attempt), false)
  assert.equal(lease.retain(10, () => events.push('expired')), true)
  assert.equal(lease.detach(attempt), false)
  assert.equal(lease.retain(20, () => events.push('renewed')), false)
  assert.equal(scheduled.length, 1)
  scheduled[0](); scheduled[0]()
  assert.deepEqual(events, ['expired'])
  lease.retain(10, () => events.push('after-dispose'))
  lease.dispose(); lease.dispose()
  scheduled.at(-1)()
  assert.deepEqual(events, ['expired'])
})
