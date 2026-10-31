import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installControllerGuards } from '../plugin/controller-guards.mjs'

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
test('安装版原生控制器保留 RPC 签名和身份，实际调用命中实例守卫，卸载后恢复', { skip: !native }, async () => {
  const { resolveDshModule } = await import('../plugin/compat/resolve-dsh-module.mjs')
  const { SessionController } = await import(resolveDshModule('@deepseek-ai/dsh-api-session-controller'))
  const { Remote, RemoteError, remoteMethods } = await import(resolveDshModule('@deepseek-ai/dsh-typert-protocol'))
  const { TypertGatewayService } = await import(pathToFileURL(join(process.env.DSH_CLAUDE_BRIDGE_RESOURCES,
    'app.asar/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js')).href)
  const controller = Object.create(SessionController.prototype)
  // Run the native Remote instance initializer without starting a Host or
  // touching file-upload resolvers, persistence, credentials or user sessions.
  const initializers = []
  Remote('selectModel')(SessionController.prototype.selectModel, { kind: 'method', name: 'selectModel',
    static: false, private: false, addInitializer: callback => initializers.push(callback) })
  for (const initialize of initializers) initialize.call(controller)
  const session = { id: 'fixture', header: { agentPreset: 'standard' } }
  let calls = 0
  controller.agents = { resolveAgent: async () => ({ agent: { id: session.id, session } }) }
  controller.commands = { async selectModel() { calls++; return { selected: {} } } }
  const registry = { async select() {} }
  const ctx = { sessionController: controller, agentPresets: registry,
    agentDefaultModel: { async saveSelection() {} },
    sessionProjections: { stateOf: () => 'standard' } }
  const gateway = Object.create(TypertGatewayService.prototype)
  Object.defineProperty(gateway, 'ctx', { value: { typert: { lookups: { definitions: () => [] } } } })
  const marker = remoteMethods(controller).find(item => item.method === 'selectModel')
  assert.ok(marker)
  const binding = { service: controller, serviceKey: 'sessionController', namespace: 'session' }
  const original = controller.selectModel
  const before = gateway.srcDescriptor(binding, marker, 'selectModel', 'session/selectModel')
  const dispose = installControllerGuards(ctx, RemoteError)
  try {
    assert.equal(Object.getPrototypeOf(controller), SessionController.prototype)
    assert.equal(SessionController.prototype.selectModel, original)
    assert.deepEqual(gateway.srcDescriptor(binding, marker, 'selectModel', 'session/selectModel'), before)
    assert.deepEqual(before.parameters.map(parameter => parameter.wire), ['request'])
    // Gateway dispatch retrieves the implementation from this same receiver.
    await assert.rejects(Reflect.get(controller, 'selectModel').call(controller,
      { sessionId: 'fixture', provider: 'claude-sdk-remote', model: 'fixture' }),
    error => error.code === 'agent-preset/locked')
    assert.equal(calls, 0)
  } finally { dispose() }
  assert.equal(controller.selectModel, original)
  assert.equal((await controller.selectModel({ sessionId: 'fixture' })).selected.constructor, Object)
  assert.equal(calls, 1)
})
