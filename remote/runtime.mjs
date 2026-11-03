import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPlanUsageReader } from './plan-usage.mjs'
import { acquireSessionLock } from './lock.mjs'
import { CatalogError, createCatalogReader, validateModelSelection } from './catalog.mjs'
import { isModelCatalogAuthFailure } from '../src/catalog-cache-policy.mjs'
import { AuthError, createAuthReader } from './auth.mjs'
import { sdkErrorDetail } from './errors.mjs'
import { createHistoryReader, createRunStore } from './history.mjs'
import { createDiagnostics } from '../src/diagnostics.mjs'
import { evaluateBridgeCompatibility } from '../src/bridge-compatibility.mjs'
import { createRunObservations } from './run-observations.mjs'
import { normalizeObservabilityRecord } from '../src/observability-schema.mjs'
import { sanitizePlanUsage } from '../src/plan-usage.mjs'
import { createToolCalls } from './tool-calls.mjs'
import { createRunSettlement } from './run-settlement.mjs'
import { readSessionTitleMetadata } from './session-title-metadata.mjs'
import { WorkerError, requireObject, requireString, throwIfAborted } from './worker-error.mjs'
import { MAX_PROMPT_BYTES, SESSION_ID, prepareQueryPayload, validateQueryEnvelope, validateRunLimits } from './query-input.mjs'
import { cleanChildEnvironment, verifyHooksApplied } from './sdk-handshake.mjs'
import { createQueryTelemetry } from './query-telemetry.mjs'
import { bindQuerySession } from './query-session.mjs'
import { createQueryTools } from './query-tools.mjs'
import { SKIP_MESSAGE, buildSdkOptions, createQueryStream } from './query-stream.mjs'

const bridgeManifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
const defaultBridgeRelease = { serverVersion: bridgeManifest.version,
  minimumClientVersion: bridgeManifest.bridge?.minimumClientVersion ?? null }

