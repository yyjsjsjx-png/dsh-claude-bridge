import { randomUUID, createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { BridgeState } from './state.mjs'
import { createDiagnostics } from './diagnostics.mjs'
import { createSshTransport } from './ssh-transport.mjs'
import { createWebSocketTransport } from './websocket-transport.mjs'
import { createConnectionSettings } from './connection-settings.mjs'
import { ConnectionContext } from './connection-context.mjs'
import { toMcpToolDefinitions, toSdkPrompt, toMcpContent } from './dsh-content.mjs'
import { SdkProjection, dshUsage } from './sdk-projection.mjs'
import { CLAUDE_PROVIDER, CLAUDE_PRESET } from '../plugin/policy.mjs'
import { defaultVisibleIds, validateVisibleIds, validateCreationSelection,
  readModelEffortPreferences, applyModelEffortPreference } from './model-preferences.mjs'
import { imageCapability } from './model-capabilities.mjs'
import { contextSnapshot, initialSessionStatus, reconcileSessionStatus, SESSION_STATUS_RECORD } from './session-status.mjs'
import { sanitizePlanUsage, planUsageFreshUntil } from './plan-usage.mjs'
import { retainedPlanUsage } from './observability-plan-usage.mjs'
import { createLocalRunTiming, startLocalRunPhase } from './local-run-timing.mjs'
import { localHistory, coalesceHistory, restoreAssistant, assistantPrefix, knownToolResult,
  verifiedCloudToolResult, recoveryToolUpdate, UNKNOWN_TOOL_TEXT } from './history-sync.mjs'
import { readHistoryPages } from './history-reader.mjs'
import { appendHistoryRecord, HISTORY_TOOL_RESULT } from './history-records.mjs'
import { isNoResponsePlaceholder } from './sdk-message.mjs'
import { recoveryNotice } from './recovery-notice.mjs'
import { validateContextPreferences } from './context-preferences.mjs'
import { requiredShellName, assertRemoteShell,
  shellInfrastructureFailure } from './remote-capabilities.mjs'
import { prepareRequestAssembly, prepareRequestMessages } from './request-preparation.mjs'
import { evaluateBridgeCompatibility, bridgeCompatibilityAllowed } from './bridge-compatibility.mjs'
import { catalogConnectionIdentity, catalogDisplayModels, readDisplayCatalog } from './catalog-display.mjs'
import { createRunProgressReporter, RUN_PROGRESS_RECORD } from './run-progress.mjs'
import { RunStepLifecycle } from './step-lifecycle.mjs'
import { assertPreparedInstructionAudit } from './instruction-audit.mjs'

const clientVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const USER_MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const uncheckedBridgeCompatibility = () => ({ status: 'unchecked', clientVersion,
  serverVersion: undefined, minimumClientVersion: undefined, message: '尚未检查服务器版本要求。' })

function failure(code, message) {
  const error = new Error(`[${code}] ${message}`)
  error.code = code
  return error
}

function selectionFor(ctx, agent) {
  const projection = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
  const selected = projection?.pending ?? agent.session.requestHeader()?.config ?? agent.options
  if (selected?.provider !== CLAUDE_PROVIDER || typeof selected.model !== 'string' || !selected.model) {
    throw failure('ENGINE_SELECTION_REQUIRED', '请从新会话入口选择远程模型。')
  }
  if (agent.session.header.agentPreset !== CLAUDE_PRESET) throw failure('PRESET_ENGINE_MISMATCH', '远程会话必须使用专属预设。')
  return selected
}

/** Host-side coordinator. It never imports or starts a local Claude SDK. */
export class BridgeBackend {
  constructor(ctx, config = {}, { helpers, createTransport, hostCompatibility } = {}) {
    this.ctx = ctx
    this.config = config
    this.helpers = helpers
    this.createTransport = createTransport
    this.directory = config.stateDirectory ?? join(helpers.resolveDshHome(), 'claude-bridge')
    this.state = new BridgeState(this.directory)
    this.diagnostics = createDiagnostics({ directory: join(this.directory, 'diagnostics') })
    for (const check of hostCompatibility?.checks ?? []) {
      this.diagnostics.event('host.compatibility', { stage: check.id, evidence: check.evidence, status: check.status })
    }
    this.runs = new Map()
    this.localTiming = createLocalRunTiming({ onTiming: row => {
      if (this.initialized?.capabilities?.observability !== true) return
      const unavailable = () => this.notification('observability.warning', { code: 'OBSERVABILITY_UPLOAD_FAILED', observedAt: Date.now(), gap: true })
      if (!this.connection) { void unavailable(); return }
      void this.connection.peer.request('observabilityTiming', row, { timeoutMs: 5000 })
        .then(reply => { if (reply?.status !== 'queued') void unavailable() }).catch(() => { void unavailable() })
    } })
    this.syncing = new Map()
    this.retiredRuns = new Set()
    this.compatibility = []
    this.bridgeCompatibility = uncheckedBridgeCompatibility()
    this.remoteCapabilities = { status: 'unchecked', shell: requiredShellName(), reason: '尚未检查远程会话的基础执行能力。' }
    this.shellFailures = new WeakMap()
    this.connectionContext = new ConnectionContext()
    this.historyGeneration = 0
    this.verifiedHistory = new WeakMap()
    this.connectionUsers = 0
    this.connectionChanging = false
    this.disposed = false
    this.lifetime = new AbortController()
  }

  get connection() { return this.connectionContext.transport }
  get initialized() { return this.connectionContext.initialized }

  async settings() {
    await this.state.ready
    return this.connectionSettings ??= createConnectionSettings({
      configPath: join(this.directory, 'connection.json'), credentials: this.ctx.credentials,
      credentialKey: this.helpers.credentialKey('dsh-claude-bridge', 'connection'),
      deviceId: this.state.value.deviceId,
    })
  }

  async saveConnection(value) {
    return this.changeConnection(settings => settings.save(value))
  }

  async clearConnection() {
    return this.changeConnection(settings => settings.clear())
  }

  async changeConnection(operation) {
    if (this.disposed) throw failure('BRIDGE_DISPOSED', '桥接服务已关闭。')
    if (this.connectionChanging || this.connectionUsers || this.runs.size || this.syncing.size) {
      throw failure('BRIDGE_BUSY', '请等待当前任务或历史同步结束后更改连接。')
    }
    this.connectionChanging = true
    this.historyGeneration++
    const { transport, pending: connecting } = this.connectionContext.invalidate()
    this.bridgeCompatibility = uncheckedBridgeCompatibility()
    this.authentication = 'unknown'
    this.catalogCache = undefined
    this.catalogPending = undefined
    this.catalogPendingRefresh = undefined
    this.displayIdentityPending = undefined
    this.displayCatalogRefreshPending = undefined
    this.displayCatalogRefreshAfter = 0
    this.displayCatalogStatus = undefined
    this.planUsageCache = undefined
    this.planUsagePending = undefined
    let closeError
    const closing = Promise.all([
      Promise.resolve().then(() => transport?.close()).catch(error => { closeError = error }),
      connecting?.catch(() => {}),
    ])
    try {
      await this.state.update(state => { delete state.displayCatalog })
      const accepted = await operation(await this.settings())
      await closing
      if (closeError) throw failure('CONNECTION_CLOSE_FAILED', '连接设置已更新，但旧连接未能确认关闭，请重载插件。')
      return accepted
    } finally {
      await closing
      this.connectionChanging = false
    }
  }

  async useConnection(operation) {
    if (this.connectionChanging) throw failure('BRIDGE_BUSY', '连接设置正在更改，请稍后重试。')
    this.connectionUsers++
    try { return await operation() } finally { this.connectionUsers-- }
  }

  async status() {
    await this.state.ready
    const settings = await (await this.settings()).read()
    return { ...settings, connected: this.connection?.connected ?? Boolean(this.connection), compatibility: this.compatibility,
      remoteCapabilities: this.remoteCapabilities, bridgeCompatibility: this.bridgeCompatibility,
      diagnosticsPath: this.diagnostics.path, activeRuns: this.runs.size,
      observabilityWarning: this.observabilityWarning ?? null,
      authentication: this.authentication ?? 'unknown', usageSummary: this.usageSummary(),
      modelCatalog: this.displayCatalogStatus ?? { status: 'idle' },
      contextPreferences: this.contextPreferences(),
      autoCompactWindowSupported: this.initialized ? this.initialized.capabilities?.autoCompactWindow === true : null }
  }

  contextPreferences() {
    return validateContextPreferences(this.state.value.contextPreferences)
  }

  async saveContextPreferences(value) {
    const preferences = validateContextPreferences(value)
    await this.state.ready
    await this.state.update(state => { state.contextPreferences = preferences })
    return preferences
  }

  contextRequestPreferences() {
    const preferences = this.contextPreferences()
    if (preferences.autoCompactWindowTokens === null) return {}
    if (this.initialized?.capabilities?.autoCompactWindow !== true) {
      throw failure('CONTEXT_SETTINGS_UNSUPPORTED', '当前服务器不支持自定义自动压缩窗口，请更新服务器或恢复跟随模型默认。')
    }
    return { contextPreferences: preferences }
  }

  usageSummary() {
    const summary = { sessions: 0, runs: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0, costKind: 'sdk-estimate' }
    for (const session of Object.values(this.state.value.sessions)) {
      const reports = Object.values(session.usage ?? {})
      if (reports.length) summary.sessions++
      for (const report of reports) {
        summary.runs++
        const usage = dshUsage(report)
        if (usage) for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) summary[key] += usage[key]
      }
      // SDK costs include the session's earlier turns. Take its latest value.
      const latest = reports.findLast(report => Number.isFinite(report.total_cost_usd) && report.total_cost_usd >= 0)
      if (latest) summary.estimatedCostUsd += latest.total_cost_usd
    }
    return summary
  }

  async refreshAuthentication() {
    this.planUsageCache = undefined
    const identity = this.connectionContext.capture()
    const transport = await this.connect()
    try {
      const status = await transport.peer.request('authStatus', { refresh: true }, { timeoutMs: 30000 })
      if (!this.connectionContext.current(identity)) throw failure('CONNECTION_CHANGED', '连接设置已更改。')
      if (status.status === 'failed' || typeof status.loggedIn !== 'boolean') {
        throw failure(status.code ?? 'AUTH_STATUS_UNAVAILABLE', status.message ?? '无法验证服务器上的 Claude 登录状态。')
      }
      this.authentication = status.loggedIn === true ? 'logged-in' : 'login-required'
      if (status.loggedIn !== true) throw failure('AUTH_REQUIRED', '请在服务器上重新完成 Claude 官方登录。')
      return status
    } catch (error) {
      if (this.connectionContext.current(identity)) this.authentication = ['AUTH_REQUIRED', 'AUTH_EXPIRED'].includes(error.code) ? 'login-required' : 'verification-failed'
      throw error
    }
  }

  async connect({ signal } = {}) {
    if (this.disposed) throw failure('BRIDGE_DISPOSED', '桥接服务已关闭。')
    if (this.connectionChanging) throw failure('BRIDGE_BUSY', '连接设置正在更改，请稍后重试。')
    if (this.connection) return this.connection
    if (this.connectionContext.pending) return this.connectionContext.pending
    this.historyGeneration++
    const identity = this.connectionContext.capture()
    const pending = (async () => {
      await this.state.ready
      let transport
      const options = {
        signal: AbortSignal.any([signal, this.lifetime.signal, identity.signal].filter(Boolean)),
        handlers: {
          'tool.execute': (params, context) => this.dispatchTool(params, context),
          'approval.request': (params, context) => this.dispatchApproval(params, context),
          'step.prepare': (params, context) => this.prepareStep(params, context),
        },
        onNotification: (method, params) => this.notification(method, params),
        onTraffic: event => this.localTiming.observe(event),
        onClose: () => {
          if (this.connectionContext.disconnected(identity, transport)) {
            this.historyGeneration++
            this.planUsageCache = undefined
          }
        },
        onConnectionState: connection => {
          if (!this.connectionContext.accepts(identity, transport)) return
          if (connection !== 'connected') this.historyGeneration++
          for (const run of this.runs.values()) {
            try { this.sessionStatus(run.agent, { connection }) }
            catch { this.diagnostics.event('run.connection_status_failed', { runId: run.runId, code: 'STATUS_FAILED' }) }
          }
          this.diagnostics.event('connection.state', { status: connection })
        },
        onDiagnostic: ({ event, ...fields }) => this.diagnostics.event(event,
          { ...fields, ...(event === 'perf.rpc' ? { source: 'host-rpc' } : {}) }),
      }
      if (this.createTransport) transport = await this.createTransport(options)
      else if (this.config.transport === 'ssh') {
        if (!this.config.remoteWorkerPath || !this.config.remoteNodePath) {
          throw failure('BRIDGE_NOT_CONFIGURED', '开发用 SSH 入口尚未配置。')
        }
        transport = createSshTransport({ ...options, workerPath: this.config.remoteWorkerPath,
          nodeCommand: this.config.remoteNodePath })
      } else {
        const configured = await (await this.settings()).resolve()
        transport = await createWebSocketTransport({ ...options, ...configured, initialConnectWindowMs: 60_000 })
      }
      try {
        if (!this.connectionContext.beginInitialization(identity)) throw failure('CONNECTION_CHANGED', '连接设置已更改。')
        const initialized = await transport.peer.request('initialize', { protocolVersion: 1, clientVersion }, { timeoutMs: 30000 })
        if (!this.connectionContext.current(identity)) throw failure('CONNECTION_CHANGED', '连接设置已更改。')
        if (initialized.protocolVersion !== 1) throw failure('PROTOCOL_MISMATCH', '服务器协议不兼容。')
        this.bridgeCompatibility = evaluateBridgeCompatibility({ clientVersion,
          serverVersion: initialized.serverVersion, minimumClientVersion: initialized.minimumClientVersion })
        if (initialized.clientCompatible === false && bridgeCompatibilityAllowed(this.bridgeCompatibility)) {
          this.bridgeCompatibility = { ...this.bridgeCompatibility, status: 'invalid',
            message: '服务器拒绝了客户端版本协商，请核对服务器的最低客户端版本配置。' }
        }
        if (!bridgeCompatibilityAllowed(this.bridgeCompatibility)) {
          throw failure(this.bridgeCompatibility.status === 'update-required' ? 'CLIENT_UPDATE_REQUIRED' : 'SERVER_COMPATIBILITY_INVALID',
            this.bridgeCompatibility.message)
        }
        this.connectionContext.completeInitialization(identity, initialized)
        this.authentication = initialized.authenticated === true ? 'logged-in' : initialized.authenticated === false ? 'login-required' : 'unknown'
        if (initialized.authenticated === false) throw failure('AUTH_REQUIRED', '请在服务器上完成 Claude 官方登录。')
        this.connectionContext.bind(identity, transport)
        return transport
      } catch (error) { await transport.close(); throw error }
    })()
    this.connectionContext.track(pending)
    try { return await pending } finally { this.connectionContext.untrack(pending) }
  }

  async catalog({ refresh = false } = {}) {
    if (this.disposed) throw failure('BRIDGE_DISPOSED', '桥接服务已关闭。')
    if (!refresh && this.catalogCache && Date.now() - this.catalogCache.time < 30000) return structuredClone(this.catalogCache.reply)
    if (this.catalogPending) {
      if (!refresh || this.catalogPendingRefresh) return this.catalogPending
      const identity = this.connectionContext.capture()
      await this.catalogPending.catch(() => {})
      if (!this.connectionContext.current(identity)) throw failure('CONNECTION_CHANGED', '连接设置已更改。')
      return this.catalog({ refresh: true })
    }
    const identity = this.connectionContext.capture()
    const pending = (async () => {
      const transport = await this.connect()
      // Automatic model resolution may call this once for every catalog row.
      // Only the explicit refresh action forces a fresh CLI auth check.
      if (refresh) await this.refreshAuthentication()
      const reply = await transport.peer.request('catalog', { refresh }, { timeoutMs: 45000 })
      if (!this.connectionContext.current(identity, transport)) throw failure('CONNECTION_CHANGED', '连接设置已更改。')
      if (reply.status !== 'ok') throw failure(reply.code ?? 'CATALOG_UNAVAILABLE', reply.message ?? '无法获取当前账号模型目录。')
      this.catalogCache = { time: Date.now(), reply: structuredClone(reply) }
      await this.rememberDisplayCatalog(reply.models, identity, transport)
      if (!this.connectionContext.current(identity, transport)) throw failure('CONNECTION_CHANGED', '连接设置已更改。')
      this.displayCatalogStatus = { status: 'ready' }
      return reply
    })()
    this.catalogPending = pending
    this.catalogPendingRefresh = refresh
    try { return await pending } finally {
      if (this.catalogPending === pending) { this.catalogPending = undefined; this.catalogPendingRefresh = undefined }
    }
  }

  async displayCatalogIdentity() {
    if (this.displayIdentityPending) return this.displayIdentityPending
    const identity = this.connectionContext.capture()
    const pending = (async () => {
      await this.state.ready
      const transport = this.createTransport ? 'custom' : this.config.transport ?? 'wss'
      const configured = transport === 'wss'
        ? { transport, ...(await (await this.settings()).resolve()) }
        : { transport, deviceId: this.state.value.deviceId,
          worker: this.config.remoteWorkerPath, node: this.config.remoteNodePath }
      if (!this.connectionContext.current(identity)) throw failure('CONNECTION_CHANGED', '连接设置已更改。')
      return catalogConnectionIdentity(configured)
    })()
    this.displayIdentityPending = pending
    try { return await pending } finally {
      if (this.displayIdentityPending === pending) this.displayIdentityPending = undefined
    }
  }

  /** Advisory local metadata only; never hydrate the execution-freshness cache. */
  async displayCatalog({ visible = false } = {}) {
    await this.state.ready
    if (this.disposed || this.connectionChanging) return { status: 'ok', models: [] }
    const context = this.connectionContext.capture()
    let identity
    try { identity = await this.displayCatalogIdentity() } catch { return { status: 'ok', models: [] } }
    if (!this.connectionContext.current(context) || this.connectionChanging) return { status: 'ok', models: [] }
    const cached = readDisplayCatalog(this.state.value.displayCatalog, identity)
    let models = cached?.models ?? []
    if (visible) {
      const saved = this.state.value.modelPreferences
      if (saved !== undefined && saved.version !== 1) return { status: 'ok', models: [] }
      const enabled = new Set(saved === undefined ? defaultVisibleIds(models) : validateVisibleIds({ enabledIds: saved.enabledIds }))
      models = models.filter(model => enabled.has(model.value))
    }
    return { status: 'ok', models, ...(cached ? { updatedAt: cached.updatedAt } : {}) }
  }

  async rememberDisplayCatalog(input, context, transport) {
    let changed = false
    try {
      const models = catalogDisplayModels(input)
      const identity = await this.displayCatalogIdentity()
      await this.state.update(state => {
        if (!this.connectionContext.current(context, transport)) return
        const previous = readDisplayCatalog(state.displayCatalog, identity)
        changed = !previous || !isDeepStrictEqual(previous.models, models)
        state.displayCatalog = { version: 1, identity, updatedAt: Date.now(), models }
      })
    } catch {
      // Display metadata is optional. Run/tool journals retain their existing
      // required persistence, and a cache failure never authorizes execution.
      this.diagnostics.event('catalog.cache_unavailable', { code: 'DISPLAY_CACHE_UNAVAILABLE' })
    }
    if (changed && this.connectionContext.current(context, transport)) {
      try { this.onDisplayCatalogChanged?.() }
      catch { this.diagnostics.event('catalog.notification_failed', { code: 'CATALOG_NOTIFICATION_FAILED' }) }
    }
  }

  /** Detached refresh: the native global picker must not await remote I/O. */
  refreshDisplayCatalog() {
    if (this.disposed || this.connectionChanging || this.displayCatalogRefreshPending
      || Date.now() < (this.displayCatalogRefreshAfter ?? 0)) return
    const identity = this.connectionContext.capture()
    this.displayCatalogStatus = { status: 'refreshing' }
    const pending = this.catalog().then(() => {
      if (this.connectionContext.current(identity)) this.displayCatalogStatus = { status: 'ready' }
    }).catch(error => {
      if (!this.connectionContext.current(identity)) return
      const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'CATALOG_UNAVAILABLE'
      this.displayCatalogStatus = { status: 'failed', code }
      this.diagnostics.event('catalog.refresh_failed', { code })
    }).finally(() => {
      if (this.displayCatalogRefreshPending === pending) {
        this.displayCatalogRefreshPending = undefined
        this.displayCatalogRefreshAfter = Date.now() + 30_000
      }
    })
    this.displayCatalogRefreshPending = pending
  }

  async planUsage(refresh = false) {
    if (typeof refresh !== 'boolean') return { status: 'unavailable', code: 'INVALID_REQUEST' }
    if (!refresh && this.planUsageCache?.until > Date.now()) return structuredClone(this.planUsageCache.value)
    if (this.planUsagePending) return this.planUsagePending
    const identity = this.connectionContext.capture()
    const pending = (async () => {
      let value
      try {
        const transport = await this.connect()
        if (this.initialized?.capabilities?.planUsage !== true) {
          return { status: 'unavailable', code: 'SDK_QUOTA_UNAVAILABLE' }
        }
        const reply = await transport.peer.request('planUsage', { refresh }, { timeoutMs: 20_000 })
        if (this.connection !== transport) return { status: 'unavailable', code: 'CONNECTION_CHANGED' }
        value = this.initialized?.capabilities?.observability === true
          ? retainedPlanUsage(reply) : sanitizePlanUsage(reply)
      } catch (error) { value = sanitizePlanUsage({ status: 'unavailable', code: error.code ?? 'QUOTA_READ_FAILED' }) }
      if (!this.connectionContext.current(identity)) return { status: 'unavailable', code: 'CONNECTION_CHANGED' }
      if (['CLIENT_UPDATE_REQUIRED', 'SERVER_COMPATIBILITY_INVALID'].includes(value.code)) {
        value = { ...value, minimumClientVersion: this.bridgeCompatibility.minimumClientVersion }
      }
      if (['AUTH_REQUIRED', 'AUTH_EXPIRED'].includes(value.code)) this.authentication = 'login-required'
      this.planUsageCache = { value, until: value.status === 'available' ? planUsageFreshUntil(value) : Date.now() + 30_000 }
      return structuredClone(value)
    })()
    this.planUsagePending = pending
    try { return await pending } finally { if (this.planUsagePending === pending) this.planUsagePending = undefined }
  }

  async listModelPreferences() {
    const catalog = await this.catalog()
    await this.state.ready
    const saved = this.state.value.modelPreferences
    if (saved !== undefined && saved.version !== 1) throw failure('MODEL_PREFERENCES_INVALID', '模型显示设置版本不兼容。')
    const selected = saved === undefined ? defaultVisibleIds(catalog.models) : validateVisibleIds({ enabledIds: saved.enabledIds })
    const enabled = new Set(selected)
    return { models: catalog.models, enabledIds: catalog.models.filter(model => enabled.has(model.value)).map(model => model.value),
      usingDefaults: saved === undefined }
  }

  async saveModelPreferences(value) {
    const enabledIds = validateVisibleIds(value)
    const catalog = await this.catalog()
    const available = new Set(catalog.models.map(model => model.value))
    if (enabledIds.some(id => !available.has(id))) throw failure('MODEL_CATALOG_CHANGED', '模型目录已经变化，请刷新后重新选择。')
    await this.state.update(state => {
      state.modelPreferences = { version: 1, enabledIds, updatedAt: new Date().toISOString() }
    })
    return { enabledIds: [...enabledIds], usingDefaults: false }
  }

  async visibleCatalog() {
    const preferences = await this.listModelPreferences()
    const enabled = new Set(preferences.enabledIds)
    return { status: 'ok', models: preferences.models.filter(model => enabled.has(model.value)) }
  }

  async creationSelection() {
    await this.state.ready
    const value = this.state.value.creationSelection ?? this.ctx.agentDefaultModel?.currentSelection()
    return value?.provider === CLAUDE_PROVIDER ? validateCreationSelection(value) : null
  }

  async rememberCreationSelection(value) {
    const selection = validateCreationSelection(value)
    await this.state.update(state => {
      const entries = Object.entries(readModelEffortPreferences(state)).filter(([model]) => model !== selection.model)
      entries.push([selection.model, selection.reasoningEffort ?? null])
      state.modelEffortPreferences = { version: 1, byModel: Object.fromEntries(entries.slice(-1024)) }
      state.creationSelection = selection
    })
  }

  async modelEffortPreferences() {
    await this.state.ready
    return readModelEffortPreferences(this.state.value, this.ctx.agentDefaultModel?.currentSelection())
  }

  async applyModelEffortPreference(value, current) {
    const selection = validateCreationSelection(value)
    if (Object.hasOwn(value, 'reasoningEffort')
      || (current?.provider === selection.provider && current.model === selection.model)) return selection
    const preferences = await this.modelEffortPreferences()
    const remembered = Object.hasOwn(preferences, selection.model) ? preferences[selection.model] : null
    const models = typeof remembered === 'string' ? (await this.catalog()).models : []
    return applyModelEffortPreference(selection, current, preferences, models)
  }

  async notification(method, params) {
    if (method === 'observability.warning') {
      if (params && /^[A-Z][A-Z0-9_]{0,79}$/.test(params.code)) {
        this.observabilityWarning = { code: params.code, observedAt: Number.isSafeInteger(params.observedAt) ? params.observedAt : Date.now(), gap: params.gap === true }
        this.diagnostics.event('observability.failed', this.observabilityWarning)
      }
      return
    }
    if (method === 'diagnostic') {
      this.diagnostics.event(params.event ?? 'remote.event', params)
      return
    }
    if (method !== 'sdk.message') return
    const run = this.runs.get(params?.runId)
    if (!run) {
      if (this.retiredRuns.has(params?.runId)) return
      throw failure('UNEXPECTED_RUN_EVENT', '收到不属于当前运行的 SDK 事件。')
    }
    if (run.kind === 'compact') return
    if (params.message?.type === 'result') run.inputClosed = true
    if (!run.firstModelEvent && (params.message?.type === 'stream_event'
      || (params.message?.type === 'assistant' && !isNoResponsePlaceholder(params.message.message)))) {
      run.firstModelEvent = true
      run.timing('first_model_event')
    }
    const before = run.agent.session.seq
    await run.projection.accept(params.message)
    const after = run.agent.session.seq
    // Live deltas only update the renderer. Flush each new durable record,
    // and conservatively retain the old behavior without a monotonic counter.
    if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(after) || after < 0 || after !== before) {
      await this.checkpoint(run.agent.session)
    }
  }

  async checkpoint(session) {
    if (typeof this.ctx.sessions?.flush !== 'function' || await this.ctx.sessions.flush(session) !== true) {
      throw failure('DURABILITY_UNAVAILABLE', '无法确认本机会话已可靠保存，已停止派发。')
    }
  }

  async syncSession(agent, { signal, withinRun = false } = {}) {
    if (this.connectionChanging) throw failure('BRIDGE_BUSY', '连接设置正在更改，请稍后同步。')
    if (agent.session.header.agentPreset !== CLAUDE_PRESET) return { status: 'not-remote' }
    if (this.syncing.has(agent.id)) return this.syncing.get(agent.id)
    if ([...this.runs.values()].some(run => run.agent.id === agent.id)) return { status: 'active' }
    if (!withinRun && agent.phase?.kind !== 'idle') return { status: 'active' }
    const operation = async maintenanceSignal => {
      const combined = AbortSignal.any([signal, maintenanceSignal].filter(Boolean))
      combined.throwIfAborted()
      const pending = await this.state.recoveryStatus(agent.id)
      const verified = this.verifiedHistory.get(agent.session)
      if (withinRun && verified && verified.transport === this.connection && verified.generation === this.historyGeneration
        && this.connection?.connected !== false && !pending.some(run => !run.reconciledAt)) {
        return { status: 'ready', added: 0, unresolvedTools: pending.reduce((sum, run) => sum
          + Object.values(run.tools).filter(tool => ['dispatched', 'unknown'].includes(tool.status)).length, 0) }
      }
      this.verifiedHistory.delete(agent.session)
      const binding = await this.state.binding(agent.id, agent.session.header.cwd)
      if (!binding.started && !Object.keys(binding.runs ?? {}).length) return { status: 'empty' }
      const previous = agent._bridgeStatus ?? this.ctx.sessionProjections.stateOf(agent.session, 'claudeBridge')
      // Reconciled unknown tools remain in the journal for later verification.
      // They must not turn a newer successful run back into an interrupted one.
      const interrupted = pending.some(run => !run.reconciledAt || run.runId === previous?.runId)
        || ['running', 'stopping', 'unknown'].includes(previous?.phase)
      this.sessionStatus(agent, { recovery: { status: 'syncing', added: 0, unresolvedTools: 0,
        interrupted, updatedAt: Date.now() } })
      try {
        const transport = await this.connect({ signal: combined })
        const generation = this.historyGeneration
        combined.throwIfAborted()
        if (this.initialized?.capabilities?.historySync !== true) {
          throw failure('HISTORY_UNAVAILABLE', '服务器尚未提供云端记录同步。')
        }
        let local
        const cloudResults = new Map()
        // Re-read the last response's page so a split API message is never
        // treated as a complete new snapshot at an incremental cursor.
        let cursor = binding.historyCursor?.projectionVersion !== 3 || pending.some(run => !run.reconciledAt)
          ? { offset: 0, lastUuid: null } : binding.historyCursor.replay ?? { offset: 0, lastUuid: null }
        let cloudRuns = {}, added = 0, replay
        for (let attempt = 0; attempt < 2; attempt++) {
          local = localHistory(agent.session)
          local.turn = pending.findLast(run => Number.isSafeInteger(run.turn))?.turn
            ?? Math.max(1, local.turn - (withinRun ? 1 : 0))
          const history = await readHistoryPages({ sessionId: binding.sdkSessionId, cursor, signal: combined,
            readPage: cursor => transport.peer.request('history', { deviceId: binding.deviceId,
              dshSessionId: agent.id, sessionId: binding.sdkSessionId, projectPath: binding.projectPath,
              offset: cursor.offset, ...(cursor.offset ? { afterUuid: cursor.lastUuid } : {}) }, { signal: combined, timeoutMs: 30_000 }) })
          if (history.status === 'busy') {
            this.sessionStatus(agent, { recovery: { status: 'waiting', added, unresolvedTools: 0,
              interrupted: true, updatedAt: Date.now() } })
            return { status: 'waiting' }
          }
          cursor = history.cursor
          cloudRuns = history.runs
          cloudResults.clear()
          try {
            for (const record of coalesceHistory(history.records)) {
              if (record.type === 'prompt' && binding.runs?.[record.uuid]?.turn) {
                local.turn = binding.runs[record.uuid].turn; local.step = binding.runs[record.uuid].step
              } else if (record.type === 'assistant') {
                const previous = local.assistants.find(event => event.data.message.id.startsWith(assistantPrefix(record.apiId)))
                if (previous) { local.turn = previous.data.turn; local.step = previous.data.step }
                added += restoreAssistant(agent.session, record, local, this.helpers,
                  agent._bridgeStatus?.model ?? selectionFor(this.ctx, agent).model)
                // Each distinct main-agent API response owns a DSH step. Tool
                // results and split transcript blocks must not collapse them.
                local.step++
              } else if (record.type === 'tool-result') cloudResults.set(record.callId, record)
            }
            replay = history.replay
            break
          } catch (error) {
            if (error.code !== 'HISTORY_FRAGMENT_INCOMPLETE' || history.readStart.offset === 0 || attempt > 0) throw error
            cursor = { offset: 0, lastUuid: null }
          }
        }
        const updates = []
        let unresolvedTools = 0
        for (const run of pending) {
          const tools = {}
          for (const [callId, tool] of Object.entries(run.tools)) {
            let result = local.results.get(callId)
            if (tool.status !== 'not-sent' && !knownToolResult(result)) {
              const receipt = cloudRuns[run.runId]?.tools?.[callId]
              const call = local.calls.get(callId)
              const cloud = verifiedCloudToolResult(tool, call, receipt, cloudResults.get(callId))
              if (cloud) {
                result = appendHistoryRecord(agent.session, HISTORY_TOOL_RESULT, { turn: call.data.turn, step: call.data.step,
                  message: this.helpers.createToolResultMessage({ callId, content: cloud.content, isError: cloud.isError }),
                  meta: { claudeBridgeRecovered: true }, callSeq: call.seq }, this.helpers)
                local.results.set(callId, result)
              }
            }
            tools[callId] = recoveryToolUpdate(callId, tool, result)
            if (tools[callId].status === 'unknown') unresolvedTools++
          }
          const observed = cloudRuns[run.runId]?.status
          updates.push({ runId: run.runId, status: ['completed', 'cancelled', 'failed'].includes(observed)
            ? observed : run.status === 'prepared' ? 'not-sent' : 'unknown', tools })
        }
        await this.checkpoint(agent.session)
        await this.state.reconcileRecovery(agent.id, updates, { ...cursor, replay, projectionVersion: 3 })
        await this.state.markStarted(agent.id)
        this.sessionStatus(agent, { ...(interrupted ? { phase: 'stopped', context: { status: 'unknown' } } : {}),
          toolMayHaveExecuted: interrupted && unresolvedTools > 0, recovery: { status: 'ready', added, unresolvedTools,
            interrupted, updatedAt: Date.now() } })
        await this.checkpoint(agent.session)
        if (transport === this.connection && generation === this.historyGeneration) {
          this.verifiedHistory.set(agent.session, { transport, generation })
        }
        this.diagnostics.event('history.synced', { sessionId: agent.id, status: 'ready' })
        return { status: 'ready', added, unresolvedTools }
      } catch (error) {
        this.sessionStatus(agent, { recovery: { status: 'unavailable', added: 0, unresolvedTools: 0,
          code: typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'HISTORY_READ_FAILED',
          interrupted, updatedAt: Date.now() } })
        this.diagnostics.event('history.failed', { sessionId: agent.id, code: error.code ?? 'HISTORY_READ_FAILED' })
        throw error
      }
    }
    const task = !withinRun && typeof agent.runMaintenance === 'function'
      ? agent.runMaintenance(operation) : operation(signal)
    this.syncing.set(agent.id, task)
    try { return await task } finally { if (this.syncing.get(agent.id) === task) this.syncing.delete(agent.id) }
  }

  requestRunStop(run) {
    if (run.stopPersistence) return
    run.stopPersistence = this.state.requestStop(run.agent.id, run.runId).catch(error => {
      run.journalError = error
      this.diagnostics.event('run.stop_record_failed', { runId: run.runId, code: 'STOP_RECORD_FAILED' })
    }).finally(() => run.queryAbort.abort())
  }

  listenForRunStop(run, onStop) {
    run.signal.addEventListener('abort', onStop, { once: true })
    if (run.signal.aborted) onStop()
  }

  async markRunSent(run) {
    run.signal.throwIfAborted()
    await this.state.markRunSent(run.agent.id, run.runId)
    // The caller checks cancellation and marks requestStarted in the same
    // continuation as the RPC call; returning here adds an async boundary.
  }

  async detachRun(run, onStop) {
    await run.stopPersistence
    if (onStop) run.signal.removeEventListener('abort', onStop)
    this.runs.delete(run.runId)
  }

  async finishRunResources(run, requiresReview) {
    const finishTiming = startLocalRunPhase({ runId: run.runId, stage: 'run_finalize',
      onTiming: fields => this.diagnostics.event('perf.local', fields) })
    try {
      this.retiredRuns.add(run.runId)
      if (this.retiredRuns.size > 256) this.retiredRuns.delete(this.retiredRuns.values().next().value)
      // A saved send intent is not proof of an RPC dispatch: cancellation can
      // arrive while markRunSent is still being persisted.
      const status = run.requestStarted ? (run.journalStatus ?? 'unknown') : 'not-sent'
      await this.state.finishRun(run.agent.id, run.runId, status, requiresReview)
      await this.diagnostics.flush()
    } finally { finishTiming() }
  }

  async recover(agent, confirm, signal) {
    if (agent.session.header.agentPreset !== CLAUDE_PRESET) return { kind: 'error', text: '此命令只用于远程会话。' }
    if (agent.phase?.kind !== 'idle' || typeof agent.runMaintenance !== 'function') {
      return { kind: 'error', text: '请先等待当前运行结束。' }
    }
    return agent.runMaintenance(async maintenanceSignal => {
      AbortSignal.any([signal, maintenanceSignal]).throwIfAborted()
      if ([...this.runs.values()].some(run => run.agent.id === agent.id)) return { kind: 'error', text: '当前会话仍在收尾，请稍后核实。' }
      const records = await this.state.recoveryStatus(agent.id)
      if (!records.length) return { kind: 'success', text: '当前会话没有待核实的中断记录。' }
      if (confirm) {
        await this.state.acknowledgeRecovery(agent.id)
        this.sessionStatus(agent, { phase: 'unknown', context: { status: 'unknown' }, toolMayHaveExecuted: true })
        await this.checkpoint(agent.session)
        return { kind: 'success', text: '已记录你的核实确认，允许后续对话；原请求不会重发，原有未知结果保留。' }
      }
      const tools = records.flatMap(run => Object.values(run.tools).filter(tool => ['dispatched', 'unknown'].includes(tool.status)))
      return { kind: 'success', text: `有 ${records.length} 轮执行状态待核实，${tools.length} 个工具未确认结果。请先核对实际文件、进程或外部操作；核实后使用 /bridge-recovery confirm 允许后续对话。原请求不会自动重试。` }
    })
  }

  async compact(agent, commandSignal) {
    try {
      if (agent.session.header.agentPreset !== CLAUDE_PRESET) throw failure('PRESET_ENGINE_MISMATCH', '此命令只用于远程会话。')
      if (agent.phase?.kind !== 'idle' || typeof agent.runMaintenance !== 'function') {
        throw failure('BRIDGE_BUSY', '请等待当前运行结束后再压缩。')
      }
      return await this.useConnection(() => agent.runMaintenance(async maintenanceSignal => {
        const signal = AbortSignal.any([maintenanceSignal, commandSignal])
        signal.throwIfAborted()
        const selected = selectionFor(this.ctx, agent)
        if (selected.model === 'account-default') throw failure('MODEL_SELECTION_REQUIRED', '请先选择明确的远程模型。')
        await this.state.ready
        if (!this.state.value.sessions[agent.id]?.started) throw failure('NATIVE_CONTEXT_MISSING', '会话尚未建立可恢复的远端上下文。')
        const binding = await this.state.binding(agent.id, agent.session.header.cwd)
        const transport = await this.connect()
        signal.throwIfAborted()
        if (this.initialized?.capabilities?.manualCompact !== true) {
          throw failure('COMPACT_UNAVAILABLE', '当前服务器版本尚未接入主动压缩。')
        }
        const contextPreferences = this.contextRequestPreferences()
        const runId = randomUUID()
        const run = { runId, kind: 'compact', agent, signal, queryAbort: new AbortController(), toolQueue: Promise.resolve() }
        let onStop
        await this.state.beginRun(agent.id, runId, 'compact')
        try {
          this.verifiedHistory.delete(agent.session)
          this.runs.set(runId, run)
          this.sessionStatus(agent, { model: selected.model, runId, phase: 'compacting', connection: 'connected', toolMayHaveExecuted: false })
          onStop = () => {
            this.requestRunStop(run)
            this.diagnostics.event('compact.stop_requested', { runId, sessionId: agent.id })
            try { this.sessionStatus(agent, { phase: 'stopping', context: { status: 'unknown' } }) }
            catch { this.diagnostics.event('compact.stop_status_failed', { runId, code: 'STOP_STATUS_FAILED' }) }
          }
          this.listenForRunStop(run, onStop)
          this.diagnostics.event('compact.started', { runId, sessionId: agent.id })
          await this.checkpoint(agent.session)
          await this.markRunSent(run)
          signal.throwIfAborted()
          run.requestStarted = true
          const result = await transport.peer.request('query', { action: 'compact', runId,
            ...contextPreferences,
            deviceId: binding.deviceId, dshSessionId: agent.id, sessionId: binding.sdkSessionId,
            projectPath: binding.projectPath, resume: true, model: selected.model,
            ...(selected.reasoningEffort ? { effort: selected.reasoningEffort } : {}),
          }, { signal: run.queryAbort.signal })
          signal.throwIfAborted()
          if (result.status !== 'completed') throw failure(result.code ?? 'COMPACT_FAILED', result.message ?? '远端压缩未完成。')
          if (!['compacted', 'unchanged'].includes(result.compaction?.status)) throw failure('COMPACT_UNCONFIRMED', 'SDK 未提供可验证的压缩结果。')
          if (result.metrics) {
            await this.state.recordUsage(agent.id, runId, { usage: result.metrics.usage,
              usageScope: 'current-turn-main-agent', modelUsage: result.metrics.modelUsage?.models,
              modelUsageScope: 'session-cumulative', total_cost_usd: result.metrics.cost?.usd,
              costScope: 'session-cumulative-estimate' })
          }
          signal.throwIfAborted()
          if (result.compaction.status === 'compacted') await this.state.markRecoveryNotice(agent.id, null)
          this.sessionStatus(agent, { model: selected.model, phase: 'completed', context: contextSnapshot(result.metrics?.context) })
          await this.checkpoint(agent.session)
          run.journalStatus = 'completed'
          this.diagnostics.event('compact.completed', { runId, status: result.compaction.status })
          return { kind: 'success', text: result.compaction.status === 'compacted'
            ? '已压缩远端 Claude 原生上下文；本机展示历史保留。' : 'SDK 本次未执行压缩，当前可能没有足够的可压缩内容。' }
        } catch (error) {
          if (signal.aborted && run.requestStarted) {
            await run.stopPersistence
            try { await transport.peer.request('settle', { runId }, { timeoutMs: 15000 }) }
            catch { /* A missing reply cannot prove compaction did not occur. */ }
          }
          this.sessionStatus(agent, { phase: 'unknown', context: { status: 'unknown' }, toolMayHaveExecuted: false })
          this.diagnostics.event('compact.failed', { runId, code: error.code ?? 'COMPACT_FAILED' })
          throw error
        } finally {
          await this.detachRun(run, onStop)
          await this.finishRunResources(run, Boolean(run.journalError))
        }
      }))
    } catch (error) {
      const messages = { BRIDGE_BUSY: '请等待当前运行结束后再压缩。',
        NATIVE_CONTEXT_MISSING: '会话尚未建立可恢复的远端上下文。',
        COMPACT_UNAVAILABLE: '当前服务器或 SDK 尚未提供主动压缩。',
        RECOVERY_REQUIRED: '上一轮状态待核实；请先使用 /bridge-recovery 查看并核实。',
        MODEL_SELECTION_REQUIRED: '请先选择明确的远程模型。', AUTH_REQUIRED: '请先在服务器完成官方登录。' }
      return { kind: 'error', text: messages[error.code] ?? '压缩未能确认完成；已发送的请求可能已生效，请核实会话状态后再决定是否重试。' }
    }
  }

  sessionStatus(agent, patch) {
    const current = this.ctx.sessionProjections.stateOf(agent.session, 'claudeBridge')
    const previous = current?.version === 1 ? current : agent._bridgeStatus ?? initialSessionStatus()
    const changedModel = patch.model !== undefined && patch.model !== previous.model
    const next = reconcileSessionStatus(previous, {
      ...previous, ...(changedModel ? { context: { status: 'unknown' }, compatibility: null } : {}),
      ...patch, updatedAt: Date.now(),
    })
    if (patch.runId !== undefined && ['running', 'compacting'].includes(patch.phase)) delete next.recovery
    this.helpers.appendPluginRecord(agent.session, SESSION_STATUS_RECORD, next)
    agent._bridgeStatus = next
    return next
  }

  async convertTools(assembly, selected, catalogModels) {
    let image = { supported: undefined, source: 'unknown', reason: '本次工具集合没有读图工具。' }
    if (assembly.tools.some(tool => tool.name === 'read_image')) {
      catalogModels ??= (await this.catalog()).models
      image = imageCapability(catalogModels.find(model => model.value === selected.model))
    }
    const converted = toMcpToolDefinitions(assembly.tools.filter(tool => tool.name !== 'read_image' || image.supported === true))
    if (assembly.tools.some(tool => tool.name === 'read_image') && image.supported !== true) {
      converted.compatibility.push({ name: 'read_image', status: 'disabled', reason: image.reason })
    }
    return { ...converted, catalogModels }
  }

  admitRemoteShell(agent, assembly, converted) {
    try {
      const previous = this.shellFailures.get(agent.session)
      if (previous) throw previous
      this.remoteCapabilities = assertRemoteShell(assembly, converted, this.ctx, agent)
    } catch (error) {
      if (error.code !== 'REMOTE_SHELL_UNAVAILABLE') throw error
      this.remoteCapabilities = error.capabilities
      this.compatibility = [...converted.compatibility.filter(tool => tool.name !== error.capabilities.shell),
        { name: error.capabilities.shell, status: 'disabled', reason: error.capabilities.reason }]
      if (typeof agent?.session?.append === 'function') this.sessionStatus(agent,
        { phase: 'failed', context: { status: 'unknown' },
          compatibility: { model: selectionFor(this.ctx, agent).model, version: 1, tools: this.compatibility } })
      throw error
    }
  }

  stopForShellFailure(run, name, result) {
    const error = shellInfrastructureFailure(name, result)
    if (!error) return
    this.shellFailures.set(run.agent.session, error)
    this.remoteCapabilities = error.capabilities
    run.compatibility = [...run.compatibility.filter(tool => tool.name !== error.capabilities.shell),
      { name: error.capabilities.shell, status: 'disabled', reason: error.capabilities.reason }]
    this.compatibility = run.compatibility
    this.sessionStatus(run.agent, { compatibility: { model: selectionFor(this.ctx, run.agent).model,
      version: 1, tools: run.compatibility } })
    run.preparationError = error
    this.requestRunStop(run)
    return error
  }

  prepareRequest(agent, decision, converted) {
    return prepareRequestAssembly({ assembly: decision.assembly, converted,
      admitShell: (assembly, tools) => this.admitRemoteShell(agent, assembly, tools),
      renderPrompt: assembly => this.helpers.renderPrompt(assembly) })
  }

  prepareMessages(agent, assembly, messages, signal, continuation = false) {
    const prepared = prepareRequestMessages({ assembly, messages, continuation,
      context: this.helpers.assembleContextFor(agent, signal),
      refreshContext: (accepted, context) => this.ctx.systemPrompt.refreshContext(accepted, context),
      renderContextSections: refreshed => this.helpers.renderContextSections(refreshed),
      joinContextSections: sections => this.helpers.joinContextSections(sections),
      projectContext: (text, sections) => agent.runtimeContext.project(text, sections) })
    assertPreparedInstructionAudit(agent, prepared)
    return prepared
  }

  async runStep(agent, decision) {
    return this.useConnection(() => this.performRunStep(agent, decision))
  }

  async performRunStep(agent, decision) {
    const enteredAt = performance.now()
    const phase = agent.phase
    if (phase?.kind !== 'running') throw failure('INVALID_AGENT_PHASE', '会话尚未进入执行阶段。')
    const { turn, step, abort: { signal } } = phase
    signal.throwIfAborted()
    const selected = selectionFor(this.ctx, agent)
    // Fail before connecting or starting a model request. This is an admission
    // check, not an implicit command: actual executions retain native policy.
    const shell = requiredShellName()
    this.admitRemoteShell(agent, decision.assembly,
      toMcpToolDefinitions((decision.assembly?.tools ?? []).filter(tool => tool.name === shell)))
    const runId = randomUUID()
    const timing = (stage, method) => this.diagnostics.event('perf.local', {
      runId, sessionId: agent.id, model: selected.model, effort: selected.reasoningEffort,
      stage, durationMs: Math.round(performance.now() - enteredAt), ...(method ? { method } : {}),
    })
    timing('start')
    let binding = await this.state.binding(agent.id, agent.session.header.cwd)
    const transport = await this.connect({ signal })
    const contextPreferences = this.contextRequestPreferences()
    timing('connected')
    if (this.initialized?.capabilities?.historySync === true) {
      const deadline = Date.now() + 120_000
      let retries = 0
      for (;;) {
        const recovered = await this.syncSession(agent, { signal, withinRun: true })
        if (recovered.status !== 'waiting') break
        if (Date.now() >= deadline) throw failure('RECOVERY_PENDING', '云端原运行仍未完成收尾，已保留对话记录，请等待连接恢复。')
        await delay(Math.min(8000, 1000 * 2 ** retries++), undefined, { signal })
      }
      binding = await this.state.binding(agent.id, agent.session.header.cwd)
    }
    timing('history_checked')
    const converted = await this.convertTools(decision.assembly, selected)
    // The full conversion can exclude the shell (for example, the global tool
    // count cap); the cheap initial probe cannot admit that final collection.
    const prepared = this.prepareRequest(agent, decision, converted)
    timing('tools_converted')
    this.compatibility = converted.compatibility
    const { assembly } = prepared
    const messages = this.prepareMessages(agent, assembly, decision.messages, signal)
    const media = { attachments: this.ctx.attachments, signal,
      imageInput: converted.tools.some(tool => tool.name === 'read_image'),
      mapHostPath: path => this.ctx.fs.processPathFromHostPath(path) }
    let prompt = await toSdkPrompt(messages, media)
    const notice = recoveryNotice(binding.runs)
    const injectNotice = notice && notice.key !== binding.lastRecoveryNoticeKey
    if (injectNotice) prompt = [{ type: 'text', text: notice.text }, ...prompt]
    signal.throwIfAborted()
    const systemPrompt = prepared.renderSystemPrompt()
    timing('prompt_prepared')
    const steps = new RunStepLifecycle({ agent, phase, turn, step })
    const run = { runId, agent, turn, steps, get step() { return steps.current },
      signal, timing, queryAbort: new AbortController(), media, calls: new Map(), toolQueue: Promise.resolve(),
      systemPrompt, toolSignature: prepared.toolSignature, catalogModels: converted.catalogModels,
      compatibility: converted.compatibility,
      toolNames: new Set(converted.tools.map(tool => tool.name)), concluded: false }
    let onStop, startedAt
    await this.state.beginRun(agent.id, runId, 'query', { turn, step })
    try {
      this.verifiedHistory.delete(agent.session)
      timing('journal_prepared')
      const header = { config: { provider: selected.provider, model: selected.model,
        ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) },
      tools: assembly.tools }
      agent.session.append('request/header', { header, reason: binding.started ? 'resume' : 'initial' })
      for (const { message, intent } of agent.systemPrompt.project(systemPrompt, { inHistory: false, startsSeries: true })) {
        agent.session.append('system/message', { turn, step, message }, intent)
      }
      for (const message of messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
      run.historyGeneration = this.historyGeneration
      run.progress = createRunProgressReporter({ runId, model: selected.model,
        isActive: () => this.runs.get(runId) === run && !signal.aborted,
        readStatus: () => agent._bridgeStatus,
        writeStatus: patch => this.sessionStatus(agent, patch),
        writeProgress: value => this.helpers.appendPluginRecord(agent.session, RUN_PROGRESS_RECORD, value) })
      run.projection = new SdkProjection({ agent, helpers: this.helpers, runId, turn, step, model: selected.model,
        onStarted: () => this.state.markStarted(agent.id),
        onProgress: event => run.progress.accept(event),
        onFirstToken: type => timing('first_token', type),
        onFirstText: () => timing('first_text'),
        onModelStart: () => steps.modelStart({ signal, tools: run.toolQueue }),
        onUsage: async message => {
          const report = { usage: message.usage, usageScope: 'current-turn-main-agent',
            modelUsage: message.modelUsage, modelUsageScope: 'session-cumulative',
            total_cost_usd: message.total_cost_usd, costScope: 'session-cumulative-estimate' }
          await this.state.recordUsage(agent.id, runId, report)
        } })
      this.runs.set(runId, run)
      this.sessionStatus(agent, { model: selected.model, runId, phase: 'running', connection: 'connected', toolMayHaveExecuted: false,
        compatibility: { model: selected.model, version: 1, tools: converted.compatibility } })
      run.progress.start()
      onStop = () => {
        this.requestRunStop(run)
        this.diagnostics.event('run.stop_requested', { runId, sessionId: agent.id })
        try { run.projection.interrupt() }
        catch { this.diagnostics.event('run.stop_projection_failed', { runId, code: 'STOP_PROJECTION_FAILED' }) }
        try { this.sessionStatus(agent, { phase: 'stopping', context: { status: 'unknown' } }) }
        catch { this.diagnostics.event('run.stop_status_failed', { runId, code: 'STOP_STATUS_FAILED' }) }
      }
      this.listenForRunStop(run, onStop)
      this.diagnostics.event('run.started', { runId, sessionId: agent.id, deviceId: binding.deviceId, stage: 'query' })
      startedAt = Date.now()
      await this.checkpoint(agent.session)
      signal.throwIfAborted()
      timing('checkpointed')
      await this.markRunSent(run)
      signal.throwIfAborted()
      run.requestStarted = true
      timing('request_sent')
      const result = await transport.peer.request('query', {
        ...contextPreferences,
        runId, deviceId: binding.deviceId, dshSessionId: agent.id, sessionId: binding.sdkSessionId,
        resume: binding.started, projectPath: binding.projectPath, prompt, systemPrompt,
        tools: converted.tools,
        ...(selected.model === 'account-default' ? {} : { model: selected.model }),
        ...(selected.reasoningEffort ? { effort: selected.reasoningEffort } : {}),
      }, { signal: run.queryAbort.signal })
      if (['completed', 'cancelled', 'failed'].includes(result.status)) run.observedOutcome = result.status
      await transport.peer.drainNotifications?.()
      await run.toolQueue
      signal.throwIfAborted()
      if (run.preparationError) throw run.preparationError
      if (result.status !== 'completed') throw failure(result.code ?? 'SDK_QUERY_FAILED', result.message ?? '远程会话运行未完成。')
      run.progress.close(result.metrics?.context)
      await this.state.markStarted(agent.id)
      signal.throwIfAborted()
      if (injectNotice) await this.state.markRecoveryNotice(agent.id, notice.key)
      this.sessionStatus(agent, { model: selected.model, phase: 'completed', context: contextSnapshot(result.metrics?.context) })
      await this.checkpoint(agent.session)
      run.journalStatus = 'completed'
      this.diagnostics.event('run.completed', { runId, sessionId: agent.id, durationMs: Date.now() - startedAt })
      timing('completed')
      run.completed = true
      // Optional display metadata is projected only after the required run
      // checkpoint. It cannot change the main outcome or add a flush barrier.
      if (typeof result.sessionTitle === 'string') {
        try { this.onSessionTitle?.(agent.session, result.sessionTitle) }
        catch { this.diagnostics.event('title.sync', { code: 'SDK_TITLE_SYNC_FAILED' }) }
      }
      return { kind: 'completed' }
    } catch (error) {
      startedAt ??= Date.now()
      if (run.preparationError && !signal.aborted) error = run.preparationError
      run.progress?.close()
      if (['AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_FLOW_FAILED'].includes(error.code)) {
        this.authentication = error.code === 'AUTH_FLOW_FAILED' ? 'verification-failed' : 'login-required'
      }
      if (signal.aborted) {
        await run.stopPersistence
        let stopState = { phase: run.requestStarted ? 'unknown' : 'stopped', toolMayHaveExecuted: Boolean(run.requestStarted) }
        try {
          const settled = run.requestStarted ? await transport.peer.request('settle', { runId }, { timeoutMs: 15000 })
            : { status: 'cancelled', toolMayHaveExecuted: false }
          if (['completed', 'cancelled', 'failed'].includes(settled.status)) {
            run.observedOutcome = settled.status
            stopState = { phase: settled.status === 'cancelled' ? 'stopped' : settled.status,
              toolMayHaveExecuted: settled.toolMayHaveExecuted === true }
          }
          this.diagnostics.event('run.stop_settled', { runId, status: settled.status, code: settled.code,
            durationMs: Date.now() - startedAt })
          if (settled.toolMayHaveExecuted) this.diagnostics.event('run.cancelled', { runId, code: 'TOOL_OUTCOME_REQUIRES_CHECK', toolMayHaveExecuted: true })
        } catch {
          this.diagnostics.event('run.unknown', { runId, code: 'UNKNOWN_EXECUTION_OUTCOME', toolMayHaveExecuted: true })
        }
        run.stopState = stopState
      }
      await run.toolQueue.catch(() => {})
      await transport.peer.drainNotifications?.().catch(() => {})
      run.projection?.finish({ interrupted: true })
      this.sessionStatus(agent, { ...(run.stopState ?? { phase: run.requestStarted && !run.observedOutcome ? 'unknown' : 'failed', toolMayHaveExecuted: run.calls.size > 0 }),
        ...(run.toolOutcomeUnknown ? { toolMayHaveExecuted: true } : {}),
        context: { status: 'unknown' } })
      await this.checkpoint(agent.session)
      run.journalStatus = run.observedOutcome ?? (run.requestStarted ? 'unknown' : 'not-sent')
      this.diagnostics.event('run.failed', { runId, sessionId: agent.id, code: error.code ?? 'BRIDGE_RUN_FAILED',
        errorName: error.name, durationMs: Date.now() - startedAt })
      throw error
    } finally {
      await this.detachRun(run, onStop)
      this.localTiming.finish(runId)
      await this.finishRunResources(run, Boolean(run.toolOutcomeUnknown || run.journalError))
      if (run.completed && !signal.aborted && !run.toolOutcomeUnknown && !run.journalError
        && transport === this.connection && run.historyGeneration === this.historyGeneration) {
        this.verifiedHistory.set(agent.session, { transport, generation: this.historyGeneration })
      }
    }
  }

  async prepareStep(params, context) {
    const run = this.runs.get(params?.runId)
    if (!run) throw failure('UNKNOWN_RUN', '准备下一步的运行已结束。')
    const signal = AbortSignal.any([run.signal, context.signal])
    signal.throwIfAborted()
    await run.toolQueue
    signal.throwIfAborted()
    if (run.preparationError) throw run.preparationError
    if (run.concluded || run.inputClosed) return { continue: false }
    const { agent } = run
    if (typeof agent.preStep !== 'function') throw failure('DSH_PRE_STEP_UNAVAILABLE', '当前 DSH 未提供所需的步骤准备接口。')
    const pending = [...agent.inbox.nextStep]
    let decision
    let accepted = false
    try {
      // DSH waits for nested instruction projections at its native step boundary.
      decision = await agent.preStep('next-step', run.steps.beginPreparation())
      signal.throwIfAborted()
      if (decision.kind === 'reject') throw failure('DSH_PRE_STEP_REJECTED', 'DSH 拒绝继续当前步骤，已停止远端推理。')
      const tools = await this.convertTools(decision.assembly, selectionFor(this.ctx, agent), run.catalogModels)
      const prepared = this.prepareRequest(agent, decision, tools)
      const promptChanged = prepared.renderSystemPrompt() !== run.systemPrompt
      if (promptChanged || prepared.toolSignature !== run.toolSignature) {
        throw failure('QUERY_CONFIGURATION_CHANGED', promptChanged
          ? '运行期间系统提示发生变化，本轮已在安全边界停止并保留原对话；恢复原预设配置后可继续。'
          : '运行期间工具集合已更新，本轮已在安全边界停止并保留当前对话；继续时将重新检查最新工具。')
      }
      const messages = this.prepareMessages(agent, prepared.assembly, decision.messages, signal, true)
      const additionalContexts = [], userMessages = []
      for (const message of messages) {
        const blocks = await toSdkPrompt([message], { ...run.media, signal })
        if (blocks.some(block => block.type !== 'text')) throw failure('UNSUPPORTED_STEP_CONTEXT', '步骤附加上下文含有无法在此处投递的图片等内容；已停止。')
        // The durable event name is also used for instructions, tool context
        // and subagent delivery. Only native user provenance may steer as user.
        if (message.source.kind === 'user') {
          if (!USER_MESSAGE_ID.test(message.id)) throw failure('USER_INPUT_INVALID', '用户插话缺少有效消息标识，已停止且保留未发送消息。')
          userMessages.push({ id: message.id, content: blocks })
        } else additionalContexts.push(...blocks.map(block => block.text))
      }
      if (userMessages.length && this.initialized?.capabilities?.userInputViaStream !== true) {
        throw failure('USER_INTERJECTION_UNSUPPORTED', '服务器不支持以用户身份接收运行中插话，请更新服务器；已停止且保留未发送消息。')
      }
      signal.throwIfAborted()
      if (run.inputClosed) throw failure('USER_INPUT_CLOSED', '当前运行已结束接收插话，未发送消息已保留。')
      for (const message of messages) agent.session.append('user/message', message, { surfaceOp: 'append' })
      run.projection.advanceStep(run.steps.completePreparation())
      accepted = true
      this.diagnostics.event('step.prepared', { runId: run.runId, stage: 'pre-step' })
      return { ...(additionalContexts.length ? { additionalContexts } : {}),
        ...(userMessages.length ? { userMessages } : {}) }
    } catch (error) {
      run.preparationError = error
      this.diagnostics.event('step.failed', { runId: run.runId, stage: 'pre-step', code: error.code ?? 'DSH_PRE_STEP_FAILED' })
      throw error
    } finally {
      if (!accepted) {
        // preStep claims from the durable inbox. Restore unsent context on a
        // rejected configuration or cancellation, including newly found files.
        const restore = [...pending, ...(decision?.messages ?? [])]
          .filter(message => message.source.kind !== 'runtime-context')
        const present = new Set(agent.inbox.nextStep.map(message => message.id))
        for (const message of restore) if (!present.has(message.id)) {
          agent.inbox.splice('next-step', agent.inbox.nextStep.length, 0, [message]); present.add(message.id)
        }
      }
    }
  }

  async dispatchTool(params, context) {
    // Assistant tool-use events must settle before DSH starts their tool cards.
    await context.peer?.drainNotifications?.()
    const run = this.runs.get(params?.runId)
    if (!run || !run.toolNames.has(params.name) || typeof params.callId !== 'string') {
      throw failure('UNADMITTED_TOOL', '工具不属于当前运行的能力集合。')
    }
    const advertised = run.projection.getCommittedToolCall(params.callId)
    if (!advertised || advertised.name !== params.name) throw failure('TOOL_EVENT_UNCOMMITTED', '工具调用尚未在本地历史中登记，未执行。')
    let parsed
    try { parsed = JSON.parse(advertised.arguments) } catch { throw failure('TOOL_ARGUMENTS_INVALID', '模型声明的工具参数不是有效 JSON，未执行。') }
    if (!isDeepStrictEqual(parsed, params.arguments)) throw failure('TOOL_ARGUMENTS_MISMATCH', '声明参数与实际工具参数不一致，未执行。')
    if (run.calls.has(params.callId)) return run.calls.get(params.callId)
    const finishTiming = startLocalRunPhase({ runId: run.runId, stage: 'tool_total', callId: params.callId,
      onTiming: fields => this.diagnostics.event('perf.local', fields) })
    const operation = run.toolQueue.then(async () => {
      try {
        const signal = AbortSignal.any([run.signal, context.signal])
        signal.throwIfAborted()
        if (run.concluded) return { content: [{ type: 'text', text: '当前工具已结束本轮，请直接给出最终回复。' }], isError: true }
        const { agent, turn, step } = run
        const previous = await this.state.previousTool(agent.id, params.callId)
        if (previous && previous.runId !== run.runId) {
          const call = agent.session.eventAt?.(previous.callSeq)
          let original
          try { original = JSON.parse(call?.data.arguments) } catch {}
          if (previous.name !== params.name || !isDeepStrictEqual(original, params.arguments)) {
            throw failure('TOOL_ARGUMENTS_MISMATCH', '恢复调用与原工具参数不一致，未执行。')
          }
          const result = agent.session.eventAt?.(previous.resultSeq)
          if (call?.type !== 'tool/call' || call.data.callId !== params.callId
            || !knownToolResult(result) || (result.data.message.toolCallId ?? result.data.message.source?.callId) !== params.callId) {
            throw failure('UNKNOWN_TOOL_OUTCOME', '原工具结果仍未知，未重复执行。')
          }
          return { content: await toMcpContent(result.data.message.content, run.media), isError: Boolean(result.data.message.isError) }
        }
        await this.state.beginTool(agent.id, run.runId, params.callId, params.name,
          createHash('sha256').update(advertised.arguments).digest('hex'))
        const call = agent.session.append('tool/call', { turn, step, callId: params.callId, name: params.name,
          // DSH's durable validator requires the exact advertised JSON string,
          // including whitespace/key order. Execution uses the checked object.
          arguments: advertised.arguments })
        this.diagnostics.event('tool.started', { runId: run.runId, callId: params.callId, toolName: params.name })
        const startedAt = Date.now()
        let result
        let dispatched = false
        try {
          await this.checkpoint(agent.session)
          signal.throwIfAborted()
          await this.state.markToolDispatched(agent.id, run.runId, params.callId, call.seq)
          signal.throwIfAborted()
          dispatched = true
          // The native pipeline includes its own approval wait, not pure tool CPU.
          const finishPipeline = startLocalRunPhase({ runId: run.runId, stage: 'tool_pipeline', callId: params.callId,
            onTiming: fields => this.diagnostics.event('perf.local', fields) })
          try {
            result = await this.ctx.agents.withInitiator(agent, () => this.ctx.tools.execute({
              callId: params.callId, name: params.name, arguments: params.arguments, agent, signal,
            }))
          } finally { finishPipeline() }
        } catch (error) {
          if (!dispatched) {
            await this.state.finishTool(agent.id, run.runId, params.callId, 'not-sent')
            throw error
          }
          run.toolOutcomeUnknown = true
          const unknownResult = agent.session.append('tool/result', { turn, step,
            message: this.helpers.createToolResultMessage({ callId: params.callId, isError: true,
              content: [{ type: 'text', text: UNKNOWN_TOOL_TEXT }] }),
            meta: { claudeBridgeOutcome: 'unknown' },
          }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
          await this.checkpoint(agent.session)
          await this.state.finishTool(agent.id, run.runId, params.callId, 'unknown', unknownResult.seq)
          this.diagnostics.event('tool.unknown', { runId: run.runId, callId: params.callId, toolName: params.name,
            code: 'UNKNOWN_TOOL_OUTCOME', toolMayHaveExecuted: true, durationMs: Date.now() - startedAt })
          throw this.stopForShellFailure(run, params.name, error) ?? error
        }
        const resultEvent = agent.session.append('tool/result', { turn, step,
          message: this.helpers.createToolResultMessage({ callId: params.callId, content: result.content, isError: Boolean(result.isError) }),
          ...(result.meta === undefined ? {} : { meta: result.meta }),
          ...(result.error?.info ? { error: result.error.info } : {}),
        }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
        try {
          await this.checkpoint(agent.session)
          await this.state.finishTool(agent.id, run.runId, params.callId, 'completed', resultEvent.seq)
        } catch (error) { run.toolOutcomeUnknown = true; throw error }
        const shellFailure = this.stopForShellFailure(run, params.name, result)
        if (shellFailure) throw shellFailure
        const content = await toMcpContent(result.content, run.media)
        const additionalContexts = []
        if (result.isError === true && typeof result.error?.info?.code === 'string'
          && /^[A-Z0-9_]{1,80}$/.test(result.error.info.code)) {
          additionalContexts.push(`[桥接插件工具说明] ${params.name}（${params.callId}）返回错误码 ${result.error.info.code}。请依据实际工具结果调整做法；错误本身不能证明操作未生效。涉及先前副作用时先只读核实，并遵守用户停止和审批结果。`)
        }
        for (const additional of result.additionalContexts ?? []) {
          const blocks = await toSdkPrompt([additional], run.media)
          if (blocks.some(block => block.type !== 'text')) throw failure('UNSUPPORTED_TOOL_CONTEXT', '工具附加上下文含有当前无法转换的内容。')
          additionalContexts.push(blocks.map(block => block.text).join('\n'))
          agent.session.append('user/message', additional, { surfaceOp: 'append' })
          this.diagnostics.event('tool.context_converted', { runId: run.runId, callId: params.callId, toolName: params.name })
        }
        if (result.concludesTurn) run.concluded = true
        this.diagnostics.event('tool.completed', { runId: run.runId, callId: params.callId, toolName: params.name,
          durationMs: Date.now() - startedAt, status: result.isError ? 'error' : 'ok' })
        return { content, isError: Boolean(result.isError),
          ...(additionalContexts.length ? { additionalContexts } : {}),
          ...(result.concludesTurn ? { concludesTurn: true } : {}),
        }
      } finally { finishTiming() }
    })
    run.calls.set(params.callId, operation)
    run.toolQueue = operation.then(() => {}, () => {})
    return operation
  }

  async dispatchApproval(params, context) {
    const run = this.runs.get(params?.runId)
    if (!run) return { behavior: 'deny', message: '审批运行已结束。' }
    // Tool permissions are enforced by the local DSH tool pipeline. Native SDK
    // tools are not silently granted a second execution world.
    if (params.toolName !== 'AskUserQuestion') return { behavior: 'deny', message: '请通过本机 DSH 工具执行。' }
    return { behavior: 'deny', message: '请使用 DSH 的 ask_user_question 工具提出问题。' }
  }

  async dispose() {
    if (this.disposing) return this.disposing
    this.disposed = true
    this.connectionContext.retire()
    this.lifetime.abort()
    this.disposing = (async () => {
      try { if (this.connection) await this.connection.close() }
      finally {
        await Promise.allSettled([...this.runs.values()].map(run => run.toolQueue))
        try { await this.state.flush() } finally { await this.diagnostics.flush() }
      }
    })()
    return this.disposing
  }
}
