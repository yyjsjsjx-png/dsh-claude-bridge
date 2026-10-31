import { spawn } from 'node:child_process'

const port = value => Number.isSafeInteger(value) && value > 0 && value <= 65535

/** Own only the ssh child created here. Never adopt or kill a port owner's PID. */
export function superviseSshTunnel({ target, localPort = 18944, remotePort = 18944,
  sshPath = 'ssh', spawnProcess = spawn, retryDelays = [1000, 2000, 4000, 8000, 15_000],
  onState, signal } = {}) {
  if (typeof target !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,253}$/.test(target)
    || !port(localPort) || !port(remotePort) || typeof sshPath !== 'string' || !sshPath
    || !Array.isArray(retryDelays) || !retryDelays.length
    || retryDelays.some(value => !Number.isSafeInteger(value) || value < 1)) throw new TypeError('SSH 转发配置无效')
  const args = ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, '--', target]
  let child, timer, stopped = false, attempts = 0, closing, exited = Promise.resolve()
  const report = (status, processId = null) => {
    try { Promise.resolve(onState?.({ status, pid: processId, localPort, remotePort })).catch(() => {}) } catch {}
  }
  const retry = () => {
    if (stopped) return
    report('retrying')
    timer = setTimeout(start, retryDelays[Math.min(attempts++, retryDelays.length - 1)])
  }
  function start() {
    if (stopped) return
    const began = Date.now()
    report('starting')
    let owned
    try {
      owned = spawnProcess(sshPath, args, { stdio: 'ignore', windowsHide: true, shell: false })
      if (!owned || typeof owned.once !== 'function' || typeof owned.kill !== 'function') throw new Error('SSH_START_FAILED')
    } catch { retry(); return }
    child = owned
    exited = new Promise(resolve => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        if (child === owned) child = undefined
        if (Date.now() - began >= 30_000) attempts = 0
        resolve(); retry()
      }
      owned.once('error', finish)
      owned.once('close', finish)
    })
    owned.once('spawn', () => { if (child === owned && !stopped) report('running', owned.pid) })
  }
  async function close() {
    if (closing) return closing
    stopped = true; clearTimeout(timer); signal?.removeEventListener('abort', close)
    const owned = child
    closing = (async () => {
      if (owned) {
        try { owned.kill('SIGTERM') } catch {}
        let forceTimer
        try {
          await Promise.race([exited, new Promise(resolve => { forceTimer = setTimeout(() => {
            if (child === owned) { try { owned.kill('SIGKILL') } catch {} }
            resolve()
          }, 3000) })])
        } finally { clearTimeout(forceTimer) }
      }
      report('stopped')
    })()
    return closing
  }
  signal?.addEventListener('abort', close, { once: true })
  if (signal?.aborted) void close(); else start()
  return { close, get pid() { return child?.pid }, args: [...args] }
}
