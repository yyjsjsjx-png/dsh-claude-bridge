import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createRpcPeer } from '../src/rpc.mjs'
import { createBridgeServer } from '../remote/server.mjs'

class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; this.closeCode = undefined }
  send(value, done) { this.sent.push(value); done?.(); this.emit('sent') }
  message(value, binary = false) { this.emit('message', Buffer.from(value), binary) }
  close(code) { if (this.readyState === 3) return; this.readyState = 3; this.closeCode = code; this.emit('close', code) }
  terminate() { this.close(1006) }
  pause() {}
  resume() {}
}

class FakeWss extends EventEmitter {
  connect(socket, address = '127.0.0.1') { this.emit('connection', socket, { socket: { remoteAddress: address } }) }
  close(done) { setImmediate(() => done?.()) }
}

class FakeWorker extends EventEmitter {
  constructor({ exitOnEof = true } = {}) {
    super()
    this.pid = 93210
    this.stdin = new PassThrough()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.finished = false
    this.peer = createRpcPeer({ input: this.stdin, output: this.stdout, handlers: { echo: async (params) => params } })
    if (exitOnEof) this.stdin.once('finish', () => this.finish(0))
  }
  finish(code) {
    if (this.finished) return
    this.finished = true
    this.peer.close()
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.emit('close', code))
  }
}

async function setup(t, options = {}) {
  const wss = new FakeWss()
  const workers = []
  const spawns = []
  const diagnostics = []
  let listenerOptions
  const token = 'Z'.repeat(43)
  const server = await createBridgeServer({
    remoteRoot: '/home/tester/portable bridge',
    workerPath: '/home/tester/portable bridge/remote/worker.mjs',
    tokenFile: '/home/tester/private/service-token',
    getUid: () => 1000,
    getUserInfo: () => ({ homedir: '/home/tester' }),
    loadToken: async () => token,
    webSocketServerFactory(listener) { listenerOptions = listener; setImmediate(() => wss.emit('listening')); return wss },
    spawnImpl(command, args, config) {
      const worker = new FakeWorker(options.workerOptions)
      workers.push(worker)
      spawns.push({ command, args, config })
      return worker
    },
    onDiagnostic: (record) => diagnostics.push(record),
    ...options.serverOptions,
  })
  t.after(async () => { for (const worker of workers) worker.finish(0); await server.close() })
  return { wss, workers, spawns, diagnostics, listenerOptions, token, server }
}

function authenticate(wss, token, deviceId = randomUUID(), address) {
  const socket = new FakeSocket()
  wss.connect(socket, address)
  socket.message(JSON.stringify({ type: 'auth', protocol: 1, token, deviceId }))
  return socket
}

