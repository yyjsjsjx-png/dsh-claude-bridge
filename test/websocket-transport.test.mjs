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
