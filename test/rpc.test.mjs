import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createRpcPeer } from '../src/rpc.mjs'

function peers(leftHandlers = {}, rightHandlers = {}, options = {}) {
  const leftToRight = new PassThrough()
  const rightToLeft = new PassThrough()
  const left = createRpcPeer({ input: rightToLeft, output: leftToRight, handlers: leftHandlers, ...options.left })
  const right = createRpcPeer({ input: leftToRight, output: rightToLeft, handlers: rightHandlers, ...options.right })
  return { left, right, leftToRight, rightToLeft, close() { left.close(); right.close(); leftToRight.destroy(); rightToLeft.destroy() } }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('双向并发请求及请求中的反向回调可完成', async (t) => {
  const pair = peers(
    { twice: async ({ value }) => value * 2 },
    {
      relay: async ({ value }, { peer }) => ({ value: await peer.request('twice', { value }) }),
      add: async ({ a, b }) => a + b,
    },
  )
  t.after(() => pair.close())
  const [relay, sum] = await Promise.all([
    pair.left.request('relay', { value: 21 }),
    pair.left.request('add', { a: 2, b: 3 }),
  ])
  assert.deepEqual(relay, { value: 42 })
  assert.equal(sum, 5)
})

test('取消与超时传播到对端，其他并发请求继续运行', async (t) => {
  const started = deferred()
  const cancelled = deferred()
  const pair = peers({}, {
    wait: async (_params, { signal }) => {
      started.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      cancelled.resolve()
      throw new Error('handler stopped')
    },
    ready: async () => 'ready',
  })
  t.after(() => pair.close())
  const controller = new AbortController()
  const pending = pair.left.request('wait', {}, { signal: controller.signal })
  await started.promise
  assert.equal(await pair.left.request('ready', {}), 'ready')
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError', code: 'RPC_CANCELLED' })
  await cancelled.promise

  const timeoutStarted = deferred()
  const timeoutCancelled = deferred()
  const second = peers({}, {
    wait: async (_params, { signal }) => {
      timeoutStarted.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      timeoutCancelled.resolve()
    },
  })
  t.after(() => second.close())
  const timed = second.left.request('wait', {}, { timeoutMs: 100 })
  await timeoutStarted.promise
  await assert.rejects(timed, { code: 'RPC_TIMEOUT' })
  await timeoutCancelled.promise
})

test('EOF 会拒绝所有未完成请求并中止对端工作', async (t) => {
  const started = deferred()
  const stopped = deferred()
  const pair = peers({}, {
    wait: async (_params, { signal }) => {
      started.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      stopped.resolve()
    },
  })
  t.after(() => pair.close())
  const pending = pair.left.request('wait', {})
  await started.promise
  pair.rightToLeft.end()
  await assert.rejects(pending, { code: 'RPC_CLOSED' })
  assert.equal((await pair.left.closed).reason, 'eof')
  pair.right.close()
  await stopped.promise
})

test('多行同块、UTF-8 跨块和通知按消息处理', async (t) => {
  const input = new PassThrough()
  const output = new PassThrough()
  const received = []
  const done = deferred()
  const peer = createRpcPeer({
    input, output, maxLineBytes: 100,
    onNotification(method, params) {
      received.push([method, params])
      if (received.length === 2) done.resolve()
    },
  })
  t.after(() => { peer.close(); input.destroy(); output.destroy() })
  const frame = Buffer.from('{"jsonrpc":"2.0","method":"one","params":{"text":"中文"}}\n{"jsonrpc":"2.0","method":"two","params":{}}\n')
  const split = frame.indexOf(Buffer.from('中文')) + 1
  input.write(frame.subarray(0, split))
  input.write(frame.subarray(split))
  await done.promise
  assert.deepEqual(received, [['one', { text: '中文' }], ['two', {}]])
})

test('异步通知保持顺序，等待时不阻塞请求', async (t) => {
  const started = deferred()
  const release = deferred()
  const complete = deferred()
  const events = []
  const pair = peers({}, { ready: async () => 'ready' }, {
    left: {
      onNotification: async (method) => {
        events.push(`${method}:start`)
        if (method === 'first') { started.resolve(); await release.promise }
        events.push(`${method}:end`)
        if (method === 'second') complete.resolve()
      },
    },
  })
  t.after(() => pair.close())
  pair.right.notify('first', {})
  await started.promise
  pair.right.notify('second', {})
  assert.equal(await pair.left.request('ready', {}), 'ready')
  assert.deepEqual(events, ['first:start'])
  release.resolve()
  await complete.promise
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end'])
})

test('等待已收到的尾部通知处理完成，再结束步骤', async (t) => {
  const started = deferred()
  const release = deferred()
  let processed = false
  const pair = peers({}, {
    query: async (_params, { peer }) => {
      peer.notify('sdk.message', { text: 'tail' })
      return { finished: true }
    },
  }, {
    left: { onNotification: async () => { started.resolve(); await release.promise; processed = true } },
  })
  t.after(() => pair.close())
  const response = await pair.left.request('query', {})
  await started.promise
  assert.deepEqual(response, { finished: true })
  let drained = false
  const pendingDrain = pair.left.drainNotifications().then(() => { drained = true })
  await Promise.resolve()
  assert.equal(drained, false)
  release.resolve()
  await pendingDrain
  assert.equal(processed, true)
})

test('非法 JSON、无效 UTF-8 和超长行关闭连接且不回显正文', async (t) => {
  for (const inputBytes of [Buffer.from('invalid-private-body\n'), Buffer.from([0xff, 10]), Buffer.from('x'.repeat(65))]) {
    const input = new PassThrough()
    const output = new PassThrough()
    const written = []
    output.on('data', (part) => written.push(part))
    const peer = createRpcPeer({ input, output, maxLineBytes: 64 })
    input.write(inputBytes)
    const closed = await peer.closed
    assert.ok(['protocol_error', 'line_too_large'].includes(closed.reason))
    assert.equal(Buffer.concat(written).length, 0)
    input.destroy()
    output.destroy()
  }
})

test('重复请求 ID 不会再次执行，处理错误不会泄漏正文', async (t) => {
  const input = new PassThrough()
  const output = new PassThrough()
  const started = deferred()
  let calls = 0
  const peer = createRpcPeer({
    input, output,
    handlers: { run: async (_params, { signal }) => {
      calls++
      started.resolve()
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    } },
  })
  t.after(() => { peer.close(); input.destroy(); output.destroy() })
  const line = '{"jsonrpc":"2.0","id":"same","method":"run","params":{}}\n'
  input.write(line)
  await started.promise
  input.write(line)
  assert.equal((await peer.closed).reason, 'protocol_error')
  assert.equal(calls, 1)

  const pair = peers({}, { fail: async () => { throw new Error('private-handler-body') } })
  t.after(() => pair.close())
  await assert.rejects(pair.left.request('fail', {}), (error) => {
    assert.equal(error.code, -32000)
    assert.doesNotMatch(error.message, /private-handler-body/)
    return true
  })
})

test('诊断仅包含元数据，记录失败不会影响正常请求', async (t) => {
  const records = []
  const diagnostic = (record) => {
    records.push(record)
    if (record.event === 'rpc_handler_started') throw new Error('diagnostic failed')
  }
  const pair = peers({}, {
    echo: async ({ value }) => value,
    fail: async () => { throw new Error('PRIVATE_HANDLER_BODY') },
  }, { left: { onDiagnostic: diagnostic }, right: { onDiagnostic: diagnostic } })
  t.after(() => pair.close())
  assert.equal(await pair.left.request('echo', { value: 'PRIVATE_REQUEST_BODY' }), 'PRIVATE_REQUEST_BODY')
  await assert.rejects(pair.left.request('fail', {}), { code: -32000 })
  assert.ok(records.some((record) => record.event === 'rpc_request_result' && record.method === 'echo'))
  assert.ok(records.some((record) => record.event === 'rpc_handler_failed' && record.code === -32000))
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_REQUEST_BODY|PRIVATE_HANDLER_BODY/)
})
