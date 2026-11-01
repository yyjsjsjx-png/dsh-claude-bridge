import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createObservabilityLedger } from '../remote/observability-ledger.mjs'

const at = 1_800_000_000_000
const scope = { from: at - 1, to: at + 100_000 }
const common = { version: 1, deviceId: 'synthetic-device', dshSessionId: 'synthetic-dsh',
  sdkSessionId: 'synthetic-sdk', model: 'synthetic-model' }
const run = (runId, observedAt, extra = {}) => ({ ...common, runId, observedAt,
  kind: 'query', status: 'completed', ...extra })
const tokens = (scope = 'current-turn-main-agent') => ({ scope, uncachedInputTokens: 2,
  outputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 3 })
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-observability-'))
  const diagnostics = []
  const ledger = createObservabilityLedger({ directory, onDiagnostic: value => diagnostics.push(value), ...options })
  t.after(async () => { await ledger.close(); await rm(directory, { recursive: true, force: true }) })
  assert.equal(await ledger.ready, true)
  return { ledger, directory, diagnostics }
}

test('durable identities replace observations and sum only main-agent run usage', async t => {
  const { ledger, directory } = await fixture(t)
  assert.equal(ledger.recordRun(run('run-a', at, { status: 'unknown', model: 'unknown' })), true)
  const final = run('run-a', at + 1, { usage: tokens() })
  assert.equal(ledger.recordRun(final), true)
  ledger.recordRun(final)
  ledger.recordRun(run('run-a', at + 2, { status: 'unknown' }))
  ledger.recordRun(run('run-cancel', at + 3, { status: 'cancelled' }))
  ledger.recordRun(run('run-compact', at + 4, { kind: 'compact' }))
  const response = { ...common, runId: 'run-a', responseId: 'response-a', observedAt: at,
    usage: tokens('response-main-agent') }
  ledger.recordResponse(response); ledger.recordResponse(response)
  const timing = { ...common, runId: 'run-a', observedAt: at, level: 'response', responseId: 'response-a',
    side: 'upstream', metric: 'first-output', quality: 'unknown', clock: 'unknown', source: 'sdk-first-output' }
  ledger.recordTiming(timing)
  ledger.recordTiming({ ...timing, observedAt: at + 1, quality: 'estimate', clock: 'remote-monotonic', durationMs: 25 })
  assert.equal((await ledger.flush()).status, 'ok')
  const summary = await ledger.summarize({ ...scope, groupBy: 'model' })
  assert.equal(summary.status, 'ok')
  assert.equal(summary.totals.runs, 3)
  assert.equal(summary.totals.knownUsageRuns, 1)
  assert.equal(summary.totals.unknownUsageRuns, 2)
  assert.deepEqual(summary.totals.usage, tokens())
  assert.equal(summary.totals.cost.knownDeltaUsd, null)
  assert.equal(summary.timing[0].samples, 1)
  const rows = (await ledger.query(scope)).rows
  assert.equal(rows[0].status, 'completed')
  assert.equal(rows[0].model, 'synthetic-model')
  assert.equal((await ledger.query({ ...scope, kind: 'responses' })).rows.length, 1)
  assert.equal((await ledger.query({ ...scope, kind: 'timing' })).rows[0].durationMs, 25)
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(join(directory, 'observability.sqlite'))).mode & 0o777, 0o600)
  }
  await ledger.close()
  const reopened = createObservabilityLedger({ directory })
  t.after(() => reopened.close())
  assert.equal(await reopened.ready, true)
  assert.equal((await reopened.query(scope)).rows.length, 3)
  await reopened.close()
})

