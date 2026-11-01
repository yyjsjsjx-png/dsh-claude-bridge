// Explicit desktop-acceptance SDK substitute. Never import the SDK or CLI.
import { createRequire } from 'node:module'
import { appendFile, readFile, open, access } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
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
const metadata = event => appendFile(join(root, 'fixture-metadata.jsonl'), JSON.stringify({ at: Date.now(), ...event }) + '\n', { mode: 0o600 })
const models = [{ value: 'fixture-haiku', displayName: '确定性验收替身（无真实模型）',
  description: '仅供本轮隔离桌面验收，不调用 Claude SDK、CLI 或真实模型。', supportedEffortLevels: ['low'] }]
async function syntheticQuota() {
  let mode = 'both'
  try { mode = JSON.parse(await readFile(join(root, 'private/quota-mode.json'), 'utf8')).mode }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!['both', 'week-only', '5h-only', 'neither'].includes(mode)) throw new Error('FIXTURE_QUOTA_MODE_INVALID')
  const now = Date.now(), rate_limits = {}
  if (mode === 'both' || mode === '5h-only') rate_limits.five_hour = {
    utilization: 1, resets_at: new Date(now + 5 * 60 * 60 * 1000).toISOString(),
  }
  if (mode === 'both' || mode === 'week-only') rate_limits.seven_day = {
    utilization: 83, resets_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
  }
  await metadata({ event: 'quota', mode, synthetic: true, actualModelRequests: 0 })
  return { rate_limits_available: true, rate_limits }
}
function payloadOf(input) {
  const content = input.message.content
  const text = typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const encoded = [...text.matchAll(/DSH_ACCEPTANCE_V1:([A-Za-z0-9_-]+)/g)].at(-1)?.[1]
  let payload
  if (!encoded) {
    // DSH can deliver this known synthetic child completion in an automatic
    // settlement turn, without repeating the user's acceptance payload.
    if (text.includes('Background subagent') && text.includes('DSH_ACCEPTANCE_DONE:subagent-child')) {
      payload = { scenario: 'subagent-delivery', tools: [] }
    } else throw new Error('FIXTURE_INPUT_MARKER_REQUIRED')
  } else {
    if (encoded.length > 131072) throw new Error('FIXTURE_INPUT_MARKER_REQUIRED')
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  }
  if (!payload || !/^[a-z0-9_-]{1,64}$/.test(payload.scenario) || !Array.isArray(payload.tools)
    || payload.tools.length > 12 || payload.tools.some(tool => !tool || typeof tool.name !== 'string'
      || !tool.arguments || typeof tool.arguments !== 'object' || Array.isArray(tool.arguments))) {
    throw new Error('FIXTURE_PAYLOAD_INVALID')
  }
  for (const field of ['delayMs', 'afterToolsDelayMs']) {
    if (payload[field] !== undefined && (!Number.isInteger(payload[field]) || payload[field] < 0 || payload[field] > 60000)) {
      throw new Error('FIXTURE_DELAY_INVALID')
    }
  }
  return { payload, childCompletionInPrompt: text.includes('DSH_ACCEPTANCE_DONE:subagent-child') }
}
const sdk = {
  tool(name, description, shape, handler) { return { name, description, shape, handler } },
  createSdkMcpServer({ name, tools }) { return { type: 'sdk', name, instance: { tools } } },
  async getSessionInfo(sessionId, { dir }) {
    try { await access(transcript(dir)); return { sessionId } } catch { return undefined }
  },
  async getSessionMessages(_id, { dir, offset = 0, limit = 32 }) { return (await records(dir)).slice(offset, offset + limit) },
  query({ prompt, options }) {
    if (options.persistSession === false) return {
      async initializationResult() { return { models } },
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(usageOptions) {
        if (usageOptions?.skipBehaviors !== true) throw new Error('FIXTURE_QUOTA_OPTIONS_INVALID')
        return syntheticQuota()
      },
      close() {},
    }
    const id = options.resume ?? options.sessionId
    const signal = options.abortController.signal
    const generator = (async function* () {
      const input = (await prompt.next()).value
      if (!input) return
      const { payload, childCompletionInPrompt } = payloadOf(input)
      await metadata({ event: 'query', scenario: payload.scenario, pid: process.pid, sessionId: id,
        runId: input.uuid, resumed: Boolean(options.resume), toolCount: payload.tools.length, childCompletionInPrompt })
      await persist(options.cwd, { ...input, uuid: input.uuid ?? randomUUID(), session_id: id })
      yield { type: 'system', subtype: 'init', session_id: id,
        tools: options.mcpServers.dsh.instance.tools.map(tool => `mcp__dsh__${tool.name}`) }
      const assistant = content => ({ type: 'assistant', uuid: randomUUID(), session_id: id,
        parent_tool_use_id: null, message: { id: `msg-${randomUUID()}`, model: 'fixture-haiku', role: 'assistant', content } })
      if (payload.delayMs) await delay(payload.delayMs, undefined, { signal })
      const outcomes = [], batch = []
      let lastJobId
      for (const tool of payload.tools) {
        signal.throwIfAborted()
        const local = options.mcpServers.dsh.instance.tools.find(item => item.name === tool.name)
        if (!local) throw new Error('FIXTURE_TOOL_NOT_ADVERTISED')
        const args = { ...tool.arguments }
        if (args.job_id === '$LAST_JOB') {
          if (!lastJobId) throw new Error('FIXTURE_JOB_ID_UNAVAILABLE')
          args.job_id = lastJobId
        }
        const callId = `fixture-${randomUUID()}`, name = `mcp__dsh__${tool.name}`
        const hookInput = { hook_event_name: 'PreToolUse', tool_name: name,
          tool_input: args, tool_use_id: callId }
        const pre = await options.hooks.PreToolUse[0].hooks[0](hookInput)
        if (pre.hookSpecificOutput?.permissionDecision === 'deny') throw new Error('FIXTURE_PRE_TOOL_DENIED')
        const call = assistant([{ type: 'text', text: `确定性验收：${payload.scenario}` },
          { type: 'tool_use', id: callId, name, input: args }])
        await persist(options.cwd, call); yield call
        let result
        if (payload.approval === true) {
          const approved = await options.canUseTool(name, args, { toolUseID: callId })
          result = approved.behavior === 'allow' ? await local.handler(approved.updatedInput ?? args)
            : { isError: true, content: [{ type: 'text', text: '确定性验收：审批拒绝，未执行命令。' }] }
        } else result = await local.handler(args)
        const resultText = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        if (tool.name === 'pwsh' && result.isError !== true) {
          const startedJob = /^started background job ([A-Za-z0-9_-]{1,128})$/m.exec(resultText)?.[1]
          if (startedJob) lastJobId = startedJob
        }
        outcomes.push({ name: tool.name, isError: result.isError === true })
        await metadata({ event: 'tool', scenario: payload.scenario, sessionId: id, runId: input.uuid,
          callId, name: tool.name, isError: result.isError === true,
          ...(lastJobId ? { jobId: lastJobId } : {}),
          ...(tool.name === 'job_output' ? { backgroundOutputObserved: resultText.includes('DESKTOP_BACKGROUND_OK') } : {}) })
        await persist(options.cwd, { type: 'user', uuid: randomUUID(), session_id: id, parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId,
            content: result.content, is_error: result.isError === true }] } })
        const hookName = result.isError ? 'PostToolUseFailure' : 'PostToolUse'
        const post = await options.hooks[hookName][0].hooks[0]({ hook_event_name: hookName, tool_use_id: callId })
        batch.push({ tool_use_id: callId, tool_name: name, tool_input: args })
        if (post.continue === false) break
      }
      if (payload.afterToolsDelayMs) await delay(payload.afterToolsDelayMs, undefined, { signal })
      let additionalContexts = 0
      if (batch.length) {
        const postBatch = await options.hooks.PostToolBatch[0].hooks[0]({ hook_event_name: 'PostToolBatch', tool_calls: batch }, undefined, { signal })
        const extra = postBatch.hookSpecificOutput?.additionalContext
        additionalContexts = typeof extra === 'string' && extra.length ? 1 : 0
        await metadata({ event: 'batch', scenario: payload.scenario, sessionId: id, runId: input.uuid,
          toolCount: batch.length, additionalContexts, stopped: postBatch.continue === false,
          ...(additionalContexts ? { contextSha256: createHash('sha256').update(extra).digest('hex'), contextBytes: Buffer.byteLength(extra) } : {}) })
      }
      const text = `DSH_ACCEPTANCE_DONE:${payload.scenario};tools=${JSON.stringify(outcomes)};additionalContexts=${additionalContexts};resume=${Boolean(options.resume)}`
      const final = assistant([{ type: 'text', text }])
      await persist(options.cwd, final)
      await metadata({ event: 'final', scenario: payload.scenario, sessionId: id, runId: input.uuid })
      if (payload.crashAfterPersist === true) { process.kill(process.pid, 'SIGKILL'); await delay(30000) }
      yield final
      yield { type: 'result', subtype: 'success', session_id: id,
        usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }
    })()
    generator.initializationResult = async () => ({ hooks_applied: true, commands: [] })
    return generator
  },
}
const worker = createWorkerHandlers({ sdk, zod, sessionRoot: join(root, 'sessions'),
  configDir: join(root, 'claude-config'), cliPath: '/fixture/never-executed', homeDir: process.env.HOME,
  userName: 'desktop-fixture', sdkVersion: '0.3.314', cliVersion: '2.1.314',
  authorizedDeviceId: process.env.BRIDGE_DEVICE_ID,
  authReader: { async read() { return { loggedIn: true, authMethod: 'claude.ai' } } },
})
const peer = createRpcPeer({ input: process.stdin, output: process.stdout, handlers: worker.handlers, onClose: worker.close })
await peer.closed
await worker.close()
