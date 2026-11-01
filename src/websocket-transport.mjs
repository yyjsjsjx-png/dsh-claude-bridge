import { PassThrough, Writable } from 'node:stream'
import { createRpcPeer } from './rpc.mjs'
import { setTimeout as wait } from 'node:timers/promises'
import { urlContainsToken, validateConnectionToken, validateDeviceId, validateServerUrl } from './connection-settings.mjs'
import { COMPRESSION, encodeFrame, decodeFrame, compressedFrameSize } from './websocket-compression.mjs'
import { RECOVERY_PROTOCOL, createReplayBuffer } from './replay-buffer.mjs'

export class WebSocketTransportError extends Error {
  constructor(code, message) { super(message); this.name = 'WebSocketTransportError'; this.code = code }
}
const positive = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} 必须是正整数`)
}
const permanent = new Set(['AUTH_FAILED', 'AUTH_PROTOCOL_ERROR', 'RECOVERY_LOST', 'CONNECT_CANCELLED'])
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Keep the original RPC peer only when both endpoints negotiate resume-v1. */
export async function createWebSocketTransport({
  url: rawUrl, token: rawToken, deviceId: rawDeviceId, handlers = {}, onNotification, onClose, onDiagnostic,
  onConnectionState, onTraffic, signal, webSocketFactory = url => new WebSocket(url), connectTimeoutMs = 10_000,
  closeTimeoutMs = 10_000, maxLineBytes = 4 * 1024 * 1024, reconnectWindowMs = 60_000, initialConnectWindowMs = 0,
  reconnectDelays = [1000, 2000, 4000, 8000], heartbeatMs = 15_000, heartbeatTimeoutMs = 45_000,
  random = Math.random,
} = {}) {
  const url = validateServerUrl(rawUrl)
  let token = validateConnectionToken(rawToken)
  const deviceId = validateDeviceId(rawDeviceId)
  if (urlContainsToken(url, token)) throw new WebSocketTransportError('INVALID_URL', '服务器地址不能包含连接凭据')
  for (const [name, value] of Object.entries({ connectTimeoutMs, closeTimeoutMs, maxLineBytes, reconnectWindowMs, heartbeatMs, heartbeatTimeoutMs })) positive(value, name)
  if (maxLineBytes > 64 * 1024 * 1024 || reconnectWindowMs > 300_000 || heartbeatTimeoutMs <= heartbeatMs) throw new RangeError('连接限制无效')
  if (!Number.isSafeInteger(initialConnectWindowMs) || initialConnectWindowMs < 0 || initialConnectWindowMs > 300_000) throw new RangeError('首次连接等待时间无效')
  if (!Array.isArray(reconnectDelays) || !reconnectDelays.length || reconnectDelays.some(value => !Number.isSafeInteger(value) || value < 1)) throw new TypeError('重连间隔无效')
  if (typeof webSocketFactory !== 'function' || typeof random !== 'function') throw new TypeError('连接依赖无效')
  for (const callback of [onDiagnostic, onConnectionState]) if (callback !== undefined && typeof callback !== 'function') throw new TypeError('连接回调无效')
  if (signal !== undefined && typeof signal?.addEventListener !== 'function') throw new TypeError('signal 必须是 AbortSignal')
  if (signal?.aborted) throw new WebSocketTransportError('CONNECT_CANCELLED', '连接已取消')
  const diagnose = (event, fields = {}) => { try { Promise.resolve(onDiagnostic?.({ event, ...fields })).catch(() => {}) } catch {} }
  const stateChanged = state => { try { Promise.resolve(onConnectionState?.(state)).catch(() => {}) } catch {} }
  let current, peer, input, output, replay, recoveryId, closing = false, closePromise, retryTask, heartbeat
  let incomingQueue = Promise.resolve(), sendingQueue = Promise.resolve(), incomingBytes = 0
  const lifetime = new AbortController()

  function closeSocket(attempt, code = 1000) {
    if (attempt && [0, 1].includes(attempt.socket.readyState)) { try { attempt.socket.close(code) } catch {} }
  }
  function control(attempt, message) {
    if (attempt !== current || attempt.socket.readyState !== 1) throw new Error('连接不可达')
    attempt.socket.send(JSON.stringify({ ...message, protocol: 1 }))
  }
  function shutdown(reason = 'closed') {
    if (closing) return
    closing = true
    if (replay && current?.ready) { try { control(current, { type: 'recovery.release' }) } catch {} }
    lifetime.abort(); clearInterval(heartbeat)
    peer?.close(reason); closeSocket(current)
    input?.end(); output?.end(); token = undefined
    stateChanged('disconnected')
  }
  function flushReplay() {
    const attempt = current
    sendingQueue = sendingQueue.then(async () => {
      if (closing || !attempt?.ready || attempt !== current) return
      const cancelIds = replay.pendingCancels()
      if (cancelIds.length) control(attempt, { type: 'recovery.cancel', cancelIds })
      for (const frame of replay.frames(attempt.sentThrough)) {
        const data = await encodeFrame(frame.line, { enabled: attempt.compressed, maxLineBytes })
        if (closing || !attempt.ready || attempt !== current) return
        const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length
        if (attempt.socket.bufferedAmount + size > maxLineBytes * 4) throw new Error('发送队列已满')
        replay.markTransmitted(frame.id)
        attempt.socket.send(data)
        attempt.sentThrough = frame.id
      }
    }).catch(() => lose(attempt, 'websocket_write_error'))
  }
  function establishPeer() {
    input = new PassThrough({ highWaterMark: maxLineBytes + 1 })
    output = new Writable({ write(chunk, _encoding, callback) {
      const line = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      if (replay) {
        try { replay.enqueue(line.toString('utf8')); callback(); flushReplay() }
        catch { callback(new Error('恢复缓冲已满')); peer?.close('recovery_buffer_full') }
      } else {
        const attempt = current
        void encodeFrame(line, { enabled: attempt.compressed, maxLineBytes }).then(frame => {
          if (!attempt.ready || attempt !== current || attempt.socket.readyState !== 1) return callback(new Error('WebSocket 已关闭'))
          const size = typeof frame === 'string' ? Buffer.byteLength(frame) : frame.length
          if (attempt.socket.bufferedAmount + size > maxLineBytes * 4) return callback(new Error('WebSocket 发送队列已满'))
          try { attempt.socket.send(frame); callback() } catch { callback(new Error('WebSocket 发送失败')) }
        }, () => callback(new Error('消息压缩失败')))
      }
    } })
    peer = createRpcPeer({ input, output, handlers, onNotification, onClose, onDiagnostic, onTraffic, maxLineBytes })
    peer.closed.then(info => shutdown(info.reason))
  }
  async function deliverLine(line) {
    if (!peer || closing || input.destroyed) throw new Error('RPC 已关闭')
    if (!input.write(line)) throw new Error('接收缓冲已满')
    await peer.drainNotifications()
  }
  function negotiated(attempt) {
    if (current !== attempt || closing) return
    attempt.ready = true; attempt.stage = 'ready'; attempt.lastHeard = Date.now()
    attempt.sentThrough = replay?.acknowledged ?? 0
    clearTimeout(attempt.timer); signal?.removeEventListener('abort', attempt.abort)
    if (!peer) establishPeer()
    if (replay) {
      clearInterval(heartbeat)
      heartbeat = setInterval(() => {
        if (closing || current !== attempt || !attempt.ready) return
        if (Date.now() - attempt.lastHeard >= heartbeatTimeoutMs) { lose(attempt, 'websocket_heartbeat_timeout'); return }
        try { control(attempt, { type: 'recovery.ping' }) } catch { lose(attempt, 'websocket_error') }
      }, heartbeatMs)
      heartbeat.unref?.()
      flushReplay()
    }
    diagnose('websocket_authenticated', { durationMs: Math.max(0, Date.now() - attempt.startedAt) })
    if (attempt.compressed) diagnose('websocket_compression_negotiated')
    stateChanged('connected')
    attempt.resolve()
  }
  function negotiateRecovery(attempt) {
    if (!replay) return negotiated(attempt)
    attempt.stage = 'recovery'
    control(attempt, { type: 'recovery.negotiate', id: recoveryId, ack: replay.received, cancelIds: replay.pendingCancels() })
  }
  function rejectAttempt(attempt, code, message) {
    if (attempt.ready || attempt.failed) return
    attempt.failed = true
    clearTimeout(attempt.timer); signal?.removeEventListener('abort', attempt.abort)
    diagnose('websocket_connect_failed', { code })
    attempt.reject(new WebSocketTransportError(code, message))
    closeSocket(attempt)
  }
  function receivedSize(value) {
    if (typeof value === 'string') return Buffer.byteLength(value)
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size
  }
  async function decode(value, attempt) {
    if (typeof value === 'string') return Buffer.from(value, 'utf8')
    const bytes = value instanceof ArrayBuffer ? Buffer.from(value) : ArrayBuffer.isView(value)
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(await value.arrayBuffer())
    return decodeFrame(bytes, { enabled: attempt.compressed, maxLineBytes })
  }
  function receive(attempt, value) {
    if (attempt !== current || closing || attempt.lost || attempt.failed) return
    attempt.lastHeard = Date.now()
    if (!attempt.ready) {
      if (typeof value !== 'string' || Buffer.byteLength(value) > 16384 || !attempt.authSent) return rejectAttempt(attempt, 'AUTH_PROTOCOL_ERROR', '服务器认证响应无效')
      let answer
      try { answer = JSON.parse(value) } catch { return rejectAttempt(attempt, 'AUTH_PROTOCOL_ERROR', '服务器认证响应无效') }
      if (!answer || answer.protocol !== 1) return rejectAttempt(attempt, 'AUTH_PROTOCOL_ERROR', '服务器认证响应无效')
      if (attempt.stage === 'compression') {
        if (answer.type !== 'compression.ready' || answer.compression !== COMPRESSION) return rejectAttempt(attempt, 'AUTH_PROTOCOL_ERROR', '服务器压缩协商无效')
        attempt.compressed = true
        try { negotiateRecovery(attempt) } catch { rejectAttempt(attempt, 'AUTH_PROTOCOL_ERROR', '连接恢复协商无效') }
        return
      }
      if (attempt.stage === 'recovery') {
        if (answer.type !== 'recovery.ready' || answer.id !== recoveryId) return rejectAttempt(attempt, 'RECOVERY_LOST', '原连接已不可恢复，执行状态需核实')
        try { replay.acknowledge(answer.ack) } catch { return rejectAttempt(attempt, 'RECOVERY_LOST', '连接恢复游标无效') }
        return negotiated(attempt)
      }
      if (answer.type !== 'auth.ok') return rejectAttempt(attempt, 'AUTH_FAILED', '服务器未接受连接认证')
      const offered = answer.recovery
      if (attempt.resuming && (offered?.protocol !== RECOVERY_PROTOCOL || offered.id !== recoveryId || offered.resumed !== true)) {
        return rejectAttempt(attempt, 'RECOVERY_LOST', '原连接已不可恢复，执行状态需核实')
      }
      if (!attempt.resuming && offered?.protocol === RECOVERY_PROTOCOL) {
        if (typeof offered.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(offered.id)
          || !Number.isSafeInteger(offered.graceMs) || offered.graceMs < 1) return rejectAttempt(attempt, 'AUTH_PROTOCOL_ERROR', '连接恢复协商无效')
        recoveryId = offered.id
        replay = createReplayBuffer({ maxLineBytes, onLine: deliverLine })
      }
      if (answer.compression !== undefined) {
        if (answer.compression !== COMPRESSION) return rejectAttempt(attempt, 'AUTH_PROTOCOL_ERROR', '服务器压缩协商无效')
        attempt.stage = 'compression'
        try { control(attempt, { type: 'compression.negotiate', compression: COMPRESSION }) } catch { rejectAttempt(attempt, 'CONNECT_FAILED', '无法协商连接压缩') }
      } else {
        try { negotiateRecovery(attempt) } catch { rejectAttempt(attempt, 'AUTH_PROTOCOL_ERROR', '连接恢复协商无效') }
      }
      return
    }
    if (replay && typeof value === 'string' && !value.endsWith('\n') && Buffer.byteLength(value) <= 16384) {
      try {
        const message = JSON.parse(value)
        if (message.protocol !== 1) throw new Error('恢复协议无效')
        if (message.type === 'recovery.ack') {
          if (!Number.isSafeInteger(message.ack) || message.ack < 0) throw new Error('恢复游标无效')
          if (message.ack >= replay.acknowledged) replay.acknowledge(message.ack)
        } else if (message.type !== 'recovery.pong') throw new Error('恢复协议无效')
      } catch { peer.close('websocket_protocol_error') }
      return
    }
    const size = receivedSize(value)
    if (size === undefined || size > maxLineBytes + 1) return peer.close('websocket_protocol_error')
    let queued = size
    try {
      if (typeof value !== 'string') {
        if (!attempt.compressed) throw new Error('未协商压缩')
        if (value instanceof ArrayBuffer) queued = Math.max(size, compressedFrameSize(Buffer.from(value), { enabled: true, maxLineBytes }))
        else if (ArrayBuffer.isView(value)) queued = Math.max(size, compressedFrameSize(Buffer.from(value.buffer, value.byteOffset, value.byteLength), { enabled: true, maxLineBytes }))
        else queued = maxLineBytes + 1
      }
    } catch { return peer.close('websocket_protocol_error') }
    if (incomingBytes + queued > maxLineBytes * 4) return peer.close('websocket_backpressure')
    incomingBytes += queued
    incomingQueue = incomingQueue.then(async () => {
      if (closing) return
      const line = await decode(value, attempt)
      if (line.length < 1 || line.length > maxLineBytes + 1 || line[line.length - 1] !== 10 || line.indexOf(10) !== line.length - 1) throw new Error('消息格式无效')
      if (replay) {
        await replay.accept(decoder.decode(line))
        if (current?.ready) { try { control(current, { type: 'recovery.ack', ack: replay.received }) } catch { lose(current, 'websocket_error') } }
      } else await deliverLine(line)
    }).catch(() => peer.close('websocket_protocol_error')).finally(() => { incomingBytes -= queued })
  }
  function openSocket(resuming = false, timeoutMs = connectTimeoutMs) {
    return new Promise((resolve, reject) => {
      let socket
      try { socket = webSocketFactory(url) } catch { return reject(new WebSocketTransportError('CONNECT_FAILED', '无法创建服务器连接')) }
      if (!socket || typeof socket.addEventListener !== 'function' || typeof socket.send !== 'function' || typeof socket.close !== 'function') return reject(new TypeError('WebSocket 实现无效'))
      try { socket.binaryType = 'arraybuffer' } catch {}
      const attempt = { socket, resuming, resolve, reject, ready: false, stage: 'auth', compressed: false,
        startedAt: Date.now(), sentThrough: replay?.acknowledged ?? 0 }
      current = attempt
      attempt.closed = new Promise(done => { attempt.resolveClosed = done })
      attempt.abort = () => rejectAttempt(attempt, 'CONNECT_CANCELLED', '连接已取消')
      attempt.timer = setTimeout(() => rejectAttempt(attempt, 'CONNECT_TIMEOUT', '服务器连接超时'), timeoutMs)
      if (!resuming) signal?.addEventListener('abort', attempt.abort, { once: true })
      lifetime.signal.addEventListener('abort', attempt.abort, { once: true })
      const cleanup = () => lifetime.signal.removeEventListener('abort', attempt.abort)
      diagnose('websocket_connecting')
      socket.addEventListener('open', () => {
        if (attempt !== current || attempt.failed || closing) return
        attempt.authSent = true
        try { control(attempt, { type: 'auth', token, deviceId,
          ...(resuming ? { resume: { id: recoveryId, ack: replay.received } } : {}) }) }
        catch { rejectAttempt(attempt, 'CONNECT_FAILED', '无法发送连接认证') }
      })
      socket.addEventListener('message', event => receive(attempt, event.data))
      socket.addEventListener('error', () => {
        if (!attempt.ready) rejectAttempt(attempt, 'CONNECT_FAILED', '服务器连接失败')
        else lose(attempt, 'websocket_error')
      })
      socket.addEventListener('close', event => {
        attempt.resolveClosed(); cleanup()
        if (attempt !== current || closing) return
        diagnose('websocket_disconnected', { ...(Number.isInteger(event.code) ? { code: event.code } : {}) })
        if (!attempt.ready) rejectAttempt(attempt, event.code === 4004 ? 'RECOVERY_LOST' : event.code === 1008 ? 'AUTH_FAILED' : 'CONNECT_CLOSED', '服务器连接已关闭')
        else lose(attempt, 'websocket_closed', [1002, 1008, 1009, 4004].includes(event.code))
      })
      if (signal?.aborted && !resuming || lifetime.signal.aborted) attempt.abort()
    })
  }
  function lose(attempt, reason, fatal = false) {
    if (!attempt || attempt !== current || attempt.lost || closing) return
    attempt.lost = true; attempt.ready = false; clearInterval(heartbeat)
    closeSocket(attempt, 4000)
    if (!replay || fatal) { peer?.close(reason); return }
    if (retryTask) return
    stateChanged('reconnecting')
    retryTask = (async () => {
      const deadline = Date.now() + reconnectWindowMs
      let failures = 0
      while (!closing && Date.now() < deadline) {
        const base = reconnectDelays[Math.min(failures++, reconnectDelays.length - 1)]
        const delay = Math.min(Math.max(1, Math.round(base * (0.8 + random() * 0.4))), Math.max(1, deadline - Date.now()))
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); lifetime.signal.removeEventListener('abort', done); resolve() }
          const timer = setTimeout(done, delay)
          lifetime.signal.addEventListener('abort', done, { once: true })
          if (lifetime.signal.aborted) done()
        })
        if (closing || Date.now() >= deadline) break
        try {
          await openSocket(true, Math.min(connectTimeoutMs, Math.max(1, deadline - Date.now())))
          if (current.ready) return
        }
        catch (error) { if (permanent.has(error.code)) break }
      }
      if (!closing) shutdown('recovery_unavailable')
    })().finally(() => {
      retryTask = undefined
      if (!closing && current?.lost) { current.lost = false; lose(current, 'websocket_closed') }
    })
  }
  try {
    const deadline = Date.now() + initialConnectWindowMs
    let failures = 0
    for (;;) {
      try { await openSocket(false, initialConnectWindowMs ? Math.min(connectTimeoutMs, Math.max(1, deadline - Date.now())) : connectTimeoutMs); break }
      catch (error) {
        if (!['CONNECT_FAILED', 'CONNECT_CLOSED', 'CONNECT_TIMEOUT'].includes(error.code)
          || !initialConnectWindowMs || Date.now() >= deadline) throw error
        stateChanged('reconnecting')
        const base = reconnectDelays[Math.min(failures++, reconnectDelays.length - 1)]
        await wait(Math.min(Math.max(1, Math.round(base * (0.8 + random() * 0.4))), Math.max(1, deadline - Date.now())), undefined,
          { signal: AbortSignal.any([signal, lifetime.signal].filter(Boolean)) })
      }
    }
  } catch (error) { shutdown(); throw error }
  return {
    peer, closed: peer.closed,
    get recoverable() { return Boolean(replay) },
    get connected() { return Boolean(current?.ready && !closing) },
    close() {
      if (closePromise) return closePromise
      shutdown()
      closePromise = (async () => {
        const startedAt = Date.now()
        let timeout
        try {
          await Promise.race([current.closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(
            new WebSocketTransportError('CLOSE_TIMEOUT', 'WebSocket 未在限定时间内关闭')), closeTimeoutMs) })])
          diagnose('websocket_closed', { durationMs: Date.now() - startedAt })
        } catch (error) {
          diagnose('websocket_close_timeout', { code: 'CLOSE_TIMEOUT', durationMs: Date.now() - startedAt })
          throw error
        }
        finally { clearTimeout(timeout) }
      })()
      return closePromise
    },
  }
}
