import { createHash } from 'node:crypto'

const EVENTS = /^(?:perf\.(?:local|remote|sdk)|run\.[a-z_]+|history\.[a-z_]+|connection\.state|step\.[a-z_]+|tool\.[a-z_]+|diagnostics\.failed|start|complete|reserved|resumed|ready|hooks-verified|toolset-verified|dispatch|received|iterator-exited|failed|completed|lock-release-failed)$/
const STAGES = new Set(['start', 'connected', 'history_checked', 'request_sent', 'first_model_event', 'first_token',
  'first_text', 'completed', 'hooks_verified', 'toolset_verified', 'ttft_ms', 'ttft_stream_ms',
  'time_to_request_ms', 'first_content_frame_ms', 'duration_ms', 'duration_api_ms',
  'query', 'validation', 'session', 'mcp', 'sdk', 'tool', 'cancel', 'compact', 'pre-step', 'execute'])
const NUMBERS = ['durationMs', 'bytes', 'inputBytes', 'outputBytes', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
const anonymous = value => /^run-[a-f0-9]{12}$/.test(value) ? value
  : `run-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`

/** Export an allowlist, never the raw application log or an SDK transcript. */
export function sanitizePerformanceRecord(value) {
  if (!value || typeof value !== 'object' || !EVENTS.test(value.event ?? '')) return undefined
  const output = { event: value.event }
  if (typeof value.time === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value.time)
    && Number.isFinite(Date.parse(value.time))) output.time = value.time
  if (typeof value.runId === 'string' && value.runId.length <= 256) output.runId = anonymous(value.runId)
  if (STAGES.has(value.stage)) output.stage = value.stage
  for (const key of NUMBERS) if (Number.isFinite(value[key]) && value[key] >= 0) output[key] = value[key]
  if (/^[A-Z][A-Z0-9_]{1,79}$/.test(value.code ?? '')) output.code = value.code
  if (['connected', 'connecting', 'reconnecting', 'disconnected', 'closed', 'ready', 'completed', 'failed', 'cancelled', 'unknown'].includes(value.status)) output.status = value.status
  if (['query', 'compact', 'text-delta', 'reasoning-delta', 'tool-call-delta'].includes(value.method)) output.method = value.method
  if (typeof value.model === 'string' && /^[a-z][a-z0-9_.:-]{0,100}$/i.test(value.model)
    && !/token|key|bearer|secret|password/i.test(value.model)) output.model = value.model
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value.effort)) output.effort = value.effort
  return output
}

function summary(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!ordered.length) return { samples: 0 }
  const percentile = fraction => ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]
  return { samples: ordered.length, minMs: ordered[0], p50Ms: percentile(.5), p95Ms: percentile(.95),
    maxMs: ordered.at(-1), meanMs: Math.round(ordered.reduce((sum, value) => sum + value, 0) / ordered.length) }
}
const difference = (later, earlier) => Number.isFinite(later) && Number.isFinite(earlier) && later >= earlier ? later - earlier : undefined
const METRICS = {
  localPreparationMs: '本地准备至发送', localFirstTokenMs: '本地收到首 token（含准备）',
  localWaitAfterSendMs: '发送后等待首 token', localFirstTextMs: '本地收到首段正文（含准备）',
  remoteStartupMs: '云端工具集初始化', remoteFirstTokenMs: '云端收到首 token', remoteFirstTextMs: '云端收到首段正文',
  thinkingToTextMs: '云端首 token 至首段正文', transportResidualMs: '两端传输与调度余量估算',
  localTotalMs: '本地整轮耗时', remoteTotalMs: '云端整轮耗时', sdkTtftStreamMs: 'SDK ttft_stream_ms（原始上报）',
}

