import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSummary, normalizeSummary, MAX_COMPACTION_SUMMARY_BYTES } from '../src/compaction-summary.mjs'
import { diagnosticRecord } from '../src/diagnostics.mjs'

test('原生摘要逐字保留，空白/缺失/超限明确失败而不截断', () => {
  assert.deepEqual(parseSummary('  ## 真实摘要\n保留格式\n'), { status: 'available', text: '  ## 真实摘要\n保留格式\n' })
  assert.deepEqual(parseSummary(undefined), { status: 'unavailable', code: 'SUMMARY_MISSING' })
  assert.deepEqual(parseSummary(' \n'), { status: 'unavailable', code: 'SUMMARY_EMPTY' })
  assert.equal(parseSummary('a'.repeat(MAX_COMPACTION_SUMMARY_BYTES)).status, 'available')
  assert.deepEqual(parseSummary('文'.repeat(Math.floor(MAX_COMPACTION_SUMMARY_BYTES / 3) + 1)),
    { status: 'unavailable', code: 'SUMMARY_TOO_LARGE' })
  assert.deepEqual(parseSummary('a' + '\u0000'.repeat(600_000)),
    { status: 'unavailable', code: 'SUMMARY_TOO_LARGE' }, '转义放大不能使可选正文突破RPC帧而中断查询')
})

test('摘要状态只接受白名单字段，诊断不会收录摘要正文', () => {
  assert.deepEqual(normalizeSummary({ status: 'available', text: '私有正文', path: '/secret' }), { status: 'available', text: '私有正文' })
  assert.deepEqual(normalizeSummary({ status: 'unavailable', code: '私有正文' }), { status: 'unavailable', code: 'SUMMARY_UNAVAILABLE' })
  assert.equal(JSON.stringify(diagnosticRecord('compact.summary', { text: '私有正文', summary: { text: '私有正文' }, status: 'available' })).includes('私有正文'), false)
})
