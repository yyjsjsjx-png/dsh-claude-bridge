import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createContextSampler, sanitizeCompactionMessage } from './context-sampler.mjs'
import { createPlanUsageReader } from './plan-usage.mjs'
import { acquireSessionLock } from './lock.mjs'
import { CatalogError, createCatalogReader, validateModelSelection } from './catalog.mjs'
import { AuthError, createAuthReader } from './auth.mjs'
import { sdkErrorDetail } from './errors.mjs'
import { createHistoryReader, createRunStore } from './history.mjs'
import { createDiagnostics } from '../src/diagnostics.mjs'
import { isNoResponsePlaceholder } from '../src/sdk-message.mjs'
import { validateContextPreferences } from '../src/context-preferences.mjs'
import { evaluateBridgeCompatibility } from '../src/bridge-compatibility.mjs'
import { createFirstOutputObserver } from './first-output.mjs'
import { createRunObservations } from './run-observations.mjs'
import { normalizeObservabilityRecord } from '../src/observability-schema.mjs'
import { sanitizePlanUsage } from '../src/plan-usage.mjs'
import { createPromptInput } from './prompt-input.mjs'
import { createToolCalls } from './tool-calls.mjs'

const bridgeManifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
const defaultBridgeRelease = { serverVersion: bridgeManifest.version,
  minimumClientVersion: bridgeManifest.bridge?.minimumClientVersion ?? null }

const MAX_PROMPT_BYTES = 3 * 1024 * 1024
const MAX_INSTRUCTION_BYTES = 1024 * 1024
const MAX_TOOLS = 80
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

class WorkerError extends Error {
  constructor(code, message, { toolMayHaveExecuted = false } = {}) {
    super(message)
    this.name = 'WorkerError'
    this.code = code
    this.toolMayHaveExecuted = toolMayHaveExecuted
  }
}

function requireObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerError('INVALID_REQUEST', `${name} 必须是对象`)
  }
  return value
}

function requireString(value, name, maximum = 4096) {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > maximum) {
    throw new WorkerError('INVALID_REQUEST', `${name} 无效`)
  }
  return value
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new WorkerError('CANCELLED', '请求已取消')
}

function validateInputBlocks(prompt) {
  if (typeof prompt === 'string') {
    if (!prompt.trim() || Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw new WorkerError('INVALID_PROMPT', '消息为空或超过大小限制')
    }
    return prompt
  }
  if (!Array.isArray(prompt) || prompt.length === 0 || prompt.length > 64) {
    throw new WorkerError('INVALID_PROMPT', '消息内容格式不受支持')
  }
  const blocks = prompt.map((input) => {
    const block = requireObject(input, '消息内容')
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw new WorkerError('INVALID_PROMPT', '文本内容无效')
      return { type: 'text', text: block.text }
    }
    if (block.type === 'image') {
      const source = requireObject(block.source, '图片来源')
      if (source.type !== 'base64' || !MIME_TYPES.has(source.media_type) || typeof source.data !== 'string'
        || source.data.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data)) {
        throw new WorkerError('INVALID_PROMPT', '仅支持有效的 base64 图片')
      }
      return { type: 'image', source: { type: 'base64', media_type: source.media_type, data: source.data } }
    }
    throw new WorkerError('UNSUPPORTED_ATTACHMENT', '暂不支持该消息或附件类型')
  })
  if (Buffer.byteLength(JSON.stringify(blocks), 'utf8') > MAX_PROMPT_BYTES) {
    throw new WorkerError('PROMPT_TOO_LARGE', '消息或图片超过当前传输大小限制')
  }
  return blocks
}

function buildSystemPrompt(params) {
  const prompt = requireString(params.systemPrompt, 'systemPrompt', MAX_INSTRUCTION_BYTES)
  const path = requireString(params.projectPath, 'projectPath', 32768)
  if (/[\r\n\0]/.test(path)) throw new WorkerError('INVALID_REQUEST', '项目路径无效')
  const instructions = params.instructions
  if (instructions !== undefined && typeof instructions !== 'string') {
    throw new WorkerError('INVALID_REQUEST', 'instructions 必须是文本')
  }
  if (instructions && Buffer.byteLength(instructions, 'utf8') > MAX_INSTRUCTION_BYTES) {
    throw new WorkerError('INVALID_REQUEST', '项目指令超过大小限制')
  }
  // The DSH host is the source of the assembled preset and instruction order.
  // An exact duplicate signals a host wiring error rather than being silently dropped.
  if (instructions?.trim() && prompt.includes(instructions)) {
    throw new WorkerError('DUPLICATE_INSTRUCTIONS', '工作区指令已包含在系统提示词中')
  }
  const suffix = `用户项目位于 DSH 客户端本机的 ${JSON.stringify(path)}。该路径属于客户端工具环境；VPS 运行目录只保存远端会话。请通过提供的 DSH 工具操作项目。`
  return `${prompt}\n\n${suffix}${instructions?.trim() ? `\n\n${instructions}` : ''}`
}

function validateToolDefinitions(tools) {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) {
    throw new WorkerError('INVALID_TOOLS', '工具列表无效或数量过多')
  }
  const names = new Set()
  return tools.map((input) => {
    const definition = requireObject(input, '工具定义')
    if (typeof definition.name !== 'string' || !TOOL_NAME.test(definition.name) || names.has(definition.name)) {
      throw new WorkerError('INVALID_TOOLS', '工具名称无效或重复')
    }
    names.add(definition.name)
    requireString(definition.description, '工具说明', 32768)
    const schema = requireObject(definition.inputSchema, '工具参数')
    if (schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object'
      || Array.isArray(schema.properties) || (schema.additionalProperties !== undefined && schema.additionalProperties !== false)) {
      throw new WorkerError('UNSUPPORTED_TOOL_SCHEMA', '工具参数需要受限的对象格式')
    }
    // SDK tool() accepts a raw Zod property shape. Root object-level constraints
    // cannot be represented by that API, so reject them instead of dropping them.
    const allowedRoot = new Set(['type', 'properties', 'required', 'additionalProperties', 'description', 'title', '$schema'])
    if (Object.keys(schema).some((key) => !allowedRoot.has(key))) {
      throw new WorkerError('UNSUPPORTED_TOOL_SCHEMA', '工具参数的对象级约束暂不支持')
    }
    if (schema.required !== undefined && (!Array.isArray(schema.required)
      || schema.required.some((name) => typeof name !== 'string' || !Object.hasOwn(schema.properties, name)))) {
      throw new WorkerError('INVALID_TOOLS', '工具必填参数无效')
    }
    return { name: definition.name, description: definition.description, schema }
  })
}

function asMcpResult(response) {
  let result
  try { result = requireObject(response, '工具结果') } catch {
    throw new WorkerError('INVALID_TOOL_RESULT', '工具结果格式无效', { toolMayHaveExecuted: true })
  }
  if (!Array.isArray(result.content)) throw new WorkerError('INVALID_TOOL_RESULT', '工具结果格式无效', { toolMayHaveExecuted: true })
  if (result.additionalContexts !== undefined && (!Array.isArray(result.additionalContexts)
    || result.additionalContexts.length > 64 || result.additionalContexts.some((item) => typeof item !== 'string')
    || Buffer.byteLength(JSON.stringify(result.additionalContexts), 'utf8') > MAX_INSTRUCTION_BYTES)) {
    throw new WorkerError('UNSUPPORTED_TOOL_EFFECT', '工具附加上下文必须是受限的文本列表', { toolMayHaveExecuted: true })
  }
  if (result.concludesTurn !== undefined && typeof result.concludesTurn !== 'boolean') {
    throw new WorkerError('UNSUPPORTED_TOOL_EFFECT', '工具结束标记无效', { toolMayHaveExecuted: true })
  }
  // The CLI prioritizes continue:false over event decisions. Whether additional
  // context survives that same stop into a later session has not been verified.
  if (result.concludesTurn === true && result.additionalContexts?.length) {
    throw new WorkerError('UNSUPPORTED_TOOL_EFFECT_COMBINATION', '工具同时要求附加上下文和结束本轮，暂无法保证上下文保留', { toolMayHaveExecuted: true })
  }
  if (result.content.some((block) => !block || typeof block !== 'object'
    || !['text', 'image', 'audio', 'resource', 'resource_link'].includes(block.type))) {
    throw new WorkerError('UNSUPPORTED_TOOL_RESULT', '工具结果包含暂不支持的内容', { toolMayHaveExecuted: true })
  }
  if (result.isError !== undefined && typeof result.isError !== 'boolean') {
    throw new WorkerError('INVALID_TOOL_RESULT', '工具结果状态无效', { toolMayHaveExecuted: true })
  }
  let structuredContent
  if (result.structuredContent !== undefined) {
    try { structuredContent = requireObject(result.structuredContent, '结构化结果') } catch {
      throw new WorkerError('INVALID_TOOL_RESULT', '结构化结果无效', { toolMayHaveExecuted: true })
    }
  }
  return {
    mcpResult: {
      content: result.content,
      ...(result.isError === undefined ? {} : { isError: result.isError }),
      ...(structuredContent === undefined ? {} : { structuredContent }),
    },
    effects: {
      additionalContexts: result.additionalContexts ?? [],
      concludesTurn: result.concludesTurn === true,
    },
  }
}

