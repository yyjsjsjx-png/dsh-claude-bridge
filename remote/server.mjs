import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { userInfo } from 'node:os'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateConnectionToken, validateDeviceId } from '../src/connection-settings.mjs'
import { COMPRESSION, encodeFrame, decodeFrame, compressedFrameSize } from '../src/websocket-compression.mjs'
import { RECOVERY_PROTOCOL, createReplayBuffer, validatePriorityCancels } from '../src/replay-buffer.mjs'
import { createObservabilityHost } from './observability-host.mjs'
import { SocketAttempt, WorkerSocketLease } from './socket-lifecycle.mjs'
import { networkNow as defaultNetworkNow, networkPongTiming, readNetworkTime } from '../src/network-timing.mjs'

const decoder = new TextDecoder('utf-8', { fatal: true })

function integer(value, name, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} 无效`)
  return value
}

function absolutePath(value, name) {
  if (typeof value !== 'string' || value.length > 4096 || !posix.isAbsolute(value)
    || value === '/' || posix.normalize(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} 必须是规范的绝对路径`)
  }
  return value
}

async function readPrivateToken(path, uid) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  const file = await open(path, flags)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.size > 1024) {
      throw new Error('凭据文件权限无效')
    }
    const content = await file.readFile('utf8')
    return validateConnectionToken(content.replace(/\r?\n$/, ''))
  } finally { await file.close() }
}

/**
 * Start a loopback-only WebSocket bridge. `ws` and process primitives may be
 * injected for offline tests. Authentication precedes worker creation.
 */
