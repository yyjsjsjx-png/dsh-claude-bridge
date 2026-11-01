import test from 'node:test'
import assert from 'node:assert/strict'
import { createRunProgressReporter, createRunProgressProjection, RUN_PROGRESS_RECORD } from '../src/run-progress.mjs'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'

const available = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
const summary = totalTokens => ({ source: 'sdk-summary-approximate', totalTokens, maxTokens: 400000 })

function fixture() {
  let status = { runId: 'run-a', model: 'haiku', phase: 'running' }, active = true, time = 100
  const records = []
  const reporter = createRunProgressReporter({ runId: 'run-a', model: 'haiku',
    isActive: () => active, readStatus: () => status, now: () => time++,
    writeStatus: patch => { status = { ...status, ...patch } },
    writeProgress: value => records.push(structuredClone(value)) })
  reporter.start()
  return { reporter, records, get status() { return status },
    setStatus: patch => { status = { ...status, ...patch } }, stop: () => { active = false } }
}

test('自动压缩阶段可见，数值边界保留，压缩后上下文允许下降', () => {
  const f = fixture()
  f.reporter.accept({ type: 'context', context: summary(365000), observedAt: 1 })
  f.reporter.accept({ type: 'status', status: 'compacting' })
  assert.equal(f.status.phase, 'compacting')
  assert.equal(f.records.at(-1).compaction.trigger, 'auto')
  f.reporter.accept({ type: 'context', context: summary(368000), observedAt: 2 })
  assert.equal(f.status.context.totalTokens, 365000)
  f.reporter.accept({ type: 'compact-boundary', trigger: 'auto', preTokens: 368207,
    postTokens: 3380, durationMs: 61876, privateText: '不应存储' })
  assert.equal(f.status.phase, 'running')
  assert.equal(f.records.at(-1).compaction.durationMs, 61876)
  assert.equal(JSON.stringify(f.records).includes('不应存储'), false)
  f.reporter.accept({ type: 'context', context: summary(21973), observedAt: 3 })
  assert.equal(f.status.context.totalTokens, 21973)
})

test('采样失败保留旧值，成功或最终有效summary解除提示；结束后拒绝迟到更新', () => {
  const f = fixture()
  f.reporter.accept({ type: 'context', context: summary(1000), observedAt: 1 })
  f.reporter.accept({ type: 'context', context: { status: 'unknown' }, code: 'CONTEXT_SUMMARY_TIMEOUT' })
  assert.equal(f.status.context.totalTokens, 1000)
  assert.equal(f.records.at(-1).contextUpdate.status, 'unavailable')
  f.reporter.close(summary(2000))
  assert.equal(f.records.at(-1).contextUpdate.status, 'updated')
  const count = f.records.length
  f.reporter.accept({ type: 'status', status: 'compacting' })
  f.reporter.accept({ type: 'context', context: summary(9999), observedAt: 1000 })
  assert.equal(f.records.length, count)
  assert.equal(f.status.phase, 'running')
})

test('停止、换run或模型后旧进度不覆盖新状态，只有边界也能记录压缩', () => {
  for (const mutate of [f => f.stop(), f => f.setStatus({ runId: 'new-run' }),
    f => f.setStatus({ model: 'sonnet' }), f => f.setStatus({ phase: 'stopping' })]) {
    const f = fixture()
    mutate(f)
    f.reporter.accept({ type: 'status', status: 'compacting' })
    f.reporter.accept({ type: 'context', context: summary(1000), observedAt: 1 })
    assert.equal(f.records.length, 1)
  }
  const f = fixture()
  f.reporter.accept({ type: 'compact-boundary', trigger: 'auto', durationMs: 61876 })
  assert.equal(f.records.at(-1).compaction.status, 'completed')
  assert.equal(f.status.phase, 'running')
})

test('实际rc5：新数值记录可忽略且不进模型历史，旧状态与普通会话保持可读', { skip: !available }, async () => {
  const { z } = await import(resolveDshModule('zod'))
  const { Session, SESSION_FORMAT_VERSION, appendPluginRecord } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const session = Session.create('progress-replay', undefined, { version: SESSION_FORMAT_VERSION,
    id: 'progress-replay', createdAt: 0, isSeeded: false, agentPreset: 'claude-sdk-remote' })
  const projection = createRunProgressProjection(z)
  const f = fixture()
  f.reporter.accept({ type: 'status', status: 'compacting' })
  f.reporter.accept({ type: 'compact-boundary', trigger: 'auto', preTokens: 368207, postTokens: 3380, durationMs: 61876 })
  for (const data of f.records) appendPluginRecord(session, RUN_PROGRESS_RECORD, data)
  const restored = Session.create(session.id, session.snapshotEvents(), session.header)
  const state = restored.snapshotEvents().reduce(projection.apply, projection.init(restored.header))
  assert.equal(state.compaction.durationMs, 61876)
  assert.deepEqual(projection.wire.viewSchema.parse(state), state)
  assert.deepEqual(restored.surface.nodes, [])
  assert.equal(projection.init({ agentPreset: 'standard' }), null)
})
