import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { deflateRawSync } from 'node:zlib'
import { createRpcPeer } from '../src/rpc.mjs'
import { createWebSocketTransport } from '../src/websocket-transport.mjs'
import { decodeFrame } from '../src/websocket-compression.mjs'
import { createBridgeServer } from '../remote/server.mjs'

class ServerSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = [] }
  send(frame, done) {
    this.sent.push(frame)
    queueMicrotask(() => {
      if (this.readyState === 1 && !this.dropFrames) this.browser.receive(frame)
      done?.()
    })
  }
  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', code)
    this.browser.finish(code)
  }
  terminate() { this.close(1006) }
  pause() {}
  resume() {}
}
class BrowserSocket extends EventTarget {
  constructor(server) { super(); this.server = server; server.browser = this; this.readyState = 0; this.bufferedAmount = 0; this.sent = [] }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  send(frame) {
    this.sent.push(frame)
    this.dispatchEvent(new Event('sent'))
    queueMicrotask(() => {
      if (this.readyState === 1 && !this.dropAll && !(this.dropRequests && (typeof frame !== 'string' || frame.endsWith('\n')))) {
        this.server.emit('message', Buffer.from(frame), typeof frame !== 'string')
      }
    })
  }
  receive(frame) { this.dispatchEvent(new MessageEvent('message', { data: frame })) }
  finish(code) {
    if (this.readyState === 3) return
    this.readyState = 3
    const event = new Event('close')
    Object.defineProperty(event, 'code', { value: code })
    this.dispatchEvent(event)
  }
  close(code = 1000) { this.server.close(code) }
}
class FakeWss extends EventEmitter {
  close(done) { setImmediate(() => done?.()) }
}
class FakeWorker extends EventEmitter {
  constructor(calls) {
    super()
    this.pid = 12345
    this.stdin = new PassThrough()
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.finished = false
    this.peer = createRpcPeer({ input: this.stdin, output: this.stdout, handlers: {
      echo: async (params) => { calls.push(params); return params },
      wait: async (_params, { signal }) => {
        this.emit('waiting')
        return new Promise((resolve) => signal.addEventListener('abort', () => {
          this.emit('cancelled')
          resolve('cancelled')
        }, { once: true }))
      },
    } })
    this.stdin.once('finish', () => this.finish())
  }
  finish() {
    if (this.finished) return
    this.finished = true
    this.peer.close()
    this.stdout.end()
    this.stderr.end()
    setImmediate(() => this.emit('close', 0))
  }
}

async function setup(t, { serverOptions = {}, transportOptions = {} } = {}) {
  const wss = new FakeWss()
  const sockets = [], browsers = []
  const calls = []
  const workers = []
  const diagnostics = []
  const token = 'T'.repeat(43)
  const server = await createBridgeServer({
    getUid: () => 1000, getUserInfo: () => ({ homedir: '/home/tester' }),
    loadToken: async () => token,
    webSocketServerFactory() { setImmediate(() => wss.emit('listening')); return wss },
    spawnImpl() { const worker = new FakeWorker(calls); workers.push(worker); return worker },
    onDiagnostic: (entry) => diagnostics.push(entry),
    ...serverOptions,
  })
  const transport = await createWebSocketTransport({
    url: 'ws://127.0.0.1:18944/', token, deviceId: randomUUID(),
    webSocketFactory() {
      const socket = new ServerSocket()
      const browser = new BrowserSocket(socket)
      sockets.push(socket); browsers.push(browser)
      setImmediate(() => { wss.emit('connection', socket, { socket: { remoteAddress: '127.0.0.1' } }); browser.open() })
      return browser
    },
    onDiagnostic: (entry) => diagnostics.push(entry),
    ...transportOptions,
  })
  t.after(async () => { await transport.close(); for (const worker of workers) worker.finish(); await server.close() })
  return { transport, browser: browsers[0], socket: sockets[0], sockets, browsers, workers, calls, diagnostics, token }
}

