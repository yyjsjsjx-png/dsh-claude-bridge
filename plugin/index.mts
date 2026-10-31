/** DSH rc.5 Host service and catalog facade for the remote SDK engine. */
import {
  TypertRemoteService, Remote, RemoteError, principalOf,
  LlmAdapter, schema, resolveDshHome, credentialKey,
  renderPrompt, renderContextSections, joinContextSections, assembleContextFor,
  createAssistantMessage, createToolResultMessage, createSystemMessage,
  AssistantStreamAccumulator, BlockAssembler,
} from './compat/runtime.mjs';
import { BridgeBackend } from '../src/backend.mjs';
import { CLAUDE_PRESET, CLAUDE_PROVIDER } from './policy.mjs';
import { REMOTE_PRESET_CONVERSIONS, REMOTE_PRESET_LIMITATIONS } from './preset.mjs';
import { resolveDshModule } from './compat/resolve-dsh-module.mjs';
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
  name: '远程 Claude（账号默认）',
  description: '由远程 Claude 账号选择默认模型。',
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
    return { id: provider, name: '远程 Claude' };
  }

  async models(visible = false) {
    const method = visible ? this.backend.visibleCatalog : this.backend.catalog;
    if (typeof method !== 'function') throw new Error('远程 Claude 模型目录服务尚未就绪。');
    let reply;
    try {
      reply = await method.call(this.backend);
    } catch (error) {
      if (NO_CONFIGURATION.has(error?.code)) return [];
      throw error;
    }
    const models = Array.isArray(reply) ? reply : reply?.status === 'ok' ? reply.models : undefined;
    if (!Array.isArray(models)) throw new Error('远程 Claude 模型目录响应无效。');
    const seen = new Set([ACCOUNT_DEFAULT]);
    return models.map((model) => {
      if (!model || typeof model.value !== 'string' || !model.value
        || typeof model.displayName !== 'string' || !model.displayName
        || (model.description !== undefined && typeof model.description !== 'string')
        || seen.has(model.value)) throw new Error('远程 Claude 模型目录包含无效或重复项目。');
      seen.add(model.value);
      const efforts = model.supportedEffortLevels;
      if (efforts !== undefined && (!Array.isArray(efforts)
        || efforts.some(level => typeof level !== 'string' || !level)
        || new Set(efforts).size !== efforts.length)) {
        throw new Error('远程 Claude 模型的推理强度目录无效。');
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
    if (provider !== CLAUDE_PROVIDER) throw new Error('远程 Claude 提供方无效。');
    const models = await this.models(true);
    const visible = new Set(models.map(model => model.id));
    const active = new Set();
    for (const session of this.ctx?.sessions?.list?.() ?? []) {
      if (session?.header?.agentPreset !== CLAUDE_PRESET) continue;
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
        if (model) models.push({ ...model, name: `${model.name}（已有会话使用中）` });
      }
    }
    return models.map(({ reasoning: _reasoning, ...model }) => model);
  }

  async resolveModel(provider, model) {
    if (provider !== CLAUDE_PROVIDER) throw new Error('远程 Claude 提供方无效。');
    if (model === ACCOUNT_DEFAULT) return { ...DEFAULT_MODEL };
    const found = (await this.models()).find(item => item.id === model);
    if (!found) throw new Error('该远程 Claude 模型不在当前账号的官方目录中。');
    return found;
  }

  async *stream() {
    throw new Error('远程 Claude 只能由专属会话引擎执行。');
  }
}

/** This plugin deliberately registers no credentials or network endpoint. */
export class ClaudeBridgeService extends TypertRemoteService {
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
        if (typeof backend.dispose === 'function') await backend.dispose();
      };
    }, '远程 Claude 桥接服务');
    const refreshActiveModels = session => {
      if (session?.header?.agentPreset === CLAUDE_PRESET) {
        try { this.catalogRegistration?.replace?.([CLAUDE_PROVIDER]); }
        catch { ctx.logger.warn('远程模型目录刷新失败。'); }
      }
    };
    ctx.on('session/created', refreshActiveModels);
    ctx.on('session/disposed', refreshActiveModels);
    ctx.on('session/event', (session, event) => {
      if (event?.type === 'model/selection' || event?.type === 'request/header') refreshActiveModels(session);
    });
    const reconcileStatus = session => {
      if (session?.header?.agentPreset !== CLAUDE_PRESET) return;
      const previous = ctx.sessionProjections.stateOf(session, 'claudeBridge');
      if (['running', 'compacting', 'stopping'].includes(previous?.phase)
        && ![...backend.runs.values()].some(run => run.agent.session === session)) {
        backend.sessionStatus({ session }, { phase: 'unknown', context: { status: 'unknown' }, toolMayHaveExecuted: true });
      }
    };
    ctx.on('session/created', reconcileStatus);
    for (const session of ctx.sessions.list()) reconcileStatus(session);
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
      throw new RemoteError('remote-access/denied', '仅本机所有者可管理远程 Claude 连接。', {});
    }
  }

  @Remote('status')
  async status() {
    this.assertOwner();
    const status = await this.backend.status();
    return { ...status,
      disabledFeatures: REMOTE_PRESET_LIMITATIONS.map(entry => ({ ...entry })),
      convertedFeatures: REMOTE_PRESET_CONVERSIONS.map(entry => ({ ...entry })) };
  }

  @Remote('saveConnection')
  async saveConnection(value) {
    this.assertOwner();
    const result = await this.backend.saveConnection(value);
    this.catalogRegistration?.replace?.([CLAUDE_PROVIDER]);
    return { url: result.url, configured: result.configured, status: result.status };
  }

  @Remote('clearConnection')
  async clearConnection() {
    this.assertOwner();
    const result = await this.backend.clearConnection();
    this.catalogRegistration?.replace?.([CLAUDE_PROVIDER]);
    return { configured: result.configured, status: result.status };
  }

  @Remote('planUsage')
  async planUsage(refresh) {
    this.assertOwner();
    return this.backend.planUsage(refresh);
  }

  @Remote('syncSession')
  async syncSession(sessionId) {
    this.assertOwner();
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 160) {
      throw new RemoteError('claude-bridge/invalid-session', '会话标识无效。', {});
    }
    const resolved = await this.ctx.get('sessionController').resolveAgent(sessionId);
    if (resolved?.error) throw resolved.error;
    const agent = resolved?.agent;
    if (!agent?.session) throw new RemoteError('claude-bridge/invalid-session', '无法解析会话智能体。', {});
    if (agent.session.header.agentPreset !== CLAUDE_PRESET) return { status: 'not-remote' };
    return this.backend.syncSession(agent);
  }

  @Remote('refreshCatalog')
  async refreshCatalog() {
    this.assertOwner();
    const result = await this.backend.catalog({ refresh: true });
    this.catalogRegistration?.replace?.([CLAUDE_PROVIDER]);
    return result;
  }

  @Remote('modelPreferences')
  async modelPreferences() {
    this.assertOwner();
    return this.backend.listModelPreferences();
  }

  @Remote('visibleModels')
  async visibleModels() {
    this.assertOwner();
    return { models: await this.catalogAdapter.models(true), selection: await this.backend.creationSelection() };
  }

  @Remote('saveModelPreferences')
  async saveModelPreferences(value) {
    this.assertOwner();
    await this.backend.saveModelPreferences(value);
    this.catalogRegistration?.replace?.([CLAUDE_PROVIDER]);
    return { saved: true };
  }
}

export default ClaudeBridgeService;