function cleanChildEnvironment({ homeDir, configDir, cliPath, userName }) {
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

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function numericFields(source, names) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined
  const result = {}
  for (const name of names) {
    const value = nonnegative(source[name])
    if (value !== undefined) result[name] = value
  }
  return Object.keys(result).length ? result : undefined
}

function resultMetrics(result, runId, contextSummary) {
  const metrics = { source: 'sdk-result', dedupeKey: typeof result.uuid === 'string' ? result.uuid : runId }
  const usage = numericFields(result.usage, ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'])
  if (usage) {
    const thinking = nonnegative(result.usage?.output_tokens_details?.thinking_tokens)
    if (thinking !== undefined) usage.thinking_tokens = thinking
    metrics.usage = { scope: 'current-turn-main-agent', ...usage }
  }
  if (result.modelUsage && typeof result.modelUsage === 'object' && !Array.isArray(result.modelUsage)) {
    const models = Object.create(null)
    const entries = Object.entries(result.modelUsage)
    if (entries.length <= 256) {
      for (const [model, value] of entries) {
        if (!model || model.length > 256) continue
        const counts = numericFields(value, ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadInputTokens',
          'cacheCreationInputTokens', 'webSearchRequests', 'costUSD', 'contextWindow', 'maxOutputTokens'])
        if (counts) models[model] = counts
      }
    }
    if (Object.keys(models).length) metrics.modelUsage = { scope: 'session-cumulative-includes-subagents', models }
  }
  const cost = nonnegative(result.total_cost_usd)
  if (cost !== undefined) metrics.cost = { scope: 'session-cumulative-estimate', usd: cost }
  if (contextSummary) metrics.context = contextSummary
  return Object.keys(metrics).length > 2 ? metrics : undefined
}

// A queued user input may be folded into the running SDK turn or start the
// next one. Main usage is per SDK turn; modelUsage and cost remain cumulative.
function combineTurnResults(previous, last) {
  if (!previous.length) return last
  const turns = [...previous, last]
  const keys = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
  const complete = turns.every(result => result.usage && keys.every(key =>
    (result.usage[key] === undefined && key.startsWith('cache_'))
      || Number.isSafeInteger(result.usage[key]) && result.usage[key] >= 0))
  const { usage: _usage, ...result } = last
  if (complete) result.usage = Object.fromEntries(keys.map(key => [key,
    turns.reduce((total, turn) => total + (turn.usage[key] ?? 0), 0)]))
  return result
}

function failureDetail(result, assistantError, authFlowFailed = false) {
  const known = {
    error_max_turns: ['MAX_TURNS_REACHED', '本轮达到最大调用次数'],
    error_during_execution: ['SDK_EXECUTION_FAILED', 'SDK 执行过程中失败'],
    error_max_budget_usd: ['BUDGET_EXHAUSTED', '本轮达到费用预算上限'],
    error_max_structured_output_retries: ['STRUCTURED_OUTPUT_FAILED', '结构化输出重试次数已用尽'],
  }
  const mapped = sdkErrorDetail(result, assistantError) ?? (authFlowFailed
    ? { code: 'AUTH_FLOW_FAILED', message: 'Claude 认证流程失败，请检查服务器登录状态和网络' } : undefined)
  const startup = {
    gateway_signin_required: ['AUTH_REQUIRED', 'Claude 网关需要重新登录'],
    gateway_access_denied: ['AUTHORIZATION_DENIED', 'Claude 网关拒绝了当前账号'],
    cwd_unavailable: ['SESSION_DIRECTORY_UNAVAILABLE', '远程会话目录无法访问'],
    temp_dir_unusable: ['TEMP_DIRECTORY_UNAVAILABLE', '远程临时目录不可用'],
    session_held_by_background: ['SESSION_BUSY', '远程会话正在后台运行'],
    cli_version_too_old: ['CLI_VERSION_UNSUPPORTED', '远程 Claude Code 版本过旧'],
  }
  const [code, message] = mapped ? [mapped.code, mapped.message]
    : Object.hasOwn(startup, result.startup_failure_reason) ? startup[result.startup_failure_reason]
      : Object.hasOwn(known, result.subtype) ? known[result.subtype] : ['SDK_QUERY_FAILED', 'SDK 查询失败']
  const apiErrorStatus = Number.isInteger(result.api_error_status) && result.api_error_status >= 100 && result.api_error_status <= 599
    ? result.api_error_status : undefined
  const startupFailureReason = typeof result.startup_failure_reason === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(result.startup_failure_reason)
    ? result.startup_failure_reason : undefined
  return {
    code, message,
    ...(apiErrorStatus === undefined ? {} : { apiErrorStatus }),
    ...(startupFailureReason === undefined ? {} : { startupFailureReason }),
  }
}

async function verifyHooksApplied(query, controller) {
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

function verifyToolset(message, sessionId, expectedNames) {
  if (message?.type !== 'system' || message.subtype !== 'init' || message.session_id !== sessionId
    || !Array.isArray(message.tools) || message.tools.some((name) => typeof name !== 'string')
    || new Set(message.tools).size !== message.tools.length
    || message.tools.length !== expectedNames.size || message.tools.some((name) => !expectedNames.has(name))) {
    throw new WorkerError('SDK_TOOLSET_MISMATCH', '远程 SDK 工具清单与本机 DSH 工具不一致')
  }
}

async function readMetadata(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new WorkerError('SESSION_METADATA_INVALID', '会话记录无法读取')
  }
}

/** An optional operator setting; an omitted/blank value adds no SDK dollar cap. */
export function parseServiceBudget(value) {
  if (value === undefined || (typeof value === 'string' && !value.trim())) return undefined
  if (typeof value !== 'string') throw new TypeError('预算配置必须是正数文本')
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit <= 0) throw new TypeError('预算配置必须是正数')
  return limit
}

