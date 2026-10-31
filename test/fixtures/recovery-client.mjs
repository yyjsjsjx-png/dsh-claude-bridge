// Real bridge, WebSocket, state, projection, and installed DSH Session APIs.
// Only the surrounding agent context and synthetic tool are fixture-owned.
import { readFile, open, rename, mkdir, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { resolveDshModule } from '../../plugin/compat/resolve-dsh-module.mjs'
import { BridgeBackend } from '../../src/backend.mjs'
import { localHistory, knownToolResult } from '../../src/history-sync.mjs'
import { SESSION_STATUS_RECORD } from '../../src/session-status.mjs'

const directory = process.env.BRIDGE_FIXTURE_CLIENT
const connection = JSON.parse(await readFile(process.env.BRIDGE_FIXTURE_CONNECTION, 'utf8'))
await mkdir(directory, { recursive: true })
const { Session, SESSION_FORMAT_VERSION, appendPluginRecord } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
const llm = await import(resolveDshModule('@deepseek-ai/dsh-llm'))
let saved
try { saved = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
const header = saved?.header ?? { version: SESSION_FORMAT_VERSION, id: 'e2e-session', createdAt: Date.now(),
  isSeeded: false, agentPreset: 'claude-sdk-remote', cwd: directory }
const session = Session.create(header.id, saved?.events, header)
let turn = 0, latestStatus
for (let seq = 0; seq < session.seq; seq++) {
  const event = session.eventAt(seq)
  if (event.type === SESSION_STATUS_RECORD) latestStatus = event.data
  if (Number.isSafeInteger(event.data?.turn)) turn = Math.max(turn, event.data.turn)
}
const selection = { provider: 'claude-sdk-remote', model: 'fixture-haiku', reasoningEffort: 'low' }
const assembly = { tools: [{ name: 'local_command', description: '执行合成工具', parameters: { type: 'object',
  properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false } }] }
let credential, backend, controller, running
const emit = event => process.send?.({ event })
async function checkpoint() {
  const file = await open(join(directory, 'session.tmp'), 'w', 0o600)
  try {
    await file.writeFile(JSON.stringify({ header: session.header,
      events: Array.from({ length: session.seq }, (_, i) => session.eventAt(i)) }))
    await file.sync()
  } finally { await file.close() }
  await rename(join(directory, 'session.tmp'), join(directory, 'session.json'))
  return true
}
const ctx = {
  credentials: { async readRecord() { return credential }, async modifyRecord(_key, mutate) { credential = await mutate(credential); return credential }, async deleteRecord() { credential = undefined } },
  sessionProjections: { stateOf(_session, key) { return key === 'modelSelection' ? { pending: selection } : agent._bridgeStatus } },
  systemPrompt: { refreshContext() { return [] } }, fs: { processPathFromHostPath(path) { return path } }, attachments: {},
  agents: { withInitiator(_agent, operation) { return operation() } }, sessions: { flush: checkpoint },
  tools: { async execute({ arguments: args, signal }) {
    await appendFile(join(directory, 'tool-starts.txt'), args.command + '\n')
    const toolScript = "setTimeout(()=>{require('node:fs').appendFileSync(process.argv[1], 'effect\\n');process.exit(0)}, Number(process.argv[2]))"
    const child = spawn(process.execPath, ['-e', toolScript, join(directory, 'effects.txt'),
      ['short-drop', 'ssh-restart', 'offline-stop'].includes(args.command) ? '6000' : '50'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'ignore' })
    emit('tool-started')
    const stop = () => { child.kill() }
    signal.addEventListener('abort', stop, { once: true })
    try { await new Promise((accept, reject) => { child.once('close', accept); child.once('error', reject) }) }
    finally { signal.removeEventListener('abort', stop) }
    signal.throwIfAborted()
    if (args.command === 'unknown-result') throw Object.assign(new Error('合成工具回执丢失'), { code: 'FIXTURE_RESULT_LOST' })
    return { content: [{ type: 'text', text: '合成工具完成。' }], isError: false }
  } },
}
const helpers = { ...llm, appendPluginRecord, resolveDshHome: () => directory,
  credentialKey: (provider, name) => `${provider}/${name}`, renderPrompt: () => 'DSH 合成验收预设',
  assembleContextFor: () => ({}), renderContextSections: () => [], joinContextSections: () => '' }
const agent = { id: session.id, session, phase: { kind: 'idle' }, options: selection, _bridgeStatus: latestStatus,
  systemPrompt: { project: () => [] }, runtimeContext: { project: () => undefined },
  dispatch: { emit() {} }, inbox: { nextStep: [], splice() {} },
  async preStep() { return { kind: 'continue', assembly, messages: [] } },
  async runMaintenance(job) { return job(new AbortController().signal) },
}
backend = new BridgeBackend(ctx, { stateDirectory: join(directory, 'bridge') }, { helpers })
await backend.saveConnection(connection)
const notification = backend.notification.bind(backend)
backend.notification = async (method, params) => {
  await notification(method, params)
  if (method === 'sdk.message' && params.message?.subtype === 'fixture-persisted') emit('native-persisted')
}
function summary() {
  const history = localHistory(session)
  const texts = history.assistants.flatMap(event => event.data.message.content).filter(block => block.type === 'text').map(block => block.text)
  return { phase: agent._bridgeStatus?.phase, recovery: agent._bridgeStatus?.recovery,
    tailCount: texts.filter(text => text.includes('断线后的合成尾部')).length,
    continueCount: texts.filter(text => text.includes('合成续聊成功')).length,
    knownResults: [...history.results.values()].filter(knownToolResult).length,
    pending: Object.values(backend.state.value.sessions[agent.id]?.runs ?? {}).filter(run => !run.reconciledAt
      && ['prepared', 'sent', 'unknown'].includes(run.status)).length }
}
process.on('message', message => {
  const reply = value => process.send?.({ id: message.id, value })
  if (message.command === 'stop') { controller?.abort(); reply({ stopped: true }); return }
  const job = (async () => {
    if (message.command === 'run') {
      if (running) throw new Error('FIXTURE_BUSY')
      running = true; controller = new AbortController(); turn++
      agent.phase = { kind: 'running', turn, step: 1, abort: controller }
      session.append('turn/start', { turn }); session.append('step/start', { turn, step: 1 })
      let outcome = 'completed', code
      try { await backend.runStep(agent, { assembly, messages: [llm.createUserMessage({
        content: [{ type: 'text', text: `E2E:${message.mode}` }], source: { kind: 'human' } })] }) }
      catch (error) { outcome = 'failed'; code = error.code ?? error.name }
      finally {
        session.append('step/end', { turn, step: agent.phase.step }); session.append('turn/end', { turn })
        agent.phase = { kind: 'idle' }; running = false; await checkpoint()
      }
      return { outcome, code, ...summary() }
    }
    if (message.command === 'sync') { const recovery = await backend.syncSession(agent); return { reply: recovery, ...summary() } }
    if (message.command === 'summary') return summary()
    if (message.command === 'close') { await backend.dispose(); await checkpoint(); setTimeout(() => process.exit(0), 10); return { closed: true } }
    throw new Error('FIXTURE_COMMAND_INVALID')
  })()
  job.then(reply, error => process.send?.({ id: message.id, error: error.code ?? error.message }))
})
emit('ready')
