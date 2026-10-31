import { spawn } from 'node:child_process'
import { createRpcPeer } from './rpc.mjs'

const SAFE_WORD = /^[A-Za-z0-9_./:=+-]+$/
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/

/** Validate a worker path before OpenSSH passes it to the remote shell. */
export function validateRemoteWorkerPath(workerPath) {
  if (typeof workerPath !== 'string' || !workerPath.startsWith('/home/desktop/') || !workerPath.endsWith('.mjs')) {
    throw new TypeError('远端工作程序必须是 /home/desktop 下的 .mjs 文件')
  }
  const segments = workerPath.slice(1).split('/')
  if (segments.some(segment => !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    throw new TypeError('远端工作程序路径包含不安全字符')
  }
  return workerPath
}

function validateNodeCommand(command) {
  if (command === 'node') return command
  if (typeof command !== 'string' || !command.startsWith('/') || !SAFE_WORD.test(command)) {
    throw new TypeError('远端 Node 命令必须是 node 或安全的绝对路径')
  }
  if (command.slice(1).split('/').some(segment => !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    throw new TypeError('远端 Node 路径包含不安全字符')
  }
  return command
}

function validateWorkerArgs(args) {
  if (!Array.isArray(args) || args.length > 32) throw new TypeError('远端参数必须是不超过 32 项的数组')
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > 512 || !SAFE_WORD.test(arg)) {
      throw new TypeError('远端参数包含不安全字符')
    }
  }
  return args
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} 必须是正整数`)
  return value
}

/**
 * Start one SSH stdio transport to the desktop user on the configured `au`
 * host. The peer is the only owner of stdout. stderrTail is bounded but may
 * contain sensitive text; the caller must not log or display it automatically.
 */
export function createSshTransport({
  workerPath,
  nodeCommand = 'node',
  workerArgs = [],
  sshExecutable = 'ssh',
  spawnImpl = spawn,
  handlers = {},
  onNotification,
  onClose,
  onDiagnostic,
  maxLineBytes,
  maxStderrBytes = 64 * 1024,
  stopGraceMs = 1000,
  forceKillMs = 3500,
  stopTimeoutMs = 7000,
} = {}) {
  validateRemoteWorkerPath(workerPath)
  validateNodeCommand(nodeCommand)
  validateWorkerArgs(workerArgs)
  positiveInteger(maxStderrBytes, 'maxStderrBytes')
  positiveInteger(stopGraceMs, 'stopGraceMs')
  positiveInteger(forceKillMs, 'forceKillMs')
  positiveInteger(stopTimeoutMs, 'stopTimeoutMs')
  if (forceKillMs <= stopGraceMs || stopTimeoutMs <= forceKillMs) {
    throw new RangeError('停止、强制结束和等待超时必须依次递增')
  }
  if (typeof sshExecutable !== 'string' || !sshExecutable || typeof spawnImpl !== 'function') {
    throw new TypeError('SSH 程序和启动函数无效')
  }
  if (onDiagnostic !== undefined && typeof onDiagnostic !== 'function') {
    throw new TypeError('onDiagnostic 必须是函数')
  }
  function diagnose(event, fields = {}) {
    if (!onDiagnostic) return
    try {
      const result = onDiagnostic({ event, ...fields })
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {})
    } catch { /* Diagnostics must not interrupt the transport. */ }
  }
  const args = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    'au',
    'runuser', '-u', 'desktop', '--',
    nodeCommand, workerPath, ...workerArgs,
  ]
  const startedAt = Date.now()
  let child
  try {
    child = spawnImpl(sshExecutable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } catch (error) {
    diagnose('ssh_spawn_failed', { code: 'SSH_SPAWN_FAILED' })
    throw error
  }
  if (!child?.stdin || !child?.stdout || !child?.stderr || typeof child.once !== 'function' || typeof child.kill !== 'function') {
    throw new TypeError('SSH 启动未提供必要的标准流')
  }
  const peer = createRpcPeer({
    input: child.stdout,
    output: child.stdin,
    handlers,
    onNotification,
    onClose,
    onDiagnostic,
    ...(maxLineBytes === undefined ? {} : { maxLineBytes }),
  })

  diagnose('ssh_started')
  let stderr = Buffer.alloc(0)
  let stderrBytes = 0
  child.stderr.on('data', (chunk) => {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(String(chunk))
    stderrBytes += chunk.length
    if (chunk.length >= maxStderrBytes) stderr = Buffer.from(chunk.subarray(chunk.length - maxStderrBytes))
    else {
      const combined = Buffer.concat([stderr, chunk])
      stderr = combined.length <= maxStderrBytes ? combined : combined.subarray(combined.length - maxStderrBytes)
    }
  })
  child.stderr.on('error', () => peer.close('ssh_stderr_error'))

  let exitInfo
  let spawnError = false
  const exited = new Promise((resolve) => {
    child.once('error', () => {
      spawnError = true
      diagnose('ssh_spawn_failed', { code: 'SSH_SPAWN_FAILED' })
      peer.close('ssh_spawn_error')
    })
    child.once('close', (code, signal) => {
      exitInfo = { code, signal, spawnError }
      diagnose('ssh_exited', {
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(Number.isInteger(code) ? { code } : {}),
        ...(typeof signal === 'string' && /^SIG[A-Z0-9]+$/.test(signal) ? { signal } : {}),
        stderrBytes,
      })
      peer.close('ssh_exit')
      resolve(exitInfo)
    })
  })

  let closing
  function close() {
    if (closing) return closing
    peer.close()
    closing = (async () => {
      // Continue draining stdout after RPC dispatch has stopped, allowing the
      // remote worker to terminate even if it has bytes left to write.
      child.stdout.resume()
      if (!child.stdin.destroyed) {
        try { child.stdin.end() } catch { child.stdin.destroy() }
      }
      if (exitInfo !== undefined) return exitInfo
      let failTimer
      const kill = (signal) => {
        if (exitInfo === undefined) {
          diagnose('ssh_stop_signal', { signal })
          try { child.kill(signal) } catch { /* The final timeout reports an unreaped process. */ }
        }
      }
      const softTimer = setTimeout(() => kill('SIGTERM'), stopGraceMs)
      const hardTimer = setTimeout(() => kill('SIGKILL'), forceKillMs)
      const timeout = new Promise((_, reject) => {
        failTimer = setTimeout(() => {
          diagnose('ssh_stop_timeout', { code: 'SSH_STOP_TIMEOUT' })
          reject(new Error('SSH 子进程未在限定时间内退出'))
        }, stopTimeoutMs)
      })
      try {
        return await Promise.race([exited, timeout])
      } finally {
        clearTimeout(softTimer)
        clearTimeout(hardTimer)
        clearTimeout(failTimer)
      }
    })()
    return closing
  }

  // A broken protocol stream also tears down SSH; caller can await `close()`
  // to learn whether the process was actually reaped.
  peer.closed.then(() => { void close().catch(() => {}) })
  return {
    peer,
    exited,
    close,
    get stderrTail() { return stderr.toString('utf8') },
  }
}
