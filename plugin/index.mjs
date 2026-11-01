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
import { TypertRemoteService, Remote, RemoteError, principalOf, LlmAdapter, schema, resolveDshHome, credentialKey, renderPrompt, renderContextSections, joinContextSections, assembleContextFor, createAssistantMessage, createToolResultMessage, createSystemMessage, AssistantStreamAccumulator, BlockAssembler, } from './compat/runtime.mjs';
import { BridgeBackend } from '../src/backend.mjs';
import { CLAUDE_PRESET, CLAUDE_PROVIDER } from './policy.mjs';
import { remotePresetFeatures } from './preset.mjs';
import { remotePresetStatus } from './preset-loading.mjs';
import { resolveDshModule, assertDshCompatibility } from './compat/resolve-dsh-module.mjs';
import { createWorkflowDepthGuard } from './workflow-depth-guard.mjs';
import { imageCapability } from '../src/model-capabilities.mjs';
import { createSessionStatusProjection } from '../src/session-status.mjs';
const { delegationDepthOf } = await import(resolveDshModule('@deepseek-ai/dsh-subagent'));
const { z } = await import(resolveDshModule('zod'));
const { appendPluginRecord } = await import(resolveDshModule('@deepseek-ai/dsh-session'));
const ACCOUNT_DEFAULT = 'account-default';
const DEFAULT_MODEL = Object.freeze({
    provider: CLAUDE_PROVIDER,
    id: ACCOUNT_DEFAULT,
    name: '远程模型（账号默认）',
    description: '由远程账号选择默认模型。',
});
const NO_CONFIGURATION = new Set(['SETTINGS_MISSING', 'TOKEN_MISSING', 'BRIDGE_NOT_CONFIGURED']);
/** Catalog only: all model calls belong to ClaudeLoopAgent, never LlmRuntime. */
export class ClaudeCatalogAdapter extends LlmAdapter {
    constructor(backend, ctx) {
        super();
        this.backend = backend;
        this.ctx = ctx;
    }
    providerInfo(provider) {
        return { id: provider, name: '远程模型' };
    }
    async models(visible = false) {
        const method = visible ? this.backend.visibleCatalog : this.backend.catalog;
        if (typeof method !== 'function')
            throw new Error('远程模型目录服务尚未就绪。');
        let reply;
        try {
            reply = await method.call(this.backend);
        }
        catch (error) {
            if (NO_CONFIGURATION.has(error?.code))
                return [];
            throw error;
        }
        const models = Array.isArray(reply) ? reply : reply?.status === 'ok' ? reply.models : undefined;
        if (!Array.isArray(models))
            throw new Error('远程模型目录响应无效。');
        const seen = new Set([ACCOUNT_DEFAULT]);
        return models.map((model) => {
            if (!model || typeof model.value !== 'string' || !model.value
                || typeof model.displayName !== 'string' || !model.displayName
                || (model.description !== undefined && typeof model.description !== 'string')
                || seen.has(model.value))
                throw new Error('远程模型目录包含无效或重复项目。');
            seen.add(model.value);
            const efforts = model.supportedEffortLevels;
            if (efforts !== undefined && (!Array.isArray(efforts)
                || efforts.some(level => typeof level !== 'string' || !level)
                || new Set(efforts).size !== efforts.length)) {
                throw new Error('远程模型的推理强度目录无效。');
            }
            return {
                provider: CLAUDE_PROVIDER,
                id: model.value,
                name: model.displayName,
                ...(imageCapability(model).supported === true ? { inputModalities: ['text', 'image'] } : {}),
                ...(model.description === undefined ? {} : { description: model.description }),
                ...(efforts === undefined || efforts.length === 0 ? {} : {
                    reasoning: { efforts: efforts.map(id => ({ id, name: id })) },
                }),
            };
        });
    }
    async listModels(provider) {
        if (provider !== CLAUDE_PROVIDER)
            throw new Error('远程模型提供方无效。');
        const models = await this.models(true);
        const visible = new Set(models.map(model => model.id));
        const active = new Set();
        for (const session of this.ctx?.sessions?.list?.() ?? []) {
            if (session?.header?.agentPreset !== CLAUDE_PRESET)
                continue;
            const projected = this.ctx.sessionProjections.stateOf(session, 'modelSelection');
            const selected = projected?.pending ?? projected?.lastUsed ?? session.requestHeader?.()?.config;
            if (selected?.provider === CLAUDE_PROVIDER && typeof selected.model === 'string' && selected.model) {
                active.add(selected.model);
            }
        }
        const hiddenActive = [...active].filter(id => !visible.has(id));
        if (hiddenActive.length) {
            const full = await this.models();
            const byId = new Map([[ACCOUNT_DEFAULT, DEFAULT_MODEL], ...full.map(model => [model.id, model])]);
            for (const id of hiddenActive) {
                const model = byId.get(id);
                if (model)
                    models.push({ ...model, name: `${model.name}（已有会话使用中）` });
            }
        }
        return models.map(({ reasoning: _reasoning, ...model }) => model);
    }
    async resolveModel(provider, model) {
        if (provider !== CLAUDE_PROVIDER)
            throw new Error('远程模型提供方无效。');
        if (model === ACCOUNT_DEFAULT)
            return { ...DEFAULT_MODEL };
        const found = (await this.models()).find(item => item.id === model);
        if (!found)
            throw new Error('该远程模型不在当前账号的官方目录中。');
        return found;
    }
    async *stream() {
        throw new Error('远程会话只能由专属会话引擎执行。');
    }
}
/** This plugin deliberately registers no credentials or network endpoint. */
let ClaudeBridgeService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _status_decorators;
    let _saveConnection_decorators;
    let _clearConnection_decorators;
    let _planUsage_decorators;
    let _syncSession_decorators;
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
                AssistantStreamAccumulator, BlockAssembler,
            };
            this.backend = new BridgeBackend(ctx, config, { helpers });
            ctx.sessionProjections.register(createSessionStatusProjection(z));
            const backend = this.backend;
            const adapter = new ClaudeCatalogAdapter(backend, ctx);
            this.catalogAdapter = adapter;
            ctx.effect(() => {
                const removeWorkflowGuard = ctx.tools.guard(createWorkflowDepthGuard({
                    subagents: ctx.subagents, delegationDepthOf,
                }));
                const unregister = ctx.llm.registerAdapter([CLAUDE_PROVIDER], adapter);
                this.catalogRegistration = unregister;
                return async () => {
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
                    backend.sessionStatus({ session }, { phase: 'unknown', context: { status: 'unknown' }, toolMayHaveExecuted: true });
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
            return { ...status, remotePreset,
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
            const resolved = await this.ctx.get('sessionController').resolveAgent(sessionId);
            if (resolved?.error)
                throw resolved.error;
            const agent = resolved?.agent;
            if (!agent?.session)
                throw new RemoteError('claude-bridge/invalid-session', '无法解析会话智能体。', {});
            if (agent.session.header.agentPreset !== CLAUDE_PRESET)
                return { status: 'not-remote' };
            return this.backend.syncSession(agent);
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
            return { models: await this.catalogAdapter.models(true), selection: await this.backend.creationSelection() };
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