export async function createBridgeServer({
  remoteRoot: configuredRoot,
  workerPath: configuredWorker,
  tokenFile: configuredToken,
  host = '127.0.0.1',
  port = 18944,
  maxLineBytes = 4 * 1024 * 1024,
  maxConnections = 16,
  maxFailedPerWindow = 5,
  authTimeoutMs = 10_000,
  authWindowMs = 60_000,
  stopGraceMs = 1000,
  forceKillMs = 3500,
  stopTimeoutMs = 7000,
  recoveryGraceMs = 90_000,
  heartbeatMs = 15_000,
  heartbeatTimeoutMs = 45_000,
  webSocketServerFactory,
  spawnImpl = spawn,
  loadToken = readPrivateToken,
  getUid = () => process.getuid?.(),
  getUserInfo = () => userInfo(),
  killGroup = (pid, signal) => process.kill(-pid, signal),
  executable = process.execPath,
  onDiagnostic,
  observability,
  networkNow = defaultNetworkNow,
} = {}) {
  const uid = getUid()
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('远端服务必须由非 root 用户运行')
  const user = getUserInfo()
  if (!user || typeof user.homedir !== 'string') throw new Error('无法确定服务用户主目录')
  const homeDir = absolutePath(user.homedir, '用户主目录')
  const remoteRoot = absolutePath(configuredRoot ?? posix.join(homeDir, 'dsh-claude-bridge'), '远端根目录')
  const workerPath = absolutePath(configuredWorker ?? posix.join(remoteRoot, 'remote/worker.mjs'), '工作程序')
  const tokenFile = absolutePath(configuredToken ?? posix.join(remoteRoot, 'private/service-token'), '凭据文件')
  if (!workerPath.endsWith('.mjs') || workerPath === tokenFile) throw new TypeError('工作程序路径无效')
  if (host !== '127.0.0.1') throw new Error('服务只允许监听 IPv4 回环地址')
  integer(port, 'port', 1, 65535)
  integer(maxLineBytes, 'maxLineBytes', 1024, 64 * 1024 * 1024)
  integer(maxConnections, 'maxConnections', 1, 256)
  integer(maxFailedPerWindow, 'maxFailedPerWindow', 1, 1000)
  integer(authTimeoutMs, 'authTimeoutMs')
  integer(authWindowMs, 'authWindowMs')
  integer(stopGraceMs, 'stopGraceMs')
  integer(forceKillMs, 'forceKillMs')
  integer(stopTimeoutMs, 'stopTimeoutMs')
  integer(recoveryGraceMs, 'recoveryGraceMs', 1, 300_000)
  integer(heartbeatMs, 'heartbeatMs')
  integer(heartbeatTimeoutMs, 'heartbeatTimeoutMs')
  if (heartbeatTimeoutMs <= heartbeatMs) throw new RangeError('心跳等待时间无效')
  if (forceKillMs <= stopGraceMs || stopTimeoutMs <= forceKillMs) throw new RangeError('停止等待时间无效')
  if (typeof spawnImpl !== 'function' || typeof loadToken !== 'function' || typeof killGroup !== 'function' || typeof networkNow !== 'function') {
    throw new TypeError('服务依赖无效')
  }
  if (onDiagnostic !== undefined && typeof onDiagnostic !== 'function') throw new TypeError('onDiagnostic 必须是函数')

  function diagnose(event, fields = {}) {
    if (!onDiagnostic) return
    try {
      const result = onDiagnostic({ event, ...fields })
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {})
    } catch { /* Diagnostics must not disrupt the service. */ }
  }

  let loadedToken
  try { loadedToken = validateConnectionToken(await loadToken(tokenFile, uid)) } catch {
    throw new Error('无法加载受保护的服务连接凭据')
  }
  const expectedDigest = createHash('sha256').update(loadedToken).digest()
  loadedToken = undefined

  let factory = webSocketServerFactory
  if (factory === undefined) {
    const { WebSocketServer } = await import('ws')
    factory = (options) => new WebSocketServer(options)
  }
  if (typeof factory !== 'function') throw new TypeError('WebSocket 服务工厂无效')
  const wss = await factory({ host, port, maxPayload: maxLineBytes + 1, perMessageDeflate: false })
  if (!wss || typeof wss.on !== 'function' || typeof wss.close !== 'function') throw new TypeError('WebSocket 服务无效')
  let ready = false
  const listening = new Promise((resolve, reject) => {
    wss.once('listening', () => { ready = true; resolve() })
    wss.on('error', () => {
      diagnose('server_listener_error', { code: 'LISTENER_ERROR' })
      if (!ready) reject(new Error('远端桥接服务无法监听'))
    })
  })

  const states = new Set()
  const devices = new Map()
  const failures = new Map()
  let stopping = false
  let closePromise
  function updateFailure(address) {
    const now = Date.now()
    for (const [key, entry] of failures) if (entry.until <= now) failures.delete(key)
    if (!failures.has(address) && failures.size >= 1024) return
    const entry = failures.get(address) ?? { count: 0, until: now + authWindowMs }
    entry.count++
    failures.set(address, entry)
  }
  function blocked(address) {
    const entry = failures.get(address)
    if (!entry) {
      if (failures.size < 1024) return false
      for (const [key, candidate] of failures) if (candidate.until <= Date.now()) failures.delete(key)
      return failures.size >= 1024
    }
    if (entry.until <= Date.now()) { failures.delete(address); return false }
    return entry.count >= maxFailedPerWindow
  }

  function socketClose(socket, code = 1000) {
    if (socket.readyState === 0 || socket.readyState === 1) {
      try { socket.close(code) } catch { socket.terminate?.() }
      if (socket.readyState !== 3 && typeof socket.terminate === 'function') {
        const timer = setTimeout(() => socket.terminate(), stopGraceMs)
        timer.unref?.()
        socket.once('close', () => clearTimeout(timer))
      }
    }
  }

  function release(state) {
    state.lease.dispose()
    states.delete(state)
    if (state.deviceId && devices.get(state.deviceId) === state) devices.delete(state.deviceId)
  }

  function stop(state) {
    if (state.stopPromise) return state.stopPromise
    state.lease.dispose()
    state.stopPromise = (async () => {
      const child = state.child
      if (!child) { release(state); return }
      try { if (!child.stdin.destroyed) child.stdin.end() } catch { child.stdin.destroy() }
      child.stdout.resume()
      if (state.exited) { release(state); return }
      const sendSignal = (signal) => {
        if (!state.exited && Number.isSafeInteger(child.pid) && child.pid > 0) {
          try { killGroup(child.pid, signal) } catch { /* The final timeout reports an unreaped worker. */ }
        }
      }
      const softTimer = setTimeout(() => sendSignal('SIGTERM'), stopGraceMs)
      const hardTimer = setTimeout(() => sendSignal('SIGKILL'), forceKillMs)
      let failureTimer
      try {
        await Promise.race([
          state.workerClosed,
          new Promise((_, reject) => { failureTimer = setTimeout(() => reject(new Error('远端工作进程未退出')), stopTimeoutMs) }),
        ])
        release(state)
      } catch (error) {
        // Keep the device reserved while its previous worker may still run.
        diagnose('server_worker_stop_timeout', { code: 'WORKER_STOP_TIMEOUT' })
        throw error
      } finally {
        clearTimeout(softTimer)
        clearTimeout(hardTimer)
        clearTimeout(failureTimer)
      }
    })()
    return state.stopPromise
  }

  function disconnect(state, code = 1000) {
    socketClose(state.socket, code)
    void stop(state).catch(() => {})
  }

  function detach(state, attempt) {
    if (!state.lease.isCurrent(attempt) || state.stopPromise) return
    if (!state.recoverable) { void stop(state).catch(() => {}); return }
    state.recoveryReady = false
    state.lease.detach(attempt)
    if (state.lease.retain(recoveryGraceMs, () => {
      if (state.recoveryReady || state.stopPromise) return
      diagnose('server_recovery_expired', { code: 'RECOVERY_EXPIRED' })
      disconnect(state, 4004)
    })) diagnose('server_connection_waiting', { code: 'RECOVERY_WAIT' })
  }

  function sendControl(state, message) {
    const attempt = state.lease.attempt, socket = attempt.socket
    if (!state.lease.isCurrent(attempt) || socket.readyState !== 1 || state.stopPromise) return
    try { socket.send(JSON.stringify(message)) }
    catch { detach(state, attempt); socketClose(socket, 1011) }
  }

  function authReply(state, resumed = false) {
    sendControl(state, { type: 'auth.ok', protocol: 1, compression: COMPRESSION,
      recovery: { protocol: RECOVERY_PROTOCOL, id: state.recoveryId, graceMs: recoveryGraceMs, resumed } })
  }

  function failAuth(state) {
    updateFailure(state.address)
    diagnose('server_auth_failed', { code: 'AUTH_FAILED' })
    disconnect(state, 1008)
  }

  function waitForDrain(state) {
    const { socket, child } = state
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        child.stdin.removeListener('drain', drained)
        child.stdin.removeListener('close', closed)
        socket.removeListener('close', closed)
      }
      const drained = () => { cleanup(); resolve() }
      const closed = () => { cleanup(); reject(new Error('连接已关闭')) }
      child.stdin.once('drain', drained)
      child.stdin.once('close', closed)
      if (!state.recoverable) socket.once('close', closed)
      if (state.stopPromise || child.stdin.destroyed || (!state.recoverable && socket.readyState !== 1)) closed()
    })
  }

  async function writeWorkerLine(state, line, message = JSON.parse(line)) {
    if (state.stopPromise || state.child.stdin.destroyed) throw new Error('工作进程已关闭')
    if (message.id !== undefined && message.method && state.priorityCancelled?.has(message.id)) {
      queueWorkerFrame(state, JSON.stringify({ jsonrpc: '2.0', id: message.id,
        error: { code: -32800, message: '请求已取消' } }) + '\n')
      return
    }
    if (!state.child.stdin.write(line)) await waitForDrain(state)
  }

  function flushReplay(state) {
    const attempt = state.lease.attempt, socket = attempt.socket
    state.outputQueue = state.outputQueue.then(async () => {
      if (state.stopPromise || !state.recoveryReady || !state.lease.isCurrent(attempt) || socket.readyState !== 1) return
      for (const frame of state.replay.frames(state.outputWireSeq)) {
        const data = await encodeFrame(frame.line, { enabled: state.compressed, maxLineBytes })
        if (state.stopPromise || !state.recoveryReady || !state.lease.isCurrent(attempt) || socket.readyState !== 1) return
        const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length
        if (socket.bufferedAmount + size > maxLineBytes * 4) throw new Error('发送缓冲已满')
        state.replay.markTransmitted(frame.id)
        await new Promise((resolve, reject) => {
          const finish = error => { socket.removeListener('close', closed); error ? reject(error) : resolve() }
          const closed = () => finish(new Error('连接已关闭'))
          socket.once('close', closed)
          try { socket.send(data, finish) } catch (error) { finish(error) }
        })
        if (!state.lease.isCurrent(attempt)) return
        state.outputWireSeq = frame.id
      }
    }).catch(() => { detach(state, attempt); socketClose(socket, 1011) })
  }

  function priorityCancel(state, values) {
    for (const id of validatePriorityCancels(values)) {
      if (state.priorityCancelled.size >= 4096 && !state.priorityCancelled.has(id)) throw new Error('取消记录已满')
      state.priorityCancelled.add(id)
      if (!state.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }) + '\n')) {
        throw new Error('取消队列已满')
      }
    }
  }

  function queueClientFrame(state, frame, isBinary) {
    if (state.recoverable && !state.recoveryReady) return disconnect(state, 1002)
    const compressed = state.compressed
    let queuedBytes = frame.length
    try {
      if (isBinary) queuedBytes = Math.max(queuedBytes, compressedFrameSize(frame, { enabled: compressed, maxLineBytes }))
    } catch { return disconnect(state, 1002) }
    if (state.inputBytes + queuedBytes > maxLineBytes * 4) return disconnect(state, 1009)
    state.inputBytes += queuedBytes
    state.inputQueue = state.inputQueue.then(async () => {
      if (state.stopPromise || (!state.recoverable && state.socket.readyState !== 1)) return
      const line = isBinary ? await decodeFrame(frame, { enabled: compressed, maxLineBytes }) : frame
      if (line.length < 1 || line.length > maxLineBytes + 1 || line[line.length - 1] !== 10
        || line.indexOf(10) !== line.length - 1) throw new Error('消息格式无效')
      const text = decoder.decode(line.subarray(0, line.length - 1))
      const message = JSON.parse(text)
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0') throw new Error('消息格式无效')
      if (state.stopPromise) return
      if (state.recoverable) {
        await state.replay.accept(text + '\n')
        sendControl(state, { type: 'recovery.ack', protocol: 1, ack: state.replay.received })
      } else await writeWorkerLine(state, line, message)
    }).catch(() => disconnect(state, 1002)).finally(() => { state.inputBytes -= queuedBytes })
  }

  function queueWorkerFrame(state, line) {
    if (state.recoverable) {
      try { state.replay.enqueue(line); flushReplay(state) }
      catch { diagnose('server_recovery_buffer_failed', { code: 'RECOVERY_BUFFER_FULL' }); disconnect(state, 1009) }
      return
    }
    const bytes = Buffer.byteLength(line, 'utf8')
    if (state.outputBytes + bytes > maxLineBytes * 4) return disconnect(state, 1009)
    state.outputBytes += bytes
    const attempt = state.lease.attempt, socket = attempt.socket
    state.outputQueue = state.outputQueue.then(async () => {
      if (state.stopPromise || !state.lease.isCurrent(attempt) || socket.readyState !== 1) return
      const frame = await encodeFrame(line, { enabled: state.compressed, maxLineBytes })
      if (state.stopPromise || !state.lease.isCurrent(attempt) || socket.readyState !== 1) return
      const frameBytes = typeof frame === 'string' ? Buffer.byteLength(frame, 'utf8') : frame.length
      if (typeof socket.bufferedAmount === 'number' && socket.bufferedAmount + frameBytes > maxLineBytes * 4) {
        throw new Error('发送队列已满')
      }
      await new Promise((resolve, reject) => {
        let settled = false
        const finish = (error) => {
          if (settled) return
          settled = true
          socket.removeListener('close', closed)
          if (error) reject(error)
          else resolve()
        }
        const closed = () => finish(new Error('连接已关闭'))
        socket.once('close', closed)
        if (socket.readyState !== 1) return closed()
        try { socket.send(frame, finish) } catch { finish(new Error('消息发送失败')) }
      })
    }).catch(() => { detach(state, attempt); socketClose(socket, 1011) }).finally(() => { state.outputBytes -= bytes })
  }

  function startWorker(state, deviceId) {
    if (stopping || devices.has(deviceId)) return disconnect(state, 1013)
    state.deviceId = deviceId
    devices.set(deviceId, state)
    let child
    try {
      child = spawnImpl(executable, [workerPath], {
        detached: true,
        stdio: observability ? ['pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'],
        env: {
          HOME: homeDir,
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          CLAUDE_CONFIG_DIR: posix.join(remoteRoot, 'claude-config'),
          BRIDGE_REMOTE_ROOT: remoteRoot,
          BRIDGE_DEVICE_ID: deviceId,
          ...Object.fromEntries(['BRIDGE_CLAUDE_PATH', 'BRIDGE_CLAUDE_VERSION', 'BRIDGE_MAX_BUDGET_USD']
            .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]])),
        },
      })
      if (!child?.stdin || !child?.stdout || !child?.stderr || typeof child.once !== 'function') throw new Error('worker')
    } catch {
      diagnose('server_worker_start_failed', { code: 'WORKER_START_FAILED' })
      release(state)
      return disconnect(state, 1011)
    }
    state.child = child
    state.recoveryId = randomUUID()
    state.priorityCancelled = new Set()
    state.outputWireSeq = 0
    state.replay = createReplayBuffer({ maxLineBytes, onLine: (line, message) => writeWorkerLine(state, line, message) })
    let resolveClosed
    state.workerClosed = new Promise((resolve) => { resolveClosed = resolve })
    child.once('error', () => {
      diagnose('server_worker_error', { code: 'WORKER_ERROR' })
      disconnect(state, 1011)
    })
    child.once('close', (code) => {
      state.exited = true
      resolveClosed()
      release(state)
      diagnose('server_worker_exited', { ...(Number.isInteger(code) ? { code } : {}) })
      if (state.socket.readyState === 1) socketClose(state.socket, 1011)
      void stop(state).catch(() => {})
    })
    child.stdin.on('error', () => disconnect(state, 1011))
    child.stdout.on('error', () => disconnect(state, 1011))
    child.stderr.on('error', () => disconnect(state, 1011))
    // Drain stderr but never send or log its potentially sensitive contents.
    child.stderr.on('data', () => {})

    let lineBuffer = Buffer.alloc(0)
    let lineBytes = 0
    child.stdout.on('data', (chunk) => {
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(String(chunk), 'utf8')
      let start = 0
      for (;;) {
        const end = chunk.indexOf(10, start)
        const part = end === -1 ? chunk.subarray(start) : chunk.subarray(start, end)
        const needed = lineBytes + part.length
        if (needed > maxLineBytes) return disconnect(state, 1009)
        if (needed > lineBuffer.length) {
          const capacity = Math.min(maxLineBytes, Math.max(needed, lineBuffer.length * 2, 256))
          const next = Buffer.allocUnsafe(capacity)
          lineBuffer.copy(next, 0, 0, lineBytes)
          lineBuffer = next
        }
        part.copy(lineBuffer, lineBytes)
        lineBytes = needed
        if (end === -1) return
        let text
        try {
          text = decoder.decode(lineBuffer.subarray(0, lineBytes))
          const message = JSON.parse(text)
          if (!message || Array.isArray(message) || message.jsonrpc !== '2.0') throw new Error('invalid')
        } catch { return disconnect(state, 1002) }
        lineBytes = 0
        if (state.socket.readyState !== 1 && !state.recoverable) return disconnect(state)
        queueWorkerFrame(state, `${text}\n`)
        start = end + 1
        if (start === chunk.length) return
      }
    })
    child.stdout.once('end', () => { if (lineBytes !== 0) disconnect(state, 1002) })
    // From this point the lease owns the spawned child and its exit listeners.
    // Optional observer setup must not release a still-running worker/device.
    try { observability?.attach(child, deviceId) } catch {
      diagnose('server_worker_start_failed', { code: 'WORKER_START_FAILED' })
      return disconnect(state, 1011)
    }
    authReply(state)
    diagnose('server_authenticated')
  }

  wss.on('connection', (socket, request) => {
    if (stopping || states.size >= maxConnections) return socketClose(socket, 1013)
    const address = typeof request?.socket?.remoteAddress === 'string' ? request.socket.remoteAddress : 'unknown'
    if (blocked(address)) return socketClose(socket, 1008)
    const attempt = new SocketAttempt(socket, address)
    const lease = new WorkerSocketLease()
    lease.bind(attempt)
    let state = { lease, get socket() { return lease.socket }, get address() { return lease.attempt?.address },
      deviceId: undefined, child: undefined, exited: false, stopPromise: undefined,
      negotiable: true, compressed: false, inputQueue: Promise.resolve(), outputQueue: Promise.resolve(), inputBytes: 0, outputBytes: 0 }
    states.add(state)
    attempt.authenticateWithin(authTimeoutMs, () => { if (!state.child) failAuth(state) })
    socket.on('error', () => { if (state.lease.isCurrent(attempt)) { detach(state, attempt); socketClose(socket, 1011) } })
    socket.on('close', () => detach(state, attempt))
    socket.on('message', (data, isBinary) => {
      if (state.stopPromise || !state.lease.isCurrent(attempt)) return
      const receivedAt = readNetworkTime(networkNow)
      attempt.heard()
      let bytes
      try { bytes = Buffer.isBuffer(data) ? data : Buffer.from(data) }
      catch { if (state.child) disconnect(state, 1002); else failAuth(state); return }
      if ((!state.child && isBinary) || bytes.length > (state.child ? maxLineBytes + 1 : 1024)) {
        if (state.child) disconnect(state, 1009)
        else failAuth(state)
        return
      }
      if (!state.child) {
        if (state.authenticating) return disconnect(state, 1002)
        let text
        try { text = decoder.decode(bytes) } catch { failAuth(state); return }
        let auth
        try { auth = JSON.parse(text) } catch { return failAuth(state) }
        if (!auth || auth.type !== 'auth' || auth.protocol !== 1 || typeof auth.token !== 'string'
          || Object.keys(auth).some((key) => !['type', 'protocol', 'token', 'deviceId', 'resume'].includes(key))) return failAuth(state)
        let token, deviceId
        try { token = validateConnectionToken(auth.token); deviceId = validateDeviceId(auth.deviceId) }
        catch { return failAuth(state) }
        const suppliedDigest = createHash('sha256').update(token).digest()
        token = undefined
        if (!timingSafeEqual(expectedDigest, suppliedDigest)) return failAuth(state)
        attempt.authenticated()
        if (auth.resume !== undefined) {
          const existing = devices.get(deviceId)
          if (!existing || existing.stopPromise || existing.exited || !existing.recoverable
            || auth.resume?.id !== existing.recoveryId || !Number.isSafeInteger(auth.resume.ack)
            || auth.resume.ack < existing.replay.acknowledged
            || Object.keys(auth.resume).some(key => !['id', 'ack'].includes(key))) return disconnect(state, 4004)
          try { existing.replay.acknowledge(auth.resume.ack) } catch { return disconnect(state, 4004) }
          states.delete(state)
          const previous = existing.lease.bind(attempt)
          state = existing
          state.negotiable = true; state.compressed = false
          state.recoveryReady = false; state.outputWireSeq = state.replay.acknowledged
          socketClose(previous, 1000)
          authReply(state, true)
          attempt.recoverWithin(authTimeoutMs, () => {
            if (state.recoveryReady || state.stopPromise) return
            diagnose('server_recovery_handshake_expired', { code: 'RECOVERY_EXPIRED' })
            disconnect(state, 4004)
          })
          diagnose('server_connection_resumed')
          return
        }
        const previous = devices.get(deviceId)
        // A fresh Host cannot possess the lost RAM recovery id. It may retire
        // only an authenticated same-device worker whose socket is already
        // disconnected, then read the native transcript in a NEW worker.
        if (previous && previous.socket.readyState !== 1 && !previous.exited) {
          state.authenticating = true
          void stop(previous).then(() => {
            if (stopping || !state.lease.isCurrent(attempt) || socket.readyState !== 1) { release(state); return }
            state.authenticating = false
            startWorker(state, deviceId)
          }).catch(() => disconnect(state, 1013))
          return
        }
        return startWorker(state, deviceId)
      }
      if (!isBinary && bytes.length <= 16384 && bytes[bytes.length - 1] !== 10) {
        let control
        try { control = JSON.parse(decoder.decode(bytes)) } catch { return disconnect(state, 1002) }
        if (control.type?.startsWith('recovery.')) {
          if (control.protocol !== 1) return disconnect(state, 1002)
          if (control.type === 'recovery.negotiate') {
            if (state.recoveryReady || control.id !== state.recoveryId) return disconnect(state, 1002)
            state.recoverable = true
            state.inputQueue = state.inputQueue.then(() => {
              if (!state.lease.isCurrent(attempt) || state.stopPromise) return
              if (control.ack < state.replay.acknowledged) throw new Error('恢复游标已过期')
              state.replay.acknowledge(control.ack)
              priorityCancel(state, control.cancelIds)
              state.recoveryReady = true
              attempt.recoveryReady({ intervalMs: heartbeatMs, timeoutMs: heartbeatTimeoutMs, onTimeout: () => {
                if (state.stopPromise || !state.recoveryReady) return
                diagnose('server_heartbeat_expired', { code: 'HEARTBEAT_TIMEOUT' })
                detach(state, attempt)
                socketClose(socket, 4000)
              } })
              sendControl(state, { type: 'recovery.ready', protocol: 1, id: state.recoveryId, ack: state.replay.received })
              flushReplay(state)
            }).catch(() => disconnect(state, 1002))
            return
          }
          if (!state.recoverable || !state.recoveryReady) return disconnect(state, 1002)
          if (control.type === 'recovery.release') return disconnect(state, 1000)
          if (control.type === 'recovery.ping') {
            const timing = networkPongTiming(control.timing, receivedAt, readNetworkTime(networkNow))
            sendControl(state, { type: 'recovery.pong', protocol: 1, ...(timing ? { timing } : {}) })
            return
          }
          if (control.type === 'recovery.ack') {
            try {
              if (!Number.isSafeInteger(control.ack) || control.ack < 0) throw new Error('游标无效')
              if (control.ack >= state.replay.acknowledged) state.replay.acknowledge(control.ack)
            }
            catch { return disconnect(state, 1002) }
            return
          }
          if (control.type === 'recovery.cancel') {
            state.inputQueue = state.inputQueue.then(() => priorityCancel(state, control.cancelIds)).catch(() => disconnect(state, 1002))
            return
          }
          return disconnect(state, 1002)
        }
      }
      if (state.negotiable) {
        state.negotiable = false
        if (!isBinary && bytes.length <= 1024 && bytes[bytes.length - 1] !== 10) {
          let negotiation
          try { negotiation = JSON.parse(decoder.decode(bytes)) } catch { return disconnect(state, 1002) }
          if (!negotiation || negotiation.type !== 'compression.negotiate' || negotiation.protocol !== 1
            || negotiation.compression !== COMPRESSION
            || Object.keys(negotiation).some((key) => !['type', 'protocol', 'compression'].includes(key))) {
            return disconnect(state, 1002)
          }
          state.compressed = true
          try { socket.send(JSON.stringify({ type: 'compression.ready', protocol: 1, compression: COMPRESSION })) }
          catch { disconnect(state, 1011) }
          diagnose('server_compression_negotiated')
          return
        }
      }
      queueClientFrame(state, bytes, isBinary)
    })
  })

  function close() {
    if (closePromise) return closePromise
    stopping = true
    closePromise = (async () => {
      const closing = [...states].map((state) => { socketClose(state.socket, 1001); return stop(state) })
      const outcomes = await Promise.allSettled(closing)
      await new Promise((resolve, reject) => wss.close((error) => {
        if (error) reject(new Error('远端服务无法关闭'))
        else resolve()
      }))
      if (outcomes.some((item) => item.status === 'rejected')) throw new Error('部分远端工作进程未退出')
      await observability?.close()
    })()
    return closePromise
  }
  await listening
  return { close }
}

