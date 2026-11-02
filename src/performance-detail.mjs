// Detailed diagnostics stay independent of the legacy cumulative run-stage report.
export const DETAIL_STAGES = new Set(['sample', 'unsupported', 'timeout', 'submission', 'first-output',
  'encode', 'write', 'receive', 'notification_wait', 'notification_handle', 'tool_total', 'tool_pipeline',
  'run_finalize', 'approval_wait', 'callback_drain', 'recovery_save', 'lock_release', 'diagnostic_flush'])
export const NETWORK_NUMBERS = ['roundTripMs', 'serverResidenceMs', 'networkRoundTripMs',
  'clockOffsetMs', 'offsetLowerMs', 'offsetUpperMs', 'oneWayEstimateMs', 'uncertaintyMs']
const SIGNED = new Set(['clockOffsetMs', 'offsetLowerMs', 'offsetUpperMs'])

export function sanitizeTimingDetail(value, output, anonymous) {
  if (DETAIL_STAGES.has(value.stage)) output.stage = value.stage
  for (const key of [...NETWORK_NUMBERS, 'samples', 'maxMs']) {
    if (Number.isFinite(value[key]) && (SIGNED.has(key) || value[key] >= 0)) output[key] = value[key]
  }
  for (const key of ['requestId', 'sampleId']) {
    if (typeof value[key] === 'string' && value[key].length <= 256) output[key] = anonymous(value[key], key === 'requestId' ? 'request' : 'sample')
  }
  if (['precise', 'unknown'].includes(value.quality)) output.quality = value.quality
  if (['client-session-receive', 'host-rpc'].includes(value.source)) output.source = value.source
  if (value.clock === 'client-monotonic') output.clock = value.clock
  if (value.assumption === 'symmetric-path') output.assumption = value.assumption
  if (['foreground', 'background', 'queued', 'steering'].includes(value.condition)) output.condition = value.condition
}

export function analyzeTimingDetails(rows, summary) {
  const network = rows.filter(row => row.event === 'perf.network')
  const samples = network.filter(row => row.stage === 'sample' && Number.isFinite(row.networkRoundTripMs))
  const best = samples.reduce((a, b) => !a || b.networkRoundTripMs < a.networkRoundTripMs ? b : a, undefined)
  const requests = new Map()
  for (const row of rows.filter(row => row.event === 'perf.client' && row.requestId)) {
    if (!requests.has(row.requestId)) requests.set(row.requestId, { requestId: row.requestId })
    const request = requests.get(row.requestId)
    if (row.stage === 'submission') request.submitted = true
    if (row.stage === 'first-output' && !request.result) request.result = row
  }
  const observed = [...requests.values()]
  const measured = observed.filter(row => row.result?.quality === 'precise' && Number.isFinite(row.result.durationMs))
  const unknown = observed.filter(row => row.result?.quality === 'unknown')
  const grouped = new Map(), detailIds = new Set()
  for (const row of rows) {
    const interval = row.event === 'perf.rpc' || DETAIL_STAGES.has(row.stage)
      && ['perf.local', 'perf.remote'].includes(row.event)
    if (!interval || !Number.isFinite(row.durationMs)) continue
    // The same remote interval can be collected from VPS and its Host forward.
    if (row.sampleId) {
      const id = `${row.runId}/${row.event}/${row.sampleId}`
      if (detailIds.has(id)) continue
      detailIds.add(id)
    }
    const key = `${row.event}/${row.stage}/${row.method ?? ''}`
    if (!grouped.has(key)) grouped.set(key, { event: row.event, stage: row.stage, method: row.method,
      samples: 0, totalMs: 0, maxMs: 0, bytes: 0 })
    const group = grouped.get(key)
    group.samples += row.samples ?? 1
    group.totalMs += row.durationMs
    group.maxMs = Math.max(group.maxMs, row.maxMs ?? row.durationMs)
    group.bytes += row.bytes ?? 0
  }
  const reasonCounts = {}
  for (const row of unknown) reasonCounts[row.result.code ?? 'UNKNOWN'] = (reasonCounts[row.result.code ?? 'UNKNOWN'] ?? 0) + 1
  return {
    network: { samples: samples.length, unsupported: network.filter(row => row.stage === 'unsupported').length,
      timeouts: network.filter(row => row.stage === 'timeout').length,
      aggregates: Object.fromEntries(NETWORK_NUMBERS.map(key => [key, summary(samples.map(row => row[key]))])),
      ...(best ? { minimumRttProbe: Object.fromEntries(NETWORK_NUMBERS.filter(key => Number.isFinite(best[key])).map(key => [key, best[key]])) } : {}) },
    client: { submissions: observed.filter(row => row.submitted).length, samples: measured.length, unknown: unknown.length,
      pendingOrIncomplete: observed.filter(row => row.submitted && !row.result).length,
      unpairedResults: observed.filter(row => !row.submitted && row.result).length,
      firstOutput: summary(measured.map(row => row.result.durationMs)), reasonCounts,
      requests: observed.map(row => ({ requestId: row.requestId, submitted: Boolean(row.submitted),
        quality: row.result?.quality ?? 'pending-or-incomplete', ...(row.result?.condition ? { condition: row.result.condition } : {}),
        ...(Number.isFinite(row.result?.durationMs) ? { durationMs: row.result.durationMs } : {}),
        ...(row.result?.code ? { code: row.result.code } : {}) })) },
    intervals: [...grouped.values()].map(row => ({ ...row, meanMs: row.samples ? row.totalMs / row.samples : 0 })),
  }
}

