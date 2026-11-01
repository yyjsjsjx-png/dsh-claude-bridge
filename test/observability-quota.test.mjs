import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createQuotaCoordinator } from '../remote/observability-quota.mjs'
import { normalizeObservabilityRecord } from '../src/observability-schema.mjs'

const start = 1_800_000_000_000
const snapshot = (at = start) => ({ status: 'available', source: 'sdk-plan-usage', observedAt: at,
  expiresAt: at + 120_000, windows: [{ id: 'five_hour', name: '5 小时', scope: 'session',
    usedPercent: 7, resetsAt: at + 3_600_000 }] })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('all request reasons share cooldown while cache freshness keeps original observedAt', async () => {
  let now = start, calls = 0
  const observations = []
  const coordinator = createQuotaCoordinator({ now: () => now,
    fetchUsage: async () => { calls++; return snapshot(now) }, onObservation: row => observations.push(row) })
  assert.equal(coordinator.peek().snapshot, null)
  assert.equal(calls, 0)
  assert.equal((await coordinator.request()).active, false)
  assert.equal(calls, 0)
  coordinator.setActive('device-a:run-a', true)
  assert.equal((await coordinator.request()).fresh, true)
  now += 120_001
  const stale = await coordinator.request({ reason: 'run-start' })
  assert.equal(stale.fresh, false)
  assert.equal(stale.lastObservedAt, start)
  assert.equal(stale.snapshot.observedAt, start)
  assert.equal(coordinator.setActive('device-b:run-b', true), true)
  assert.equal(calls, 1)
  assert.equal(observations.length, 1)
  assert.doesNotThrow(() => normalizeObservabilityRecord('quota', observations[0]))
  now = start + 300_000
  assert.equal((await coordinator.request({ reason: 'run-end' })).lastObservedAt, now)
  assert.equal(calls, 2)
  assert.equal(observations.length, 2)
  await coordinator.close()
})

test('singleflight caller cancellation does not cancel another device waiter', async () => {
  const raw = deferred(), abort = new AbortController(), observations = []
  let calls = 0, sharedSignal
  const coordinator = createQuotaCoordinator({ now: () => start,
    fetchUsage: ({ signal }) => { calls++; sharedSignal = signal; return raw.promise },
    onObservation: row => observations.push(row) })
  coordinator.setActive('device-a:run-a', true)
  const first = coordinator.request({ signal: abort.signal })
  const second = coordinator.request({ reason: 'run-start' })
  await Promise.resolve()
  abort.abort()
  assert.equal((await first).error.code, 'CANCELLED')
  assert.equal(sharedSignal.aborted, false)
  raw.resolve(snapshot())
  assert.equal((await second).fresh, true)
  assert.equal(calls, 1)
  assert.equal(observations.length, 1)
  await coordinator.close()
})

test('failed reads back off and retryAfter applies to manual requests', async () => {
  let now = start, calls = 0
  const observations = []
  const coordinator = createQuotaCoordinator({ now: () => now,
    fetchUsage: async () => { calls++; return { status: 'unavailable', code: 'RATE_LIMITED', retryAfterMs: 700_000 } },
    onObservation: row => observations.push(row) })
  coordinator.setActive('device-a:run-a', true)
  let result = await coordinator.request()
  assert.equal(result.error.code, 'RATE_LIMITED')
  assert.equal(result.nextAllowedAt, start + 700_000)
  now += 300_000
  await coordinator.request(); assert.equal(calls, 1)
  now = start + 700_000
  result = await coordinator.request()
  assert.equal(calls, 2)
  assert.equal(result.nextAllowedAt, now + 700_000)
  assert.equal(observations.length, 2)
  assert.ok(observations.every(row => row.snapshot === undefined))
  await coordinator.close()
})

test('timeout holds actual flight gate, ignores late result, and exposes fixed gap diagnostics', async () => {
  let now = start, calls = 0
  const raw = deferred(), observations = [], diagnostics = []
  const coordinator = createQuotaCoordinator({ now: () => now, timeoutMs: 10,
    fetchUsage: () => { calls++; return raw.promise }, onObservation: row => observations.push(row),
    onDiagnostic: row => diagnostics.push(row) })
  coordinator.setActive('device-a:run-a', true)
  const result = await coordinator.request()
  assert.equal(result.error.code, 'QUOTA_TIMEOUT')
  assert.equal(result.inFlight, true)
  now += 900_000
  await coordinator.request()
  assert.equal(calls, 1)
  raw.resolve(snapshot(now))
  await delay(0)
  assert.equal(coordinator.peek().inFlight, false)
  assert.equal(coordinator.peek().snapshot, null)
  assert.equal(observations.length, 1)
  assert.deepEqual(diagnostics, [{ code: 'QUOTA_TIMEOUT', gap: false }])
  await coordinator.close()
})