test('认证帧保持纯文本，大消息双向压缩并保持请求顺序', async (t) => {
  const { transport, browser, socket, calls, diagnostics, token } = await setup(t)
  assert.equal(typeof browser.sent[0], 'string')
  assert.equal(JSON.parse(browser.sent[0]).token, token)
  assert.deepEqual(JSON.parse(browser.sent[1]), { type: 'compression.negotiate', protocol: 1, compression: 'deflate-raw-v1' })
  assert.ok(!browser.sent[1].includes(token))
  const input = { text: '较长的重复内容'.repeat(5000) }
  const first = transport.peer.request('echo', input)
  const second = transport.peer.request('echo', { text: 'small' })
  assert.deepEqual(await first, input)
  assert.deepEqual(await second, { text: 'small' })
  assert.deepEqual(calls, [input, { text: 'small' }])
  const requests = browser.sent.filter(frame => typeof frame !== 'string' || frame.endsWith('\n'))
  assert.ok(Buffer.isBuffer(requests[0]))
  assert.ok(requests[0].length < Buffer.byteLength(JSON.stringify(input), 'utf8') / 3)
  assert.equal(typeof requests[1], 'string')
  assert.ok(socket.sent.some((frame) => Buffer.isBuffer(frame)))
  assert.ok(diagnostics.some((entry) => entry.event === 'websocket_compression_negotiated'))
  assert.doesNotMatch(JSON.stringify(diagnostics), /较长的重复内容|T{43}/)
})

test('包含图片的内容不再次压缩，取消仍能传至对端', { timeout: 5000 }, async (t) => {
  const { transport, browser, socket, workers } = await setup(t)
  const image = { type: 'image', source: { type: 'base64', data: 'A'.repeat(10000) } }
  assert.deepEqual(await transport.peer.request('echo', { image }), { image })
  assert.equal(typeof browser.sent.find(frame => typeof frame !== 'string' || frame.endsWith('\n')), 'string')
  assert.equal(typeof socket.sent.at(-1), 'string')
  const controller = new AbortController()
  const observed = new Promise((resolve) => workers[0].once('cancelled', resolve))
  const waiting = new Promise(resolve => workers[0].once('waiting', resolve))
  const pending = transport.peer.request('wait', { text: 'x'.repeat(5000) }, { signal: controller.signal })
  // Wait for the actual outgoing request, then cancel it.
  await waiting
  controller.abort()
  await assert.rejects(pending, { code: 'RPC_CANCELLED' })
  await observed
  assert.equal(typeof browser.sent.at(-1), 'string')
  assert.ok(browser.sent.some(frame => typeof frame === 'string' && /\$\/cancelRequest/.test(frame)))
})

test('压缩帧拒绝超额解压、错误长度和多余尾部数据', async () => {
  const raw = Buffer.from('x'.repeat(10_000))
  const body = deflateRawSync(raw)
  const header = Buffer.alloc(8)
  header.write('DSH1')
  header.writeUInt32BE(100, 4)
  await assert.rejects(decodeFrame(Buffer.concat([header, body]), { enabled: true, maxLineBytes: 1024 }))
  header.writeUInt32BE(raw.length, 4)
  await assert.rejects(decodeFrame(Buffer.concat([header, body, Buffer.from('extra')]), { enabled: true, maxLineBytes: 20_000 }))
  await assert.rejects(decodeFrame(Buffer.concat([header, body]), { enabled: false, maxLineBytes: 20_000 }))
})

test('无效二进制帧立即关闭连接', async (t) => {
  const { transport, socket } = await setup(t)
  socket.send(Buffer.from('malformed'))
  assert.equal((await transport.closed).reason, 'websocket_protocol_error')
})

const fastRecovery = { reconnectDelays: [5], reconnectWindowMs: 500, heartbeatMs: 1000, heartbeatTimeoutMs: 2000 }
async function until(check) {
  const deadline = Date.now() + 1500
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('未观察到预期状态')
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('短断保留原 RPC 与 worker，丢失的响应补齐且原请求只执行一次', { timeout: 3000 }, async t => {
  const states = []
  const f = await setup(t, { transportOptions: { ...fastRecovery, onConnectionState: value => states.push(value) } })
  assert.equal(f.transport.recoverable, true)
  f.socket.dropFrames = true
  const pending = f.transport.peer.request('echo', { synthetic: 'lost-response' })
  await until(() => f.calls.length === 1)
  f.socket.close(1006)
  assert.equal(f.workers[0].finished, false)
  assert.deepEqual(await pending, { synthetic: 'lost-response' })
  assert.equal(f.workers.length, 1)
  assert.equal(f.calls.length, 1)
  assert.equal(f.browsers.length, 2)
  assert.deepEqual(states, ['connected', 'reconnecting', 'connected'])
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /lost-response|T{43}/)
})

