import test from 'node:test'
import assert from 'node:assert/strict'
import { contextSnapshot, initialSessionStatus, createSessionStatusProjection, SESSION_STATUS_RECORD } from '../src/session-status.mjs'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'

const available = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)

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
  assert.equal(projection.init({ agentPreset: 'standard' }), null)
})
