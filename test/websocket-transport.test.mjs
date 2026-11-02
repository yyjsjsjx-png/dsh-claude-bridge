import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createWebSocketTransport } from '../src/websocket-transport.mjs'

class FakeSocket extends EventTarget {
  constructor(onSend) {
    super()
    this.readyState = 0
    this.bufferedAmount = 0
    this.sent = []
    this.onSend = onSend
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  send(value) { this.sent.push(value); this.onSend?.(value, this) }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: value })) }
  close(code = 1000) {
    if (this.readyState === 3) return
    this.readyState = 3
    const event = new Event('close')
    Object.defineProperty(event, 'code', { value: code })
    this.dispatchEvent(event)
  }
}

function factoryWith(handler) {
  let socket
  let openedUrl
  return {
    factory(url) {
      openedUrl = url
      socket = new FakeSocket(handler)
      setImmediate(() => socket.open())
      return socket
    },
    get socket() { return socket },
    get url() { return openedUrl },
  }
}

test('新连接在 SSH 尚未恢复时自动等待，连通后只发送一次原 RPC', async t => {
  let sockets = 0, queries = 0
  const transport = await createWebSocketTransport({
    url: 'ws://127.0.0.1:18944/', token: 'T'.repeat(43), deviceId: randomUUID(),
    initialConnectWindowMs: 500, connectTimeoutMs: 100, reconnectDelays: [1],
    webSocketFactory() {
      const number = ++sockets
      const socket = new FakeSocket((line, active) => {
        const message = JSON.parse(line)
        if (message.type === 'auth') {
          queueMicrotask(() => number === 1 ? active.close(1013) : active.receive('{"type":"auth.ok","protocol":1}'))
        } else {
          queries++
          queueMicrotask(() => active.receive(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: 'ok' })}\n`))
        }
      })
      setImmediate(() => socket.open()); return socket
    },
  })
  t.after(() => transport.close())
  assert.equal(sockets, 2)
  assert.equal(await transport.peer.request('fixture', {}), 'ok')
  assert.equal(queries, 1)
})

test('首帧认证成功后传输单行 RPC，凭据不进入 URL 或诊断', async () => {
  const token = 'T'.repeat(43)
  const deviceId = randomUUID()
  const diagnostics = []
  const holder = factoryWith((value, socket) => {
    const message = JSON.parse(value)
    if (message.type === 'auth') {
      assert.deepEqual(message, { type: 'auth', protocol: 1, token, deviceId })
      queueMicrotask(() => socket.receive('{"type":"auth.ok","protocol":1}'))
    } else {
      assert.ok(value.endsWith('\n'))
      queueMicrotask(() => socket.receive(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: 'ok' })}\n`))
    }
  })
  const transport = await createWebSocketTransport({
    url: 'wss://example.test/bridge', token, deviceId,
    webSocketFactory: holder.factory,
    onDiagnostic: (record) => diagnostics.push(record),
  })
  assert.equal(await transport.peer.request('ping', { text: 'PRIVATE_REQUEST_BODY' }), 'ok')
  assert.equal(holder.url, 'wss://example.test/bridge')
  assert.ok(diagnostics.some((record) => record.event === 'websocket_authenticated'))
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_REQUEST_BODY|T{43}|example\.test/)
  await transport.close()
})

test('认证失败不启动 RPC，远程明文地址不创建连接', async () => {
  const holder = factoryWith((_value, socket) => queueMicrotask(() => socket.receive('{"type":"auth.error","protocol":1}')))
  await assert.rejects(createWebSocketTransport({
    url: 'wss://example.test/', token: 'T'.repeat(43), deviceId: randomUUID(), webSocketFactory: holder.factory,
  }), { code: 'AUTH_FAILED' })
  let created = false
  await assert.rejects(createWebSocketTransport({
    url: 'ws://example.test/', token: 'T'.repeat(43), deviceId: randomUUID(),
    webSocketFactory: () => { created = true },
  }), { code: 'INSECURE_URL' })
  assert.equal(created, false)
})

