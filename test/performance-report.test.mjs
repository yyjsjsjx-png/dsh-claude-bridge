import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { analyzePerformance, formatPerformanceReport, sanitizePerformanceRecord } from '../src/performance-report.mjs'

test('详细诊断保留有误差的网络估计、每请求覆盖和有界RPC聚合，双端转发不重复', () => {
  const rows = [
    { event: 'perf.network', stage: 'sample', roundTripMs: 102, serverResidenceMs: 2, networkRoundTripMs: 100,
      clockOffsetMs: -20, offsetLowerMs: -70, offsetUpperMs: 30, oneWayEstimateMs: 50, uncertaintyMs: 50,
      assumption: 'symmetric-path', token: 'PRIVATE', url: 'https://PRIVATE/' },
    { event: 'perf.network', stage: 'unsupported', code: 'NETWORK_TIMING_UNSUPPORTED' },
    { event: 'perf.network', stage: 'timeout' },
    { event: 'perf.client', stage: 'submission', requestId: 'private-r1', sessionId: 'private-session', quality: 'precise', durationMs: 0 },
    { event: 'perf.client', stage: 'first-output', requestId: 'private-r1', quality: 'precise', durationMs: 400, condition: 'background' },
    { event: 'perf.client', stage: 'submission', requestId: 'private-r2', quality: 'precise', durationMs: 0 },
    { event: 'perf.client', stage: 'first-output', requestId: 'private-r2', quality: 'unknown', code: 'SUBMISSION_FAILED' },
    { event: 'perf.client', stage: 'submission', requestId: 'private-r3', quality: 'precise', durationMs: 0 },
    { event: 'perf.rpc', stage: 'notification_handle', method: 'sdk.message', runId: 'private-run',
      durationMs: 50, samples: 10, maxMs: 9, bytes: 1000, source: 'host-rpc' },
    { event: 'perf.remote', stage: 'approval_wait', runId: 'private-run', sampleId: 'private-sample', durationMs: 200,
      time: '2026-11-03T00:00:00.000Z' },
    { event: 'perf.remote', stage: 'approval_wait', runId: 'private-run', sampleId: 'private-sample', durationMs: 200,
      time: '2026-11-03T00:00:01.000Z' },
  ]
  const report = analyzePerformance(rows), detail = report.details
  assert.equal(detail.network.samples, 1)
  assert.equal(detail.network.unsupported, 1)
  assert.equal(detail.network.timeouts, 1)
  assert.equal(detail.network.minimumRttProbe.clockOffsetMs, -20)
  assert.equal(detail.network.aggregates.oneWayEstimateMs.p50Ms, 50)
  assert.equal(detail.client.submissions, 3)
  assert.equal(detail.client.samples, 1)
  assert.equal(detail.client.unknown, 1)
  assert.equal(detail.client.pendingOrIncomplete, 1)
  assert.deepEqual(detail.client.reasonCounts, { SUBMISSION_FAILED: 1 })
  assert.equal(detail.intervals.find(row => row.event === 'perf.rpc').meanMs, 5)
  assert.equal(detail.intervals.find(row => row.stage === 'approval_wait').samples, 1)
  const sanitized = rows.map(sanitizePerformanceRecord)
  assert.doesNotMatch(JSON.stringify(sanitized), /PRIVATE|private-|sessionId/)
  assert.deepEqual(analyzePerformance(sanitized).details, detail)
  const text = formatPerformanceReport(report)
  assert.match(text, /单程值假定上下行对称/)
  assert.match(text, /不是丢包率/)
  assert.match(text, /观察到提交 3 次，有效 1 次/)
})

