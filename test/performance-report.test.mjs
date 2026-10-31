import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { analyzePerformance, formatPerformanceReport, sanitizePerformanceRecord } from '../src/performance-report.mjs'

test('两端耗时按匿名轮次对应，思考与正文分开，SDK 累计耗时不冒充单轮推理', () => {
  const mark = (event, stage, durationMs) => ({ event, stage, durationMs, runId: '11111111-1111-4111-8111-111111111111', model: 'haiku', effort: 'high' })
  const rows = [mark('perf.local', 'start', 0), mark('perf.local', 'request_sent', 600),
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
})
