import { validateContextPreferences } from '../src/context-preferences.mjs'
import { WorkerError, requireObject, requireString } from './worker-error.mjs'

export const MAX_PROMPT_BYTES = 3 * 1024 * 1024
export const MAX_INSTRUCTION_BYTES = 1024 * 1024
const MAX_TOOLS = 80
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const QUERY_KEYS = new Set(['runId', 'deviceId', 'dshSessionId', 'sessionId', 'resume', 'prompt', 'projectPath', 'systemPrompt', 'instructions', 'tools', 'model', 'effort', 'maxTurns', 'maxBudgetUsd', 'action', 'contextPreferences'])

/**
 * Validate the request shape that must hold before a run is registered.
 * @returns {{ compact: boolean, contextPreferences: object, runId: string }}
 */
export function validateQueryEnvelope(params) {
  requireObject(params, '请求')
  if (Object.keys(params).some((key) => !QUERY_KEYS.has(key))) {
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
  const runId = requireString(params.runId, 'runId', 256)
  return { compact, contextPreferences, runId }
}

/** Validate the per-request budget against the optional service cap, then maxTurns. */
export function validateRunLimits(params, serviceBudgetUsd) {
  if (params.maxBudgetUsd !== undefined && (typeof params.maxBudgetUsd !== 'number'
    || !Number.isFinite(params.maxBudgetUsd) || params.maxBudgetUsd <= 0
    || (serviceBudgetUsd !== undefined && params.maxBudgetUsd > serviceBudgetUsd))) {
    throw new WorkerError('BUDGET_LIMIT_EXCEEDED', '请求预算无效或超过服务上限')
  }
  if (params.maxTurns !== undefined && (!Number.isSafeInteger(params.maxTurns) || params.maxTurns < 1 || params.maxTurns > 1000)) {
    throw new WorkerError('INVALID_REQUEST', 'maxTurns 无效')
  }
}

/** Validate a text prompt or a list of text / base64 image blocks. */
export function validateInputBlocks(prompt) {
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

/** Render the DSH system prompt, project location suffix and workspace instructions. */
export function buildSystemPrompt(params) {
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

/** Validate local DSH tool definitions against the restricted object-schema subset. */
export function validateToolDefinitions(tools) {
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

/** Convert validated JSON schemas to the raw Zod shapes that SDK tool() accepts. */
export function convertToolDefinitions(zod, definitions) {
  return definitions.map((definition) => {
    let converted
    try { converted = zod.fromJSONSchema(definition.schema) } catch {
      throw new WorkerError('UNSUPPORTED_TOOL_SCHEMA', '工具参数无法转换')
    }
    if (!converted || !converted.shape || typeof converted.shape !== 'object') {
      throw new WorkerError('UNSUPPORTED_TOOL_SCHEMA', '工具参数无法转换为对象')
    }
    return { ...definition, shape: converted.shape }
  })
}

/**
 * Validate the request fields that precede session reservation and build the
 * prompt, system prompt and tool definitions. Compaction carries none of them.
 */
export function prepareQueryPayload(params, compact, zod) {
  requireString(params.projectPath, 'projectPath', 32768)
  const prompt = compact ? '/compact' : validateInputBlocks(params.prompt)
  // Native resume retains its original system-prompt snapshot. Maintenance
  // neither reconstructs it from DSH history nor injects a replacement.
  const systemPrompt = compact ? undefined : buildSystemPrompt(params)
  const definitions = compact ? [] : validateToolDefinitions(params.tools)
  // Validate conversion before reserving a durable session directory.
  const convertedDefinitions = convertToolDefinitions(zod, definitions)
  return { prompt, systemPrompt, definitions, convertedDefinitions }
}

/** Split a local tool response into the MCP result and its DSH-only hook effects. */
export function asMcpResult(response) {
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

/**
 * Whether a `step.prepare` reply is well formed and does not combine a stop
 * with additional context or user input.
 */
export function isValidStepPreparation(response) {
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
  return Boolean(valid) && !(response.continue === false && (response.additionalContexts?.length || response.userMessages?.length))
}

/** Map validated step user messages to SDK streaming-input user messages. */
export function toSdkUserMessages(userMessages, sessionId) {
  return userMessages.map(item => ({ type: 'user', uuid: item.id.toLowerCase(),
    session_id: sessionId, message: { role: 'user', content: item.content },
    parent_tool_use_id: null, priority: 'now' }))
}
