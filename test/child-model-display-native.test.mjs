import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { createMeterViews } from '../plugin/ui/client/meter-views.mjs'

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
test('实际rc5原生modelSelection：child请求头重放与待发送选型隔离，badge保留模型默认', { skip: !native }, async () => {
  const { z } = await import(resolveDshModule('zod'))
  const { Session, SESSION_FORMAT_VERSION } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  // Execute the installed pure projection, using the same region-reading
  // approach as the existing native chat fixtures; no service or model calls.
  const source = readFileSync(new URL(resolveDshModule('@deepseek-ai/dsh-api-session-controller')), 'utf8')
  const begin = source.indexOf('//#region lib/types/model-selection-projection.js')
  const end = source.indexOf('//#endregion', begin)
  assert.ok(begin >= 0 && end > begin)
  const projection = new Function('z$1', `${source.slice(begin, end)}\nreturn modelSelectionProjection;`)(z)
  const session = Session.create('child-model', undefined, { version: SESSION_FORMAT_VERSION, id: 'child-model',
    createdAt: 0, isSeeded: false, origin: 'subagent', parentSession: 'parent', delegationDepth: 1,
    agentPreset: 'claude-sdk-remote' })
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { reason: 'initial', header: { config: {
    provider: 'claude-sdk-remote', model: 'sonnet', reasoningEffort: 'high' } } })
  session.append('model/selection', { provider: 'claude-sdk-remote', model: 'haiku', reasoningEffort: 'low' })
  const replay = () => projection.wire.view(session.snapshotEvents().reduce(projection.apply, projection.init(session.header)))
  const { ChildModelBadge } = createMeterViews({ React: { createElement: (type, props, ...children) => ({ type, props, children }) } })
  const render = () => ChildModelBadge({ sessionId: session.id,
    useBridgeStatus: select => select({ model: 'haiku' }), useModelSelection: select => select(replay()),
    useSessionList: select => select({ byId: { [session.id]: { origin: session.header.origin } } }),
    useModelDirectory: select => select({ groups: [{ id: 'claude-sdk-remote', models: [{ id: 'sonnet', name: 'Sonnet 5.5' }] }] }),
  })
  assert.equal(replay().next.model, 'haiku')
  assert.deepEqual(render().children, ['Sonnet 5.5 · high'])
  session.append('request/header', { reason: 'resume', header: { config: { provider: 'claude-sdk-remote', model: 'sonnet' } } })
  assert.deepEqual(render().children, ['Sonnet 5.5 · 模型默认'])
  projection.wire.viewSchema.parse(replay())
})