test('通知提交完成前不发 ACK，重连重复帧只投影一次', { timeout: 3000 }, async t => {
  let commit
  const barrier = new Promise(resolve => { commit = resolve })
  const events = []
  const f = await setup(t, { transportOptions: { ...fastRecovery,
    async onNotification(method, params) { events.push({ method, params }); await barrier },
  } })
  f.workers[0].peer.notify('sdk.message', { synthetic: 'one-event' })
  await until(() => events.length === 1)
  assert.equal(f.browser.sent.filter(frame => typeof frame === 'string' && frame.includes('recovery.ack')).length, 0)
  f.socket.close(1006)
  await until(() => f.browsers.length === 2 && f.transport.connected)
  commit()
  await f.transport.peer.request('echo', { barrier: true })
  await f.transport.peer.drainNotifications()
  assert.equal(events.length, 1)
  assert.equal(f.workers.length, 1)
})

test('离线停止优先送达原 worker，不重建 query', { timeout: 3000 }, async t => {
  const f = await setup(t, { transportOptions: fastRecovery })
  const waiting = new Promise(resolve => f.workers[0].once('waiting', resolve))
  const cancelled = new Promise(resolve => f.workers[0].once('cancelled', resolve))
  const controller = new AbortController()
  const pending = f.transport.peer.request('wait', {}, { signal: controller.signal })
  await waiting
  f.socket.close(1006)
  controller.abort()
  await assert.rejects(pending, { code: 'RPC_CANCELLED' })
  await cancelled
  assert.equal(f.workers.length, 1)
  const negotiation = f.browsers.at(-1).sent.filter(frame => typeof frame === 'string')
    .map(frame => JSON.parse(frame)).find(message => message.type === 'recovery.negotiate')
  assert.equal(negotiation.cancelIds.length, 1)
})

test('未送达的 query 在离线取消后被挡住，恢复时不执行原操作', { timeout: 3000 }, async t => {
  const f = await setup(t, { transportOptions: fastRecovery })
  f.browser.dropRequests = true
  const controller = new AbortController()
  const pending = f.transport.peer.request('echo', { originalOperation: true }, { signal: controller.signal })
  await until(() => f.browser.sent.some(frame => typeof frame === 'string' && frame.endsWith('\n')))
  f.socket.close(1006); controller.abort()
  await assert.rejects(pending, { code: 'RPC_CANCELLED' })
  await until(() => f.browsers.length === 2 && f.transport.connected)
  await f.transport.peer.request('echo', { afterStop: true })
  assert.deepEqual(f.calls, [{ afterStop: true }])
  assert.equal(f.workers.length, 1)
})

test('保留期过后明确未知，不启动替代 worker 或自动重发原运行', { timeout: 3000 }, async t => {
  const f = await setup(t, { serverOptions: { recoveryGraceMs: 20 },
    transportOptions: { ...fastRecovery, reconnectDelays: [60] } })
  const waiting = new Promise(resolve => f.workers[0].once('waiting', resolve))
  const pending = f.transport.peer.request('wait', {}).catch(error => error)
  await waiting
  f.socket.close(1006)
  assert.equal((await f.transport.closed).reason, 'recovery_unavailable')
  assert.equal((await pending).code, 'RPC_CLOSED')
  assert.equal(f.workers.length, 1)
  assert.equal(f.workers[0].finished, true)
})

test('心跳发现半开连接并接回原 worker，旧连接失效', { timeout: 3000 }, async t => {
  const f = await setup(t, { transportOptions: { ...fastRecovery, heartbeatMs: 5, heartbeatTimeoutMs: 15 } })
  f.socket.dropFrames = true
  await until(() => f.browsers.length === 2 && f.transport.connected)
  assert.equal(f.socket.readyState, 3)
  assert.equal(f.workers.length, 1)
  assert.deepEqual(await f.transport.peer.request('echo', { heartbeat: true }), { heartbeat: true })
})

test('云端发现客户端失联后有限保留，不无限挂起原 worker', { timeout: 3000 }, async t => {
  const f = await setup(t, { serverOptions: { heartbeatMs: 5, heartbeatTimeoutMs: 15, recoveryGraceMs: 20 },
    transportOptions: { ...fastRecovery, reconnectDelays: [80] } })
  f.browser.dropAll = true
  assert.equal((await f.transport.closed).reason, 'recovery_unavailable')
  assert.equal(f.workers.length, 1)
  assert.equal(f.workers[0].finished, true)
  assert.ok(f.diagnostics.some(entry => entry.event === 'server_heartbeat_expired'))
})
