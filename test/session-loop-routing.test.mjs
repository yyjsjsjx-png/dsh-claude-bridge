import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSessionRoutedAgentLoop } from '../plugin/session-loop-routing.mjs'
import { createClaudeLoopAgent } from '../plugin/claude-agent.mjs'

test('单一原生 constructor 在声明式启动期间即按会话头分流，不构造兼容 factory', () => {
  const calls = []
  class Native {
    static Config = {}
    constructor(_ctx, config) {
      calls.push(['constructor', config])
      this.runtime = { ctx: {} }
      this.ownership = { isActive() {}, signal: {}, track() {} }
      for (const preset of config.agents) this.prepare(null, preset, {}, { header: { agentPreset: preset } })
    }
    prepare(_ctx, id) { calls.push(['native', id]); return id }
  }
  class Compat {
    constructor() { assert.fail('不能构造第二个工厂') }
    prepare(_ctx, id) { calls.push(['remote', id]); assert.ok(this instanceof Native); return id }
  }
  const Routed = makeSessionRoutedAgentLoop(Native, Compat)
  const config = { agents: ['standard', 'claude-sdk-remote'] }
  const factory = new Routed({}, config)
  assert.deepEqual(calls, [['constructor', config], ['native', 'standard'], ['remote', 'claude-sdk-remote']])
  assert.equal(Routed.Config, Native.Config)
  assert.equal(Object.getPrototypeOf(factory), Routed.prototype)
})

test('新版初始化入口按准备会话选择驱动，普通生命周期不走兼容副本', () => {
  const calls = []
  class Native {
    initializeAgent(ctx, options) { calls.push(['native', ctx, options]); return options.session }
  }
  class Compat {
    initializeAgent(ctx, options) { assert.ok(this instanceof Native); calls.push(['remote', ctx, options]); return options.session }
  }
  const routed = new (makeSessionRoutedAgentLoop(Native, Compat))()
  const ctx = {}, normal = { session: { header: { agentPreset: 'standard' } } }
  const remote = { session: { header: { agentPreset: 'claude-sdk-remote' } }, signal: {} }
  assert.equal(routed.initializeAgent(ctx, normal), normal.session)
  assert.equal(routed.initializeAgent(ctx, remote), remote.session)
  assert.deepEqual(calls, [['native', ctx, normal], ['remote', ctx, remote]])
})

test('桥接构造 seam 无损传递新版投影与lastTurn，普通Agent保持原类', () => {
  const args = [{}, 'session', {}, { header: { agentPreset: 'standard' } }, { inbox() {} }, 7]
  class Base { constructor(...input) { this.args = input } }
  const ordinary = createClaudeLoopAgent(Base, ...args)
  assert.equal(Object.getPrototypeOf(ordinary), Base.prototype)
  assert.deepEqual(ordinary.args, args)
  args[3] = { header: { agentPreset: 'claude-sdk-remote' } }
  const remote = createClaudeLoopAgent(Base, ...args)
  assert.ok(remote instanceof Base)
  assert.deepEqual(remote.args, args)
})
