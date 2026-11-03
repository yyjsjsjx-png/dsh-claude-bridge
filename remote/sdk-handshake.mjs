import { WorkerError } from './worker-error.mjs'

/** Minimal child environment for the official CLI; no parent secrets are inherited. */
export function cleanChildEnvironment({ homeDir, configDir, cliPath, userName }) {
  const env = {
    HOME: homeDir,
    USER: userName,
    LOGNAME: userName,
    PATH: `${cliPath.slice(0, cliPath.lastIndexOf('/'))}:/usr/local/bin:/usr/bin:/bin`,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
  }
  for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR']) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name]
  }
  return env
}

/** Await the SDK initialization result and require that the bridge hooks were applied. */
export async function verifyHooksApplied(query, controller) {
  if (typeof query?.initializationResult !== 'function') {
    throw new WorkerError('HOOK_HANDSHAKE_UNAVAILABLE', 'SDK 未提供可验证的 hooks 初始化结果')
  }
  let timer, onAbort
  try {
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(new WorkerError('CANCELLED', '请求已取消'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
      if (controller.signal.aborted) onAbort()
      timer = setTimeout(() => reject(new WorkerError('HOOK_HANDSHAKE_TIMEOUT', 'SDK hooks 初始化超时')), 30_000)
    })
    const initialized = await Promise.race([query.initializationResult(), cancelled])
    if (initialized?.hooks_applied !== true) throw new WorkerError('HOOKS_NOT_APPLIED', 'SDK 未确认必要 hooks 已注册')
    return initialized
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

/** Require the SDK init message to list exactly the tools admitted for this query. */
export function verifyToolset(message, sessionId, expectedNames) {
  if (message?.type !== 'system' || message.subtype !== 'init' || message.session_id !== sessionId
    || !Array.isArray(message.tools) || message.tools.some((name) => typeof name !== 'string')
    || new Set(message.tools).size !== message.tools.length
    || message.tools.length !== expectedNames.size || message.tools.some((name) => !expectedNames.has(name))) {
    throw new WorkerError('SDK_TOOLSET_MISMATCH', '远程 SDK 工具清单与本次准入的工具不一致')
  }
}