export function formatTimingDetails(details) {
  const network = details.network, client = details.client
  const names = { roundTripMs: '应用层往返', serverResidenceMs: '服务端心跳处理', networkRoundTripMs: '扣除服务端停留后的往返',
    clockOffsetMs: '时钟偏差估计（远端减本机）', offsetLowerMs: '时钟偏差下界', offsetUpperMs: '时钟偏差上界',
    oneWayEstimateMs: '对称路径下单程估计', uncertaintyMs: '路径不对称的偏差范围半宽' }
  const lines = ['', '## 网络探测', '', `有效 ${network.samples} 次，不支持 ${network.unsupported} 次，探测超时 ${network.timeouts} 次。`, '',
    '| 指标 | 样本 | P50 / ms | P95 / ms | 最大 / ms |', '| --- | ---: | ---: | ---: | ---: |']
  for (const [key, name] of Object.entries(names)) {
    const value = network.aggregates[key]
    lines.push(`| ${name} | ${value.samples} | ${value.p50Ms ?? '—'} | ${value.p95Ms ?? '—'} | ${value.maxMs ?? '—'} |`)
  }
  lines.push('', '四时间戳测量包含两端 WebSocket 编解码、操作系统及中间链路调度；扣除的是服务端收到心跳后到回复前的停留。单程值假定上下行对称，偏差区间还依赖探测期间时钟速率稳定；不是纯链路单程实测，TCP 探测超时也不是丢包率。', '',
    '## 客户端首有效输出接收', '', `观察到提交 ${client.submissions} 次，有效 ${client.samples} 次，明确不可测 ${client.unknown} 次，待完成或日志缺尾 ${client.pendingOrIncomplete} 次；缺提交起点日志的结果 ${client.unpairedResults} 次。`, '',
    `客户端 TTFT：P50 ${client.firstOutput.p50Ms ?? '—'} ms，P95 ${client.firstOutput.p95Ms ?? '—'} ms。起点为本窗口提交，终点为同请求的有效模型输出被 ClientSession 接收处理；不代表像素已绘制，也不与 SDK 均值混合。`, '',
    '| 不可测原因 | 数量 |', '| --- | ---: |', ...Object.entries(client.reasonCounts).map(([key, count]) => `| ${key} | ${count} |`), '',
    '## RPC、工具及收尾分段', '', '| 侧 / 阶段 / 方法 | 调用数 | 累计 / ms | 每次平均 / ms | 单次最大 / ms |', '| --- | ---: | ---: | ---: | ---: |')
  for (const row of details.intervals) lines.push(`| ${row.event} / ${row.stage} / ${row.method ?? '—'} | ${row.samples} | ${row.totalMs.toFixed(3)} | ${row.meanMs.toFixed(3)} | ${row.maxMs.toFixed(3)} |`)
  lines.push('', 'RPC write 仅计同步写入调用，不是物理发包或 drain 完成；通知等待/处理及工具管线可能重叠，不能直接相加为整轮耗时。工具管线含原生审批；SDK approval_wait 仅表示 SDK 回调审批等待。', '')
  return lines
}
