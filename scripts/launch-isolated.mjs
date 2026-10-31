import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, access, copyFile } from 'node:fs/promises'
import { createWriteStream, watch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { superviseSshTunnel } from '../src/ssh-tunnel.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const resources = process.argv[2] ?? process.env.DSH_CLAUDE_BRIDGE_RESOURCES
if (!resources) throw new Error('请指定现有 DSH 安装的 resources 目录。')
const executable = join(dirname(resolve(resources)), 'DeepSeek Harness.exe')
const cli = join(resources, 'app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
const directory = join(project, '.local')
const home = join(directory, 'harness')
const profile = join(home, 'profiles/claude-bridge')
const hostArgs = process.argv.slice(3)
let sshTarget = process.env.DSH_CLAUDE_BRIDGE_SSH_TARGET
const tunnelIndex = hostArgs.indexOf('--ssh-target')
if (tunnelIndex >= 0) {
  if (!hostArgs[tunnelIndex + 1]) throw new Error('--ssh-target 需要现有 SSH 别名。')
  sshTarget = hostArgs[tunnelIndex + 1]; hostArgs.splice(tunnelIndex, 2)
}
if (sshTarget) {
  const probe = createServer()
  try {
    await new Promise((accept, reject) => {
      probe.once('error', reject)
      probe.listen({ host: '127.0.0.1', port: 18944, exclusive: true }, accept)
    })
  } catch (error) {
    throw new Error(error.code === 'EADDRINUSE'
      ? '本机 18944 端口已占用，请先关闭已有转发，或不传 --ssh-target 以复用已有转发。'
      : '无法检查 SSH 转发端口。')
  } finally { if (probe.listening) await new Promise(resolve => probe.close(resolve)) }
}
await mkdir(directory, { recursive: true })
await mkdir(home, { recursive: true })

const replacements = {
  __AGENT_LOOP_URL__: 'plugin/compat/agent-loop.mjs',
  __BRIDGE_SERVICE_URL__: 'plugin/index.mjs',
  __SESSION_CONTROLLER_URL__: 'plugin/session-controller.mjs',
  __SESSION_CLIENT_URL__: 'plugin/session-client/index.mjs',
  __PRESET_REGISTRY_URL__: 'plugin/preset-registry.mjs',
  __PRESET_SERVICE_URL__: 'plugin/preset-service.mjs',
  __BRIDGE_UI_URL__: 'plugin/ui/index.mjs',
}
let patch = await readFile(join(project, 'patches/isolated.template.yml'), 'utf8')
for (const [key, path] of Object.entries(replacements)) patch = patch.replaceAll(key, pathToFileURL(join(project, path)).href)
const patchPath = join(directory, 'isolated.patch.yml')
await writeFile(patchPath, patch)

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home,
  DSH_CLAUDE_BRIDGE_RESOURCES: resolve(resources), NO_COLOR: '1' }
let exists = false
try { await access(profile); exists = true } catch (error) { if (error.code !== 'ENOENT') throw error }
if (!exists) {
  const bootstrap = spawnSync(executable, ['--expose-internals', cli, '--profile', 'claude-bridge',
    '--from-default-profile', 'web', '--help'], { env, encoding: 'utf8', windowsHide: true, timeout: 90000 })
  if (bootstrap.status !== 0) {
    await writeFile(join(directory, 'bootstrap.error.log'), bootstrap.stderr ?? '')
    throw new Error(`隔离 profile 初始化失败（${bootstrap.status ?? bootstrap.error?.code}），见 .local/bootstrap.error.log。`)
  }
}

// Development-only mirror: preserve this machine's real global instructions in
// the isolated test home while leaving the installed DSH home unchanged.
const globalInstructions = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'AGENTS.md')
let instructionWatcher
try {
  await access(globalInstructions)
  await copyFile(globalInstructions, join(home, 'AGENTS.md'))
  instructionWatcher = watch(globalInstructions, () => {
    copyFile(globalInstructions, join(home, 'AGENTS.md')).catch(() => {})
  })
} catch (error) { if (error.code !== 'ENOENT') throw error }

const output = createWriteStream(join(directory, 'host.stdout.log'), { flags: 'a', mode: 0o600 })
const errors = createWriteStream(join(directory, 'host.stderr.log'), { flags: 'a', mode: 0o600 })
let tunnelWrites = Promise.resolve()
const tunnel = sshTarget ? superviseSshTunnel({ target: sshTarget,
  onState: value => { tunnelWrites = tunnelWrites.catch(() => {}).then(() =>
    writeFile(join(directory, 'tunnel-process.json'), JSON.stringify({ ...value, launcherPid: process.pid }), { mode: 0o600 }));
    return tunnelWrites },
}) : undefined
const child = spawn(executable, ['--expose-internals', cli, '--profile', 'claude-bridge', '--patch', patchPath,
  '--no-open', ...hostArgs], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
child.stdout.pipe(output)
child.stderr.pipe(errors)
await writeFile(join(directory, 'host-process.json'), JSON.stringify({ pid: child.pid, home, patchPath }, null, 2))
console.log('隔离 DSH Host 已启动；日志保存在项目 .local 目录。')
const shutdown = () => { child.kill(); instructionWatcher?.close(); void tunnel?.close() }
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)
child.once('exit', async (code) => {
  instructionWatcher?.close(); await tunnel?.close(); await tunnelWrites; output.end(); errors.end(); process.exitCode = code ?? 1
})
child.once('error', async (error) => {
  instructionWatcher?.close(); await tunnel?.close(); await tunnelWrites; errors.end(); output.end(); console.error(error.code ?? 'HOST_START_FAILED'); process.exitCode = 1
})
