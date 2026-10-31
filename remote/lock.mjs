import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'

class LockError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LockError'
    this.code = code
  }
}

function abortError() {
  return new LockError('CANCELLED', '获取会话锁时已取消')
}

function waitForExit(child) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    child.once('exit', (code, signal) => finish({ code, signal }))
    child.once('error', () => finish({ error: true }))
  })
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Hold a Linux advisory lock for the lifetime of the child process's stdin. */
export async function acquireSessionLock(lockPath, { signal, spawnProcess = spawn } = {}) {
  if (typeof lockPath !== 'string' || !lockPath || signal?.aborted) {
    if (signal?.aborted) throw abortError()
    throw new LockError('LOCK_INVALID', '会话锁路径无效')
  }
  // The lock file is intentionally retained: unlinking it could create two
  // independent inodes while another worker still holds the original lock.
  const file = await open(lockPath, 'a', 0o600)
  await file.close()
  if (signal?.aborted) throw abortError()

  let child
  try {
    child = spawnProcess('/usr/bin/flock', [
      '-n', '-x', '-E', '75', lockPath, '/bin/sh', '-c', 'printf R; exec cat >/dev/null',
    ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  } catch {
    throw new LockError('LOCK_UNAVAILABLE', '无法启动会话锁')
  }
  // The child can exit before a release closes the pipe; this listener keeps
  // that teardown error from escaping the worker.
  child.stdin.on('error', () => {})
  const exited = waitForExit(child)
  let expectedExit = false
  let hasExited = false
  let acquired = false
  const lost = exited.then((result) => {
    hasExited = true
    return acquired && !expectedExit ? { code: 'SESSION_LOCK_LOST', ...result } : undefined
  })
  const ready = new Promise((resolve, reject) => {
    child.stdout.once('data', (data) => {
      if (data.length !== 1 || data[0] !== 82) return reject(new LockError('LOCK_UNAVAILABLE', '会话锁响应无效'))
      acquired = true
      resolve()
    })
    child.stdout.once('error', () => reject(new LockError('LOCK_UNAVAILABLE', '无法读取会话锁状态')))
  })
  let cancelReady
  const cancellation = new Promise((_, reject) => { cancelReady = () => reject(abortError()) })
  signal?.addEventListener('abort', cancelReady, { once: true })
  if (signal?.aborted) cancelReady()
  try {
    await Promise.race([
      ready,
      exited.then((result) => {
        throw result.code === 75
          ? new LockError('SESSION_BUSY', '此会话正在其他进程中运行')
          : new LockError('LOCK_UNAVAILABLE', '会话锁进程无法运行')
      }),
      cancellation,
      delay(5000).then(() => { throw new LockError('LOCK_TIMEOUT', '获取会话锁超时') }),
    ])
  } catch (error) {
    expectedExit = true
    child.stdin.end()
    if (!hasExited) child.kill('SIGTERM')
    await Promise.race([exited, delay(2000)])
    throw error
  } finally {
    signal?.removeEventListener('abort', cancelReady)
  }

  return {
    lost,
    get held() { return acquired && !expectedExit && !hasExited },
    async release() {
      if (expectedExit) return
      expectedExit = true
      child.stdin.end()
      const done = await Promise.race([exited.then(() => true), delay(3000).then(() => false)])
      if (!done) {
        child.kill('SIGTERM')
        const stopped = await Promise.race([exited.then(() => true), delay(2000).then(() => false)])
        if (!stopped) {
          child.kill('SIGKILL')
          const killed = await Promise.race([exited.then(() => true), delay(2000).then(() => false)])
          if (!killed) throw new LockError('LOCK_RELEASE_FAILED', '会话锁进程未能结束')
        }
      }
    },
  }
}
