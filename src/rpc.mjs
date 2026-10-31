import { randomUUID } from 'node:crypto'

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024
const MAX_INCOMING_IDS = 100_000
const textDecoder = new TextDecoder('utf-8', { fatal: true })

/** An RPC failure that does not contain request or response bodies. */
export class RpcError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'RpcError'
    this.code = code
  }
}

function cancelledError() {
  const error = new Error('请求已取消，远端执行状态需核实')
  error.name = 'AbortError'
  error.code = 'RPC_CANCELLED'
  return error
}

function closedError() {
  return new RpcError('连接已关闭，未完成请求的执行状态未知', 'RPC_CLOSED')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isId(value) {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function idKey(value) {
  return `${typeof value}:${String(value)}`
}

function validateMethod(method) {
  if (typeof method !== 'string' || method.length === 0) {
    throw new TypeError('RPC 方法名必须是非空字符串')
  }
}

function validateParams(params) {
  if (params !== undefined && (params === null || typeof params !== 'object')) {
    throw new TypeError('RPC 参数必须是对象或数组')
  }
}

/**
 * Run bidirectional JSON-RPC 2.0 messages over one NDJSON stream pair.
 * Each line contains one object; JSON-RPC batch arrays are unsupported.
 * The caller owns the streams. `closed` resolves with a body-free reason.
 */
export function createRpcPeer({
  input,
  output,
  handlers = {},
  onNotification,
  onClose,
  onDiagnostic,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
}) {
  if (!input || typeof input.on !== 'function' || !output || typeof output.write !== 'function') {
    throw new TypeError('RPC 需要可读输入流和可写输出流')
  }
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new RangeError('maxLineBytes 必须是正整数')
  }
  if (!isRecord(handlers)) throw new TypeError('handlers 必须是对象')
  if (onNotification !== undefined && typeof onNotification !== 'function') {
    throw new TypeError('onNotification 必须是函数')
  }
  if (onClose !== undefined && typeof onClose !== 'function') {
    throw new TypeError('onClose 必须是函数')
  }
  if (onDiagnostic !== undefined && typeof onDiagnostic !== 'function') {
    throw new TypeError('onDiagnostic 必须是函数')
  }

  const prefix = randomUUID()
  const pending = new Map()
  const incoming = new Map()
  const seenIncomingIds = new Set()
  let lineBuffer = Buffer.alloc(0)
  let lineBytes = 0
  let notificationQueue = Promise.resolve()
  let notificationBytes = 0
  let notificationFailure
  let counter = 0
  let isClosed = false
  let finishClosed
  const closed = new Promise((resolve) => { finishClosed = resolve })

  function diagnose(event, { id, method, startedAt, code } = {}) {
    if (!onDiagnostic) return
    const record = { event }
    if (typeof id === 'string' && /^[0-9a-f-]{36}:[1-9][0-9]*$/i.test(id)) record.requestId = id
    if (typeof method === 'string' && /^[a-zA-Z0-9_.$/-]{1,100}$/.test(method)
      && !/^(?:sk|pk|token|secret)[-_]/i.test(method)) record.method = method
    if (typeof startedAt === 'number') record.durationMs = Math.max(0, Date.now() - startedAt)
    if ((typeof code === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(code)) || Number.isInteger(code)) record.code = code
    try {
      const result = onDiagnostic(record)
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {})
    } catch { /* Diagnostics must not interrupt the transport. */ }
  }

  function finishPending(id, method, value) {
    const entry = pending.get(id)
    if (!entry) return false
    pending.delete(id)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (entry.signal && entry.abort) entry.signal.removeEventListener('abort', entry.abort)
    diagnose(method === 'resolve' ? 'rpc_request_result' : 'rpc_request_failed', {
      id, method: entry.method, startedAt: entry.startedAt,
      ...(method === 'reject' ? { code: value?.code } : {}),
    })
    entry[method](value)
    return true
  }

  function close(reason = 'closed') {
    if (isClosed) return
    isClosed = true
    input.removeListener('data', onData)
    input.removeListener('end', onInputEnd)
    input.removeListener('close', onInputClose)
    if (typeof input.pause === 'function') input.pause()
    // Keep the error listener until the underlying stream closes: a pending
    // write or read can still emit an error during owner-managed teardown.
    for (const controller of incoming.values()) controller.abort()
    incoming.clear()
    for (const id of [...pending.keys()]) finishPending(id, 'reject', closedError())
    const info = { reason: typeof reason === 'string' && /^[a-z0-9_]{1,40}$/.test(reason) ? reason : 'closed' }
    diagnose('rpc_closed', { code: info.reason })
    try { onClose?.(info) } catch { /* Close notifications cannot undo teardown. */ }
    finishClosed(info)
  }

  function send(message) {
    if (isClosed) throw closedError()
    let json
    try {
      json = JSON.stringify(message)
    } catch {
      throw new RpcError('RPC 消息无法序列化', 'RPC_SERIALIZE')
    }
    if (typeof json !== 'string') throw new RpcError('RPC 消息无法序列化', 'RPC_SERIALIZE')
    const frame = Buffer.from(`${json}\n`, 'utf8')
    if (frame.length - 1 > maxLineBytes) throw new RpcError('RPC 消息超过大小限制', 'RPC_TOO_LARGE')
    const buffered = typeof output.writableLength === 'number' ? output.writableLength : 0
    if (buffered + frame.length > maxLineBytes * 4 + 4) {
      close('output_backpressure')
      throw closedError()
    }
    try {
      output.write(frame)
    } catch {
      close('write_error')
      throw closedError()
    }
  }

  function notify(method, params) {
    validateMethod(method)
    validateParams(params)
    send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
    diagnose('rpc_notification_sent', { method })
  }

  function cancelPending(id, error) {
    if (!finishPending(id, 'reject', error)) return
    if (!isClosed) {
      try {
        notify('$/cancelRequest', { id })
        diagnose('rpc_cancel_sent', { id })
      } catch { /* Closing the peer rejects all other work. */ }
    }
  }

  function request(method, params, options = {}) {
    try {
      validateMethod(method)
      validateParams(params)
      if (!isRecord(options)) throw new TypeError('RPC 请求选项必须是对象')
      if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
        throw new RangeError('timeoutMs 必须是正整数')
      }
      if (options.signal !== undefined && (!options.signal || typeof options.signal.addEventListener !== 'function')) {
        throw new TypeError('signal 必须是 AbortSignal')
      }
    } catch (error) {
      return Promise.reject(error)
    }
    if (isClosed) return Promise.reject(closedError())
    if (options.signal?.aborted) return Promise.reject(cancelledError())
    const id = `${prefix}:${++counter}`
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal: options.signal, method, startedAt: Date.now() }
      entry.abort = () => cancelPending(id, cancelledError())
      if (options.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => cancelPending(id,
          new RpcError('请求超时，远端执行状态未知', 'RPC_TIMEOUT')), options.timeoutMs)
      }
      pending.set(id, entry)
      options.signal?.addEventListener('abort', entry.abort, { once: true })
      if (options.signal?.aborted) return entry.abort()
      try {
        send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
        diagnose('rpc_request_sent', { id, method })
      } catch (error) {
        finishPending(id, 'reject', error)
      }
    })
  }

  function sendError(id, code, message) {
    if (isClosed) return
    try { send({ jsonrpc: '2.0', id, error: { code, message } }) } catch { close('write_error') }
  }

  function handleCall(message, frameBytes) {
    if (typeof message.method !== 'string' || message.method.length === 0) return close('protocol_error')
    if ('params' in message && (message.params === null || typeof message.params !== 'object')) return close('protocol_error')
    if ('result' in message || 'error' in message) return close('protocol_error')
    if (!('id' in message)) {
      if (message.method === '$/cancelRequest') {
        if (!isRecord(message.params) || !isId(message.params.id)) return close('protocol_error')
        diagnose('rpc_cancel_received', { id: message.params.id })
        incoming.get(idKey(message.params.id))?.abort()
        return
      }
      if (onNotification) {
        diagnose('rpc_notification_received')
        notificationBytes += frameBytes
        if (notificationBytes > maxLineBytes * 4) return close('notification_backpressure')
        notificationQueue = notificationQueue
          .then(() => onNotification(message.method, message.params))
          .catch(() => {
            notificationFailure = new RpcError('通知处理失败', 'RPC_NOTIFICATION_FAILED')
            close('notification_error')
          })
          .finally(() => { notificationBytes -= frameBytes })
      }
      return
    }
    if (!isId(message.id)) return close('protocol_error')
    const key = idKey(message.id)
    if (seenIncomingIds.has(key) || seenIncomingIds.size >= MAX_INCOMING_IDS) return close('protocol_error')
    seenIncomingIds.add(key)
    const handler = Object.hasOwn(handlers, message.method) ? handlers[message.method] : undefined
    if (typeof handler !== 'function') {
      diagnose('rpc_handler_failed', { id: message.id, code: -32601 })
      return sendError(message.id, -32601, '方法不存在')
    }
    const controller = new AbortController()
    const startedAt = Date.now()
    diagnose('rpc_handler_started', { id: message.id, method: message.method })
    incoming.set(key, controller)
    Promise.resolve().then(async () => {
      try {
        const result = await handler(message.params, { signal: controller.signal, id: message.id, peer })
        if (isClosed) return
        if (controller.signal.aborted) {
          diagnose('rpc_handler_failed', { id: message.id, method: message.method, startedAt, code: -32800 })
          return sendError(message.id, -32800, '请求已取消')
        }
        try {
          send({ jsonrpc: '2.0', id: message.id, result: result === undefined ? null : result })
          diagnose('rpc_handler_result', { id: message.id, method: message.method, startedAt })
        } catch {
          diagnose('rpc_handler_failed', { id: message.id, method: message.method, startedAt, code: -32603 })
          sendError(message.id, -32603, '处理结果无法发送')
        }
      } catch {
        diagnose('rpc_handler_failed', { id: message.id, method: message.method, startedAt,
          code: controller.signal.aborted ? -32800 : -32000 })
        sendError(message.id, controller.signal.aborted ? -32800 : -32000,
          controller.signal.aborted ? '请求已取消' : '请求处理失败')
      } finally {
        incoming.delete(key)
      }
    })
  }

  function handleResponse(message) {
    if (!isId(message.id)) return close('protocol_error')
    if (('result' in message) === ('error' in message)) return close('protocol_error')
    if ('error' in message) {
      if (!isRecord(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string') {
        return close('protocol_error')
      }
      const error = message.error.code === -32800
        ? cancelledError()
        : new RpcError('远端请求失败', message.error.code)
      finishPending(message.id, 'reject', error)
      return
    }
    finishPending(message.id, 'resolve', message.result)
  }

  function handleLine(line) {
    if (line.length > 0 && line[line.length - 1] === 13) line = line.subarray(0, -1)
    let message
    try { message = JSON.parse(textDecoder.decode(line)) } catch { return close('protocol_error') }
    if (!isRecord(message) || message.jsonrpc !== '2.0') return close('protocol_error')
    if ('method' in message) handleCall(message, line.length)
    else handleResponse(message)
  }

  function onData(chunk) {
    if (isClosed) return
    if (typeof chunk === 'string') chunk = Buffer.from(chunk, 'utf8')
    if (!Buffer.isBuffer(chunk)) return close('protocol_error')
    let start = 0
    for (;;) {
      const end = chunk.indexOf(10, start)
      const part = end === -1 ? chunk.subarray(start) : chunk.subarray(start, end)
      const needed = lineBytes + part.length
      if (needed > maxLineBytes) return close('line_too_large')
      if (needed > lineBuffer.length) {
        const capacity = Math.min(maxLineBytes, Math.max(needed, lineBuffer.length * 2, 256))
        const next = Buffer.allocUnsafe(capacity)
        lineBuffer.copy(next, 0, 0, lineBytes)
        lineBuffer = next
      }
      part.copy(lineBuffer, lineBytes)
      lineBytes = needed
      if (end === -1) return
      const line = lineBuffer.subarray(0, lineBytes)
      lineBytes = 0
      handleLine(line)
      if (isClosed) return
      start = end + 1
      if (start === chunk.length) return
    }
  }

  function onInputEnd() { close(lineBytes ? 'protocol_error' : 'eof') }
  function onInputClose() { close(lineBytes ? 'protocol_error' : 'input_closed') }
  function onInputError() { close('read_error') }
  function onOutputError() { close('write_error') }
  function onOutputClose() { close('output_closed') }

  async function drainNotifications() {
    const queued = notificationQueue
    await queued
    if (notificationFailure) throw notificationFailure
  }

  const peer = { request, notify, close, closed, drainNotifications }
  input.on('data', onData)
  input.once('end', onInputEnd)
  input.once('close', onInputClose)
  input.on('error', onInputError)
  output.on('error', onOutputError)
  output.once('close', onOutputClose)
  return peer
}
