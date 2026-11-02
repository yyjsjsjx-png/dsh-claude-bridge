import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientTimingRecorder } from '../src/client-timing-diagnostics.mjs'
import { diagnosticRecord } from '../src/diagnostics.mjs'

test('客户端接收诊断严格校验、限制远程会话并有界去重，不打开连接', () => {
  const rows = []
  const record = createClientTimingRecorder({ isRemoteSession: id => id === 'remote', limit: 2,
    record: (event, fields) => rows.push(diagnosticRecord(event, fields)) })
  const base = { version: 1, sessionId: 'remote', requestId: 'r1', source: 'client-session-receive',
    clock: 'client-monotonic', metric: 'submission', quality: 'precise', durationMs: 0 }
  assert.deepEqual(record({ ...base, sessionId: 'ordinary' }), { recorded: false, reason: 'not-remote' })
  assert.deepEqual(record(base), { recorded: true })
  assert.deepEqual(record(base), { recorded: false, reason: 'duplicate' })
  assert.deepEqual(record({ ...base, metric: 'first-output', durationMs: 1500, condition: 'background' }), { recorded: true })
  assert.deepEqual(record({ ...base, requestId: 'r2', metric: 'first-output', quality: 'unknown',
    durationMs: undefined, reason: 'SUBMISSION_FAILED' }), { recorded: true })
  assert.equal(rows[1].durationMs, 1500)
  assert.equal(rows[1].condition, 'background')
  assert.equal(rows[2].code, 'SUBMISSION_FAILED')
  assert.equal(rows[2].durationMs, undefined)
  for (const invalid of [{ ...base, text: 'PRIVATE' }, { ...base, durationMs: Infinity },
    { ...base, durationMs: -1 }, { ...base, clock: 'wall' }, { ...base, metric: 'first-output', quality: 'unknown' },
    { ...base, source: 'https://private/' }, { ...base, reason: 'PRIVATE' }, { ...base, condition: 'PRIVATE' }]) {
    assert.throws(() => record(invalid), { code: 'INVALID_CLIENT_TIMING' })
  }
  assert.equal(rows.length, 3)
})
