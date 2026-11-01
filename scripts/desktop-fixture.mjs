// Opt-in isolated VPS fixture for a desktop acceptance run. No real SDK/CLI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, connect } from 'node:net'
import { mkdir, readFile, writeFile, cp, access } from 'node:fs/promises'
import { join, dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { superviseSshTunnel } from '../src/ssh-tunnel.mjs'
import { createWebSocketTransport } from '../src/websocket-transport.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const directory = join(project, '.local', 'desktop-acceptance-fixture')
const currentPath = join(directory, 'current.json')
const quote = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`
function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || typeof config.target !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,253}$/.test(config.target)
    || typeof config.deployment !== 'string' || !/^\/[A-Za-z0-9/_.-]+$/.test(config.deployment)
    || config.deployment === '/' || posix.normalize(config.deployment) !== config.deployment
    || config.deployment.endsWith('/') || typeof config.user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(config.user)
    || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('FIXTURE_CONFIG_INVALID')
  }
  return { target: config.target, deployment: config.deployment, user: config.user, port: config.port }
}
function startConfig() {
  if (!process.env.BRIDGE_E2E_SSH_TARGET || !process.env.BRIDGE_E2E_REMOTE_DEPLOYMENT || !process.env.BRIDGE_E2E_REMOTE_USER) {
    throw new Error('请显式设置 BRIDGE_E2E_SSH_TARGET、BRIDGE_E2E_REMOTE_DEPLOYMENT 和 BRIDGE_E2E_REMOTE_USER。')
  }
  return validateConfig({ target: process.env.BRIDGE_E2E_SSH_TARGET,
    deployment: process.env.BRIDGE_E2E_REMOTE_DEPLOYMENT, user: process.env.BRIDGE_E2E_REMOTE_USER,
    port: Number(process.env.BRIDGE_E2E_PORT ?? 18949) })
}
async function command(binary, args, input) {
  const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const timer = setTimeout(() => child.kill(), 90000)
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
  child.stdin.end(input)
  const [code] = await once(child, 'close')
  clearTimeout(timer)
  if (code !== 0) throw Object.assign(new Error(`FIXTURE_COMMAND_FAILED:${binary}:${code}`), { detail: stderr.slice(-1200) })
  return stdout.trim()
}
const ssh = (config, text) => command('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5',
  '-o', 'ServerAliveCountMax=2', config.target, text])
const exists = path => access(path).then(() => true, () => false)
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 })
async function localPortFree(port) {
  const probe = createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve) })
  await new Promise(resolve => probe.close(resolve))
}
async function reachable(port) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const okay = await new Promise(resolve => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false)); socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (okay) return
    await delay(250)
  }
  throw new Error('FIXTURE_TUNNEL_TIMEOUT')
}
async function readCurrent() {
  const state = JSON.parse(await readFile(currentPath, 'utf8'))
  if (state.configVersion !== 1) throw new Error('FIXTURE_LEDGER_CONFIG_MISSING')
  const config = validateConfig(state.config)
  if (!/^[a-f0-9]{8}$/.test(state.id) || state.unit !== `dsh-bridge-desktop-${state.id}`
    || state.remoteRoot !== `${config.deployment}/validation/desktop-${state.id}`
    || state.port !== config.port || state.directory !== join(directory, state.id)
    || state.connectionFile !== join(state.directory, 'connection.json')) throw new Error('FIXTURE_STATE_INVALID')
  state.config = config
  return state
}
async function status(state) {
  return ssh(state.config, `systemctl show ${quote(state.unit)} --property=ActiveState --property=SubState --property=MainPID`)
}
const action = process.argv[2] ?? 'status'
if (action === 'quota') {
  const state = await readCurrent(), mode = process.argv[3]
  if (!['both', 'week-only', '5h-only', 'neither'].includes(mode)) throw new Error('FIXTURE_QUOTA_MODE_INVALID')
  const path = `${state.remoteRoot}/private/quota-mode.json`
  await ssh(state.config, `printf '%s\\n' ${quote(JSON.stringify({ mode }))} > ${quote(path)} && chown ${quote(state.config.user + ':' + state.config.user)} ${quote(path)} && chmod 600 ${quote(path)}`)
  console.log(JSON.stringify({ syntheticQuotaMode: mode, actualModelRequests: 0 }))
} else if (action === 'stop') {
  const state = await readCurrent()
  await writeFile(join(state.directory, 'stop.signal'), 'stop', { mode: 0o600 })
  await ssh(state.config, `systemctl stop ${quote(state.unit)}`)
  console.log('已请求停止本轮独立验收服务与转发。')
} else if (action === 'status' || action === 'report') {
  const state = await readCurrent()
  console.log(await status(state))
  if (action === 'report') {
    const text = await ssh(state.config, `if test -f ${quote(state.remoteRoot + '/fixture-metadata.jsonl')}; then cat ${quote(state.remoteRoot + '/fixture-metadata.jsonl')}; fi`)
    const events = text.split('\n').filter(Boolean).map(line => JSON.parse(line))
    await save(join(state.directory, 'metadata-report.json'), { actualModelRequests: 0, events })
    console.log(JSON.stringify({ report: join(state.directory, 'metadata-report.json'), queries: events.filter(e => e.event === 'query').length,
      tools: events.filter(e => e.event === 'tool').length, finals: events.filter(e => e.event === 'final').length }))
  }
} else if (action === 'start') {
  const config = startConfig(), { target, deployment, user, port } = config
  const remote = text => ssh(config, text)
  await mkdir(directory, { recursive: true })
  await localPortFree(port)
  const id = randomUUID().slice(0, 8), work = join(directory, id), deploy = join(work, 'deploy')
  const remoteRoot = `${deployment}/validation/desktop-${id}`, unit = `dsh-bridge-desktop-${id}`
  const state = { configVersion: 1, config, id, directory: work, remoteRoot, unit, port, pid: process.pid,
    connectionFile: join(work, 'connection.json'), fixture: true, actualModelRequests: 0 }
  let started = false, tunnel, done = false
  const stop = () => { done = true }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const preflight = await remote(`test -x ${quote(deployment + '/runtime/bin/node')} && test -d ${quote(deployment + '/remote/node_modules')} && `
      + `id -u ${quote(user)} && if ss -H -ltn 'sport = :${port}' | read line; then echo PORT_OCCUPIED; exit 23; else echo PORT_FREE; fi`)
    assert.match(preflight, /^[1-9][0-9]*\nPORT_FREE$/)
    await mkdir(deploy, { recursive: true })
    await cp(join(project, 'src'), join(deploy, 'src'), { recursive: true })
    await mkdir(join(deploy, 'remote')); await mkdir(join(deploy, 'test/fixtures'), { recursive: true })
    await mkdir(join(deploy, 'plugin'))
    await cp(join(project, 'plugin/policy.mjs'), join(deploy, 'plugin/policy.mjs'))
    for (const name of ['runtime', 'server', 'catalog', 'auth', 'lock', 'errors', 'plan-usage', 'history']) {
      await cp(join(project, 'remote', name + '.mjs'), join(deploy, 'remote', name + '.mjs'))
    }
    await cp(join(project, 'remote/package.json'), join(deploy, 'remote/package.json'))
    for (const name of ['desktop-server', 'desktop-worker']) await cp(join(project, 'test/fixtures', name + '.mjs'), join(deploy, 'test/fixtures', name + '.mjs'))
    const token = randomBytes(32).toString('base64url')
    await mkdir(join(deploy, 'private')); await writeFile(join(deploy, 'private/fixture-token'), token, { mode: 0o600 })
    await remote(`test ! -e ${quote(remoteRoot)} && install -d -m 700 -o ${quote(user)} -g ${quote(user)} ${quote(remoteRoot)}`)
    const archive = join(work, 'fixture.tar')
    await command('tar', ['-cf', archive, '-C', deploy, '.'])
    await command('scp', ['-q', '-B', '-o', 'ConnectTimeout=10', archive, `${target}:${remoteRoot}/fixture.tar`])
    await remote(`tar -xf ${quote(remoteRoot + '/fixture.tar')} -C ${quote(remoteRoot)} && `
      + `chown -R ${quote(user + ':' + user)} ${quote(remoteRoot)} && chmod -R go-rwx ${quote(remoteRoot)} && `
      + `ln -s ${quote(deployment + '/remote/node_modules')} ${quote(remoteRoot + '/remote/node_modules')}`)
    await remote(`systemd-run --unit=${quote(unit)} --collect --service-type=exec --property=KillMode=control-group `
      + `--property=${quote(`User=${user}`)} --property=${quote(`Group=${user}`)} --property=TimeoutStopSec=10 --property=RuntimeMaxSec=7200 `
      + `--setenv=${quote(`BRIDGE_REMOTE_ROOT=${remoteRoot}`)} --setenv=${quote(`BRIDGE_PORT=${port}`)} `
      + `${quote(deployment + '/runtime/bin/node')} ${quote(remoteRoot + '/test/fixtures/desktop-server.mjs')}`)
    started = true
    await delay(500)
    const serviceStatus = await status(state)
    assert.match(serviceStatus, /ActiveState=active/)
    tunnel = superviseSshTunnel({ target, localPort: port, remotePort: port })
    await reachable(port)
    await save(state.connectionFile, { url: `ws://127.0.0.1:${port}/`, token })
    const transport = await createWebSocketTransport({ url: `ws://127.0.0.1:${port}/`, token, deviceId: randomUUID() })
    try {
      const initialized = await transport.peer.request('initialize', { protocolVersion: 1 })
      const catalog = await transport.peer.request('catalog', {})
      assert.equal(initialized.authenticated, true)
      assert.equal(catalog.status, 'ok')
      assert.equal(catalog.models[0].value, 'fixture-haiku')
      await save(join(work, 'readiness.json'), { authenticated: true, historySync: initialized.capabilities.historySync,
        modelCount: catalog.models.length, actualModelRequests: 0 })
    } finally { await transport.close() }
    await save(currentPath, state)
    await save(join(work, 'state.json'), { ...state, serviceStatus, ready: true, tunnelPid: tunnel.pid })
    console.log(JSON.stringify({ ready: true, connectionFile: state.connectionFile, directory: work, unit, port,
      cleanup: 'node scripts/desktop-fixture.mjs stop', actualModelRequests: 0 }))
    while (!done && !await exists(join(work, 'stop.signal'))) await delay(500)
  } catch (error) {
    await mkdir(work, { recursive: true })
    await save(join(work, 'failure.json'), { error: error.message, actualModelRequests: 0 })
    console.error(error.message)
    process.exitCode = 1
  } finally {
    await tunnel?.close()
    if (started) await remote(`systemctl stop ${quote(unit)}`).catch(() => {})
    await save(join(work, 'stopped.json'), { stoppedAt: Date.now(), actualModelRequests: 0 })
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
  }
} else throw new Error('用法：node scripts/desktop-fixture.mjs start|status|report|stop|quota both|week-only|5h-only|neither')