test('长 RPC 响应可接收，断线拒绝未完成请求且不自动重发', async () => {
  let calls = 0
  const holder = factoryWith((value, socket) => {
    const message = JSON.parse(value)
    if (message.type === 'auth') return queueMicrotask(() => socket.receive('{"type":"auth.ok","protocol":1}'))
    calls++
    if (message.method === 'large') {
      queueMicrotask(() => socket.receive(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: 'x'.repeat(100_000) })}\n`))
    }
  })
  const transport = await createWebSocketTransport({
    url: 'ws://127.0.0.1:18944/', token: 'T'.repeat(43), deviceId: randomUUID(), webSocketFactory: holder.factory,
  })
  assert.equal((await transport.peer.request('large', {})).length, 100_000)
  const pending = transport.peer.request('slow', {})
  await new Promise((resolve) => setImmediate(resolve))
  holder.socket.close(1006)
  await assert.rejects(pending, { code: 'RPC_CLOSED' })
  assert.equal(calls, 2)
  await transport.close()
})

test('非单行数据与认证超时关闭连接', async () => {
  const holder = factoryWith((_value, socket) => queueMicrotask(() => socket.receive('{"type":"auth.ok","protocol":1}')))
  const transport = await createWebSocketTransport({
    url: 'wss://example.test/', token: 'T'.repeat(43), deviceId: randomUUID(), webSocketFactory: holder.factory,
  })
  holder.socket.receive('{"jsonrpc":"2.0","method":"one"}\n{"jsonrpc":"2.0","method":"two"}\n')
  assert.equal((await transport.closed).reason, 'websocket_protocol_error')
  await transport.close()

  const silent = factoryWith(() => {})
  await assert.rejects(createWebSocketTransport({
    url: 'wss://example.test/', token: 'T'.repeat(43), deviceId: randomUUID(),
    connectTimeoutMs: 20, webSocketFactory: silent.factory,
  }), { code: 'CONNECT_TIMEOUT' })
})

test('恢复心跳携带四时间戳，重复或无效扩展不影响RPC或泄露内容', async t => {
  const recoveryId = randomUUID(), rows = []
  let clock = 1000, pong, pings = 0
  const holder = factoryWith((value, socket) => {
    const frame = JSON.parse(value)
    if (frame.type === 'auth') return queueMicrotask(() => socket.receive(JSON.stringify({ type: 'auth.ok', protocol: 1,
      recovery: { protocol: 'resume-v1', id: recoveryId, graceMs: 90000 } })))
    if (frame.type === 'recovery.negotiate') return queueMicrotask(() => socket.receive(JSON.stringify({
      type: 'recovery.ready', protocol: 1, id: recoveryId, ack: 0 })))
    if (frame.type === 'recovery.ping') {
      pings++
      assert.equal(frame.timing.version, 1)
      pong = { type: 'recovery.pong', protocol: 1, timing: { ...frame.timing, t2: 1110, t3: 1114 } }
      clock = 1024
      return queueMicrotask(() => socket.receive(JSON.stringify(pong)))
    }
    if (frame.jsonrpc) queueMicrotask(() => socket.receive(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: 'ok',
      _bridge: { sequence: 1, ack: frame._bridge.sequence } })}\n`))
  })
  const transport = await createWebSocketTransport({ url: 'ws://127.0.0.1:18944/', token: 'T'.repeat(43),
    deviceId: randomUUID(), webSocketFactory: holder.factory, networkNow: () => clock, onDiagnostic: row => rows.push(row) })
  t.after(() => transport.close())
  assert.equal(pings, 1)
  const sample = rows.find(row => row.event === 'perf.network')
  assert.equal(sample.stage, 'sample')
  assert.equal(sample.roundTripMs, 24)
  assert.equal(sample.networkRoundTripMs, 20)
  holder.socket.receive(JSON.stringify(pong))
  holder.socket.receive(JSON.stringify({ ...pong, timing: { version: 1, probeId: 1, t1: 'bad' } }))
  assert.equal(rows.filter(row => row.event === 'perf.network').length, 1)
  assert.equal(await transport.peer.request('echo', { text: 'PRIVATE_BODY' }), 'ok')
  assert.equal(transport.connected, true)
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_BODY|T{43}|127\.0\.0\.1|t1|probeId/)
})

