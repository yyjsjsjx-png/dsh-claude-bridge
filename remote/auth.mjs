import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { sdkErrorDetail } from './errors.mjs'

const execFileAsync = promisify(execFile)

export class AuthError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

// The official command may include email and other account fields; only these
// two fields are allowed to leave this module. Never log stdout or stderr.
export function createAuthReader({ cliPath, childEnv, exec = execFileAsync, now = () => Date.now(), cacheMs = 30_000 }) {
  let cached
  async function read({ signal, refresh = false } = {}) {
    if (signal?.aborted) throw new AuthError('CANCELLED', '登录状态查询已取消')
    if (!refresh && cached && now() - cached.time < cacheMs) return { ...cached.status }
    let stdout
    try {
      ;({ stdout } = await exec(cliPath, ['auth', 'status', '--json'], {
        env: childEnv, timeout: 10_000, maxBuffer: 32 * 1024, signal,
      }))
    } catch (error) {
      if (signal?.aborted) throw new AuthError('CANCELLED', '登录状态查询已取消')
      // The CLI may return nonzero with valid JSON when no login exists.
      if (typeof error?.stdout !== 'string' || !error.stdout.trim()) {
        const detail = sdkErrorDetail(error)
        throw new AuthError(detail?.code ?? 'AUTH_STATUS_UNAVAILABLE', detail?.message ?? '无法读取远程 Claude Code 登录状态')
      }
      stdout = error.stdout
    }
    let value
    try { value = JSON.parse(stdout) } catch { throw new AuthError('AUTH_STATUS_UNAVAILABLE', '远程 Claude Code 登录状态格式无效') }
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.loggedIn !== 'boolean') {
      throw new AuthError('AUTH_STATUS_UNAVAILABLE', '远程 Claude Code 登录状态格式无效')
    }
    const status = { loggedIn: value.loggedIn }
    if (typeof value.authMethod === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value.authMethod)) {
      status.authMethod = value.authMethod
    }
    cached = { time: now(), status }
    return { ...status }
  }
  return { read }
}
