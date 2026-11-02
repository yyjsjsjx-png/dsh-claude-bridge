import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSessionRoutedAgentLoop } from '../plugin/session-loop-routing.mjs'

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