test('旧服务普通pong明确unsupported，探测超时不触发重连，丢失attempt清除deadline', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  const recoveryId = randomUUID(), rows = [], sockets = []
  let mode = 'legacy', clock = 1000
  const transport = await createWebSocketTransport({ url: 'ws://127.0.0.1:18944/', token: 'T'.repeat(43), deviceId: randomUUID(),
    heartbeatMs: 20, heartbeatTimeoutMs: 1000, reconnectDelays: [1], networkNow: () => clock,
    onDiagnostic: row => rows.push(row),
    webSocketFactory() {
      const socket = new FakeSocket((value, active) => {
        const frame = JSON.parse(value)
        if (frame.type === 'auth') return queueMicrotask(() => active.receive(JSON.stringify({ type: 'auth.ok', protocol: 1,
          recovery: { protocol: 'resume-v1', id: recoveryId, graceMs: 90000, resumed: sockets.length > 1 } })))
        if (frame.type === 'recovery.negotiate') return queueMicrotask(() => active.receive(JSON.stringify({
          type: 'recovery.ready', protocol: 1, id: recoveryId, ack: 0 })))
        if (frame.type === 'recovery.ping' && mode === 'legacy') queueMicrotask(() => active.receive('{"type":"recovery.pong","protocol":1}'))
      })
      sockets.push(socket); setImmediate(() => socket.open()); return socket
    },
  })
  t.after(() => transport.close())
  assert.equal(rows.find(row => row.event === 'perf.network').stage, 'unsupported')
  mode = 'silent'; clock += 20
  t.mock.timers.tick(20)
  t.mock.timers.tick(20)
  assert.ok(rows.some(row => row.event === 'perf.network' && row.stage === 'timeout'))
  assert.equal(transport.connected, true)
  assert.equal(sockets.length, 1)
  const count = rows.filter(row => row.event === 'perf.network').length
  await transport.close()
  t.mock.timers.tick(100)
  assert.equal(rows.filter(row => row.event === 'perf.network').length, count)
})

test('恢复后旧socket的晚pong不能占用新attempt样本', { timeout: 3000 }, async t => {
  const recoveryId = randomUUID(), rows = [], sockets = [], pings = []
  let clock = 1000, connected = 0, acceptSecond
  const second = new Promise(resolve => { acceptSecond = resolve })
  const transport = await createWebSocketTransport({ url: 'ws://127.0.0.1:18944/', token: 'T'.repeat(43), deviceId: randomUUID(),
    reconnectDelays: [1], networkNow: () => clock, onDiagnostic: row => rows.push(row),
    onConnectionState: state => { if (state === 'connected' && ++connected === 2) acceptSecond() },
    webSocketFactory() {
      const number = sockets.length + 1
      const socket = new FakeSocket((value, active) => {
        const frame = JSON.parse(value)
        if (frame.type === 'auth') {
          clock = number * 1000
          return queueMicrotask(() => active.receive(JSON.stringify({ type: 'auth.ok', protocol: 1,
            recovery: { protocol: 'resume-v1', id: recoveryId, graceMs: 90000, resumed: number > 1 } })))
        }
        if (frame.type === 'recovery.negotiate') return queueMicrotask(() => active.receive(JSON.stringify({
          type: 'recovery.ready', protocol: 1, id: recoveryId, ack: 0 })))
        if (frame.type === 'recovery.ping') pings.push(frame.timing)
      })
      sockets.push(socket); setImmediate(() => socket.open()); return socket
    },
  })
  t.after(() => transport.close())
  sockets[0].close(1006)
  await second
  const timing = pings.at(-1)
  const pong = JSON.stringify({ type: 'recovery.pong', protocol: 1, timing: { ...timing, t2: 2110, t3: 2114 } })
  clock = 2024
  sockets[0].receive(pong)
  assert.equal(rows.filter(row => row.event === 'perf.network').length, 0)
  sockets[1].receive(pong)
  assert.equal(rows.filter(row => row.event === 'perf.network' && row.stage === 'sample').length, 1)
  assert.equal(transport.connected, true)
  assert.equal(sockets.length, 2)
})
