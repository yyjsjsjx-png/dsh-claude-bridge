// Explicit, opt-in fault acceptance against an existing VPS and installed DSH.
// No dependency installation, real SDK, model request, or production restart.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once, EventEmitter } from 'node:events'
import { createServer, connect } from 'node:net'
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { superviseSshTunnel } from '../src/ssh-tunnel.mjs'

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const sshTarget = process.env.BRIDGE_E2E_SSH_TARGET
const remoteDeployment = process.env.BRIDGE_E2E_REMOTE_DEPLOYMENT
const remoteUser = process.env.BRIDGE_E2E_REMOTE_USER
const resources = process.env.DSH_CLAUDE_BRIDGE_RESOURCES
if (!/^[A-Za-z0-9_.@-]+$/.test(sshTarget ?? '') || !/^\/[A-Za-z0-9/_.-]+$/.test(remoteDeployment ?? '')
  || !/^[a-z_][a-z0-9_-]{0,31}$/.test(remoteUser ?? '') || !resources) {
  throw new Error('请设置 BRIDGE_E2E_SSH_TARGET、BRIDGE_E2E_REMOTE_DEPLOYMENT、BRIDGE_E2E_REMOTE_USER 和 DSH_CLAUDE_BRIDGE_RESOURCES。')
}
const id = randomUUID().slice(0, 8)
const directory = join(project, '.local', `recovery-e2e-${id}`)
const deploy = join(directory, 'deploy')
const remoteRoot = `${remoteDeployment}/validation/recovery-${id}`
const unit = `dsh-bridge-e2e-${id}`
const node = `${remoteDeployment}/runtime/bin/node`
const executable = join(dirname(resolve(resources)), 'DeepSeek Harness.exe')
const port = Number(process.env.BRIDGE_E2E_PORT ?? 18948)
const scenarioNames = ['short-drop', 'ssh-restart', 'offline-stop', 'host-crash', 'worker-crash', 'server-crash', 'unknown-result']
const selected = new Set((process.env.BRIDGE_E2E_SCENARIOS ?? scenarioNames.join(',')).split(','))
if (!selected.size || [...selected].some(name => !scenarioNames.includes(name))) throw new Error('BRIDGE_E2E_SCENARIOS 包含无效验收项。')
const quote = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`
async function command(binary, args, input) {
  const child = spawn(binary, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const timer = setTimeout(() => child.kill(), 90_000)
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
  child.stdin.end(input)
  const [code] = await once(child, 'close')
  clearTimeout(timer)
  if (code !== 0) throw Object.assign(new Error(`验收命令失败：${binary}（${code}） ${args.at(-1)?.slice(0, 240)}`),
    { code, detail: stderr.slice(-1200), retryableConnect: code === 255 && /Connection to .+ port \d+ timed out|connect to host .+ port \d+: Connection timed out/.test(stderr) })
  return stdout.trim()
}
async function ssh(text) {
  for (let attempt = 0; ; attempt++) {
    try { return await command('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', sshTarget, text]) }
    catch (error) { if (attempt || !error.retryableConnect) throw error; await delay(1000) }
  }
}
let uid, tunnel, serviceStarted = false, blocked = false
const sockets = new Set(), clients = new Set(), report = []
const proxy = createServer(socket => {
  if (blocked) { socket.destroy(); return }
  const upstream = connect({ host: '127.0.0.1', port })
  sockets.add(socket); sockets.add(upstream)
  socket.on('error', () => {}); upstream.on('error', () => socket.destroy())
  socket.once('close', () => { sockets.delete(socket); upstream.destroy() })
  upstream.once('close', () => { sockets.delete(upstream); socket.destroy() })
  socket.pipe(upstream).pipe(socket)
})
async function reachable() {
  for (let i = 0; i < 60; i++) {
    const ok = await new Promise(resolve => {
      const socket = connect({ host: '127.0.0.1', port }); socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false)); socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
    if (ok) return
    await delay(250)
  }
  throw new Error('FIXTURE_TUNNEL_TIMEOUT')
}
async function startService() {
  await ssh(`systemd-run --unit=${quote(unit)} --collect --service-type=exec --property=KillMode=control-group `
    + `--property=${quote(`User=${remoteUser}`)} --property=${quote(`Group=${remoteUser}`)} --property=TimeoutStopSec=10 `
    + `--setenv=${quote(`BRIDGE_REMOTE_ROOT=${remoteRoot}`)} --setenv=${quote(`BRIDGE_PORT=${port}`)} `
    + `${quote(node)} ${quote(`${remoteRoot}/test/fixtures/recovery-server.mjs`)}`)
  serviceStarted = true
  await delay(300)
}
async function stopService(crash = false) {
  if (!serviceStarted) return
  await ssh(`systemctl ${crash ? 'kill --signal=SIGKILL --kill-whom=main' : 'stop'} ${quote(unit)}`)
  if (crash) await ssh(`systemctl stop ${quote(unit)}`).catch(() => {})
  serviceStarted = false
  await delay(300)
}
async function client(name) {
  const path = join(directory, name)
  const child = spawn(executable, ['--expose-internals', join(project, 'test/fixtures/recovery-client.mjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CLAUDE_BRIDGE_RESOURCES: resources,
      BRIDGE_FIXTURE_CLIENT: path, BRIDGE_FIXTURE_CONNECTION: join(directory, 'connection.json') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const events = new EventEmitter(), received = [], pending = new Map()
  let sequence = 0, tail = '', exited = false
  child.stderr.on('data', data => { tail = (tail + data.toString()).slice(-2500) })
  child.stdout.resume()
  child.on('message', message => {
    if (message.event) { received.push(message.event); events.emit(message.event) }
    if (message.id) { const handler = pending.get(message.id); pending.delete(message.id); message.error ? handler?.reject(new Error(message.error)) : handler?.resolve(message.value) }
  })
  child.on('close', () => { exited = true; for (const handler of pending.values()) handler.reject(new Error('FIXTURE_CLIENT_EXITED')); pending.clear(); events.emit('exited') })
  function stage(name) {
    if (received.includes(name)) return Promise.resolve()
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`FIXTURE_STAGE_TIMEOUT:${name}:${tail}`)) }, 25_000)
      const ready = () => { cleanup(); accept() }
      const exited = () => { cleanup(); reject(new Error(`FIXTURE_START_FAILED:${tail}`)) }
      function cleanup() { clearTimeout(timer); events.off(name, ready); events.off('exited', exited) }
      events.once(name, ready); events.once('exited', exited)
    })
  }
  function request(command, values = {}) {
    const id = ++sequence
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`FIXTURE_REQUEST_TIMEOUT:${command}`)) }, 90_000)
      pending.set(id, { resolve: value => { clearTimeout(timer); accept(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      child.send({ id, command, ...values })
    })
  }
  const handle = { path, child, stage, request,
    async close() { if (!exited) { await request('close'); if (!exited) await once(child, 'close') } clients.delete(handle) },
    async crash() { if (!exited) { child.kill('SIGKILL'); await once(child, 'close') } clients.delete(handle) },
  }
  clients.add(handle); await stage('ready'); return handle
}
async function count(path) { try { return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).length } catch (error) { if (error.code === 'ENOENT') return 0; throw error } }
async function verifyEffects(c, expected) {
  assert.equal(await count(join(c.path, 'tool-starts.txt')), 1, '原工具只能派发一次')
  assert.equal(await count(join(c.path, 'effects.txt')), expected, '合成副作用次数不符')
}
function pass(scenario, details) { report.push({ scenario, passed: true, ...details }); console.log(`通过：${scenario}`) }

try {
  await mkdir(deploy, { recursive: true })
  await cp(join(project, 'src'), join(deploy, 'src'), { recursive: true })
  await mkdir(join(deploy, 'remote')); await mkdir(join(deploy, 'test/fixtures'), { recursive: true })
  for (const name of ['runtime', 'server', 'catalog', 'auth', 'lock', 'errors', 'plan-usage', 'history']) {
    await cp(join(project, 'remote', name + '.mjs'), join(deploy, 'remote', name + '.mjs'))
  }
  await cp(join(project, 'remote/package.json'), join(deploy, 'remote/package.json'))
  for (const name of ['recovery-server', 'recovery-worker']) await cp(join(project, 'test/fixtures', name + '.mjs'), join(deploy, 'test/fixtures', name + '.mjs'))
  const token = randomBytes(32).toString('base64url')
  await mkdir(join(deploy, 'private')); await writeFile(join(deploy, 'private/fixture-token'), token, { mode: 0o600 })
  uid = await ssh(`id -u ${quote(remoteUser)}`)
  if (!/^[1-9][0-9]*$/.test(uid)) throw new Error('FIXTURE_USER_INVALID')
  await ssh(`install -d -m 700 -o ${quote(remoteUser)} -g ${quote(remoteUser)} ${quote(remoteRoot)}`)
  console.log('已准备独立测试目录，正在同步合成夹具。')
  const archive = join(directory, 'fixture.tar')
  await command('tar', ['-cf', archive, '-C', deploy, '.'])
  await command('scp', ['-q', '-B', '-o', 'ConnectTimeout=10', archive, `${sshTarget}:${remoteRoot}/fixture.tar`])
  await ssh(`tar -xf ${quote(remoteRoot + '/fixture.tar')} -C ${quote(remoteRoot)}`)
  await ssh(`chown -R ${quote(remoteUser + ':' + remoteUser)} ${quote(remoteRoot)} && chmod -R go-rwx ${quote(remoteRoot)} && ln -s ${quote(remoteDeployment + '/remote/node_modules')} ${quote(remoteRoot + '/remote/node_modules')}`)
  await startService()
  console.log('独立测试服务已启动，正在建立真实 SSH 转发。')
  tunnel = superviseSshTunnel({ target: sshTarget, localPort: port, remotePort: port })
  await reachable()
  await new Promise((accept, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', accept) })
  await writeFile(join(directory, 'connection.json'), JSON.stringify({ url: `ws://127.0.0.1:${proxy.address().port}/`, token }), { mode: 0o600 })

  for (const mode of ['short-drop', 'ssh-restart'].filter(name => selected.has(name))) {
    const c = await client(mode), running = c.request('run', { mode })
    await Promise.race([c.stage('tool-started'), running.then(result => { throw new Error(`FIXTURE_ENDED_EARLY:${JSON.stringify(result)}`) })])
    if (mode === 'short-drop') {
      blocked = true; for (const socket of sockets) socket.destroy()
      await delay(1200); blocked = false
    } else { assert.ok(tunnel.pid); process.kill(tunnel.pid, 'SIGKILL') }
    const result = await running
    assert.equal(result.outcome, 'completed'); assert.equal(result.tailCount, 1)
    await verifyEffects(c, 1); await c.close(); pass(mode, { originalQueryResumed: true, toolExecutions: 1 })
  }

  if (selected.has('offline-stop')) {
    const c = await client('offline-stop'), running = c.request('run', { mode: 'offline-stop' })
    await Promise.race([c.stage('tool-started'), running.then(result => { throw new Error(`FIXTURE_ENDED_EARLY:${JSON.stringify(result)}`) })]); blocked = true; for (const socket of sockets) socket.destroy()
    await c.request('stop'); await delay(1200); blocked = false
    const result = await running
    assert.equal(result.outcome, 'failed'); assert.equal(result.tailCount, 0)
    await verifyEffects(c, 0); await c.close(); pass('offline-stop', { sideEffects: 0, lateOutput: 0 })
  }

  for (const mode of ['host-crash', 'worker-crash', 'server-crash'].filter(name => selected.has(name))) {
    let c = await client(mode)
    const running = c.request('run', { mode }).catch(error => ({ outcome: 'process-exit', code: error.message }))
    if (mode === 'worker-crash') {
      const result = await running; assert.notEqual(result.outcome, 'completed'); await c.close()
    } else {
      await c.stage('native-persisted')
      if (mode === 'server-crash') { await stopService(true); await startService(); await delay(500) }
      await c.crash(); await running
    }
    c = await client(mode)
    const recovered = await c.request('sync')
    assert.equal(recovered.reply.status, 'ready'); assert.equal(recovered.tailCount, 1); assert.equal(recovered.knownResults, 1)
    const duplicate = await c.request('sync'); assert.equal(duplicate.tailCount, 1)
    const continued = await c.request('run', { mode: 'continue' })
    assert.equal(continued.outcome, 'completed'); assert.equal(continued.continueCount, 1)
    await verifyEffects(c, 1); await c.close(); pass(mode, { nativeTailRecovered: true, continued: true, toolExecutions: 1 })
  }

  if (selected.has('unknown-result')) {
    const c = await client('unknown-result')
    const result = await c.request('run', { mode: 'unknown-result' }); assert.equal(result.outcome, 'failed')
    const recovered = await c.request('sync')
    assert.equal(recovered.reply.status, 'ready'); assert.equal(recovered.recovery.unresolvedTools, 1)
    assert.equal((await c.request('run', { mode: 'continue' })).outcome, 'completed')
    assert.equal((await c.request('run', { mode: 'continue' })).outcome, 'completed')
    await verifyEffects(c, 1); await c.close(); pass('unknown-result', { unresolvedPreserved: true, toolExecutions: 1 })
  }

  const queryText = await ssh(`cat ${quote(remoteRoot + '/fixture-queries.jsonl')}`)
  const queries = queryText.split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (const mode of selected) {
    assert.equal(queries.filter(query => query.mode === mode).length, 1, `原 query 不可重发：${mode}`)
  }
  if (selected.has('unknown-result')) {
    const unknownSession = queries.find(query => query.mode === 'unknown-result').sessionId
    assert.deepEqual(queries.filter(query => query.mode === 'continue' && query.sessionId === unknownSession).map(query => query.notice), [true, false])
  }
  await writeFile(join(directory, 'report.json'), JSON.stringify({ passed: true, actualModelRequests: 0,
    nativeDshVersion: '0.2.1-rc.5', scenarios: report, totalQueries: queries.length }, null, 2))
  console.log(`验收完成：${report.length} 项完整链路模拟，真实模型请求 0。报告：${join(directory, 'report.json')}`)
} catch (error) {
  console.error(error.message); if (error.detail) console.error(error.detail)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'report.json'), JSON.stringify({ passed: false, actualModelRequests: 0, scenarios: report, error: error.message }, null, 2))
  process.exitCode = 1
} finally {
  blocked = true
  for (const socket of sockets) socket.destroy()
  if (proxy.listening) await new Promise(resolve => proxy.close(resolve))
  for (const c of clients) await c.crash().catch(() => {})
  await tunnel?.close()
  await stopService().catch(() => {})
}