/** Match elapsed times by run ID, without subtracting two machines' wall clocks. */
export function analyzePerformance(input) {
  const runs = new Map(), events = new Map(), seen = new Set()
  let accepted = 0
  for (const raw of input) {
    const row = sanitizePerformanceRecord(raw)
    if (!row) continue
    const key = JSON.stringify(row)
    if (seen.has(key)) continue
    seen.add(key); accepted++
    events.set(row.event, (events.get(row.event) ?? 0) + 1)
    if (!row.runId) continue
    if (!runs.has(row.runId)) runs.set(row.runId, { id: row.runId, local: {}, remote: {}, sdk: {}, status: 'incomplete' })
    const run = runs.get(row.runId)
    if (row.model) run.model = row.model
    if (row.effort) run.effort = row.effort
    if (row.method === 'compact') run.compact = true
    if (row.time) {
      run.firstObservedAt = !run.firstObservedAt || row.time < run.firstObservedAt ? row.time : run.firstObservedAt
      run.lastObservedAt = !run.lastObservedAt || row.time > run.lastObservedAt ? row.time : run.lastObservedAt
    }
    if (/^perf\./.test(row.event) && row.stage && Number.isFinite(row.durationMs)) {
      const side = row.event.slice(5)
      // Client and cloud copies describe the same remote mark. Keep one.
      run[side][row.stage] ??= row.durationMs
      if (row.stage === 'completed') run.status = 'completed'
    }
    if (row.event === 'run.completed') { run.legacyLocalTotalMs ??= row.durationMs; run.status = 'completed' }
    if (row.event === 'run.failed' || (row.event === 'failed' && row.stage === 'query')) {
      run.status = /CANCEL|Abort/i.test(row.code ?? '') ? 'cancelled' : 'failed'
      if (row.code) run.code = row.code
    }
    // Earlier builds already emitted these cloud startup marks to the client.
    if (row.stage === 'sdk' && row.event === 'hooks-verified') run.remote.hooks_verified ??= row.durationMs
    if (row.stage === 'sdk' && row.event === 'toolset-verified') run.remote.toolset_verified ??= row.durationMs
    if (row.stage === 'sdk' && row.event === 'completed') { run.legacyRemoteTotalMs ??= row.durationMs; run.status = 'completed' }
  }
  const queries = [...runs.values()].filter(run => !run.compact).map(run => {
    run.metrics = {
      localPreparationMs: run.local.request_sent, localFirstTokenMs: run.local.first_token,
      localWaitAfterSendMs: difference(run.local.first_token, run.local.request_sent),
      localFirstTextMs: run.local.first_text, remoteStartupMs: run.remote.toolset_verified,
      remoteFirstTokenMs: run.remote.first_token, remoteFirstTextMs: run.remote.first_text,
      thinkingToTextMs: difference(run.remote.first_text, run.remote.first_token),
      localTotalMs: run.local.completed ?? run.legacyLocalTotalMs, remoteTotalMs: run.remote.completed ?? run.legacyRemoteTotalMs, sdkTtftStreamMs: run.sdk.ttft_stream_ms,
    }
    run.metrics.transportResidualMs = difference(run.metrics.localWaitAfterSendMs, run.remote.first_token)
    // JSON omits absent observations rather than manufacturing zero samples.
    run.metrics = Object.fromEntries(Object.entries(run.metrics).filter(([, value]) => Number.isFinite(value)))
    return run
  })
  const aggregates = Object.fromEntries(Object.keys(METRICS).map(name => [name, summary(queries.map(run => run.metrics[name]))]))
  const groups = new Map()
  for (const run of queries) {
    const key = `${run.model ?? 'unknown'} / ${run.effort ?? 'unknown'}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(run)
  }
  return { format: 1, generatedAt: new Date().toISOString(), diagnosticRecords: accepted, runs: queries,
    coverage: { runs: queries.length, completed: queries.filter(run => run.status === 'completed').length,
      cancelled: queries.filter(run => run.status === 'cancelled').length, failed: queries.filter(run => run.status === 'failed').length,
      pairedFirstToken: queries.filter(run => Number.isFinite(run.metrics.transportResidualMs)).length,
      missingFirstToken: queries.filter(run => !Number.isFinite(run.metrics.localFirstTokenMs) && !Number.isFinite(run.metrics.remoteFirstTokenMs)).length },
    aggregates, groups: [...groups].map(([name, entries]) => ({ name, runs: entries.length,
      remoteFirstToken: summary(entries.map(run => run.metrics.remoteFirstTokenMs)),
      thinkingToText: summary(entries.map(run => run.metrics.thinkingToTextMs)) })), eventCounts: Object.fromEntries(events),
    limitations: ['首 token 是首次收到可用思考、文字或工具参数的观测点；SDK 缺少增量时以完整消息为准，首段正文单独计时。',
      '传输余量是同一轮两端耗时相减的估算，包含传输与调度，不能当作纯网络 RTT。',
      'SDK duration_api_ms 可能累计；只在每轮 SDK 原始字段中保留，不当作本轮上游耗时。',
      '旧版日志缺少分段点时不补猜；转储窗口不保证包含每轮的开头与结尾。'] }
}

export function formatPerformanceReport(report) {
  const c = report.coverage, lines = ['# 桥接性能报告', '', `生成时间：${report.generatedAt}`, '',
    `共 ${c.runs} 轮：完成 ${c.completed}，取消 ${c.cancelled}，失败 ${c.failed}；${c.pairedFirstToken} 轮可对比两端首 token，${c.missingFirstToken} 轮缺少首 token 分段。`, '',
    '| 阶段 | 样本 | P50 / ms | P95 / ms | 最大 / ms |', '| --- | ---: | ---: | ---: | ---: |']
  for (const [name, label] of Object.entries(METRICS)) {
    const value = report.aggregates[name]
    lines.push(`| ${label} | ${value.samples} | ${value.p50Ms ?? '—'} | ${value.p95Ms ?? '—'} | ${value.maxMs ?? '—'} |`)
  }
  lines.push('', '## 每轮记录', '', '| 匿名轮次 | 模型 / effort | 状态 | 本地准备 / ms | 云端首 token / ms | 云端首正文 / ms |',
    '| --- | --- | --- | ---: | ---: | ---: |')
  for (const run of report.runs) lines.push(`| ${run.id} | ${run.model ?? '未知'} / ${run.effort ?? '未知'} | ${run.status} | ${run.metrics.localPreparationMs ?? '—'} | ${run.metrics.remoteFirstTokenMs ?? '—'} | ${run.metrics.remoteFirstTextMs ?? '—'} |`)
  lines.push('', '## 数据边界', '', ...report.limitations.map(line => `- ${line}`), '')
  return lines.join('\n')
}
