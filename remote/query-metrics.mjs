import { sdkErrorDetail } from './errors.mjs'

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

/** Sanitized usage / model usage / cost / context metrics of an SDK result, if any. */
export function resultMetrics(result, runId, contextSummary) {
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

/**
 * A queued user input may be folded into the running SDK turn or start the
 * next one. Main usage is per SDK turn; modelUsage and cost remain cumulative.
 */
export function combineTurnResults(previous, last) {
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

/** Map a failed SDK result to a stable bridge error code, message and safe details. */
export function failureDetail(result, assistantError, authFlowFailed = false) {
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
