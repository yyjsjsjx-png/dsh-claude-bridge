// Deterministic SDK substitute. This fixture never imports the Claude SDK/CLI.
import { createRequire } from 'node:module'
import { appendFile, readFile, open, access } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createWorkerHandlers } from '../../remote/runtime.mjs'
import { createRpcPeer } from '../../src/rpc.mjs'

const root = process.env.BRIDGE_REMOTE_ROOT
if (!root || process.getuid?.() === 0) throw new Error('FIXTURE_CONFIG_INVALID')
const require = createRequire(new URL('../../remote/package.json', import.meta.url))
const zod = require('zod')
const transcript = cwd => join(cwd, 'fixture-native.jsonl')
async function records(cwd) {
  try { return (await readFile(transcript(cwd), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
}
async function persist(cwd, item) {
  const file = await open(transcript(cwd), 'a', 0o600)
  try { await file.writeFile(JSON.stringify(item) + '\n'); await file.sync() } finally { await file.close() }
}
const models = [{ value: 'fixture-haiku', displayName: 'Haiku 5.5 fixture', supportedEffortLevels: ['low'] }]
const sdk = {
  tool(name, description, shape, handler) { return { name, description, shape, handler } },
  createSdkMcpServer({ name, tools }) { return { type: 'sdk', name, instance: { tools } } },
  async getSessionInfo(sessionId, { dir }) {
    try { await access(transcript(dir)); return { sessionId } } catch { return undefined }
  },
  async getSessionMessages(_id, { dir, offset = 0, limit = 32 }) { return (await records(dir)).slice(offset, offset + limit) },
  query({ prompt, options }) {
    if (options.persistSession === false) return { async initializationResult() { return { models } }, close() {} }
    const id = options.resume ?? options.sessionId
    const signal = options.abortController.signal
    const generator = (async function* () {
      const input = (await prompt.next()).value
      const text = typeof input.message.content === 'string' ? input.message.content
        : input.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const mode = /E2E:([a-z-]+)/.exec(text)?.[1]
      if (!mode) throw new Error('FIXTURE_INPUT_INVALID')
      await appendFile(join(root, 'fixture-queries.jsonl'), JSON.stringify({ mode, pid: process.pid, sessionId: id,
        runId: input.uuid, notice: text.includes('只读检查核实') }) + '\n', { mode: 0o600 })
      await persist(options.cwd, { ...input, uuid: input.uuid ?? randomUUID(), session_id: id })
      yield { type: 'system', subtype: 'init', session_id: id,
        tools: options.mcpServers.dsh.instance.tools.map(tool => `mcp__dsh__${tool.name}`) }
      const assistant = content => ({ type: 'assistant', uuid: randomUUID(), session_id: id,
        parent_tool_use_id: null, message: { id: `msg-${randomUUID()}`, model: 'fixture-haiku', role: 'assistant', content } })
      if (mode !== 'continue') {
        const callId = `tool-${randomUUID()}`
        const args = { command: mode }
        const name = 'mcp__dsh__local_command'
        await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: name,
          tool_input: args, tool_use_id: callId })
        const call = assistant([{ type: 'text', text: '合成运行开始。' }, { type: 'tool_use', id: callId, name, input: args }])
        await persist(options.cwd, call); yield call
        const result = await options.mcpServers.dsh.instance.tools.find(tool => tool.name === 'local_command').handler(args)
        await persist(options.cwd, { type: 'user', uuid: randomUUID(), session_id: id, parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: result.content, is_error: result.isError === true }] } })
        await options.hooks[result.isError ? 'PostToolUseFailure' : 'PostToolUse'][0].hooks[0]({
          hook_event_name: result.isError ? 'PostToolUseFailure' : 'PostToolUse', tool_use_id: callId })
        await options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch',
          tool_calls: [{ tool_use_id: callId, tool_name: name, tool_input: args }] }, undefined, { signal })
      }
      const final = assistant([{ type: 'text', text: mode === 'continue' ? '合成续聊成功。' : '断线后的合成尾部。' }])
      await persist(options.cwd, final)
      if (['host-crash', 'worker-crash', 'server-crash'].includes(mode)) {
        yield { type: 'system', subtype: 'fixture-persisted', session_id: id }
        if (mode === 'worker-crash') { process.kill(process.pid, 'SIGKILL'); await delay(30_000) }
        else await delay(30_000, undefined, { signal })
      }
      yield final
      yield { type: 'result', subtype: 'success', session_id: id, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }
    })()
    generator.initializationResult = async () => ({ hooks_applied: true, commands: [] })
    return generator
  },
}
const worker = createWorkerHandlers({ sdk, zod, sessionRoot: join(root, 'sessions'),
  configDir: join(root, 'claude-config'), cliPath: '/fixture/never-executed', homeDir: process.env.HOME,
  userName: 'fixture', sdkVersion: '0.3.314', cliVersion: '2.1.314',
  authorizedDeviceId: process.env.BRIDGE_DEVICE_ID,
  authReader: { async read() { return { loggedIn: true, authMethod: 'claude.ai' } } },
})
const peer = createRpcPeer({ input: process.stdin, output: process.stdout, handlers: worker.handlers, onClose: worker.close })
await peer.closed
await worker.close()