test('cached raw-reader replay is not a successful new observation and close prevents queued fetch', async () => {
  let now = start
  const observations = []
  const coordinator = createQuotaCoordinator({ now: () => now, fetchUsage: async () => snapshot(),
    onObservation: row => observations.push(row) })
  coordinator.setActive('device-a:run-a', true)
  await coordinator.request()
  now += 300_000
  const replay = await coordinator.request()
  assert.equal(replay.error.code, 'QUOTA_STALE_OBSERVATION')
  assert.equal(replay.lastObservedAt, start)
  assert.equal(replay.snapshot.observedAt, start)
  assert.equal(observations[1].status, 'unavailable')
  await coordinator.close()
  let calls = 0
  const closed = createQuotaCoordinator({ now: () => now,
    fetchUsage: async () => { calls++; return snapshot(now) }, onObservation: () => false })
  closed.setActive('device-a:run-a', true)
  const request = closed.request()
  await closed.close()
  assert.equal((await request).error.code, 'QUOTA_CLOSED')
  await delay(0)
  assert.equal(calls, 0)
})

test('two active runs share one account timer and the last inactive run stops polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start })
  let calls = 0
  const observations = []
  const coordinator = createQuotaCoordinator({ fetchUsage: async () => { calls++; return snapshot(Date.now()) },
    onObservation: row => observations.push(row) })
  t.after(() => coordinator.close())
  const tick = async ms => { t.mock.timers.tick(ms); for (let n = 0; n < 6; n++) await Promise.resolve() }
  await coordinator.request()
  await tick(900_000)
  assert.equal(calls, 0)
  coordinator.setActive('device-a:run-a', true)
  coordinator.setActive('device-b:run-b', true)
  await tick(0)
  assert.equal(calls, 1)
  assert.equal(coordinator.peek().activeCount, 2)
  await tick(299_999)
  assert.equal(calls, 1)
  await tick(1)
  assert.equal(calls, 2)
  coordinator.setActive('device-a:run-a', false)
  await tick(300_000)
  assert.equal(calls, 3)
  coordinator.setActive('device-b:run-b', false)
  assert.equal(coordinator.peek().active, false)
  await tick(900_000)
  const idle = await coordinator.request()
  assert.equal(calls, 3)
  assert.equal(observations.length, 3)
  assert.equal(idle.active, false)
  assert.equal(idle.fresh, false)
})

test('a run ending before detached sampling starts makes no read or observation', async () => {
  let calls = 0
  const observations = []
  const coordinator = createQuotaCoordinator({ now: () => start,
    fetchUsage: async () => { calls++; return snapshot() }, onObservation: row => observations.push(row) })
  coordinator.setActive('device-a:run-a', true)
  coordinator.setActive('device-a:run-a', false)
  await delay(0)
  assert.equal(calls, 0)
  assert.equal(observations.length, 0)
  assert.equal((await coordinator.request()).active, false)
  coordinator.setActive('device-a:run-b', true)
  await coordinator.request()
  assert.equal(calls, 1)
  await coordinator.close()
})

test('close removes the active timer and neither stale ticks nor reads can restart sampling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start })
  let calls = 0
  const coordinator = createQuotaCoordinator({ fetchUsage: async () => { calls++; return snapshot(Date.now()) } })
  coordinator.setActive('worker-a:run-a', true)
  await coordinator.request()
  assert.equal(calls, 1)
  await coordinator.close()
  assert.equal(coordinator.setActive('worker-b:run-b', true), false)
  t.mock.timers.tick(900_000)
  for (let n = 0; n < 6; n++) await Promise.resolve()
  const result = await coordinator.request()
  assert.equal(result.error.code, 'QUOTA_CLOSED')
  assert.equal(result.active, false)
  assert.equal(result.activeCount, 0)
  assert.equal(calls, 1)
})
