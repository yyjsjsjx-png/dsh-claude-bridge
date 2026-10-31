import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createRpcPeer } from '../src/rpc.mjs'
import { createSshTransport, validateRemoteWorkerPath } from '../src/ssh-transport.mjs'

class FakeSsh extends EventEmitter {
  constructor({ exitOnEof = true, exitOnTerm = true } = {}) {
    super()
    this.stdin = new PassThrough()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.exitOnTerm = exitOnTerm
    this.signals = []
    this.finished = false
    if (exitOnEof) this.stdin.once('finish', () => this.finish(0, null))
  }

  finish(code, signal) {
    if (this.finished) return
    this.finished = true
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.emit('close', code, signal))
  }

  kill(signal) {
    this.signals.push(signal)
    if (signal === 'SIGKILL' || this.exitOnTerm) this.finish(null, signal)
    return true
  }
}

test('使用 SSH 数组参数连接 au，并在 desktop 用户下启动远端程序', async (t) => {
  const child = new FakeSsh()
  let observed
  const transport = createSshTransport({
    workerPath: '/home/desktop/dsh-claude-bridge/worker.mjs',
    workerArgs: ['--stdio'],
    spawnImpl(command, args, options) {
      observed = { command, args, options }
      return child
    },
  })
  t.after(() => { child.finish(0, null); void transport.close() })
  const remote = createRpcPeer({ input: child.stdin, output: child.stdout, handlers: { ping: async () => 'pong' } })
  t.after(() => remote.close())
  assert.equal(await transport.peer.request('ping', {}), 'pong')
  assert.equal(observed.command, 'ssh')
  assert.deepEqual(observed.args, [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    'au', 'runuser', '-u', 'desktop', '--', 'node',
    '/home/desktop/dsh-claude-bridge/worker.mjs', '--stdio',
  ])
  assert.deepEqual(observed.options, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stderr.write('abcdef')
  assert.equal(transport.stderrTail, 'abcdef')
  const result = await transport.close()
  assert.deepEqual(result, { code: 0, signal: null, spawnError: false })
  assert.deepEqual(child.signals, [])
})

test('拒绝不安全的远端路径、命令与参数，且不会启动进程', () => {
  let called = false
  const spawnImpl = () => { called = true; throw new Error('must not spawn') }
  for (const workerPath of [
    '/root/worker.mjs',
    '/home/desktop/../root/worker.mjs',
    '/home/desktop/worker.mjs;touch/tmp/x',
    '/home/desktop/worker.mjs\nwhoami',
    '/home/desktop//worker.mjs',
  ]) {
    assert.throws(() => createSshTransport({ workerPath, spawnImpl }), TypeError)
  }
  assert.throws(() => createSshTransport({
    workerPath: '/home/desktop/worker.mjs', nodeCommand: 'node;id', spawnImpl,
  }), TypeError)
  assert.throws(() => createSshTransport({
    workerPath: '/home/desktop/worker.mjs', workerArgs: ['--x=$(whoami)'], spawnImpl,
  }), TypeError)
  assert.equal(validateRemoteWorkerPath('/home/desktop/.local/project/worker.mjs'), '/home/desktop/.local/project/worker.mjs')
  assert.equal(called, false)
})

test('stderr 只保留尾部，停止时等待进程退出并在必要时强制结束', async () => {
  const child = new FakeSsh({ exitOnEof: false, exitOnTerm: false })
  const diagnostics = []
  const transport = createSshTransport({
    workerPath: '/home/desktop/worker.mjs',
    maxStderrBytes: 5,
    stopGraceMs: 10,
    forceKillMs: 25,
    stopTimeoutMs: 200,
    onDiagnostic: (record) => diagnostics.push(record),
    spawnImpl: () => child,
  })
  child.stderr.write('123456789')
  assert.equal(transport.stderrTail, '56789')
  const result = await transport.close()
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
  assert.deepEqual(result, { code: null, signal: 'SIGKILL', spawnError: false })
  assert.ok(diagnostics.some((record) => record.event === 'ssh_exited' && record.stderrBytes === 9))
  assert.doesNotMatch(JSON.stringify(diagnostics), /123456789|56789/)
})

test('SSH 启动失败时拒绝待处理请求并可等待关闭', async () => {
  const child = new FakeSsh({ exitOnEof: false })
  const transport = createSshTransport({
    workerPath: '/home/desktop/worker.mjs',
    stopGraceMs: 10,
    forceKillMs: 20,
    stopTimeoutMs: 100,
    spawnImpl: () => child,
  })
  const pending = transport.peer.request('ping', {})
  child.emit('error', new Error('sensitive diagnostics'))
  await assert.rejects(pending, { code: 'RPC_CLOSED' })
  assert.equal((await transport.peer.closed).reason, 'ssh_spawn_error')
  await transport.close()
})