test('session cumulative cost keeps baseline, reset and ordering uncertainty', async t => {
  const { ledger } = await fixture(t)
  const record = (id, time, cost) => ledger.recordRun(run(id, at + time,
    { cumulativeCostUsd: cost, costScope: 'session-cumulative-estimate' }))
  record('b', 20, 3); record('a', 10, 1); record('c', 30, 0.5); record('d', 40, 0.75)
  record('e', 50, 1); record('f', 50, 1.5); record('g', 60, 2)
  await ledger.flush()
  let rows = (await ledger.query(scope)).rows
  assert.deepEqual(rows.map(row => row.costDeltaStatus),
    ['baseline-missing', 'known', 'counter-reset', 'known', 'ambiguous-order', 'ambiguous-order', 'baseline-missing'])
  assert.deepEqual(rows.map(row => row.costDeltaUsd), [null, 2, null, 0.25, null, null, null])
  ledger.recordRun(run('b', at + 70, { usage: tokens() }))
  await ledger.flush()
  rows = (await ledger.query(scope)).rows
  const b = rows.find(row => row.runId === 'b')
  assert.equal(b.costObservedAt, at + 20)
  assert.equal(b.cumulativeCostUsd, 3)
  assert.equal(b.costDeltaUsd, 2)
  assert.equal((await ledger.summarize(scope)).totals.cost.knownDeltaUsd, 2.25)
})

test('whitelist validation and bounded queries never accept arbitrary payloads', async t => {
  const { ledger, diagnostics } = await fixture(t)
  assert.equal(ledger.recordRun(run('a', at, { text: 'synthetic forbidden body' })), false)
  assert.equal(ledger.recordRun(run('a', at, { model: 'https://example.invalid' })), false)
  assert.equal(ledger.recordRun(run('a', at, { usage: { ...tokens(), scope: 'session-cumulative' } })), false)
  assert.equal((await ledger.query({ ...scope, limit: 501 })).code, 'OBSERVABILITY_INVALID_FILTER')
  assert.equal((await ledger.query({ from: at, to: at + 367 * 86400000 })).code, 'OBSERVABILITY_INVALID_FILTER')
  assert.equal((await ledger.summarize({ ...scope, sql: 'SELECT 1' })).code, 'OBSERVABILITY_INVALID_FILTER')
  assert.equal(diagnostics.length, 3)
  assert.ok(diagnostics.every(row => row.code === 'OBSERVABILITY_INVALID_RECORD' && row.gap === true))
  assert.equal((await ledger.summarize(scope)).totals.usage, null)
})

test('queue overflow is visible and close drains accepted writes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-observability-'))
  const diagnostics = []
  const ledger = createObservabilityLedger({ directory, maxQueue: 1, onDiagnostic: row => diagnostics.push(row) })
  t.after(async () => { await ledger.close(); await rm(directory, { recursive: true, force: true }) })
  assert.equal(ledger.recordRun(run('accepted', at)), true)
  assert.equal(ledger.recordRun(run('overflow', at)), false)
  assert.equal((await ledger.close()).status, 'ok')
  assert.equal(ledger.status().dropped, 1)
  assert.ok(diagnostics.some(row => row.code === 'OBSERVABILITY_QUEUE_FULL' && row.gap))
  const reopened = createObservabilityLedger({ directory })
  t.after(() => reopened.close())
  assert.equal(await reopened.ready, true)
  assert.deepEqual((await reopened.query(scope)).rows.map(row => row.runId), ['accepted'])
  await reopened.close()
})

test('short SQLite lock failure reports a gap and does not poison later writes', async t => {
  const { ledger, directory, diagnostics } = await fixture(t, { busyTimeoutMs: 10 })
  const lock = new DatabaseSync(join(directory, 'observability.sqlite'))
  let lockClosed = false
  t.after(() => { if (!lockClosed) lock.close() })
  lock.exec('BEGIN IMMEDIATE')
  assert.equal(ledger.recordRun(run('locked', at)), true)
  assert.equal((await ledger.flush()).status, 'ok')
  assert.ok(diagnostics.some(row => row.code === 'OBSERVABILITY_STORAGE_UNAVAILABLE' && row.gap))
  lock.exec('ROLLBACK')
  assert.equal(ledger.recordRun(run('later', at + 1)), true)
  await ledger.flush()
  assert.deepEqual((await ledger.query(scope)).rows.map(row => row.runId), ['later'])
  lock.close(); lockClosed = true
})
