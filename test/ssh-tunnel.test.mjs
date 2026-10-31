import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { superviseSshTunnel } from '../src/ssh-tunnel.mjs'

test('SSH 子进程退出后自动重建同一回环转发，停止只终止自有子进程', async t => {
  const children = [], configs = [], states = []
  const tunnel = superviseSshTunnel({ target: 'fixture-host', retryDelays: [1], onState: value => states.push(value),
    spawnProcess(command, args, options) {
      configs.push({ command, args, options })
      const child = new EventEmitter(); child.pid = 40_000 + children.length
      child.kill = signal => { child.killed = signal; setImmediate(() => child.emit('close', 0)); return true }
      children.push(child); setImmediate(() => child.emit('spawn')); return child
    } })
  t.after(() => tunnel.close())
  children[0].emit('close', 255)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(children.length, 2)
  assert.deepEqual(configs[0], configs[1])
  assert.equal(configs[0].options.windowsHide, true)
  assert.equal(configs[0].options.shell, false)
  assert.equal(configs[0].options.stdio, 'ignore')
  assert.ok(configs[0].args.includes('127.0.0.1:18944:127.0.0.1:18944'))
  assert.ok(configs[0].args.includes('BatchMode=yes'))
  await tunnel.close()
  assert.equal(children[0].killed, undefined)
  assert.equal(children[1].killed, 'SIGTERM')
  assert.equal(states.at(-1).status, 'stopped')
})