/** Create handlers for one private stdio worker. Dependencies are injected for offline tests. */
export function createWorkerHandlers({ sdk, zod, sessionRoot, configDir, cliPath, homeDir, sdkVersion, cliVersion, userName = 'desktop', authorizedDeviceId, maxBudgetUsd, acquireLock = acquireSessionLock, authReader: injectedAuthReader, toolEventTimeoutMs = 15_000, inputConfirmationTimeoutMs = 30_000, bridgeRelease = defaultBridgeRelease, responseTimingNow = () => performance.now(), observability }) {
  if (!sdk || typeof sdk.query !== 'function' || typeof sdk.tool !== 'function'
    || typeof sdk.createSdkMcpServer !== 'function' || typeof sdk.getSessionInfo !== 'function') {
    throw new TypeError('SDK 接口不完整')
  }
  if (!zod || typeof zod.fromJSONSchema !== 'function') throw new TypeError('Zod 接口不完整')
  for (const [name, value] of Object.entries({ sessionRoot, configDir, cliPath, homeDir, sdkVersion, cliVersion, userName })) {
    requireString(value, name)
  }
  if (authorizedDeviceId !== undefined && (typeof authorizedDeviceId !== 'string' || !SESSION_ID.test(authorizedDeviceId))) {
    throw new TypeError('已认证的 deviceId 必须是 UUID')
  }
  if (maxBudgetUsd !== undefined && (typeof maxBudgetUsd !== 'number' || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0)) {
    throw new TypeError('服务预算上限必须是正数')
  }
  if (!Number.isSafeInteger(toolEventTimeoutMs) || toolEventTimeoutMs < 1 || toolEventTimeoutMs > 60_000) {
    throw new TypeError('工具事件等待时间无效')
  }
  if (!Number.isSafeInteger(inputConfirmationTimeoutMs) || inputConfirmationTimeoutMs < 1 || inputConfirmationTimeoutMs > 120_000) throw new TypeError('用户输入确认等待时间无效')

  const activeSessions = new Set()
  const activeRuns = new Map()
  const completedRuns = new Map()
  const diagnosticLogs = new Map()
  const childEnv = cleanChildEnvironment({ homeDir, configDir, cliPath, userName })
  const catalogReader = createCatalogReader({ sdk, sessionRoot, cliPath, childEnv })
  const planUsageReader = createPlanUsageReader({ sdk, sessionRoot, cliPath, childEnv })
  const authReader = injectedAuthReader ?? createAuthReader({ cliPath, childEnv })
  const runStore = createRunStore()
  const readHistory = createHistoryReader({ sdk, sessionRoot, authorizedDeviceId, acquireLock, requireAuth, activeSessions })
  const serverVersion = bridgeRelease?.serverVersion
  const minimumClientVersion = bridgeRelease?.minimumClientVersion ?? null
  let clientVersion

  // Release versions describe compatibility, never authenticated identity.
  // An omitted initialize cannot bypass an explicitly configured minimum.
  function compatibilityFailure() {
    const compatibility = evaluateBridgeCompatibility({ clientVersion, serverVersion, minimumClientVersion })
    if (compatibility.status === 'compatible' || compatibility.status === 'legacy') return undefined
    return { status: 'failed', code: compatibility.status === 'update-required'
      ? 'CLIENT_UPDATE_REQUIRED' : 'SERVER_COMPATIBILITY_INVALID', message: compatibility.message }
  }

  async function requireAuth(signal, refresh = false) {
    const status = await authReader.read({ signal, refresh })
    if (!status.loggedIn) throw new AuthError('AUTH_REQUIRED', '请先在服务器登录 Claude Code')
    if (status.authMethod && status.authMethod !== 'claude.ai') {
      throw new AuthError('AUTH_METHOD_UNSUPPORTED', '当前版本仅支持本人 Claude 订阅登录；API Key 等其他登录方式暂未开放')
    }
    return status
  }

  async function authStatus(params = {}, context = {}) {
    try {
      requireObject(params, '登录状态请求')
      if (Object.keys(params).some((key) => key !== 'refresh')
        || (params.refresh !== undefined && typeof params.refresh !== 'boolean')) {
        throw new WorkerError('INVALID_REQUEST', '登录状态请求无效')
      }
      return await authReader.read({ signal: context.signal, refresh: params.refresh === true })
    } catch (error) {
      const problem = error instanceof WorkerError || error instanceof AuthError
        ? error : new AuthError('AUTH_STATUS_UNAVAILABLE', '无法读取远程 Claude Code 登录状态')
      return { status: problem.code === 'CANCELLED' ? 'cancelled' : 'failed', code: problem.code, message: problem.message }
    }
  }

  async function initialize(params, context = {}) {
    if (!params || params.protocolVersion !== 1) throw new WorkerError('UNSUPPORTED_PROTOCOL', '不支持该协议版本')
    clientVersion = params.clientVersion
    const release = { serverVersion, minimumClientVersion }
    const blocked = compatibilityFailure()
    if (blocked) return { protocolVersion: 1, sdkVersion, cliVersion, ...release,
      clientCompatible: false, code: blocked.code, message: blocked.message,
      authenticated: null, capabilities: {} }
    const auth = await authStatus({}, context)
    return {
      protocolVersion: 1,
      sdkVersion,
      cliVersion,
      ...release,
      clientCompatible: true,
      authenticated: typeof auth.loggedIn === 'boolean' ? auth.loggedIn : null,
      ...(auth.authMethod ? { authMethod: auth.authMethod } : {}),
      ...(auth.code ? { authStatusError: { code: auth.code, message: auth.message } } : {}),
      capabilities: {
        customSystemPrompt: true,
        isolatedSessionResume: true,
        streamedOutput: true,
        textAndBase64Images: true,
        localMcpTools: true,
        approvalCallback: true,
        modelCatalog: true,
        perDeviceSessions: true,
        contextSummary: true,
        manualCompact: true,
        autoCompactWindow: true,
        planUsage: true,
        ...(observability ? { observability: true } : {}),
        historySync: typeof sdk.getSessionMessages === 'function',
        nativeFileAndShellTools: false,
        nativeSubagents: false,
        toolContextViaPostHook: true,
        toolConclusionViaPostHook: true,
        stepPreparationViaBatchHook: true,
        userInputViaStream: true,
        maxPromptBytes: MAX_PROMPT_BYTES,
        ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
      },
    }
  }

  async function catalog(params = {}, context = {}) {
    const blocked = compatibilityFailure()
    if (blocked) return blocked
    try {
      requireObject(params, '模型目录请求')
      if (Object.keys(params).some((key) => key !== 'refresh')
        || (params.refresh !== undefined && typeof params.refresh !== 'boolean')) {
        throw new WorkerError('INVALID_REQUEST', '模型目录请求无效')
      }
      await requireAuth(context.signal)
      return { status: 'ok', models: await catalogReader.read({ signal: context.signal, refresh: params.refresh === true }) }
    } catch (error) {
      const problem = error instanceof WorkerError || error instanceof CatalogError || error instanceof AuthError
        ? error : new WorkerError('CATALOG_UNAVAILABLE', '无法取得账号可用模型目录')
      return { status: problem.code === 'CANCELLED' ? 'cancelled' : 'failed', code: problem.code, message: problem.message }
    }
  }

  async function planUsage(params = {}, context = {}) {
    const blocked = compatibilityFailure()
    if (blocked) return blocked
    try {
      requireObject(params, '额度请求')
      if (Object.keys(params).some(key => key !== 'refresh')
        || (params.refresh !== undefined && typeof params.refresh !== 'boolean')) {
        throw new WorkerError('INVALID_REQUEST', '额度请求参数无效')
      }
      if (observability) {
        const view = await observability.quota(params.refresh ? 'manual' : 'activity')
        // Keep the original flat snapshot for older Hosts; sampling is additive.
        return { ...sanitizePlanUsage(view?.snapshot), ...view }
      }
      await requireAuth(context.signal, params.refresh === true)
      return await planUsageReader.read({ signal: context.signal })
    } catch (error) {
      return { status: 'unavailable', code: error instanceof AuthError || error instanceof WorkerError
        ? error.code : 'QUOTA_READ_FAILED' }
    }
  }

  async function history(params, context = {}) {
    const blocked = compatibilityFailure()
    if (blocked) return blocked
    return readHistory(params, context)
  }

  async function readObservabilityQuota(context = {}) {
    await requireAuth(context.signal, false)
    return planUsageReader.read({ signal: context.signal })
  }

  async function observabilityQuery(params = {}) {
    const blocked = compatibilityFailure()
    if (blocked) return blocked
    if (!observability) return { status: 'unavailable', code: 'OBSERVABILITY_UNSUPPORTED' }
    if (!params || typeof params !== 'object' || Array.isArray(params)
      || Object.keys(params).some(k => !['operation', 'filters'].includes(k))) return { status: 'unavailable', code: 'OBSERVABILITY_INVALID_QUERY' }
    if (params.operation === 'status') return observability.status()
    if (params.operation === 'summarize') return observability.summarize(params.filters)
    if (params.operation === undefined || params.operation === 'query') return observability.query(params.filters)
    return { status: 'unavailable', code: 'OBSERVABILITY_INVALID_QUERY' }
  }

  function observabilityTiming(params) {
    const blocked = compatibilityFailure()
    if (blocked) return blocked
    if (!observability) return { status: 'unavailable', code: 'OBSERVABILITY_UNSUPPORTED' }
    try {
      const row = normalizeObservabilityRecord('timing', params)
      if (authorizedDeviceId && row.deviceId.toLowerCase() !== authorizedDeviceId.toLowerCase()
        || row.side !== 'local' || row.clock !== 'local-monotonic' || row.level !== 'run') throw Error('identity')
      return { status: observability.record('timing', row) ? 'queued' : 'unavailable' }
    } catch { return { status: 'unavailable', code: 'OBSERVABILITY_INVALID_RECORD' } }
  }

  async function query(params, context) {
    const blocked = compatibilityFailure()
    if (blocked) return blocked
    let sessionId
    let deviceId
    let active = false
    let run
    let runId
    let finishRun
    let lock
    let lockLost = false
    let onAbort
    let authFlowFailed = false
    let diagnosticLog
    const started = performance.now()
    const elapsed = () => Math.round(performance.now() - started)
    const diagnose = (stage, event, code) => {
      if (!runId) return
      diagnosticLog?.event(event, { runId, stage, durationMs: elapsed(), ...(code ? { code } : {}) })
      try {
        context.peer.notify('diagnostic', {
          runId, stage, event, durationMs: elapsed(),
          ...(code === undefined ? {} : { code }),
        })
      } catch { /* A broken transport is handled by the active query signal. */ }
    }
    const timing = (stage, durationMs = elapsed(), event = 'perf.remote') => {
      const fields = { runId, stage, durationMs, model: params.model, effort: params.effort,
        method: params.action === 'compact' ? 'compact' : 'query' }
      diagnosticLog?.event(event, fields)
      try { context.peer.notify('diagnostic', { event, ...fields }) } catch {}
    }
    try {
      requireObject(params, '请求')
      const allowedKeys = new Set(['runId', 'deviceId', 'dshSessionId', 'sessionId', 'resume', 'prompt', 'projectPath', 'systemPrompt', 'instructions', 'tools', 'model', 'effort', 'maxTurns', 'maxBudgetUsd', 'action', 'contextPreferences'])
      if (Object.keys(params).some((key) => !allowedKeys.has(key))) {
        throw new WorkerError('UNSUPPORTED_REQUEST_FIELD', '请求包含暂不支持的字段')
      }
      if (params.action !== undefined && params.action !== 'compact') throw new WorkerError('UNSUPPORTED_ACTION', '不支持该会话操作')
      const compact = params.action === 'compact'
      let contextPreferences
      try { contextPreferences = validateContextPreferences(params.contextPreferences) }
      catch (error) { throw new WorkerError(error.code, error.message) }
      if (compact && (params.resume !== true || ['prompt', 'systemPrompt', 'instructions', 'tools', 'maxTurns'].some(key => params[key] !== undefined))) {
        throw new WorkerError('INVALID_COMPACT_REQUEST', '主动压缩只能操作已有 SDK 会话，不接受自定义消息、工具或提示词')
      }
      runId = requireString(params.runId, 'runId', 256)
      if (activeRuns.has(runId) || completedRuns.has(runId)) throw new WorkerError('DUPLICATE_RUN', '运行标识已被使用')
      const controller = new AbortController()
      const settled = new Promise((resolve) => { finishRun = resolve })
      run = { controller, problem: undefined, settled, outcome: undefined, callbacks: new Set(), inFlightTools: 0 }
      activeRuns.set(runId, run)
      onAbort = () => {
        diagnose('cancel', 'received')
        if (run.inFlightTools > 0 && !run.problem) {
          run.problem = new WorkerError('CANCELLED_TOOL_OUTCOME_UNKNOWN', '已请求停止，本机工具执行结果需核实', { toolMayHaveExecuted: true })
        }
        controller.abort()
      }
      context.signal?.addEventListener('abort', onAbort, { once: true })
      if (context.signal?.aborted) controller.abort()
      diagnose('query', 'start')
      deviceId = requireString(params.deviceId, 'deviceId', 36).toLowerCase()
      if (!SESSION_ID.test(deviceId)) throw new WorkerError('INVALID_REQUEST', 'deviceId 必须是 UUID')
      if (authorizedDeviceId !== undefined && deviceId !== authorizedDeviceId.toLowerCase()) {
        throw new WorkerError('DEVICE_MISMATCH', '此连接不能使用其他设备的会话')
      }
      const dshSessionId = requireString(params.dshSessionId, 'dshSessionId', 256)
      if (/[\r\n\0]/.test(dshSessionId)) throw new WorkerError('INVALID_REQUEST', 'dshSessionId 无效')
      sessionId = requireString(params.sessionId, 'sessionId', 36).toLowerCase()
      if (!SESSION_ID.test(sessionId)) throw new WorkerError('INVALID_REQUEST', 'sessionId 必须是 UUID')
      if (typeof params.resume !== 'boolean') throw new WorkerError('INVALID_REQUEST', '必须明确指定是否恢复会话')
      if (params.model !== undefined) requireString(params.model, 'model', 256)
      if (params.effort !== undefined) requireString(params.effort, 'effort', 64)
      if (observability) run.observations = createRunObservations({ params: { ...params, deviceId, sessionId },
        record: (kind, row) => observability.record(kind, row) })
      if (params.maxBudgetUsd !== undefined && (typeof params.maxBudgetUsd !== 'number'
        || !Number.isFinite(params.maxBudgetUsd) || params.maxBudgetUsd <= 0
        || (maxBudgetUsd !== undefined && params.maxBudgetUsd > maxBudgetUsd))) {
        throw new WorkerError('BUDGET_LIMIT_EXCEEDED', '请求预算无效或超过服务上限')
      }
      if (params.maxTurns !== undefined && (!Number.isSafeInteger(params.maxTurns) || params.maxTurns < 1 || params.maxTurns > 1000)) {
        throw new WorkerError('INVALID_REQUEST', 'maxTurns 无效')
      }
      requireString(params.projectPath, 'projectPath', 32768)
      const prompt = compact ? '/compact' : validateInputBlocks(params.prompt)
      // Native resume retains its original system-prompt snapshot. Maintenance
      // neither reconstructs it from DSH history nor injects a replacement.
      const systemPrompt = compact ? undefined : buildSystemPrompt(params)
      const definitions = compact ? [] : validateToolDefinitions(params.tools)
      // Validate conversion before reserving a durable session directory.
      const convertedDefinitions = definitions.map((definition) => {
        let converted
        try { converted = zod.fromJSONSchema(definition.schema) } catch {
          throw new WorkerError('UNSUPPORTED_TOOL_SCHEMA', '工具参数无法转换')
        }
        if (!converted || !converted.shape || typeof converted.shape !== 'object') {
          throw new WorkerError('UNSUPPORTED_TOOL_SCHEMA', '工具参数无法转换为对象')
        }
        return { ...definition, shape: converted.shape }
      })
      await requireAuth(controller.signal)
      const models = await catalogReader.read({ signal: controller.signal })
      const selectedModel = validateModelSelection(models, params.model, params.effort)
      if (!diagnosticLogs.has(deviceId)) diagnosticLogs.set(deviceId,
        createDiagnostics({ directory: join(sessionRoot, '_diagnostics', deviceId) }))
      diagnosticLog = diagnosticLogs.get(deviceId)
      timing('start')
      diagnose('validation', 'complete')
      throwIfAborted(controller.signal)
      if (activeSessions.has(sessionId)) {
        throw new WorkerError('SESSION_BUSY', '会话或运行标识正被使用')
      }
      activeSessions.add(sessionId)
      active = true

      const locksDir = join(sessionRoot, '_locks')
      const ownersDir = join(sessionRoot, '_owners')
      const deviceRoot = join(sessionRoot, 'devices', deviceId)
      await mkdir(locksDir, { recursive: true, mode: 0o700 })
      await mkdir(ownersDir, { recursive: true, mode: 0o700 })
      await mkdir(deviceRoot, { recursive: true, mode: 0o700 })
      try { lock = await acquireLock(join(locksDir, `${sessionId}.lock`), { signal: controller.signal }) } catch (error) {
        const known = ['CANCELLED', 'SESSION_BUSY', 'LOCK_UNAVAILABLE', 'LOCK_TIMEOUT'].includes(error?.code)
        throw new WorkerError(known ? error.code : 'LOCK_UNAVAILABLE', known ? error.message : '会话锁无法获取')
      }
      lock.lost.then((loss) => {
        if (!loss) return
        lockLost = true
        if (run && !run.problem) {
          run.problem = new WorkerError('SESSION_LOCK_LOST', '会话锁意外释放，执行结果需核实', { toolMayHaveExecuted: true })
          run.controller.abort()
        }
      }).catch(() => {
        lockLost = true
        if (run && !run.problem) {
          run.problem = new WorkerError('SESSION_LOCK_LOST', '会话锁状态异常，执行结果需核实', { toolMayHaveExecuted: true })
          run.controller.abort()
        }
      })
      const ownerPath = join(ownersDir, `${sessionId}.json`)
      const expectedOwner = { version: 2, engine: 'claude-sdk', sessionId, deviceId, dshSessionId }
      const existingOwner = await readMetadata(ownerPath)
      const cwd = join(deviceRoot, sessionId)
      const metadataPath = join(cwd, 'bridge-session.json')
      // Claude Code snapshots the system prompt on the first request. Hash the
      // exact rendered string, never the prompt itself, so later changes cannot
      // be silently accepted while the SDK continues using the old snapshot.
      const systemPromptSha256 = compact ? undefined : createHash('sha256').update(systemPrompt, 'utf8').digest('hex')
      const expectedMetadata = { ...expectedOwner, projectPath: params.projectPath, systemPromptSha256 }
      if (params.resume) {
        if (!existingOwner) throw new WorkerError('NATIVE_CONTEXT_MISSING', 'SDK 会话归属记录不存在')
        if (existingOwner.version !== 2 || existingOwner.engine !== 'claude-sdk' || existingOwner.sessionId !== sessionId
          || existingOwner.deviceId !== deviceId || existingOwner.dshSessionId !== dshSessionId) {
          throw new WorkerError('SESSION_BINDING_MISMATCH', 'SDK 会话不属于当前设备和 DSH 会话')
        }
        const metadata = await readMetadata(metadataPath)
        if (!metadata) throw new WorkerError('NATIVE_CONTEXT_MISSING', '桥接会话记录不存在')
        if (metadata.version !== 2 || metadata.engine !== 'claude-sdk' || metadata.sessionId !== sessionId
          || metadata.deviceId !== deviceId || metadata.dshSessionId !== dshSessionId || metadata.projectPath !== params.projectPath) {
          throw new WorkerError('SESSION_BINDING_MISMATCH', '会话设备、引擎或项目路径与原记录不一致')
        }
        if (typeof metadata.systemPromptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(metadata.systemPromptSha256)) {
          throw new WorkerError('SYSTEM_PROMPT_BASELINE_MISSING', '原会话缺少可验证的系统提示基线，请新建远程会话')
        }
        if (!compact && metadata.systemPromptSha256 !== systemPromptSha256) {
          throw new WorkerError('SYSTEM_PROMPT_CHANGED', '系统提示已改变；Claude 原生会话仍使用旧提示，请新建远程会话')
        }
        const existing = await sdk.getSessionInfo(sessionId, { dir: cwd })
        if (!existing) {
          const messages = typeof sdk.getSessionMessages === 'function'
            ? await sdk.getSessionMessages(sessionId, { dir: cwd, offset: 0, limit: 1, includeSystemMessages: false }) : []
          if (!Array.isArray(messages) || !messages.length || messages[0].session_id !== sessionId) {
            throw new WorkerError('NATIVE_CONTEXT_MISSING', '尚不能确认 Claude 原生会话，请保留记录后核实')
          }
        }
        diagnose('session', 'resumed')
      } else {
        // A reused ID is never guessed to be safe after an interrupted attempt.
        if (existingOwner) throw new WorkerError('SESSION_ALREADY_EXISTS', 'SDK 会话标识已被使用')
        const ownerFile = await open(ownerPath, 'wx', 0o600)
        try { await ownerFile.writeFile(`${JSON.stringify(expectedOwner)}\n`, 'utf8') } finally { await ownerFile.close() }
        try {
          await mkdir(cwd, { mode: 0o700 })
        } catch (error) {
          if (error?.code === 'EEXIST') throw new WorkerError('SESSION_ALREADY_EXISTS', '会话目录已存在，请使用新会话')
          throw error
        }
        const file = await open(metadataPath, 'wx', 0o600)
        try { await file.writeFile(`${JSON.stringify(expectedMetadata)}\n`, 'utf8') } finally { await file.close() }
        diagnose('session', 'reserved')
      }
      if (lockLost || !lock.held) throw new WorkerError('SESSION_LOCK_LOST', '会话锁意外释放')
      throwIfAborted(controller.signal)
      await runStore.begin(cwd, runId, compact ? 'compact' : 'query')
      run.recoveryCwd = cwd

      const toolCalls = createToolCalls({ signal: controller.signal, eventTimeoutMs: toolEventTimeoutMs,
        createError: (code, message, details) => new WorkerError(code, message, details) })
      try {
        let contextSampler
        const trackCallback = (promise) => {
          run.callbacks.add(promise)
          promise.finally(() => run.callbacks.delete(promise)).catch(() => {})
          return promise
        }
        // PreToolUse supplies the ID that MCP handlers lack. Only the per-run
        // registry can bind it to canonical arguments or advance tool facts.
        const qualifiedNames = new Set(definitions.map(({ name }) => `mcp__dsh__${name}`))
        const definitionsByName = new Map(definitions.map((definition) => [`mcp__dsh__${definition.name}`, definition]))
        const markForwardedToolEvents = (message) => {
          if (message?.type !== 'assistant' || message.error || !Array.isArray(message.message?.content)) return
          for (const block of message.message.content) {
            if (block?.type !== 'tool_use' || typeof block.id !== 'string' || !qualifiedNames.has(block.name)) continue
            toolCalls.markForwarded(block.id)
          }
        }
        const hasUnexpectedKeys = (name, input) => {
          const definition = definitionsByName.get(name)
          return !definition || !input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).some((key) => !Object.hasOwn(definition.schema.properties, key))
        }
        const denyTool = (reason) => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
          },
        })
        const preToolUse = async (input, toolUseId) => {
          if (input?.hook_event_name !== 'PreToolUse') return denyTool('无法确认工具执行类型')
          if (!qualifiedNames.has(input.tool_name)) return denyTool('此会话只能使用已配置的本机 DSH 工具')
          if (hasUnexpectedKeys(input.tool_name, input.tool_input)) return denyTool('工具参数包含未声明的字段')
          const id = input.tool_use_id ?? toolUseId
          if (typeof id !== 'string' || !id) return denyTool('无法关联工具调用标识')
          try {
            if (!toolCalls.register(input.tool_name, input.tool_input, id)) {
              return denyTool('相同工具参数已有待处理调用，请等待该调用完成')
            }
          } catch { return denyTool('工具参数无效') }
          return {}
        }
        const postToolUse = async (input, toolUseId) => {
          const id = input?.tool_use_id ?? toolUseId
          if (typeof id !== 'string') return {}
          const hookEventName = input?.hook_event_name
          let effects
          try { effects = toolCalls.confirmEffects(id, hookEventName) } catch (error) {
            run.problem = error
            controller.abort()
            throw run.problem
          }
          if (!effects) return {}
          diagnose('tool', 'post-hook-applied')
          return {
            ...(effects.concludesTurn ? { continue: false, stopReason: 'DSH 工具已结束本轮。' } : {}),
            ...(effects.additionalContexts.length ? {
              hookSpecificOutput: { hookEventName, additionalContext: effects.additionalContexts.join('\n\n') },
            } : {}),
          }
        }
        const postToolBatch = (input, _toolUseId, options = {}) => trackCallback((async () => {
          if (input?.hook_event_name !== 'PostToolBatch' || !Array.isArray(input.tool_calls)) {
            run.problem = new WorkerError('STEP_PREPARE_INVALID', 'SDK 工具批次信息无效', { toolMayHaveExecuted: true })
            controller.abort()
            throw run.problem
          }
          // A per-tool conclusion already instructed the SDK to stop. Do not
          // create a new DSH step if the batch callback still fires afterward.
          if (toolCalls.concluded) return { continue: false, stopReason: 'DSH 工具已结束本轮。' }
          const batchIds = new Set(input.tool_calls.map((call) => call?.tool_use_id).filter((id) => typeof id === 'string'))
          try { toolCalls.assertBatch(batchIds) } catch (error) {
            run.problem = error
            controller.abort()
            throw run.problem
          }
          const hookSignal = options?.signal
          const signal = hookSignal ? AbortSignal.any([controller.signal, hookSignal]) : controller.signal
          diagnose('step', 'prepare')
          let response
          try { response = await context.peer.request('step.prepare', { runId }, { signal }) } catch {
            if (!run.problem) run.problem = context.signal?.aborted || controller.signal.aborted
              ? new WorkerError('CANCELLED', '请求已取消')
              : new WorkerError('STEP_PREPARE_FAILED', '本机 DSH 下一步上下文准备失败', { toolMayHaveExecuted: true })
            controller.abort()
            throw run.problem
          }
          const valid = response && typeof response === 'object' && !Array.isArray(response)
            && Object.keys(response).every((key) => ['additionalContexts', 'userMessages', 'continue'].includes(key))
            && (response.continue === undefined || typeof response.continue === 'boolean')
            && (response.additionalContexts === undefined || (Array.isArray(response.additionalContexts)
              && response.additionalContexts.length <= 64 && response.additionalContexts.every((item) => typeof item === 'string')
              && Buffer.byteLength(JSON.stringify(response.additionalContexts), 'utf8') <= MAX_INSTRUCTION_BYTES))
            && (response.userMessages === undefined || (Array.isArray(response.userMessages)
              && response.userMessages.length <= 64 && response.userMessages.every(item =>
                item && typeof item === 'object' && !Array.isArray(item)
                && Object.keys(item).every(key => key === 'id' || key === 'content')
                && typeof item.id === 'string' && SESSION_ID.test(item.id)
                && Array.isArray(item.content) && item.content.length > 0 && item.content.length <= 64
                && item.content.every(block => block && typeof block === 'object' && !Array.isArray(block)
                  && Object.keys(block).every(key => key === 'type' || key === 'text')
                  && block.type === 'text' && typeof block.text === 'string')
                && item.content.some(block => block.text.trim()))
              && Buffer.byteLength(JSON.stringify(response.userMessages), 'utf8') <= MAX_PROMPT_BYTES))
          if (!valid || (response.continue === false && (response.additionalContexts?.length || response.userMessages?.length))) {
            run.problem = new WorkerError('STEP_PREPARE_INVALID', '本机 DSH 下一步上下文不受支持', { toolMayHaveExecuted: true })
            controller.abort()
            throw run.problem
          }
          if (response.continue === false) toolCalls.conclude()
          if (response.userMessages?.length) {
            const messages = response.userMessages.map(item => ({ type: 'user', uuid: item.id.toLowerCase(),
              session_id: sessionId, message: { role: 'user', content: item.content },
              parent_tool_use_id: null, priority: 'now' }))
            if (new Set([...submittedUserInputs, ...messages.map(message => message.uuid)]).size > 64) {
              run.problem = new WorkerError('USER_INPUT_LIMIT', '本轮插话数量超过 SDK 可确认范围，已停止；请核实后再继续。', { toolMayHaveExecuted: true })
              controller.abort(); throw run.problem
            }
            for (const message of messages) if (!submittedUserInputs.has(message.uuid)) {
              pendingUserInputs.add(message.uuid); submittedUserInputs.add(message.uuid)
            }
            try {
              await promptInput.send(messages)
            } catch {
              if (!run.problem) run.problem = controller.signal.aborted
                ? new WorkerError('CANCELLED', '请求已取消')
                : new WorkerError('USER_INPUT_UNCONFIRMED', '运行中插话未能确认送入 SDK，已停止；请核实后再继续。', { toolMayHaveExecuted: true })
              controller.abort()
              throw run.problem
            }
            throwIfAborted(signal)
            diagnose('input', 'submitted')
          }
          toolCalls.confirmBatch(batchIds)
          diagnose('step', response.continue === false ? 'stopped' : 'prepared')
          contextSampler?.request()
          return {
            ...(response.continue === false ? { continue: false, stopReason: 'DSH 已结束本轮。' } : {}),
            ...(response.additionalContexts?.length ? { hookSpecificOutput: {
              hookEventName: 'PostToolBatch', additionalContext: response.additionalContexts.join('\n\n'),
            } } : {}),
          }
        })())
        const mcpTools = convertedDefinitions.map((definition) => {
          return sdk.tool(definition.name, definition.description, definition.shape, (args) => trackCallback((async () => {
            const callId = toolCalls.take(`mcp__dsh__${definition.name}`, args)
            if (!callId) {
              run.problem = new WorkerError('TOOL_ID_UNAVAILABLE', '无法关联 SDK 工具调用，已停止执行')
              controller.abort()
              throw run.problem
            }
            // The real SDK callback and its yielded assistant message can race.
            // Only dispatch after the original matching assistant event has
            // entered the same ordered RPC output stream as the tool request.
            try { await toolCalls.waitForEvent(callId) } catch (error) {
              if (!run.problem) run.problem = error instanceof WorkerError ? error
                : new WorkerError('TOOL_EVENT_ORDER_UNAVAILABLE', 'SDK 工具调用顺序无法确认，未派发本机工具')
              diagnose('tool', 'event-order-failed', run.problem.code)
              controller.abort()
              throw run.problem
            }
            throwIfAborted(controller.signal)
            diagnose('tool', 'dispatch')
            run.inFlightTools++
            try {
              const response = await context.peer.request('tool.execute', {
                runId, callId, name: definition.name, arguments: args,
              }, { signal: controller.signal })
              const { mcpResult, effects } = asMcpResult(response)
              await runStore.receipt(cwd, runId, callId, definition.name, args)
              toolCalls.recordResult(callId, effects)
              diagnose('tool', 'complete')
              return mcpResult
            } catch (error) {
              if (!run.problem) run.problem = error instanceof WorkerError
                ? error : (context.signal?.aborted
                    ? new WorkerError('CANCELLED_TOOL_OUTCOME_UNKNOWN', '已请求停止，本机工具执行结果需核实', { toolMayHaveExecuted: true })
                    : new WorkerError('UNKNOWN_TOOL_OUTCOME', '本机工具调用中断，执行结果未知', { toolMayHaveExecuted: true }))
              diagnose('tool', 'failed', run.problem.code)
              controller.abort()
              throw run.problem
            } finally {
              run.inFlightTools--
            }
          })()))
        })
        const server = sdk.createSdkMcpServer({ name: 'dsh', version: '0.1.0', tools: mcpTools })
        diagnose('mcp', 'ready')
        const sdkOptions = {
          cwd,
          pathToClaudeCodeExecutable: cliPath,
          env: { ...childEnv, ...(contextPreferences.autoCompactWindowTokens === null ? {} : {
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextPreferences.autoCompactWindowTokens),
          }) },
          settingSources: [],
          strictMcpConfig: true,
          verbatimPrompts: !compact,
          tools: [],
          allowedTools: definitions.map(({ name }) => `mcp__dsh__${name}`),
          permissionMode: 'default',
          mcpServers: { dsh: server },
          persistSession: true,
          includePartialMessages: true,
          ...(compact ? {} : { systemPrompt }),
          abortController: controller,
          hooks: {
            PreToolUse: [{ hooks: [preToolUse] }],
            PostToolUse: [{ hooks: [postToolUse] }],
            PostToolUseFailure: [{ hooks: [postToolUse] }],
            PostToolBatch: [{ hooks: [postToolBatch] }],
            PermissionDenied: [{ hooks: [async (input, toolUseId) => {
              const id = input?.tool_use_id ?? toolUseId
              if (typeof id === 'string') toolCalls.forget(id)
              return {}
            }] }],
          },
          ...(params.resume ? { resume: sessionId } : { sessionId }),
          ...(params.model === undefined ? {} : { model: params.model }),
          ...(params.effort === undefined ? {} : { effort: params.effort }),
          // The SDK catalog is the authority for adaptive support. On supported
          // models ask for Anthropic's summary, never the raw thinking trace.
          ...(selectedModel.supportsAdaptiveThinking === true ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
          ...((params.maxBudgetUsd ?? maxBudgetUsd) === undefined ? {} : { maxBudgetUsd: params.maxBudgetUsd ?? maxBudgetUsd }),
          ...(compact ? { maxTurns: 1 } : params.maxTurns === undefined ? {} : { maxTurns: params.maxTurns }),
          canUseTool: (toolName, input, options) => trackCallback((async () => {
            if (controller.signal.aborted) return { behavior: 'deny', message: '请求已取消' }
            if (!qualifiedNames.has(toolName)) {
              return { behavior: 'deny', message: '此会话只能使用已配置的本机 DSH 工具' }
            }
            diagnose('approval', 'requested')
            let response
            try {
              response = await context.peer.request('approval.request', {
                runId, toolName, input, toolUseId: options?.toolUseID ?? null,
              }, { signal: controller.signal })
            } catch {
              if (!run.problem) run.problem = context.signal?.aborted
                ? new WorkerError('CANCELLED', '请求已取消')
                : new WorkerError('APPROVAL_UNAVAILABLE', '审批连接中断')
              controller.abort()
              throw run.problem
            }
            if (!response || (response.behavior !== 'allow' && response.behavior !== 'deny')) {
              if (typeof options?.toolUseID === 'string') toolCalls.forget(options.toolUseID)
              return { behavior: 'deny', message: '审批结果无效' }
            }
            if (response.updatedInput !== undefined
              && (response.updatedInput === null || typeof response.updatedInput !== 'object' || Array.isArray(response.updatedInput))) {
              if (typeof options?.toolUseID === 'string') toolCalls.forget(options.toolUseID)
              return { behavior: 'deny', message: '审批结果无效' }
            }
            if (response.behavior === 'deny' && typeof options?.toolUseID === 'string') toolCalls.forget(options.toolUseID)
            if (response.behavior === 'allow' && qualifiedNames.has(toolName) && response.updatedInput !== undefined) {
              if (hasUnexpectedKeys(toolName, response.updatedInput)) {
                if (typeof options?.toolUseID === 'string') toolCalls.forget(options.toolUseID)
                return { behavior: 'deny', message: '审批后的工具参数包含未声明的字段' }
              }
              const id = options?.toolUseID
              let rebound
              try { rebound = toolCalls.rebind(toolName, response.updatedInput, id) } catch { return { behavior: 'deny', message: '审批参数无效' } }
              if (!rebound) {
                return { behavior: 'deny', message: '无法关联审批后的工具调用' }
              }
            }
            diagnose('approval', 'resolved')
            return response.behavior === 'allow'
              ? { behavior: 'allow', updatedInput: response.updatedInput ?? input }
              : { behavior: 'deny', message: typeof response.message === 'string' ? response.message : '用户未批准' }
          })()),
        }
        // Streaming input supports images and interactive SDK callbacks.
        const pendingUserInputs = new Set(), submittedUserInputs = new Set(), turnResults = [], seenResults = new Set()
        let confirmationTimer
        const promptInput = createPromptInput({ type: 'user', ...(SESSION_ID.test(runId) ? { uuid: runId } : {}),
          message: { role: 'user', content: prompt }, parent_tool_use_id: null },
        () => new WorkerError('USER_INPUT_UNCONFIRMED', 'SDK 用户输入流已关闭，插话未确认送达。', { toolMayHaveExecuted: true }))
        const releaseInput = () => { clearTimeout(confirmationTimer); promptInput.close() }
        controller.signal.addEventListener('abort', releaseInput, { once: true })
        let result
        let contextSummary
        let compactMetadata
        let assistantError
        let toolsetVerified = false
        let firstModelEvent = false, firstToken = false, firstText = false
        const sdkQuery = sdk.query({ prompt: promptInput[Symbol.asyncIterator](), options: sdkOptions })
        const firstOutput = createFirstOutputObserver({ isActive: () => !controller.signal.aborted })
        contextSampler = createContextSampler({ query: sdkQuery, signal: controller.signal, diagnose,
          publish: message => { if (!compact) context.peer.notify('sdk.message', { runId, message }) } })
        try {
          const initialized = await verifyHooksApplied(sdkQuery, controller)
          if (compact && !initialized.commands?.some(command => command?.name === 'compact')) {
            throw new WorkerError('COMPACT_UNAVAILABLE', '当前 SDK 会话未提供官方 compact 命令')
          }
          diagnose('sdk', 'hooks-verified')
          timing('hooks_verified')
          // Verify hooks before any user prompt can start inference.
          promptInput.start()
          if (observability) { observability.activity(runId, true); run.quotaActive = true }
          for await (const incoming of sdkQuery) {
          const responseObservedAt = responseTimingNow()
          let message = incoming
          throwIfAborted(controller.signal)
          if (message?.session_id !== undefined && message.session_id !== sessionId) {
            throw new WorkerError('SESSION_ID_MISMATCH', 'SDK 返回的会话标识不匹配')
          }
          if ((message?.type === 'stream_event' && message.event?.type === 'message_start'
            || message?.type === 'assistant') && message.parent_tool_use_id == null) clearTimeout(confirmationTimer)
          if (message?.type === 'result' && typeof message.uuid === 'string') {
            if (seenResults.has(message.uuid)) continue
            seenResults.add(message.uuid)
          }
          if (message?.type === 'result' && message.subtype === 'success' && message.is_error !== true && submittedUserInputs.size
            && message.parent_tool_use_id == null) {
            // Echoed user messages only prove receipt, not consumption. Use the
            // SDK result's consumed UUIDs; never retry an unconfirmed input.
            const consumed = [...(Array.isArray(message.user_message_uuids) ? message.user_message_uuids : []), message.user_message_uuid]
            for (const id of consumed) if (typeof id === 'string') pendingUserInputs.delete(id.toLowerCase())
            if (pendingUserInputs.size) {
              turnResults.push(message)
              clearTimeout(confirmationTimer)
              confirmationTimer = setTimeout(() => {
                if (!run.problem) run.problem = new WorkerError('USER_INPUT_UNCONFIRMED', 'SDK 未确认消费运行中插话，已停止；请核实后再继续。', { toolMayHaveExecuted: true })
                controller.abort()
              }, inputConfirmationTimeoutMs)
              continue
            }
          }
          if (message?.type === 'result') message = combineTurnResults(turnResults, message)
          if (message?.type === 'system' && message.subtype === 'init') {
            verifyToolset(message, sessionId, qualifiedNames)
            toolsetVerified = true
            diagnose('sdk', 'toolset-verified')
            timing('toolset_verified')
          }
          if (!toolsetVerified && (message?.type === 'assistant' || message?.type === 'stream_event')) {
            throw new WorkerError('SDK_TOOLSET_UNVERIFIED', 'SDK 未提供可验证的工具清单')
          }
          if (!compact) message = firstOutput.observe(message, responseObservedAt)
          run.observations?.observe(message)
          if (!compact && (message?.type === 'stream_event'
            || (message?.type === 'assistant' && !isNoResponsePlaceholder(message.message)))) {
            if (!firstModelEvent) { firstModelEvent = true; timing('first_model_event') }
            const delta = message.event?.type === 'content_block_delta' ? message.event.delta : undefined
            const token = delta?.type === 'text_delta' ? delta.text : delta?.type === 'thinking_delta'
              ? delta.thinking : delta?.type === 'input_json_delta' ? delta.partial_json : undefined
            const full = message.type === 'assistant' ? message.message?.content : undefined
            if (!firstToken && ((typeof token === 'string' && token.length)
              || full?.some(block => (block.type === 'text' && block.text?.length)
                || (block.type === 'thinking' && block.thinking?.length) || block.type === 'tool_use'))) {
              firstToken = true; timing('first_token')
            }
            if (!firstText && ((delta?.type === 'text_delta' && delta.text?.length)
              || full?.some(block => block.type === 'text' && block.text?.length))) {
              firstText = true; timing('first_text')
            }
          }
          if (compact && message?.type === 'system' && message.subtype === 'compact_boundary'
            && message.compact_metadata?.trigger === 'manual') {
            const tokens = message.compact_metadata.pre_tokens
            if (!Number.isSafeInteger(tokens) || tokens < 0) throw new WorkerError('COMPACT_UNCONFIRMED', 'SDK 压缩确认信息无效')
            compactMetadata = { status: 'compacted', preTokens: tokens }
            diagnose('compact', 'confirmed')
          }
          if (message?.type === 'system' && message.subtype === 'status' && message.status === 'compacting') {
            contextSampler.invalidate({ compacting: true })
          } else if (message?.type === 'system' && (message.subtype === 'compact_boundary'
            || message.subtype === 'status' && message.status === null)) {
            contextSampler.invalidate()
          }
          if (message?.type === 'stream_event' && message.event?.type === 'message_start'
            && !toolCalls.concluded && toolCalls.hasUnconfirmedBatch) {
            run.problem = new WorkerError('STEP_BOUNDARY_UNCONFIRMED', 'SDK 未确认工具批次已更新本机上下文', { toolMayHaveExecuted: true })
            controller.abort()
            throw run.problem
          }
          try {
            if (message?.type === 'assistant' && typeof message.error === 'string') assistantError = message.error
            if (compact) {
              // A summary can contain private conversation text. Maintenance
              // exposes only its confirmed outcome and sanitized numeric metrics.
              if (message?.type === 'auth_status' && typeof message.error === 'string' && message.error.length) authFlowFailed = true
            } else if (message?.type === 'auth_status') {
              if (typeof message.error === 'string' && message.error.length > 0) {
                authFlowFailed = true
                diagnose('auth', 'failed', 'AUTH_FLOW_FAILED')
              } else if (!message.isAuthenticating) authFlowFailed = false
              context.peer.notify('sdk.message', { runId, message: { type: 'auth_status', isAuthenticating: Boolean(message.isAuthenticating),
                session_id: sessionId, ...(authFlowFailed ? { errorCode: 'AUTH_FLOW_FAILED' } : {}) } })
            } else if (message?.type === 'assistant' && message.error) {
              const detail = sdkErrorDetail(undefined, message.error) ?? { code: 'SDK_QUERY_FAILED', message: 'Claude 返回错误' }
              context.peer.notify('sdk.message', { runId, message: { ...message,
                message: { ...message.message, content: [{ type: 'text', text: detail.message }] } } })
            } else if (message?.type === 'result' && (message.subtype !== 'success' || message.is_error === true)) {
              const { errors: _errors, ...safeMessage } = message
              context.peer.notify('sdk.message', { runId, message: { ...safeMessage, errors: [], bridgeErrorCode: failureDetail(message, assistantError, authFlowFailed).code } })
            } else if (message?.type === 'system' && ['status', 'compact_boundary'].includes(message.subtype)) {
              const safeMessage = sanitizeCompactionMessage(message)
              if (safeMessage) context.peer.notify('sdk.message', { runId, message: safeMessage })
            } else {
              context.peer.notify('sdk.message', { runId, message })
            }
            // Mark only after the event was successfully written. The local RPC
            // receiver then queues that notification before the tool request.
            markForwardedToolEvents(message)
          } catch {
            run.problem = new WorkerError('SDK_EVENT_DELIVERY_FAILED', 'SDK 输出无法传回，执行状态需核实', { toolMayHaveExecuted: true })
            controller.abort()
            throw run.problem
          }
          if (!compact && (message?.type === 'stream_event' && message.event?.type === 'message_stop'
            || message?.type === 'assistant' && message.message?.stop_reason
            || message?.type === 'system' && (message.subtype === 'compact_boundary'
              || message.subtype === 'status' && message.status === null))) contextSampler.request()
          if (message?.type === 'result') {
            result = message
            if (!compact) for (const key of ['ttft_ms', 'ttft_stream_ms', 'time_to_request_ms', 'first_content_frame_ms', 'duration_ms', 'duration_api_ms']) {
              if (Number.isFinite(message[key]) && message[key] >= 0) timing(key, message[key], 'perf.sdk')
            }
            if (message.subtype === 'success' && message.is_error !== true) contextSummary = await contextSampler.finish()
            else contextSampler.stop()
            releaseInput()
          }
          }
        } catch (error) {
          // CLI may emit an error result and then terminate with a nonzero exit.
          // Preserve the structured result, but never hide cancellation or a callback failure.
          if (!result || (result.subtype === 'success' && result.is_error !== true) || run.problem || controller.signal.aborted) throw error
        } finally {
          contextSampler.stop()
          releaseInput()
          controller.signal.removeEventListener('abort', releaseInput)
          diagnose('sdk', 'iterator-exited')
        }
        if (run.problem) throw run.problem
        if (controller.signal.aborted) throw new WorkerError('CANCELLED', '请求已取消')
        if (pendingUserInputs.size && (!result && turnResults.length || result?.subtype === 'success' && result.is_error !== true)) throw new WorkerError('USER_INPUT_UNCONFIRMED', 'SDK 未确认消费运行中插话，已停止；请核实后再继续。', { toolMayHaveExecuted: true })
        if (!result) throw new WorkerError('SDK_RESULT_MISSING', 'SDK 未返回最终结果')
        if (result.subtype === 'success' && !toolsetVerified) {
          throw new WorkerError('SDK_TOOLSET_UNVERIFIED', 'SDK 未提供可验证的工具清单')
        }
        toolCalls.assertComplete({ successful: result.subtype === 'success', terminalReason: result.terminal_reason })
        if (result.subtype !== 'success' || result.is_error === true) {
          const detail = failureDetail(result, assistantError, authFlowFailed)
          diagnose('sdk', 'failed', detail.code)
          const metrics = resultMetrics(result, runId, contextSummary)
          run.outcome = { sessionId, status: 'failed', ...detail, ...(metrics ? { metrics } : {}) }
          return run.outcome
        }
        diagnose('sdk', 'completed')
        timing('completed')
        const metrics = resultMetrics(result, runId, contextSummary)
        run.outcome = { sessionId, status: 'completed', ...(metrics ? { metrics } : {}),
          ...(compact ? { compaction: compactMetadata ?? { status: 'unchanged' } } : {}) }
        return run.outcome
      } finally {
        controller.abort()
        toolCalls.dispose()
        await Promise.allSettled([...run.callbacks])
        if (run.problem) throw run.problem
      }
    } catch (error) {
      const detail = sdkErrorDetail(error) ?? (authFlowFailed
        ? { code: 'AUTH_FLOW_FAILED', message: 'Claude 认证流程失败，请检查服务器登录状态和网络' } : undefined)
      const problem = run?.problem ?? (context.signal?.aborted
        ? new WorkerError('CANCELLED', '请求已取消')
        : ((error instanceof WorkerError || error instanceof CatalogError || error instanceof AuthError) ? error
          : detail ? new WorkerError(detail.code, detail.message) : new WorkerError('WORKER_FAILED', '远程执行失败')))
      diagnose('query', 'failed', problem.code)
      const outcome = {
        ...(sessionId ? { sessionId } : {}),
        status: problem.code.startsWith('CANCELLED') ? 'cancelled' : 'failed',
        code: problem.code,
        message: problem.message,
        ...(problem.toolMayHaveExecuted ? { toolMayHaveExecuted: true } : {}),
      }
      if (run) run.outcome = outcome
      return outcome
    } finally {
      if (run?.recoveryCwd) {
        try { await runStore.finish(run.recoveryCwd, runId, run.outcome) }
        catch {
          if (run.outcome) Object.assign(run.outcome, { status: 'unknown', code: 'RECOVERY_SAVE_FAILED',
            message: '云端执行结果未能可靠登记，请等待恢复核对。', toolMayHaveExecuted: true })
        }
      }
      if (lock) {
        try { await lock.release() } catch {
          diagnose('session', 'lock-release-failed', 'LOCK_RELEASE_FAILED')
          if (run?.outcome) Object.assign(run.outcome, { status: 'unknown', code: 'LOCK_RELEASE_FAILED',
            message: '远程会话锁无法确认释放，执行状态需核实', toolMayHaveExecuted: true })
          if (run?.recoveryCwd) await runStore.finish(run.recoveryCwd, runId, run.outcome).catch(() => {})
        }
      }
      if (run) {
        run.observations?.finish(run.outcome)
        if (run.quotaActive) observability?.activity(runId, false)
        activeRuns.delete(runId)
        const outcome = run.outcome
          ? { status: run.outcome.status, ...(run.outcome.code ? { code: run.outcome.code } : {}),
              ...(run.outcome.toolMayHaveExecuted ? { toolMayHaveExecuted: true } : {}) }
          : { status: 'unknown', code: 'UNKNOWN_EXECUTION_OUTCOME', toolMayHaveExecuted: true }
        completedRuns.set(runId, outcome)
        if (completedRuns.size > 256) completedRuns.delete(completedRuns.keys().next().value)
        finishRun(outcome)
      }
      if (onAbort) context.signal?.removeEventListener('abort', onAbort)
      if (active) activeSessions.delete(sessionId)
      if (diagnosticLog) await diagnosticLog.flush().catch(() => {
        try { context.peer.notify('diagnostic', { event: 'diagnostics.failed', runId, code: 'DIAGNOSTIC_WRITE_FAILED' }) } catch {}
      })
    }
  }

  async function settle(params, context = {}) {
    try {
      requireObject(params, '等待请求')
      if (Object.keys(params).some((key) => key !== 'runId')) throw new WorkerError('INVALID_REQUEST', '等待请求无效')
      const id = requireString(params.runId, 'runId', 256)
      const finished = completedRuns.get(id)
      if (finished) return { ...finished }
      const current = activeRuns.get(id)
      if (!current) return { status: 'unknown', code: 'RUN_UNKNOWN', toolMayHaveExecuted: true }
      if (!context.signal) return { ...(await current.settled) }
      if (context.signal.aborted) throw new WorkerError('CANCELLED', '等待已取消')
      let onCancel
      try {
        const cancellation = new Promise((_, reject) => {
          onCancel = () => reject(new WorkerError('CANCELLED', '等待已取消'))
          context.signal.addEventListener('abort', onCancel, { once: true })
          if (context.signal.aborted) onCancel()
        })
        return { ...(await Promise.race([current.settled, cancellation])) }
      } finally {
        context.signal.removeEventListener('abort', onCancel)
      }
    } catch (error) {
      const problem = error instanceof WorkerError ? error : new WorkerError('WAIT_FAILED', '等待执行结束失败')
      return { status: problem.code === 'CANCELLED' ? 'cancelled' : 'failed', code: problem.code, message: problem.message }
    }
  }

  function close() {
    for (const { controller } of activeRuns.values()) controller.abort()
    return Promise.allSettled([planUsageReader.close(), ...[...activeRuns.values()].map(({ settled }) => settled)])
  }

  return { handlers: { initialize, authStatus, catalog, planUsage, history, query, settle,
    observabilityQuery, observabilityTiming }, readObservabilityQuota, close }
}
