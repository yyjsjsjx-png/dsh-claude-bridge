import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createRpcPeer } from '../src/rpc.mjs'
import { createWorkerHandlers, parseServiceBudget } from './runtime.mjs'
import { createWorkerObservability } from './observability-worker.mjs'

const execFileAsync = promisify(execFile)
const expectedSdkVersion = '0.3.314'
const defaultCliVersion = '2.1.314'
let stage = 'config'

class StartupError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function absolutePath(value, code) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\0]/.test(value)) throw new StartupError(code)
  return resolve(value)
}

async function main() {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) throw new StartupError('USER_NOT_ALLOWED')
  const userName = userInfo().username
  const homeDir = absolutePath(process.env.HOME, 'HOME_INVALID')
  const projectRoot = absolutePath(process.env.BRIDGE_REMOTE_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url))), 'ROOT_INVALID')
  const configDir = join(projectRoot, 'claude-config')
  const sessionRoot = join(projectRoot, 'sessions')
  if (absolutePath(process.env.CLAUDE_CONFIG_DIR, 'CONFIG_INVALID') !== configDir) throw new StartupError('CONFIG_MISMATCH')
  const expectedCliVersion = process.env.BRIDGE_CLAUDE_VERSION ?? defaultCliVersion
  if (!/^\d+\.\d+\.\d+$/.test(expectedCliVersion)) throw new StartupError('CLI_VERSION_INVALID')
  let maxBudgetUsd
  try { maxBudgetUsd = parseServiceBudget(process.env.BRIDGE_MAX_BUDGET_USD) }
  catch { throw new StartupError('BUDGET_INVALID') }
  const cliPath = absolutePath(process.env.BRIDGE_CLAUDE_PATH
    ?? join(homeDir, '.local/share/claude/versions', expectedCliVersion), 'CLI_PATH_INVALID')

  stage = 'dependencies'
  let sdk, zod
  try { [sdk, zod] = await Promise.all([import('@anthropic-ai/claude-agent-sdk'), import('zod')]) } catch {
    throw new StartupError('DEPENDENCY_IMPORT_FAILED')
  }
  const sdkEntry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))
  let sdkMetadata
  try { sdkMetadata = JSON.parse(await readFile(join(dirname(sdkEntry), 'package.json'), 'utf8')) } catch {
    throw new StartupError('SDK_METADATA_INVALID')
  }
  if (sdkMetadata.version !== expectedSdkVersion) throw new StartupError('SDK_VERSION_MISMATCH')

  stage = 'cli'
  let stdout
  try {
    ({ stdout } = await execFileAsync(cliPath, ['--version'], {
      timeout: 10_000,
      maxBuffer: 4096,
      env: { HOME: homeDir, PATH: '/usr/local/bin:/usr/bin:/bin', CLAUDE_CONFIG_DIR: configDir },
    }))
  } catch { throw new StartupError('CLI_VERSION_CHECK_FAILED') }
  if (!stdout.trim().startsWith(`${expectedCliVersion} `)) throw new StartupError('CLI_VERSION_MISMATCH')

  stage = 'rpc'
  let worker, peer
  const observability = createWorkerObservability(process, {
    fetchQuota: context => worker?.readObservabilityQuota(context) ?? { status: 'unavailable', code: 'SDK_QUOTA_UNAVAILABLE' },
    onWarning: warning => { try { peer?.notify('observability.warning', warning) } catch {} },
  })
  worker = createWorkerHandlers({
    sdk, zod, sessionRoot, configDir, cliPath, homeDir, userName,
    sdkVersion: sdkMetadata.version, cliVersion: expectedCliVersion,
    authorizedDeviceId: process.env.BRIDGE_DEVICE_ID,
    maxBudgetUsd,
    observability,
  })
  peer = createRpcPeer({ input: process.stdin, output: process.stdout, handlers: worker.handlers, onClose: worker.close })
  await peer.closed
  await worker.close()
  observability?.close()
  if (process.connected) process.disconnect()
}

// Diagnostics never include prompts, credentials, authorization URLs, or environment dumps.
main().catch((error) => {
  const code = error instanceof StartupError ? error.code : 'UNEXPECTED'
  process.stderr.write(`远程工作进程启动失败：${stage}/${code}\n`)
  process.exitCode = 1
})