async function main() {
  if (typeof process.getuid !== 'function' || process.getuid() <= 0) throw new Error('远端服务必须由非 root 用户运行')
  const port = process.env.BRIDGE_PORT === undefined ? undefined : Number(process.env.BRIDGE_PORT)
  const remoteRoot = process.env.BRIDGE_REMOTE_ROOT ?? posix.join(userInfo().homedir, 'dsh-claude-bridge')
  const observability = createObservabilityHost({ directory: posix.join(remoteRoot, 'observability'),
    onDiagnostic: () => process.stderr.write('统计记录异常，请查看受保护的诊断状态。\n') })
  let server
  try { server = await createBridgeServer({
    ...(process.env.BRIDGE_REMOTE_ROOT ? { remoteRoot: process.env.BRIDGE_REMOTE_ROOT } : {}),
    ...(process.env.BRIDGE_WORKER_PATH ? { workerPath: process.env.BRIDGE_WORKER_PATH } : {}),
    ...(process.env.BRIDGE_TOKEN_FILE ? { tokenFile: process.env.BRIDGE_TOKEN_FILE } : {}),
    ...(port === undefined ? {} : { port }),
    observability,
  }) } catch (error) { await observability.close(); throw error }
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    server.close().catch(() => { process.exitCode = 1 })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

if (process.argv[1] && posix.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('远端桥接服务无法启动，请检查配置与依赖。\n')
    process.exitCode = 1
  })
}
