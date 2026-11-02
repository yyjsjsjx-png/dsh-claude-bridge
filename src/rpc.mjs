import { randomUUID } from 'node:crypto'

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024
const MAX_INCOMING_IDS = 100_000
const MAX_TIMING_BUCKETS = 2048
const RPC_ID = /^[0-9a-f-]{36}:[1-9][0-9]*$/i
const RUN_ID = /^(?:[0-9a-f-]{36}|run-[a-z0-9_.-]{1,100})$/i
const safeCallId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value)
  && !/^(?:sk|pk|token|secret)[-_]/i.test(value)
const safeMethod = value => typeof value === 'string' && /^[a-zA-Z0-9_.$/-]{1,100}$/.test(value)
  && !/^(?:sk|pk|token|secret)[-_]/i.test(value)
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
  onTraffic,
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
  if (onTraffic !== undefined && typeof onTraffic !== 'function') throw new TypeError('onTraffic 必须是函数')
  const traffic = (direction, message, origin, at) => { try { onTraffic?.({ direction, message, origin, at }) } catch {} }

  const prefix = randomUUID()
  const pending = new Map()
  const incoming = new Map()
  const seenIncomingIds = new Set()
  const timings = new Map()
  let lineBuffer = Buffer.alloc(0)
  let lineBytes = 0
  let notificationQueue = Promise.resolve()
  let notificationBytes = 0
  let notificationFailure
  let counter = 0
  let isClosed = false
  let finishClosed
  const closed = new Promise((resolve) => { finishClosed = resolve })

  function diagnose(event, { id, method, startedAt, code, runId, stage, durationMs, bytes, samples, maxMs } = {}) {
    if (!onDiagnostic) return
    const record = { event }
    if (typeof id === 'string' && RPC_ID.test(id)) record.requestId = id
    if (safeMethod(method)) record.method = method
    if (typeof startedAt === 'number') record.durationMs = Math.max(0, Date.now() - startedAt)
    if (event === 'perf.rpc') {
      if (typeof runId === 'string' && RUN_ID.test(runId)) record.runId = runId
      record.stage = stage
      if (Number.isFinite(durationMs) && durationMs >= 0) record.durationMs = durationMs
      if (Number.isSafeInteger(bytes) && bytes >= 0) record.bytes = bytes
      record.samples = samples
      record.maxMs = maxMs
    }
    if ((typeof code === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(code)) || Number.isInteger(code)) record.code = code
    try {
      const result = onDiagnostic(record)
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {})
    } catch { /* Diagnostics must not interrupt the transport. */ }
  }

  function rpcMetadata(message, request) {
    if (!onDiagnostic && !onTraffic) return {}
    try {
      const origin = request ?? (typeof message.method === 'string' ? message : pending.get(message.id))
      const runId = origin?.params?.runId ?? origin?.runId
      const callId = origin?.params?.callId ?? origin?.callId
      return { ...(typeof message.id === 'string' && RPC_ID.test(message.id) ? { id: message.id } : {}),
        ...(safeMethod(origin?.method) ? { method: origin.method } : {}),
        ...(typeof runId === 'string' && RUN_ID.test(runId) ? { runId } : {}),
        ...(safeCallId(callId) ? { callId } : {}) }
    } catch { return {} }
  }

  function rpcTiming(stage, startedAt, bytes, metadata) {
    if (!onDiagnostic || isClosed) return
    const durationMs = Math.max(0, performance.now() - startedAt)
    const group = metadata.runId ? `run:${metadata.runId}` : metadata.id ? `request:${metadata.id}` : 'notifications'
    const key = JSON.stringify([group, metadata.method, stage])
    let row = timings.get(key)
    if (!row) {
      if (timings.size >= MAX_TIMING_BUCKETS) return
      row = { ...metadata, group, stage, durationMs: 0, bytes: 0, samples: 0, maxMs: 0 }
      timings.set(key, row)
    }
    if (row.id !== metadata.id) delete row.id
    row.durationMs += durationMs; row.bytes += bytes; row.samples++
    row.maxMs = Math.max(row.maxMs, durationMs)
  }

  function flushTimings(group) {
    for (const [key, { group: owner, ...row }] of timings) {
      if (group !== undefined && group !== owner) continue
      timings.delete(key)
      diagnose('perf.rpc', row)
    }
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
    if (!entry.runId) flushTimings(`request:${id}`)
    else if (entry.method === 'query') {
      // Do not log every streamed delta. Include the already-received tail's
      // queue/handler intervals without delaying or awaiting the RPC result.
      notificationQueue.then(() => flushTimings(`run:${entry.runId}`)).catch(() => {})
    }
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
    flushTimings()
    const info = { reason: typeof reason === 'string' && /^[a-z0-9_]{1,40}$/.test(reason) ? reason : 'closed' }
    diagnose('rpc_closed', { code: info.reason })
    try { onClose?.(info) } catch { /* Close notifications cannot undo teardown. */ }
    finishClosed(info)
  }

  function send(message, request) {
    if (isClosed) throw closedError()
    const encodingAt = performance.now()
    let json
    try {
      json = JSON.stringify(message)
    } catch {
      throw new RpcError('RPC 消息无法序列化', 'RPC_SERIALIZE')
    }
    if (typeof json !== 'string') throw new RpcError('RPC 消息无法序列化', 'RPC_SERIALIZE')
    const frame = Buffer.from(`${json}\n`, 'utf8')
    const metadata = rpcMetadata(message, request)
    rpcTiming('encode', encodingAt, frame.length, metadata)
    if (frame.length - 1 > maxLineBytes) throw new RpcError('RPC 消息超过大小限制', 'RPC_TOO_LARGE')
    const buffered = typeof output.writableLength === 'number' ? output.writableLength : 0
    if (buffered + frame.length > maxLineBytes * 4 + 4) {
      close('output_backpressure')
      throw closedError()
    }
    try {
      const writingAt = performance.now()
      try { output.write(frame) }
      finally { rpcTiming('write', writingAt, frame.length, metadata) }
      // Accepted by the Host's logical output stream, including backpressure
      // and recovery buffering. This is not socket or SDK upstream dispatch.
      traffic('sent', message, metadata, writingAt)
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
      const metadata = rpcMetadata({ method, params })
      const entry = { resolve, reject, signal: options.signal, method, startedAt: Date.now(),
        runId: metadata.runId, callId: metadata.callId }
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

  function sendError(id, code, message, request) {
    if (isClosed) return
    try { send({ jsonrpc: '2.0', id, error: { code, message } }, request) } catch { close('write_error') }
  }

  function handleCall(message, frameBytes, wireBytes) {
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
        const queuedAt = performance.now()
        const metadata = rpcMetadata(message)
        notificationQueue = notificationQueue
          .then(async () => {
            rpcTiming('notification_wait', queuedAt, wireBytes, metadata)
            const handlingAt = performance.now()
            try { return await onNotification(message.method, message.params) }
            finally { rpcTiming('notification_handle', handlingAt, wireBytes, metadata) }
          })
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
      return sendError(message.id, -32601, '方法不存在', message)
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
          return sendError(message.id, -32800, '请求已取消', message)
        }
        try {
          send({ jsonrpc: '2.0', id: message.id, result: result === undefined ? null : result }, message)
          diagnose('rpc_handler_result', { id: message.id, method: message.method, startedAt })
        } catch {
          diagnose('rpc_handler_failed', { id: message.id, method: message.method, startedAt, code: -32603 })
          sendError(message.id, -32603, '处理结果无法发送', message)
        }
      } catch {
        diagnose('rpc_handler_failed', { id: message.id, method: message.method, startedAt,
          code: controller.signal.aborted ? -32800 : -32000 })
        sendError(message.id, controller.signal.aborted ? -32800 : -32000,
          controller.signal.aborted ? '请求已取消' : '请求处理失败', message)
      } finally {
        incoming.delete(key)
        const metadata = rpcMetadata(message)
        if (!metadata.runId) flushTimings(`request:${message.id}`)
        else if (message.method === 'query') flushTimings(`run:${metadata.runId}`)
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
    const receivedAt = performance.now()
    const frameBytes = line.length + 1
    if (line.length > 0 && line[line.length - 1] === 13) line = line.subarray(0, -1)
    let message
    try { message = JSON.parse(textDecoder.decode(line)) } catch { return close('protocol_error') }
    if (!isRecord(message) || message.jsonrpc !== '2.0') return close('protocol_error')
    const metadata = rpcMetadata(message)
    rpcTiming('receive', receivedAt, frameBytes, metadata)
    traffic('received', message, metadata, receivedAt)
    if ('method' in message) handleCall(message, line.length, frameBytes)
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