test('只监听回环；认证后按设备启动 worker 并双向转发 RPC', async (t) => {
  const { wss, workers, spawns, diagnostics, listenerOptions, token } = await setup(t)
  assert.deepEqual(listenerOptions, { host: '127.0.0.1', port: 18944, maxPayload: 4 * 1024 * 1024 + 1, perMessageDeflate: false })
  const deviceId = randomUUID()
  const socket = authenticate(wss, token, deviceId)
  const auth = JSON.parse(socket.sent[0])
  assert.match(auth.recovery.id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(auth, { type: 'auth.ok', protocol: 1, compression: 'deflate-raw-v1',
    recovery: { protocol: 'resume-v1', id: auth.recovery.id, graceMs: 90_000, resumed: false } })
  assert.equal(workers.length, 1)
  assert.deepEqual(spawns[0].args, ['/home/tester/portable bridge/remote/worker.mjs'])
  assert.equal(spawns[0].config.env.BRIDGE_DEVICE_ID, deviceId)
  assert.equal(spawns[0].config.env.BRIDGE_REMOTE_ROOT, '/home/tester/portable bridge')
  assert.equal(spawns[0].config.env.CLAUDE_CONFIG_DIR, '/home/tester/portable bridge/claude-config')
  assert.doesNotMatch(JSON.stringify(spawns), /Z{43}/)
  const id = randomUUID() + ':1'
  socket.message(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'echo', params: { text: 'PRIVATE_MESSAGE' } })}\n`)
  while (socket.sent.length < 2) await new Promise((resolve) => socket.once('sent', resolve))
  assert.deepEqual(JSON.parse(socket.sent[1]), { jsonrpc: '2.0', id, result: { text: 'PRIVATE_MESSAGE' } })
  workers[0].stderr.write('PRIVATE_STDERR')
  socket.close(1000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_MESSAGE|PRIVATE_STDERR|Z{43}/)
})

test('错误凭据不启动 worker，失败次数达到上限后拒绝新连接', async (t) => {
  const { wss, workers, token } = await setup(t, { serverOptions: { maxFailedPerWindow: 2 } })
  for (let index = 0; index < 2; index++) {
    const socket = authenticate(wss, 'W'.repeat(43))
    assert.equal(socket.closeCode, 1008)
  }
  const blocked = authenticate(wss, token)
  assert.equal(blocked.closeCode, 1008)
  assert.equal(workers.length, 0)
})

test('多设备独立 worker；同设备并发连接在前一 worker 结束前拒绝', async (t) => {
  const { wss, workers, spawns, token } = await setup(t)
  const firstId = randomUUID()
  const secondId = randomUUID()
  const first = authenticate(wss, token, firstId)
  const second = authenticate(wss, token, secondId)
  assert.equal(workers.length, 2)
  assert.deepEqual(spawns.map((item) => item.config.env.BRIDGE_DEVICE_ID), [firstId, secondId])
  const duplicate = authenticate(wss, token, firstId)
  assert.equal(duplicate.closeCode, 1013)
  assert.equal(workers.length, 2)
  const firstWorkerClosed = new Promise((resolve) => workers[0].once('close', resolve))
  first.close(1000)
  await firstWorkerClosed
  const resumed = authenticate(wss, token, firstId)
  assert.equal(resumed.readyState, 1)
  assert.equal(workers.length, 3)
  resumed.close(1000)
  second.close(1000)
})

test('客户端断线时等待 worker，必要时按进程组终止', async (t) => {
  const signals = []
  let worker
  const { wss, workers, token, server } = await setup(t, {
    workerOptions: { exitOnEof: false },
    serverOptions: {
      stopGraceMs: 10, forceKillMs: 25, stopTimeoutMs: 200,
      killGroup(pid, signal) { signals.push([pid, signal]); if (signal === 'SIGKILL') worker.finish(null) },
    },
  })
  const socket = authenticate(wss, token)
  worker = workers[0]
  socket.close(1000)
  await server.close()
  assert.deepEqual(signals, [[93210, 'SIGTERM'], [93210, 'SIGKILL']])
})

test('服务拒绝 root、公网监听和错误协议帧', async (t) => {
  await assert.rejects(createBridgeServer({ getUid: () => 0 }), /非 root/)
  await assert.rejects(createBridgeServer({
    getUid: () => 1000, getUserInfo: () => ({ homedir: '/home/tester' }), host: '0.0.0.0',
  }), /回环/)
  const { wss, token } = await setup(t)
  const socket = authenticate(wss, token)
  const closed = new Promise((resolve) => socket.once('close', resolve))
  socket.message('{"jsonrpc":"2.0","method":"x"}\n{"jsonrpc":"2.0","method":"y"}\n')
  await closed
  assert.equal(socket.closeCode, 1002)
})

test('接回原 worker 后恢复握手卡住会超时停止', { timeout: 3000 }, async t => {
  const { wss, workers, token, diagnostics } = await setup(t, { serverOptions: { authTimeoutMs: 20 } })
  const deviceId = randomUUID()
  const first = authenticate(wss, token, deviceId)
  const id = JSON.parse(first.sent[0]).recovery.id
  const ready = new Promise(resolve => first.once('sent', resolve))
  first.message(JSON.stringify({ type: 'recovery.negotiate', protocol: 1, id, ack: 0, cancelIds: [] }))
  await ready
  first.close(1006)
  const socket = new FakeSocket()
  wss.connect(socket)
  const closed = new Promise(resolve => socket.once('close', resolve))
  socket.message(JSON.stringify({ type: 'auth', protocol: 1, token, deviceId, resume: { id, ack: 0 } }))
  await closed
  assert.equal(socket.closeCode, 4004)
  assert.equal(workers.length, 1)
  assert.ok(diagnostics.some(entry => entry.event === 'server_recovery_handshake_expired'))
})

test('新 Host 只回收已断开且同设备的旧 worker，新 worker 不伪装 RPC 接续', { timeout: 3000 }, async t => {
  const { wss, workers, token } = await setup(t)
  const deviceId = randomUUID(), first = authenticate(wss, token, deviceId)
  const oldId = JSON.parse(first.sent[0]).recovery.id
  const negotiated = new Promise(resolve => first.once('sent', resolve))
  first.message(JSON.stringify({ type: 'recovery.negotiate', protocol: 1, id: oldId, ack: 0, cancelIds: [] }))
  await negotiated
  first.close(1006)
  const rejected = authenticate(wss, 'W'.repeat(43), deviceId)
  assert.equal(rejected.closeCode, 1008)
  assert.equal(workers[0].finished, false)
  const replacement = authenticate(wss, token, deviceId)
  if (!replacement.sent.length) await new Promise(resolve => replacement.once('sent', resolve))
  assert.equal(workers[0].finished, true)
  assert.equal(workers.length, 2)
  const reply = JSON.parse(replacement.sent[0])
  assert.equal(reply.recovery.resumed, false)
  assert.notEqual(reply.recovery.id, oldId)
})
