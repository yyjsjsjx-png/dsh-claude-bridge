import { createContextSampler, sanitizeCompactionMessage } from './context-sampler.mjs'
import { sdkErrorDetail } from './errors.mjs'
import { createFirstOutputObserver } from './first-output.mjs'
import { createPromptInput } from './prompt-input.mjs'
import { isNoResponsePlaceholder } from '../src/sdk-message.mjs'
import { firstOutputKind } from '../src/sdk-output-kind.mjs'
import { WorkerError, throwIfAborted } from './worker-error.mjs'
import { SESSION_ID } from './query-input.mjs'
import { combineTurnResults, failureDetail, resultMetrics } from './query-metrics.mjs'
import { verifyToolset } from './sdk-handshake.mjs'

/** Returned by `accept` for an SDK message that must not be processed further. */
export const SKIP_MESSAGE = Symbol('skip-message')

/** Assemble the SDK query options for one DSH-only, hook-verified session. */
export function buildSdkOptions({ params, compact, cwd, cliPath, childEnv, contextPreferences, systemPrompt, definitions,
  server, controller, tools, sessionId, selectedModel, serviceBudgetUsd }) {
  return {
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
    hooks: tools.hooks,
    ...(params.resume ? { resume: sessionId } : { sessionId }),
    ...(params.model === undefined ? {} : { model: params.model }),
    ...(params.effort === undefined ? {} : { effort: params.effort }),
    // The SDK catalog is the authority for adaptive support. On supported
    // models ask for Anthropic's summary, never the raw thinking trace.
    ...(selectedModel.supportsAdaptiveThinking === true ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    ...((params.maxBudgetUsd ?? serviceBudgetUsd) === undefined ? {} : { maxBudgetUsd: params.maxBudgetUsd ?? serviceBudgetUsd }),
    ...(compact ? { maxTurns: 1 } : params.maxTurns === undefined ? {} : { maxTurns: params.maxTurns }),
    canUseTool: tools.canUseTool,
  }
}

/**
 * Per-query SDK stream consumer. It owns the streaming prompt input, the
 * user-input confirmation timer, first-output timing, event forwarding and
 * the final result evaluation. All per-message work is synchronous; the
 * caller keeps the `for await` loop and the only in-loop await
 * (`contextSampler.finish()` on a successful result).
 */
export function createQueryStream({ query, compact, prompt, toolCalls, tools, io, inputConfirmationTimeoutMs }) {
  const { context, run, runId, sessionId, diagnose, timing } = query
  const { controller } = run
  const { pendingUserInputs, submittedUserInputs } = io
  const turnResults = [], seenResults = new Set()
  let confirmationTimer
  // Streaming input supports images and interactive SDK callbacks.
  io.promptInput = createPromptInput({ type: 'user', ...(SESSION_ID.test(runId) ? { uuid: runId } : {}),
    message: { role: 'user', content: prompt }, parent_tool_use_id: null },
  () => new WorkerError('USER_INPUT_UNCONFIRMED', 'SDK 用户输入流已关闭，插话未确认送达。', { toolMayHaveExecuted: true }))
  const releaseInput = () => { clearTimeout(confirmationTimer); io.promptInput.close() }
  controller.signal.addEventListener('abort', releaseInput, { once: true })
  let result
  let contextSummary
  let compactMetadata
  let assistantError
  let toolsetVerified = false
  let firstModelEvent = false, firstToken = false, firstText = false
  let firstOutput

  /** Bind the SDK query: first-output observer and context sampler. */
  function attach(sdkQuery) {
    firstOutput = createFirstOutputObserver({ isActive: () => !controller.signal.aborted })
    io.contextSampler = createContextSampler({ query: sdkQuery, signal: controller.signal, diagnose,
      publish: message => { if (!compact) context.peer.notify('sdk.message', { runId, message }) } })
  }

  function observeFirstOutput(message) {
    if (!firstModelEvent) { firstModelEvent = true; timing('first_model_event') }
    const delta = message.event?.type === 'content_block_delta' ? message.event.delta : undefined
    const full = message.type === 'assistant' ? message.message?.content : undefined
    if (!firstToken && (firstOutputKind(message.event)
      || full?.some(block => (block.type === 'text' && block.text?.length)
        || (block.type === 'thinking' && block.thinking?.length) || block.type === 'tool_use' && block.id?.length && block.name?.length))) {
      firstToken = true; timing('first_token')
    }
    if (!firstText && ((delta?.type === 'text_delta' && delta.text?.length)
      || full?.some(block => block.type === 'text' && block.text?.length))) {
      firstText = true; timing('first_text')
    }
  }

  // Forward one message to the local host with the bridge's redactions.
  function forward(message) {
    if (message?.type === 'assistant' && typeof message.error === 'string') assistantError = message.error
    if (compact) {
      // A summary can contain private conversation text. Maintenance
      // exposes only its confirmed outcome and sanitized numeric metrics.
      if (message?.type === 'auth_status' && typeof message.error === 'string' && message.error.length) query.authFlowFailed = true
    } else if (message?.type === 'auth_status') {
      if (typeof message.error === 'string' && message.error.length > 0) {
        query.authFlowFailed = true
        diagnose('auth', 'failed', 'AUTH_FLOW_FAILED')
      } else if (!message.isAuthenticating) query.authFlowFailed = false
      context.peer.notify('sdk.message', { runId, message: { type: 'auth_status', isAuthenticating: Boolean(message.isAuthenticating),
        session_id: sessionId, ...(query.authFlowFailed ? { errorCode: 'AUTH_FLOW_FAILED' } : {}) } })
    } else if (message?.type === 'assistant' && message.error) {
      const detail = sdkErrorDetail(undefined, message.error) ?? { code: 'SDK_QUERY_FAILED', message: 'Claude 返回错误' }
      context.peer.notify('sdk.message', { runId, message: { ...message,
        message: { ...message.message, content: [{ type: 'text', text: detail.message }] } } })
    } else if (message?.type === 'result' && (message.subtype !== 'success' || message.is_error === true)) {
      const { errors: _errors, ...safeMessage } = message
      context.peer.notify('sdk.message', { runId, message: { ...safeMessage, errors: [], bridgeErrorCode: failureDetail(message, assistantError, query.authFlowFailed).code } })
    } else if (message?.type === 'system' && ['status', 'compact_boundary'].includes(message.subtype)) {
      const safeMessage = sanitizeCompactionMessage(message)
      if (safeMessage) context.peer.notify('sdk.message', { runId, message: safeMessage })
    } else {
      context.peer.notify('sdk.message', { runId, message })
    }
    // Mark only after the event was successfully written. The local RPC
    // receiver then queues that notification before the tool request.
    tools.markForwardedToolEvents(message)
  }

  /**
   * Validate, observe and forward one SDK message. Returns the (possibly
   * combined) message, or SKIP_MESSAGE for a duplicate result or a turn result
   * that still waits for queued user input to be consumed.
   */
  function accept(incoming, responseObservedAt) {
    let message = incoming
    throwIfAborted(controller.signal)
    if (message?.session_id !== undefined && message.session_id !== sessionId) {
      throw new WorkerError('SESSION_ID_MISMATCH', 'SDK 返回的会话标识不匹配')
    }
    if ((message?.type === 'stream_event' && message.event?.type === 'message_start'
      || message?.type === 'assistant') && message.parent_tool_use_id == null) clearTimeout(confirmationTimer)
    if (message?.type === 'result' && typeof message.uuid === 'string') {
      if (seenResults.has(message.uuid)) return SKIP_MESSAGE
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
        return SKIP_MESSAGE
      }
    }
    if (message?.type === 'result') message = combineTurnResults(turnResults, message)
    if (message?.type === 'system' && message.subtype === 'init') {
      verifyToolset(message, sessionId, tools.qualifiedNames)
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
      || (message?.type === 'assistant' && !isNoResponsePlaceholder(message.message)))) observeFirstOutput(message)
    if (compact && message?.type === 'system' && message.subtype === 'compact_boundary'
      && message.compact_metadata?.trigger === 'manual') {
      const tokens = message.compact_metadata.pre_tokens
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new WorkerError('COMPACT_UNCONFIRMED', 'SDK 压缩确认信息无效')
      compactMetadata = { status: 'compacted', preTokens: tokens }
      diagnose('compact', 'confirmed')
    }
    if (message?.type === 'system' && message.subtype === 'status' && message.status === 'compacting') {
      io.contextSampler.invalidate({ compacting: true })
    } else if (message?.type === 'system' && (message.subtype === 'compact_boundary'
      || message.subtype === 'status' && message.status === null)) {
      io.contextSampler.invalidate()
    }
    if (message?.type === 'stream_event' && message.event?.type === 'message_start'
      && !toolCalls.concluded && toolCalls.hasUnconfirmedBatch) {
      run.problem = new WorkerError('STEP_BOUNDARY_UNCONFIRMED', 'SDK 未确认工具批次已更新本机上下文', { toolMayHaveExecuted: true })
      controller.abort()
      throw run.problem
    }
    try { forward(message) } catch {
      run.problem = new WorkerError('SDK_EVENT_DELIVERY_FAILED', 'SDK 输出无法传回，执行状态需核实', { toolMayHaveExecuted: true })
      controller.abort()
      throw run.problem
    }
    if (!compact && (message?.type === 'stream_event' && message.event?.type === 'message_stop'
      || message?.type === 'assistant' && message.message?.stop_reason
      || message?.type === 'system' && (message.subtype === 'compact_boundary'
        || message.subtype === 'status' && message.status === null))) io.contextSampler.request()
    return message
  }

  /** Keep the final SDK result and report its SDK-side timings. */
  function recordResult(message) {
    result = message
    if (!compact) for (const key of ['ttft_ms', 'ttft_stream_ms', 'time_to_request_ms', 'first_content_frame_ms', 'duration_ms', 'duration_api_ms']) {
      if (Number.isFinite(message[key]) && message[key] >= 0) timing(key, message[key], 'perf.sdk')
    }
  }

  /**
   * CLI may emit an error result and then terminate with a nonzero exit.
   * Whether an iterator error must propagate rather than keep that structured
   * result; cancellation or a callback failure is never hidden.
   */
  function mustRethrow() {
    return !result || (result.subtype === 'success' && result.is_error !== true) || run.problem || controller.signal.aborted
  }

  /** Build the candidate outcome after the iterator exited, or throw why none exists. */
  function outcome() {
    if (run.problem) throw run.problem
    if (controller.signal.aborted) throw new WorkerError('CANCELLED', '请求已取消')
    if (pendingUserInputs.size && (!result && turnResults.length || result?.subtype === 'success' && result.is_error !== true)) throw new WorkerError('USER_INPUT_UNCONFIRMED', 'SDK 未确认消费运行中插话，已停止；请核实后再继续。', { toolMayHaveExecuted: true })
    if (!result) throw new WorkerError('SDK_RESULT_MISSING', 'SDK 未返回最终结果')
    if (result.subtype === 'success' && !toolsetVerified) {
      throw new WorkerError('SDK_TOOLSET_UNVERIFIED', 'SDK 未提供可验证的工具清单')
    }
    toolCalls.assertComplete({ successful: result.subtype === 'success', terminalReason: result.terminal_reason })
    if (result.subtype !== 'success' || result.is_error === true) {
      const detail = failureDetail(result, assistantError, query.authFlowFailed)
      diagnose('sdk', 'failed', detail.code)
      const metrics = resultMetrics(result, runId, contextSummary)
      return { sessionId, status: 'failed', ...detail, ...(metrics ? { metrics } : {}) }
    }
    diagnose('sdk', 'completed')
    timing('completed')
    const metrics = resultMetrics(result, runId, contextSummary)
    return { sessionId, status: 'completed', ...(metrics ? { metrics } : {}),
      ...(compact ? { compaction: compactMetadata ?? { status: 'unchanged' } } : {}) }
  }

  return {
    attach, accept, recordResult, mustRethrow, outcome, releaseInput,
    set contextSummary(value) { contextSummary = value },
  }
}