test('两端耗时按匿名轮次对应，思考与正文分开，SDK 累计耗时不冒充单轮推理', () => {
  const mark = (event, stage, durationMs) => ({ event, stage, durationMs, runId: '11111111-1111-4111-8111-111111111111', model: 'haiku', effort: 'high' })
  const rows = [mark('perf.local', 'start', 0), mark('perf.local', 'connected', 20),
    mark('perf.local', 'history_checked', 300), mark('perf.local', 'tools_converted', 400),
    mark('perf.local', 'prompt_prepared', 450), mark('perf.local', 'journal_prepared', 500),
    mark('perf.local', 'checkpointed', 550), mark('perf.local', 'request_sent', 600),
    mark('perf.local', 'first_token', 2400), mark('perf.local', 'first_text', 3600), mark('perf.local', 'completed', 4000),
    mark('perf.remote', 'toolset_verified', 500), mark('perf.remote', 'first_token', 1700),
    mark('perf.remote', 'first_text', 2800), mark('perf.remote', 'completed', 3300),
    mark('perf.sdk', 'ttft_stream_ms', 1300), mark('perf.sdk', 'duration_api_ms', 100000)]
  rows.push({ ...rows[0], event: 'run.completed', stage: undefined, durationMs: 3400 })
  const report = analyzePerformance([...rows, ...rows, { event: 'run.completed', runId: 'legacy', durationMs: 200 }])
  assert.equal(report.coverage.runs, 2)
  assert.equal(report.coverage.pairedFirstToken, 1)
  assert.equal(report.coverage.missingFirstToken, 1)
  const run = report.runs.find(run => run.model === 'haiku')
  assert.match(run.id, /^run-[a-f0-9]{12}$/)
  assert.equal(run.metrics.transportResidualMs, 100)
  assert.equal(run.metrics.thinkingToTextMs, 1100)
  assert.equal(run.metrics.localWaitAfterSendMs, 1800)
  assert.equal(run.metrics.remoteTotalMs, 3300)
  assert.equal(run.metrics.localTotalMs, 4000)
  assert.equal(run.metrics.localConnectionMs, 20)
  assert.equal(run.metrics.historyCheckMs, 280)
  assert.equal(run.metrics.localToolSetupMs, 100)
  assert.equal(run.metrics.localPromptPreparationMs, 50)
  assert.equal(run.metrics.localJournalPreparationMs, 50)
  assert.equal(run.metrics.localCheckpointMs, 50)
  assert.equal(run.metrics.localAfterCheckpointMs, 50)
  assert.equal(run.sdk.duration_api_ms, 100000)
  assert.equal(report.aggregates.localTotalMs.p50Ms, 200)
  assert.equal(report.aggregates.localTotalMs.p95Ms, 4000)
  assert.equal(report.diagnosticRecords, rows.length + 1)
  assert.match(formatPerformanceReport(report), /可能累计/)
  assert.equal(analyzePerformance(rows.map(sanitizePerformanceRecord)).runs[0].id, run.id)
})

test('收集器只读取桥接日志并导出白名单，排除原始错误、账号、正文及路径', async t => {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'dsh-performance-'))
  t.after(async () => { assert.equal(dirname(root), parent); assert.ok(root.startsWith(join(parent, 'dsh-performance-'))); await rm(root, { recursive: true, force: true }) })
  const logs = join(root, 'diagnostics'), output = join(root, 'export')
  await mkdir(logs)
  await writeFile(join(logs, 'bridge.jsonl'), [
    JSON.stringify({ event: 'perf.local', stage: 'first_token', durationMs: 10, runId: 'private-run-id',
      sessionId: 'private-session', token: 'PRIVATE_TOKEN', prompt: 'PRIVATE_TEXT', error: 'PRIVATE_ERROR',
      method: 'https://PRIVATE_HOST/', model: 'haiku', time: '2026-10-31T00:00:00.000Z' }),
    JSON.stringify({ event: 'PRIVATE_ARBITRARY_EVENT', message: 'PRIVATE_TEXT' }), 'incomplete JSON',
    JSON.stringify({ event: 'websocket_connect_failed', code: 'WS_CONNECT_FAILED', error: 'PRIVATE_ERROR', url: 'https://PRIVATE_HOST/' }),
    JSON.stringify({ event: 'rpc_request_failed', method: 'history', code: 'RPC_TIMEOUT', params: { text: 'PRIVATE_TEXT' } }),
  ].join('\n'))
  await writeFile(join(logs, 'connection.json'), 'PRIVATE_TOKEN')
  const result = spawnSync(process.execPath, ['scripts/collect-performance.mjs', '--logs', logs, '--out', output], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)
  const exported = await readFile(join(output, 'diagnostics.sanitized.jsonl'), 'utf8')
  assert.doesNotMatch(exported, /PRIVATE_|private-run|private-session|https|sessionId/)
  assert.match(exported, /perf.local/)
  const report = JSON.parse(await readFile(join(output, 'performance-report.json'), 'utf8'))
  assert.equal(report.collection.files, 1)
  assert.equal(report.collection.invalidLines, 1)
  assert.equal(report.collection.ignoredLines, 1)
  assert.equal(report.runs[0].metrics.localFirstTokenMs, 10)
  assert.equal(report.eventCounts.websocket_connect_failed, 1)
  assert.equal(report.eventCounts.rpc_request_failed, 1)
})
