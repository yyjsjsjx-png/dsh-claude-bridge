var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
/** DSH rc.5 Host service and catalog facade for the remote SDK engine. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { TypertRemoteService, Remote, RemoteError, principalOf, LlmAdapter, schema, resolveDshHome, credentialKey, renderPrompt, renderContextSections, joinContextSections, assembleContextFor, createAssistantMessage, createToolResultMessage, createSystemMessage, AssistantStreamAccumulator, BlockAssembler, } from './compat/runtime.mjs';
import { BridgeBackend } from '../src/backend.mjs';
import { CLAUDE_PRESET, CLAUDE_PROVIDER } from './policy.mjs';
import { remotePresetFeatures } from './preset.mjs';
import { remotePresetStatus } from './preset-loading.mjs';
import { resolveDshModule, assertDshCompatibility } from './compat/resolve-dsh-module.mjs';
import { createWorkflowDepthGuard } from './workflow-depth-guard.mjs';
import { createClaudeCatalogAdapter } from './catalog-adapter.mjs';
import { createSessionStatusProjection } from '../src/session-status.mjs';
import { createRunProgressProjection } from '../src/run-progress.mjs';
import { createResponseUsageProjection } from '../src/response-usage.mjs';
import { createResponseTimingProjection } from '../src/response-timing.mjs';
import { createModelObservationProjection } from '../src/model-observation.mjs';
import { installRemoteNativeTitles } from './remote-native-titles.mjs';
import { createClientTimingRecorder } from '../src/client-timing-diagnostics.mjs';
import { createModelCycleProjection, modelCycleRows } from '../src/model-cycle-projection.mjs';
const { delegationDepthOf } = await import(resolveDshModule('@deepseek-ai/dsh-subagent'));
const { z } = await import(resolveDshModule('zod'));
const { appendPluginRecord } = await import(resolveDshModule('@deepseek-ai/dsh-session'));
const toolModule = await import(resolveDshModule('@deepseek-ai/dsh-tools'));
const ToolExecutionPipeline = typeof toolModule.ToolsService?.prototype?.resolve === 'function'
    ? (await import(resolveDshModule('@deepseek-ai/dsh-tools/pipeline'))).ToolExecutionPipeline : undefined;
const nativeTitle = await Promise.resolve().then(() => {
    const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'));
    return import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-title')).href);
}).catch(() => undefined);
const hostCompatibility = await assertDshCompatibility();
/** Catalog only: all model calls belong to ClaudeLoopAgent, never LlmRuntime. */
export const ClaudeCatalogAdapter = createClaudeCatalogAdapter(LlmAdapter);
/** This plugin deliberately registers no credentials or network endpoint. */
let ClaudeBridgeService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _status_decorators;
    let _saveConnection_decorators;
    let _clearConnection_decorators;
    let _planUsage_decorators;
    let _syncSession_decorators;
    let _recordClientTiming_decorators;
    let _modelRequestStats_decorators;
    let _refreshCatalog_decorators;
    let _modelPreferences_decorators;
    let _visibleModels_decorators;
    let _saveModelPreferences_decorators;
    let _saveContextPreferences_decorators;
    return class ClaudeBridgeService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _status_decorators = [Remote('status')];
            _saveConnection_decorators = [Remote('saveConnection')];
            _clearConnection_decorators = [Remote('clearConnection')];
            _planUsage_decorators = [Remote('planUsage')];
            _syncSession_decorators = [Remote('syncSession')];
            _recordClientTiming_decorators = [Remote('recordClientTiming')];
            _modelRequestStats_decorators = [Remote('modelRequestStats')];
            _refreshCatalog_decorators = [Remote('refreshCatalog')];
            _modelPreferences_decorators = [Remote('modelPreferences')];
            _visibleModels_decorators = [Remote('visibleModels')];
            _saveModelPreferences_decorators = [Remote('saveModelPreferences')];
            _saveContextPreferences_decorators = [Remote('saveContextPreferences')];
            __esDecorate(this, null, _status_decorators, { kind: "method", name: "status", static: false, private: false, access: { has: obj => "status" in obj, get: obj => obj.status }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _saveConnection_decorators, { kind: "method", name: "saveConnection", static: false, private: false, access: { has: obj => "saveConnection" in obj, get: obj => obj.saveConnection }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _clearConnection_decorators, { kind: "method", name: "clearConnection", static: false, private: false, access: { has: obj => "clearConnection" in obj, get: obj => obj.clearConnection }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _planUsage_decorators, { kind: "method", name: "planUsage", static: false, private: false, access: { has: obj => "planUsage" in obj, get: obj => obj.planUsage }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _syncSession_decorators, { kind: "method", name: "syncSession", static: false, private: false, access: { has: obj => "syncSession" in obj, get: obj => obj.syncSession }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _recordClientTiming_decorators, { kind: "method", name: "recordClientTiming", static: false, private: false, access: { has: obj => "recordClientTiming" in obj, get: obj => obj.recordClientTiming }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _modelRequestStats_decorators, { kind: "method", name: "modelRequestStats", static: false, private: false, access: { has: obj => "modelRequestStats" in obj, get: obj => obj.modelRequestStats }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _refreshCatalog_decorators, { kind: "method", name: "refreshCatalog", static: false, private: false, access: { has: obj => "refreshCatalog" in obj, get: obj => obj.refreshCatalog }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _modelPreferences_decorators, { kind: "method", name: "modelPreferences", static: false, private: false, access: { has: obj => "modelPreferences" in obj, get: obj => obj.modelPreferences }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _visibleModels_decorators, { kind: "method", name: "visibleModels", static: false, private: false, access: { has: obj => "visibleModels" in obj, get: obj => obj.visibleModels }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _saveModelPreferences_decorators, { kind: "method", name: "saveModelPreferences", static: false, private: false, access: { has: obj => "saveModelPreferences" in obj, get: obj => obj.saveModelPreferences }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _saveContextPreferences_decorators, { kind: "method", name: "saveContextPreferences", static: false, private: false, access: { has: obj => "saveContextPreferences" in obj, get: obj => obj.saveContextPreferences }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['tools', 'systemPrompt', 'sessions', 'llm', 'approval', 'fs',
            'attachments', 'sessionProjections', 'credentials', 'agents', 'subagents', 'agentDefaultModel'];
        static Config = schema.object({
            stateDirectory: schema.string(),
            transport: schema.union(['wss', 'ssh']).default('wss'),
            remoteWorkerPath: schema.string(),
            remoteNodePath: schema.string(),
        });
        constructor(ctx, config = {}) {
            super(ctx, 'claudeBridge');
            __runInitializers(this, _instanceExtraInitializers);
            const helpers = {
                resolveDshHome, credentialKey,
                renderPrompt, renderContextSections, joinContextSections, assembleContextFor,
                createAssistantMessage, createToolResultMessage, createSystemMessage, appendPluginRecord,
                AssistantStreamAccumulator, BlockAssembler, ToolExecutionPipeline,
            };
            this.backend = new BridgeBackend(ctx, config, { helpers, hostCompatibility });
            ctx.inject(['sessionTitle'], titleCtx => {
                titleCtx.effect(() => {
                    const titles = installRemoteNativeTitles(titleCtx, { normalizeSessionTitle: nativeTitle?.normalizeSessionTitle,
                        report: code => this.backend.diagnostics.event('title.sync', { code }) });
                    const previous = this.backend.onSessionTitle;
                    this.backend.onSessionTitle = titles.sync;
                    return () => {
                        if (this.backend.onSessionTitle === titles.sync)
                            this.backend.onSessionTitle = previous;
                        titles.dispose();
                    };
                }, 'SDK 原生标题展示');
            });
            ctx.sessionProjections.register(createSessionStatusProjection(z));
            ctx.sessionProjections.register(createRunProgressProjection(z));
            ctx.sessionProjections.register(createResponseUsageProjection(z));
            ctx.sessionProjections.register(createResponseTimingProjection(z));
            ctx.sessionProjections.register(createModelCycleProjection(z));
            ctx.sessionProjections.register(createModelObservationProjection(z));
            const backend = this.backend;
            const adapter = new ClaudeCatalogAdapter(backend, ctx);
            this.catalogAdapter = adapter;
            ctx.effect(() => {
                const removeWorkflowGuard = ctx.tools.guard(createWorkflowDepthGuard({
                    subagents: ctx.subagents, delegationDepthOf,
                }));
                const unregister = ctx.llm.registerAdapter([CLAUDE_PROVIDER], adapter);
                this.catalogRegistration = unregister;
                backend.onDisplayCatalogChanged = () => {
                    try {
                        unregister.replace([CLAUDE_PROVIDER]);
                    }
                    catch {
                        ctx.logger.warn('远程模型目录刷新失败。');
                    }
                };
                return async () => {
                    backend.onDisplayCatalogChanged = undefined;
                    this.catalogRegistration = undefined;
                    unregister();
                    removeWorkflowGuard();
                    if (typeof backend.dispose === 'function')
                        await backend.dispose();
                };
            }, '远程会话桥接服务');
            const refreshActiveModels = session => {
                if (session?.header?.agentPreset === CLAUDE_PRESET) {
                    try {
                        this.catalogRegistration?.replace?.([CLAUDE_PROVIDER]);
                    }
                    catch {
                        ctx.logger.warn('远程模型目录刷新失败。');
                    }
                }
            };
            ctx.on('session/created', refreshActiveModels);
            ctx.on('session/disposed', refreshActiveModels);
            ctx.on('session/event', (session, event) => {
                if (event?.type === 'model/selection' || event?.type === 'request/header')
                    refreshActiveModels(session);
            });
            const reconcileStatus = session => {
                if (session?.header?.agentPreset !== CLAUDE_PRESET)
                    return;
                const previous = ctx.sessionProjections.stateOf(session, 'claudeBridge');
                if (['running', 'compacting', 'stopping'].includes(previous?.phase)
                    && ![...backend.runs.values()].some(run => run.agent.session === session)) {
                    backend.sessionStatus({ session }, { phase: 'unknown', toolMayHaveExecuted: true });
                }
            };
            ctx.on('session/created', reconcileStatus);
            for (const session of ctx.sessions.list())
                reconcileStatus(session);
        }
        runStep(agent, decision) {
            return this.backend.runStep(agent, decision);
        }
        compact(agent, signal) {
            return this.backend.compact(agent, signal);
        }
        recover(agent, confirm, signal) {
            return this.backend.recover(agent, confirm, signal);
        }
        assertOwner() {
            if (principalOf(this.ctx.invocation) !== undefined) {
                throw new RemoteError('remote-access/denied', '仅本机所有者可管理远程会话连接。', {});
            }
        }
        async status() {
            this.assertOwner();
            const status = await this.backend.status();
            const remotePreset = remotePresetStatus(this.ctx);
            const host = await assertDshCompatibility();
            return { ...status, remotePreset, host,
                desktopCompatibility: { version: host.version, verifiedVersions: ['0.2.1-rc.5'] },
                ...remotePresetFeatures(remotePreset) };
        }
        async saveConnection(value) {
            this.assertOwner();
            const result = await this.backend.saveConnection(value);
            this.catalogRegistration?.replace?.([CLAUDE_PROVIDER]);
            return { url: result.url, configured: result.configured, status: result.status };
        }
        async clearConnection() {
            this.assertOwner();
            const result = await this.backend.clearConnection();
            this.catalogRegistration?.replace?.([CLAUDE_PROVIDER]);
            return { configured: result.configured, status: result.status };
        }
        async planUsage(refresh) {
            this.assertOwner();
            return this.backend.planUsage(refresh);
        }
        async syncSession(sessionId) {
            this.assertOwner();
            if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 160) {
                throw new RemoteError('claude-bridge/invalid-session', '会话标识无效。', {});
            }
            // The native ordinary-session resolver deliberately rejects even live
            // subagents. History reconciliation uses their existing owner; it must
            // never resume or create a replacement child through that resolver.
            const live = this.ctx.agents.get(sessionId);
            if (live?.session.header.agentPreset === CLAUDE_PRESET && live.session.header.origin === 'subagent') {
                return this.backend.syncSession(live);
            }
            const attached = this.ctx.sessions.get(sessionId);
            if (attached?.header.agentPreset === CLAUDE_PRESET && attached.header.origin === 'subagent') {
                return { status: 'read-only' };
            }
            const resolved = await this.ctx.get('sessionController').resolveAgent(sessionId);
            if (resolved?.error) {
                // A persisted child can be visible without an attached Session. Only
                // the native ownership rejection plus our existing remote binding can
                // identify that case without activating or copying its transcript.
                if (resolved.error.code === 'session/agent-busy'
                    && resolved.error.details?.reason === 'use subagent delivery for this child session') {
                    await this.backend.state.ready;
                    if (Object.hasOwn(this.backend.state.value.sessions, sessionId))
                        return { status: 'read-only' };
                }
                throw resolved.error;
            }
            const agent = resolved?.agent;
            if (!agent?.session)
                throw new RemoteError('claude-bridge/invalid-session', '无法解析会话智能体。', {});
            if (agent.session.header.agentPreset !== CLAUDE_PRESET)
                return { status: 'not-remote' };
            return this.backend.syncSession(agent);
        }
        async recordClientTiming(value) {
            this.assertOwner();
            this.clientTimingRecorder ??= createClientTimingRecorder({
                isRemoteSession: id => (this.ctx.sessions.get(id) ?? this.ctx.agents.get(id)?.session)
                    ?.header.agentPreset === CLAUDE_PRESET,
                record: (event, fields) => this.backend.diagnostics.event(event, fields),
            });
            try {
                return this.clientTimingRecorder(value);
            }
            catch (error) {
                if (error.code === 'INVALID_CLIENT_TIMING') {
                    throw new RemoteError('claude-bridge/invalid-client-timing', '客户端耗时诊断格式无效。', {});
                }
                throw error;
            }
        }
        async modelRequestStats(value) {
            this.assertOwner();
            if (!value || typeof value !== 'object' || Array.isArray(value)
                || Object.keys(value).some(key => !['sessionId', 'offset', 'limit'].includes(key))
                || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 160
                || !Number.isSafeInteger(value.offset ?? 0) || (value.offset ?? 0) < 0
                || !Number.isSafeInteger(value.limit ?? 100) || (value.limit ?? 100) < 1 || (value.limit ?? 100) > 200) {
                throw new RemoteError('claude-bridge/invalid-request-stats', '请求统计分页参数无效。', {});
            }
            const session = this.ctx.sessions.get(value.sessionId) ?? this.ctx.agents.get(value.sessionId)?.session;
            if (!session || session.header.agentPreset !== CLAUDE_PRESET)
                return { status: 'not-loaded', total: 0, rows: [] };
            const state = this.ctx.sessionProjections.stateOf(session, 'claudeBridgeModelStats');
            const rows = modelCycleRows(state), offset = value.offset ?? 0;
            return { status: 'ready', total: rows.length, rows: rows.slice(offset, offset + (value.limit ?? 100)) };
        }
        async refreshCatalog() {
            this.assertOwner();
            const result = await this.backend.catalog({ refresh: true });
            this.catalogRegistration?.replace?.([CLAUDE_PROVIDER]);
            return result;
        }
        async modelPreferences() {
            this.assertOwner();
            return this.backend.listModelPreferences();
        }
        async visibleModels() {
            this.assertOwner();
            return { models: await this.catalogAdapter.models(true), selection: await this.backend.creationSelection(),
                modelEfforts: await this.backend.modelEffortPreferences() };
        }
        async saveModelPreferences(value) {
            this.assertOwner();
            await this.backend.saveModelPreferences(value);
            this.catalogRegistration?.replace?.([CLAUDE_PROVIDER]);
            return { saved: true };
        }
        async saveContextPreferences(value) {
            this.assertOwner();
            return this.backend.saveContextPreferences(value);
        }
    };
})();
export { ClaudeBridgeService };
export default ClaudeBridgeService;
