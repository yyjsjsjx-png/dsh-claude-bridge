import test from 'node:test'
import assert from 'node:assert/strict'
import { contextSnapshot, initialSessionStatus, reconcileSessionStatus, createSessionStatusProjection, SESSION_STATUS_RECORD } from '../src/session-status.mjs'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { BridgeBackend } from '../src/backend.mjs'

const available = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)

test('同步错误跨重试和等待保留，确认成功才清除，生命周期失败独立存在', () => {
  const failed = { ...initialSessionStatus('haiku'), phase: 'failed', recovery: {
    status: 'unavailable', added: 0, unresolvedTools: 0, interrupted: false, updatedAt: 1,
    code: 'HISTORY_READ_FAILED',
  } }
  const retry = reconcileSessionStatus(failed, { ...failed, recovery: {
    status: 'syncing', added: 0, unresolvedTools: 0, interrupted: false, updatedAt: 2,
  } })
  assert.equal(retry.recovery.code, 'HISTORY_READ_FAILED')
  assert.equal(retry.phase, 'failed')
  const waiting = reconcileSessionStatus(retry, { ...retry, recovery: {
    status: 'waiting', added: 0, unresolvedTools: 0, interrupted: true, updatedAt: 3,
  } })
  assert.equal(waiting.recovery.code, 'HISTORY_READ_FAILED')
  const ready = reconcileSessionStatus(waiting, { ...waiting, recovery: {
    status: 'ready', added: 0, unresolvedTools: 0, interrupted: false, updatedAt: 4,
  } })
  assert.equal(Object.hasOwn(ready.recovery, 'code'), false)
  assert.equal(ready.phase, 'failed')
  assert.equal(failed.recovery.status, 'unavailable')
})

test('状态写入保留同会话同模型最后快照和采样时间，换模型或会话不借用', () => {
  const states = new Map(), records = []
  const backend = { ctx: { sessionProjections: { stateOf: session => states.get(session) } },
    helpers: { appendPluginRecord(session, type, data) {
      records.push({ session, type, data }); states.set(session, data)
    } } }
  const agent = { session: {} }, other = { session: {} }
  const update = (agent, patch) => BridgeBackend.prototype.sessionStatus.call(backend, agent, patch)
  const context = contextSnapshot({ source: 'sdk-summary-approximate', totalTokens: 120, maxTokens: 1000 }, 100)
  update(agent, { model: 'haiku', phase: 'completed', context })
  update(agent, { phase: 'failed', connection: 'disconnected', context: { status: 'unknown' } })
  assert.deepEqual(agent._bridgeStatus.context, context)
  assert.equal(agent._bridgeStatus.phase, 'failed')
  assert.equal(agent._bridgeStatus.context.observedAt, 100)
  update(other, { model: 'haiku', context: { status: 'unknown' } })
  assert.deepEqual(other._bridgeStatus.context, { status: 'unknown' })
  update(agent, { model: 'sonnet', context: { status: 'unknown' } })
  assert.deepEqual(agent._bridgeStatus.context, { status: 'unknown' })
  update(agent, { model: 'haiku', context: { status: 'unknown' } })
  assert.deepEqual(agent._bridgeStatus.context, { status: 'unknown' })
  assert.ok(records.every(record => record.type === SESSION_STATUS_RECORD))
})

test('实际 rc5：SDK 状态使用可忽略插件日志，原生会话回放保留且不进入模型历史', { skip: !available }, async () => {
  const { z } = await import(resolveDshModule('zod'))
  const { Session, SESSION_FORMAT_VERSION, appendPluginRecord } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const id = 'sdk-status-replay'
  const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0,
    isSeeded: false, agentPreset: 'claude-sdk-remote' })
  const projection = createSessionStatusProjection(z)
  const value = { ...initialSessionStatus('claude-haiku-5-5'), phase: 'completed',
    context: contextSnapshot({ source: 'sdk-summary-approximate', totalTokens: 120, maxTokens: 1000 }),
    compatibility: { model: 'claude-haiku-5-5', version: 1,
      tools: [{ name: 'read_image', status: 'preserved', reason: '保持原生读取' }] } }
  appendPluginRecord(session, SESSION_STATUS_RECORD, value)
  const events = session.snapshotEvents()
  assert.equal(events[0].ignorable, true)
  assert.deepEqual(session.surface.nodes, [])
  const restored = Session.create(id, events, session.header)
  const state = restored.snapshotEvents().reduce(projection.apply, projection.init(restored.header))
  assert.deepEqual(state, value)
  assert.deepEqual(projection.wire.viewSchema.parse(projection.wire.view(state)), value)
  // v0.2.4 wrote whole unknown snapshots on failure/restart. Upgrading must
  // recover the earlier observation from that same log without connecting.
  const oldFailure = { ...value, phase: 'unknown', connection: 'disconnected',
    context: { status: 'unknown' }, toolMayHaveExecuted: true, updatedAt: value.updatedAt + 1 }
  appendPluginRecord(restored, SESSION_STATUS_RECORD, oldFailure)
  const offline = Session.create(id, restored.snapshotEvents(), restored.header)
  const offlineState = offline.snapshotEvents().reduce(projection.apply, projection.init(offline.header))
  assert.deepEqual(offlineState.context, value.context)
  assert.equal(offlineState.phase, 'unknown')
  assert.equal(offlineState.connection, 'disconnected')
  assert.equal(offlineState.toolMayHaveExecuted, true)
  assert.deepEqual(offline.surface.nodes, [])
  const reconnecting = { ...value, connection: 'reconnecting', recovery: {
    status: 'ready', added: 2, unresolvedTools: 1, interrupted: true, updatedAt: 1,
  } }
  appendPluginRecord(restored, SESSION_STATUS_RECORD, reconnecting)
  assert.deepEqual(projection.apply(state, restored.snapshotEvents().at(-1)), reconnecting)
  const next = restored.append('model/selection', { provider: 'claude-sdk-remote', model: 'claude-sonnet-5-5' })
  const changed = projection.apply(state, next)
  assert.equal(changed.model, 'claude-sonnet-5-5')
  assert.deepEqual(changed.context, { status: 'unknown' })
  assert.equal(changed.compatibility, null)
  const afterChange = projection.apply(changed, { type: SESSION_STATUS_RECORD, ignorable: true,
    data: { ...oldFailure, model: 'claude-sonnet-5-5' } })
  assert.deepEqual(afterChange.context, { status: 'unknown' })
  const other = projection.init({ agentPreset: 'claude-sdk-remote' })
  assert.deepEqual(projection.apply(other, { type: SESSION_STATUS_RECORD, ignorable: true,
    data: oldFailure }).context, { status: 'unknown' })
  assert.equal(projection.init({ agentPreset: 'standard' }), null)
})
