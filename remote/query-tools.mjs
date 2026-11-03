import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { NATIVE_WEB_TOOLS, WEB_RESULT_PAGE_TOOL, nativeWebApprovalReason, nativeWebResultText } from '../src/native-web.mjs'
import { createWebResultPages } from './web-result-pages.mjs'
import { hasPublicWebAddresses } from './web-fetch-policy.mjs'
import { WorkerError, throwIfAborted } from './worker-error.mjs'
import { asMcpResult, isValidStepPreparation, toSdkUserMessages } from './query-input.mjs'

/**
 * Build one query's SDK tool surface: the DSH MCP tools, the PreToolUse /
 * PostToolUse / PostToolBatch / PermissionDenied hooks and the approval
 * callback. Every callback is tracked by the run settlement, binds calls only
 * through the per-run tool registry, and records any failure on `run.problem`
 * before aborting the run, so side-effecting calls are never retried.
 *
 * `io` is shared with the stream consumer; its `promptInput` and
 * `contextSampler` are assigned after these callbacks are created.
 */
export function createQueryTools({ sdk, runStore, query, toolCalls, definitions, convertedDefinitions, cwd, configDir, io, nativeWebTools }) {
  const { context, run, runId, sessionId, diagnose, startPhase } = query
  const { controller } = run
  const trackCallback = query.settlement.track
  // PreToolUse supplies the ID that MCP handlers lack. Only the per-run
  // registry can bind it to canonical arguments or advance tool facts.
  const qualifiedNames = new Set(definitions.map(({ name }) => `mcp__dsh__${name}`))
  const nativeNames = new Set(nativeWebTools ? NATIVE_WEB_TOOLS : [])
  const nativeResults = new Map(), nativeGrants = new Map()
  const pages = query.params.nativeWebResultPages ? createWebResultPages({ configDir, cwd, sessionId }) : undefined
  const pageTool = `mcp__dsh__${WEB_RESULT_PAGE_TOOL}`
  const successfulWebCalls = new Map()
  const reportNativeResult = (name, id, text, isError, executed = false) => {
    if (nativeResults.has(id)) return nativeResults.get(id)
    const result = trackCallback((async () => {
      try {
        await toolCalls.waitForEvent(id)
        const ack = await context.peer.request('web.result', { runId, name, callId: id, text, isError }, { signal: controller.signal })
        if (ack?.recorded !== true || text === null) {
          throw new WorkerError('NATIVE_WEB_RESULT_UNCONFIRMED', 'Claude Code 网页工具结果未获确认', { toolMayHaveExecuted: true })
        }
        if (executed) toolCalls.recordResult(id, { concludesTurn: false, additionalContexts: [] })
      } catch (error) {
        run.problem = error instanceof WorkerError ? error
          : new WorkerError('NATIVE_WEB_RESULT_UNCONFIRMED', 'Claude Code 网页工具结果未能写入历史', { toolMayHaveExecuted: true })
        controller.abort()
        throw run.problem
      }
    })())
    nativeResults.set(id, result)
    return result
  }
  const definitionsByName = new Map(definitions.map((definition) => [`mcp__dsh__${definition.name}`, definition]))
  const markForwardedToolEvents = (message) => {
    if (message?.type !== 'assistant' || message.error || !Array.isArray(message.message?.content)) return
    for (const block of message.message.content) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string' || !(qualifiedNames.has(block.name) || nativeNames.has(block.name))) continue
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
    if (nativeNames.has(input.tool_name)) {
      const { tool_name: name, tool_input: args } = input
      const id = input.tool_use_id ?? toolUseId
      if (typeof id !== 'string' || !id) return denyTool('无法关联网页工具调用标识')
      const reason = nativeWebApprovalReason(name, args)
      if (!reason) {
        const message = '原生网页工具参数不受支持。抓取仅接受公开域名的标准 HTTPS 地址。'
        await reportNativeResult(name, id, message, true)
        return denyTool(message)
      }
      const finishApproval = startPhase('approval_wait', { callId: id })
      let response
      try {
        await toolCalls.waitForEvent(id)
        response = await context.peer.request('approval.request', {
          runId, toolName: name, toolUseId: id, input: args,
        }, { signal: controller.signal })
      } catch (error) {
        run.problem = error instanceof WorkerError ? error : new WorkerError('APPROVAL_UNAVAILABLE', '网页工具审批连接中断')
        controller.abort()
        throw run.problem
      } finally { finishApproval() }
      if (response?.behavior !== 'allow') {
        const message = response?.message ?? '网页工具未获批准。'
        await reportNativeResult(name, id, message, true)
        return denyTool(message)
      }
      if (name === 'WebFetch' && !await hasPublicWebAddresses(args.url)) {
        const message = '网页域名未能解析为公网地址，已拒绝抓取。'
        await reportNativeResult(name, id, message, true)
        return denyTool(message)
      }
      if (controller.signal.aborted) return denyTool('请求已取消')
      nativeGrants.set(id, { name, args })
      // Preserve any native SDK permission and domain checks after this hook.
      return {}
    }
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
    if (nativeNames.has(input?.tool_name)) {
      const ok = hookEventName === 'PostToolUse'
      const text = nativeWebResultText(ok ? input.tool_response : input.error)
      await reportNativeResult(input.tool_name, id, text, !ok, true)
      if (pages && ok && nativeGrants.get(id)?.name === input.tool_name) {
        const body = input.tool_name === 'WebFetch' ? input.tool_response?.result : undefined
        const hash = typeof body === 'string' ? createHash('sha256').update(body, 'utf8').digest('hex') : undefined
        successfulWebCalls.set(id, hash)
      }
      return {}
    }
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
    try {
      for (const call of input.tool_calls) if (nativeNames.has(call?.tool_name)) {
        const result = nativeResults.get(call.tool_use_id)
        if (!result) throw new WorkerError('NATIVE_WEB_RESULT_UNCONFIRMED', '无法确认 Claude Code 网页工具的实际结果', { toolMayHaveExecuted: true })
        await result
      }
      toolCalls.assertBatch(batchIds)
    } catch (error) {
      run.problem = error
      controller.abort()
      throw run.problem
    }
    const saved = []
    for (const call of input.tool_calls) {
      const id = call?.tool_use_id
      const hash = successfulWebCalls.get(id)
      if (successfulWebCalls.delete(id) && await pages.register(id, call.tool_response, hash)) saved.push(id)
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
    if (!isValidStepPreparation(response)) {
      run.problem = new WorkerError('STEP_PREPARE_INVALID', '本机 DSH 下一步上下文不受支持', { toolMayHaveExecuted: true })
      controller.abort()
      throw run.problem
    }
    if (response.continue === false) toolCalls.conclude()
    if (response.userMessages?.length) {
      const { pendingUserInputs, submittedUserInputs } = io
      const messages = toSdkUserMessages(response.userMessages, sessionId)
      if (new Set([...submittedUserInputs, ...messages.map(message => message.uuid)]).size > 64) {
        run.problem = new WorkerError('USER_INPUT_LIMIT', '本轮插话数量超过 SDK 可确认范围，已停止；请核实后再继续。', { toolMayHaveExecuted: true })
        controller.abort(); throw run.problem
      }
      for (const message of messages) if (!submittedUserInputs.has(message.uuid)) {
        pendingUserInputs.add(message.uuid); submittedUserInputs.add(message.uuid)
      }
      try {
        await io.promptInput.send(messages)
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
    io.contextSampler?.request()
    const additionalContexts = [...(response.additionalContexts ?? [])]
    if (saved.length) additionalContexts.push(
      'Claude saved large web tool output for these call IDs: ' + saved.join(', ')
      + '. Call read_web_result with callId. Pass the returned nextOffset as offset for the next page. Do not use local read_file or refetch for pagination.')
    return {
      ...(response.continue === false ? { continue: false, stopReason: 'DSH 已结束本轮。' } : {}),
      ...(additionalContexts.length ? { hookSpecificOutput: {
        hookEventName: 'PostToolBatch', additionalContext: additionalContexts.join('\n\n'),
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
      if (pages && definition.name === WEB_RESULT_PAGE_TOOL) {
        const page = await pages.read(args)
        throwIfAborted(controller.signal)
        const text = page
          ? `nextOffset: ${page.nextOffset}; totalBytes: ${page.totalBytes}\n\n${page.content}`
          : '当前会话无此网页结果，或分页位置无效。'
        await reportNativeResult(definition.name, callId, text, !page, true)
        return { content: [{ type: 'text', text }], isError: !page }
      }
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
  const hooks = {
    PreToolUse: [{ hooks: [(...args) => trackCallback(preToolUse(...args).catch(error => {
      if (!nativeNames.has(args[0]?.tool_name)) throw error
      return denyTool('未能完成原生网页工具审批')
    }))] }],
    PostToolUse: [{ hooks: [postToolUse] }],
    PostToolUseFailure: [{ hooks: [postToolUse] }],
    PostToolBatch: [{ hooks: [postToolBatch] }],
    PermissionDenied: [{ hooks: [async (input, toolUseId) => {
      const id = input?.tool_use_id ?? toolUseId
      if (typeof id === 'string' && nativeNames.has(input?.tool_name)) {
        await reportNativeResult(input.tool_name, id, 'Claude Code 拒绝执行此网页工具。', true)
      } else if (typeof id === 'string') toolCalls.forget(id)
      return {}
    }] }],
  }
  const canUseTool = (toolName, input, options) => trackCallback((async () => {
    if (controller.signal.aborted) return { behavior: 'deny', message: '请求已取消' }
    if (nativeNames.has(toolName)) {
      const grant = nativeGrants.get(options?.toolUseID)
      return grant?.name === toolName && isDeepStrictEqual(grant.args, input) && !nativeResults.has(options.toolUseID)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: '未取得此网页工具调用的本机审批' }
    }
    if (pages && toolName === pageTool) {
      return hasUnexpectedKeys(toolName, input)
        ? { behavior: 'deny', message: '网页结果分页参数无效。' }
        : { behavior: 'allow', updatedInput: input }
    }
    if (!qualifiedNames.has(toolName)) {
      return { behavior: 'deny', message: '此会话只能使用已配置的本机 DSH 工具' }
    }
    diagnose('approval', 'requested')
    let response
    const callId = typeof options?.toolUseID === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(options.toolUseID)
      ? options.toolUseID : undefined
    const finishApproval = startPhase('approval_wait', { callId })
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
    } finally { finishApproval() }
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
  })())
  return { qualifiedNames, nativeNames, markForwardedToolEvents, mcpTools, hooks, canUseTool }
}