// Map a query failure to its candidate outcome. A callback problem wins over
// cancellation, which wins over the thrown error.
function queryFailureOutcome({ run, context, sessionId, authFlowFailed, diagnose }, error) {
  const detail = sdkErrorDetail(error) ?? (authFlowFailed
    ? { code: 'AUTH_FLOW_FAILED', message: 'Claude 认证流程失败，请检查服务器登录状态和网络' } : undefined)
  const problem = run?.problem ?? (context.signal?.aborted
    ? new WorkerError('CANCELLED', '请求已取消')
    : ((error instanceof WorkerError || error instanceof CatalogError || error instanceof AuthError) ? error
      : detail ? new WorkerError(detail.code, detail.message) : new WorkerError('WORKER_FAILED', '远程执行失败')))
  diagnose('query', 'failed', problem.code)
  return {
    ...(sessionId ? { sessionId } : {}),
    status: problem.code.startsWith('CANCELLED') ? 'cancelled' : 'failed',
    code: problem.code,
    message: problem.message,
    ...(problem.toolMayHaveExecuted ? { toolMayHaveExecuted: true } : {}),
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
export function createWorkerHandlers({ sdk, zod, sessionRoot, configDir, cliPath, homeDir, sdkVersion, cliVersion, userName = 'desktop', authorizedDeviceId, maxBudgetUsd, acquireLock = acquireSessionLock, authReader: injectedAuthReader, runStore = createRunStore(), toolEventTimeoutMs = 15_000, inputConfirmationTimeoutMs = 30_000, bridgeRelease = defaultBridgeRelease, responseTimingNow = () => performance.now(), observability }) {
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

  // These pinned executables are the combination whose per-query TTL overrides were inspected.
  const promptCacheTtlSupported = cliVersion === '2.1.314' && sdkVersion === '0.3.314'
  const activeSessions = new Set()
  const activeRuns = new Map()
  const completedRuns = new Map()
  const diagnosticLogs = new Map()
  const childEnv = cleanChildEnvironment({ homeDir, configDir, cliPath, userName })
  const catalogReader = createCatalogReader({ sdk, sessionRoot, cliPath, childEnv })
  const planUsageReader = createPlanUsageReader({ sdk, sessionRoot, cliPath, childEnv })
  const authReader = injectedAuthReader ?? createAuthReader({ cliPath, childEnv })
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
    try {
      const status = await authReader.read({ signal, refresh })
      if (!status.loggedIn) {
        observability?.accountBoundary?.()
        throw new AuthError('AUTH_REQUIRED', '请先在服务器登录 Claude Code')
      }
      if (status.authMethod && status.authMethod !== 'claude.ai') {
        observability?.accountBoundary?.()
        throw new AuthError('AUTH_METHOD_UNSUPPORTED', '当前版本仅支持本人 Claude 订阅登录；API Key 等其他登录方式暂未开放')
      }
      return status
    } catch (error) {
      if (!signal?.aborted && error?.code !== 'CANCELLED') catalogReader.clear()
      throw error
    }
  }

  async function authStatus(params = {}, context = {}) {
    try {
      requireObject(params, '登录状态请求')
      if (Object.keys(params).some((key) => key !== 'refresh')
        || (params.refresh !== undefined && typeof params.refresh !== 'boolean')) {
        throw new WorkerError('INVALID_REQUEST', '登录状态请求无效')
      }
      const status = await authReader.read({ signal: context.signal, refresh: params.refresh === true })
      // Safe auth metadata has no account identity. An explicit recheck is an
      // account boundary even when the new account is also logged in.
      // The shared quota reading is account-scoped in the same way.
      if (params.refresh === true || !status.loggedIn || status.authMethod && status.authMethod !== 'claude.ai') {
        catalogReader.clear()
        observability?.accountBoundary?.()
      }
      return status
    } catch (error) {
      const problem = error instanceof WorkerError || error instanceof AuthError
        ? error : new AuthError('AUTH_STATUS_UNAVAILABLE', '无法读取远程 Claude Code 登录状态')
      if (!(error instanceof WorkerError) && !context.signal?.aborted && problem.code !== 'CANCELLED') catalogReader.clear()
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
        ...(promptCacheTtlSupported ? { promptCacheTtl: true } : {}),
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

  // Stage 1 (synchronous): validate the envelope, register the run and its
  // cancellation, then validate identity, limits and the prompt payload.
  function registerQuery(q) {
    const { params, context } = q
    const { compact, contextPreferences, promptCacheTtl, runId } = validateQueryEnvelope(params)
    if (promptCacheTtl !== undefined && !promptCacheTtlSupported) {
      throw new WorkerError('PROMPT_CACHE_TTL_UNSUPPORTED', '当前服务器不支持自定义缓存有效期')
    }
    q.runId = runId
    if (activeRuns.has(runId) || completedRuns.has(runId)) throw new WorkerError('DUPLICATE_RUN', '运行标识已被使用')
    const controller = new AbortController()
    const settled = new Promise((resolve) => { q.finishRun = resolve })
    const run = q.run = { controller, problem: undefined, settled, inFlightTools: 0 }
    activeRuns.set(runId, run)
    q.onAbort = () => {
      q.diagnose('cancel', 'received')
      if (run.inFlightTools > 0 && !run.problem) {
        run.problem = new WorkerError('CANCELLED_TOOL_OUTCOME_UNKNOWN', '已请求停止，本机工具执行结果需核实', { toolMayHaveExecuted: true })
      }
      controller.abort()
    }
    context.signal?.addEventListener('abort', q.onAbort, { once: true })
    if (context.signal?.aborted) controller.abort()
    q.diagnose('query', 'start')
    const deviceId = q.deviceId = requireString(params.deviceId, 'deviceId', 36).toLowerCase()
    if (!SESSION_ID.test(deviceId)) throw new WorkerError('INVALID_REQUEST', 'deviceId 必须是 UUID')
    if (authorizedDeviceId !== undefined && deviceId !== authorizedDeviceId.toLowerCase()) {
      throw new WorkerError('DEVICE_MISMATCH', '此连接不能使用其他设备的会话')
    }
    const dshSessionId = requireString(params.dshSessionId, 'dshSessionId', 256)
    if (/[\r\n\0]/.test(dshSessionId)) throw new WorkerError('INVALID_REQUEST', 'dshSessionId 无效')
    // Assigned before the UUID check: a failed outcome still echoes it.
    const sessionId = q.sessionId = requireString(params.sessionId, 'sessionId', 36).toLowerCase()
    if (!SESSION_ID.test(sessionId)) throw new WorkerError('INVALID_REQUEST', 'sessionId 必须是 UUID')
    if (typeof params.resume !== 'boolean') throw new WorkerError('INVALID_REQUEST', '必须明确指定是否恢复会话')
    if (params.model !== undefined) requireString(params.model, 'model', 256)
    if (params.effort !== undefined) requireString(params.effort, 'effort', 64)
    if (observability) run.observations = createRunObservations({ params: { ...params, deviceId, sessionId },
      record: (kind, row) => observability.record(kind, row) })
    validateRunLimits(params, maxBudgetUsd)
    return { compact, contextPreferences, promptCacheTtl, dshSessionId, ...prepareQueryPayload(params, compact, zod) }
  }

  // Stage 2: authentication, model selection, diagnostics and the
  // in-process session claim (synchronous after the catalog read).
  async function prepareQueryModel(q) {
    const { params, deviceId, sessionId } = q
    const { controller } = q.run
    await requireAuth(controller.signal)
    const models = await catalogReader.read({ signal: controller.signal })
    const selectedModel = validateModelSelection(models, params.model, params.effort)
    if (!diagnosticLogs.has(deviceId)) diagnosticLogs.set(deviceId,
      createDiagnostics({ directory: join(sessionRoot, '_diagnostics', deviceId) }))
    q.diagnosticLog = diagnosticLogs.get(deviceId)
    q.timing('start')
    q.diagnose('validation', 'complete')
    throwIfAborted(controller.signal)
    if (activeSessions.has(sessionId)) {
      throw new WorkerError('SESSION_BUSY', '会话或运行标识正被使用')
    }
    activeSessions.add(sessionId)
    q.active = true
    return selectedModel
  }

  // Stage 4: wire tools and hooks, run the SDK stream to its result, then
  // abort, dispose tool facts and drain tracked callbacks before settling.
  async function executeQuery(q, request, selectedModel, cwd) {
    const { params, run, runId, sessionId } = q
    const { controller } = run
    const { compact } = request
    const toolCalls = createToolCalls({ signal: controller.signal, eventTimeoutMs: toolEventTimeoutMs,
      createError: (code, message, details) => new WorkerError(code, message, details) })
    try {
      const io = { promptInput: undefined, contextSampler: undefined, pendingUserInputs: new Set(), submittedUserInputs: new Set() }
      const tools = createQueryTools({ sdk, runStore, query: q, toolCalls, definitions: request.definitions,
        convertedDefinitions: request.convertedDefinitions, cwd, io })
      const server = sdk.createSdkMcpServer({ name: 'dsh', version: '0.1.0', tools: tools.mcpTools })
      q.diagnose('mcp', 'ready')
      const queryEnv = request.promptCacheTtl === undefined ? childEnv : { ...childEnv,
        CLAUDE_CODE_PROMPT_CACHE_TTL: request.promptCacheTtl,
        CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: request.promptCacheTtl }
      const sdkOptions = buildSdkOptions({ params, compact, cwd, cliPath, childEnv: queryEnv, contextPreferences: request.contextPreferences,
        systemPrompt: request.systemPrompt, definitions: request.definitions, server, controller, tools, sessionId,
        selectedModel, serviceBudgetUsd: maxBudgetUsd })
      const stream = createQueryStream({ query: q, compact, prompt: request.prompt, toolCalls, tools, io, inputConfirmationTimeoutMs })
      const sdkQuery = sdk.query({ prompt: io.promptInput[Symbol.asyncIterator](), options: sdkOptions })
      stream.attach(sdkQuery)
      try {
        const initialized = await verifyHooksApplied(sdkQuery, controller)
        catalogReader.remember(initialized.models)
        if (compact && !initialized.commands?.some(command => command?.name === 'compact')) {
          throw new WorkerError('COMPACT_UNAVAILABLE', '当前 SDK 会话未提供官方 compact 命令')
        }
        q.diagnose('sdk', 'hooks-verified')
        q.timing('hooks_verified')
        // Verify hooks before any user prompt can start inference.
        io.promptInput.start()
        if (observability) { observability.activity(runId, true); run.quotaActive = true }
        for await (const incoming of sdkQuery) {
          const message = stream.accept(incoming, responseTimingNow())
          if (message === SKIP_MESSAGE || message?.type !== 'result') continue
          stream.recordResult(message)
          if (message.subtype === 'success' && message.is_error !== true) stream.contextSummary = await io.contextSampler.finish()
          else io.contextSampler.stop()
          stream.releaseInput()
        }
      } catch (error) {
        if (stream.mustRethrow()) throw error
      } finally {
        io.contextSampler.stop()
        stream.releaseInput()
        controller.signal.removeEventListener('abort', stream.releaseInput)
        q.diagnose('sdk', 'iterator-exited')
      }
      return stream.outcome()
    } finally {
      controller.abort()
      toolCalls.dispose()
      const finishDrain = q.startPhase('callback_drain')
      try { await q.settlement.drain() }
      finally { finishDrain() }
      if (run.problem) throw run.problem
    }
  }

  // Stage 5: durable save and lock release, observations, quota activity,
  // run bookkeeping, listener cleanup and diagnostic flush — in this order.
  async function finalizeQuery(q) {
    const { context, run, runId, lock, diagnose, startPhase } = q
    const finalized = await q.settlement.finish(q.candidateOutcome, {
      save: run?.recoveryCwd ? async outcome => {
        const finishSave = startPhase('recovery_save')
        try { return await runStore.finish(run.recoveryCwd, runId, outcome) }
        finally { finishSave() }
      } : undefined,
      release: lock ? async () => {
        const finishRelease = startPhase('lock_release')
        try { return await lock.release() }
        finally { finishRelease() }
      } : undefined,
      onReleaseFailure: () => diagnose('session', 'lock-release-failed', 'LOCK_RELEASE_FAILED'),
    })
    q.finalOutcome = finalized.outcome
    if (isModelCatalogAuthFailure(q.finalOutcome?.code)) catalogReader.clear()
    if (run) {
      run.observations?.finish(q.finalOutcome)
      if (run.quotaActive) observability?.activity(runId, false)
      activeRuns.delete(runId)
      const outcome = finalized.summary
      completedRuns.set(runId, outcome)
      if (completedRuns.size > 256) completedRuns.delete(completedRuns.keys().next().value)
      q.finishRun(outcome)
    }
    if (q.onAbort) context.signal?.removeEventListener('abort', q.onAbort)
    if (q.active) activeSessions.delete(q.sessionId)
    if (q.diagnosticLog) {
      const finishFlush = startPhase('diagnostic_flush')
      try {
        await q.diagnosticLog.flush().catch(() => {
          try { context.peer.notify('diagnostic', { event: 'diagnostics.failed', runId, code: 'DIAGNOSTIC_WRITE_FAILED' }) } catch {}
        })
      } finally { finishFlush() }
    }
  }

  async function query(params, context) {
    const blocked = compatibilityFailure()
    if (blocked) return blocked
    // Per-run state shared by the stages and the final settlement.
    const q = { params, context, runId: undefined, deviceId: undefined, sessionId: undefined, run: undefined,
      finishRun: undefined, onAbort: undefined, active: false, lock: undefined, authFlowFailed: false,
      diagnosticLog: undefined, candidateOutcome: undefined, finalOutcome: undefined, settlement: createRunSettlement() }
    Object.assign(q, createQueryTelemetry(q))
    try {
      const request = registerQuery(q)
      const selectedModel = await prepareQueryModel(q)
      // Stage 3: lock, owner/metadata binding and the run-store ledger entry.
      const cwd = await bindQuerySession({ sdk, sessionRoot, acquireLock, runStore }, q, request)
      q.candidateOutcome = await executeQuery(q, request, selectedModel, cwd)
    } catch (error) {
      q.candidateOutcome = queryFailureOutcome(q, error)
    } finally {
      await finalizeQuery(q)
    }
    // Optional metadata is read once after durable settlement and lock release.
    // It belongs only to this RPC reply, never to the execution/settle journal.
    const { finalOutcome, run, sessionId } = q
    if (finalOutcome?.status === 'completed' && params.action !== 'compact' && run?.recoveryCwd) {
      const sessionTitle = await readSessionTitleMetadata({ sdk, sessionId, cwd: run.recoveryCwd, signal: context.signal })
      if (sessionTitle !== undefined && !context.signal?.aborted) return { ...finalOutcome, sessionTitle }
    }
    return finalOutcome
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
