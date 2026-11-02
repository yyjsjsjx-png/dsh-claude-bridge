import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeModelRequests, formatModelRequestsCsv } from '../src/model-request-report.mjs'

const event = (event, fields = {}) => ({ event, runId: 'private-run', responseId: 'private-response', turn: 1, step: 1, ...fields })
const host = fields => event('perf.model_cycle', { stage: 'first-output', quality: 'precise', durationMs: 1500, startBoundary: 'query', kind: 'text', ...fields })
const sdk = fields => event('perf.model_sdk', { stage: 'first-output', quality: 'estimated', source: 'sdk-first-output-estimate', durationMs: 900, ...fields })
const usage = fields => event('perf.model_usage', fields)
const span = fields => sdk({ stage: 'receive-span', quality: 'precise', source: 'sdk-stream-receive', durationMs: 2000, outputTokens: 40, ...fields })

test('逐响应合并晚到四桶和型号，重复不相加，Host与SDK时间及请求强度分开', () => {
  const input = [host(), sdk(), host({ stage: 'duration', durationMs: 5000, endBoundary: 'message-stop' }),
    usage({ inputTokens: 2, outputTokens: 20 }), usage({ cacheReadTokens: 10, cacheWriteTokens: 3, outputTokens: 40 }), span(),
    event('perf.model_identity', { requestedModel: 'haiku', model: 'claude-haiku-wire', effort: 'high', actualEffort: 'max', thinkingTokens: 99 })]
  const rows = analyzeModelRequests([...input, ...input])
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row.hostTtftMs, 1500); assert.equal(row.sdkTtftMs, 900); assert.equal(row.hostDurationMs, 5000)
  assert.equal(row.outputTokens, 40); assert.equal(row.inputContextTokens, 15); assert.equal(row.totalTokens, 55)
  assert.equal(row.tps, 20); assert.equal(row.receiveOutputTokens, 40)
  assert.equal(row.requestedModel, 'haiku'); assert.equal(row.actualModel, 'claude-haiku-wire'); assert.equal(row.requestedEffort, 'high')
  assert.equal(row.endBoundary, 'message-stop')
  assert.equal(Object.hasOwn(row, 'actualEffort'), false); assert.equal(Object.hasOwn(row, 'thinkingTokens'), false)
  assert.doesNotMatch(JSON.stringify(row), /private-/)
  assert.equal(analyzeModelRequests([{ ...host(), runId: row.runId, responseId: row.responseId }])[0].responseId, row.responseId)
})

test('四用户轮次九个SDK响应输出九行，TPS汇总保留独立分母而不是每行速度平均', () => {
  const input = []
  for (const [turn, steps] of [[1, 1], [2, 3], [3, 3], [4, 2]]) {
    for (let step = 1; step <= steps; step++) {
      const fields = { runId: `private-${turn}`, responseId: `response-${step}`, turn, step }
      input.push(host({ ...fields, startBoundary: step === 1 ? 'query' : 'step-prepare', kind: step === steps ? 'text' : 'tool-name' }),
        span({ ...fields, durationMs: step * 1000, outputTokens: 20 }))
    }
  }
  const rows = analyzeModelRequests([...input, ...input])
  assert.equal(rows.length, 9)
  assert.equal(rows.filter(row => row.hostTtftQuality === 'precise').length, 9)
  assert.equal(rows.filter(row => row.firstOutputKind === 'tool-name').length, 5)
  const tokens = rows.reduce((sum, row) => sum + row.receiveOutputTokens, 0)
  const duration = rows.reduce((sum, row) => sum + row.receiveSpanMs, 0)
  assert.equal(tokens, 180); assert.equal(duration, 16000)
  assert.notEqual(tokens * 1000 / duration, rows.reduce((sum, row) => sum + row.tps, 0) / rows.length)
})

test('旧SDK-only与缺桶保留未知，真实零值仍可导出，坏时长和错误source不产生速度或Host补值', () => {
  const row = analyzeModelRequests([sdk(), usage({ inputTokens: 0, outputTokens: 0 }), span({ durationMs: 0, outputTokens: 0 })])[0]
  assert.equal(row.sdkTtftMs, 900); assert.equal(row.hostTtftMs, null); assert.equal(row.hostTtftQuality, 'unknown')
  assert.equal(row.inputTokens, 0); assert.equal(row.outputTokens, 0)
  assert.equal(row.cacheReadTokens, null); assert.equal(row.inputContextTokens, null); assert.equal(row.totalTokens, null); assert.equal(row.tps, null)
  const unknown = analyzeModelRequests([host(), host({ quality: 'unknown', code: 'NO_LOCAL_START', durationMs: 0 }),
    sdk({ source: 'untrusted' }), span({ durationMs: -10 }), usage({ outputTokens: -1 })])[0]
  assert.equal(unknown.hostTtftMs, null); assert.equal(unknown.hostTtftCode, 'NO_LOCAL_START')
  assert.equal(unknown.sdkTtftMs, null); assert.equal(unknown.receiveSpanMs, null); assert.equal(unknown.outputTokens, null)
  assert.deepEqual(analyzeModelRequests([{ ...host(), responseId: undefined }, { event: 'perf.local', runId: 'run', responseId: 'response' }]), [])
})

test('CSV列固定、未知空白、转义逗号引号换行；不导出额外正文或危险型号', () => {
  const rows = analyzeModelRequests([usage({ inputTokens: 0 }), event('perf.model_identity', {
    requestedModel: 'haiku', model: '=PRIVATE_FORMULA', effort: 'low', prompt: 'PRIVATE_PROMPT' })])
  const csv = formatModelRequestsCsv(rows)
  assert.match(csv, /requestedModel,actualModel,requestedEffort/)
  assert.match(csv, /,haiku,,low,0,,,,/)
  assert.doesNotMatch(csv, /PRIVATE|thinkingTokens|actualEffort/)
  const escaped = formatModelRequestsCsv([{ ...rows[0], requestedModel: 'model,"quoted"\nline', content: 'PRIVATE_BODY' }])
  assert.match(escaped, /"model,""quoted""\nline"/)
  assert.doesNotMatch(escaped, /PRIVATE_BODY/)
  assert.equal(formatModelRequestsCsv([]).trim().split('\n').length, 1)
})
