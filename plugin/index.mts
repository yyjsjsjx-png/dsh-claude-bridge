/** DSH rc.5 Host service and catalog facade for the remote SDK engine. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  TypertRemoteService, Remote, RemoteError, principalOf,
  LlmAdapter, schema, resolveDshHome, credentialKey,
  renderPrompt, renderContextSections, joinContextSections, assembleContextFor,
  createAssistantMessage, createToolResultMessage, createSystemMessage,
  AssistantStreamAccumulator, BlockAssembler,
} from './compat/runtime.mjs';
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

const { delegationDepthOf } = await import(resolveDshModule('@deepseek-ai/dsh-subagent'));
const { z } = await import(resolveDshModule('zod'));
const { appendPluginRecord } = await import(resolveDshModule('@deepseek-ai/dsh-session'));
const nativeTitle = await Promise.resolve().then(() => {
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'));
  return import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-title')).href);
}).catch(() => undefined);
const hostCompatibility = await assertDshCompatibility();

/** Catalog only: all model calls belong to ClaudeLoopAgent, never LlmRuntime. */
export const ClaudeCatalogAdapter = createClaudeCatalogAdapter(LlmAdapter);

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
    this.backend = new BridgeBackend(ctx, config, { helpers, hostCompatibility });
    ctx.inject(['sessionTitle'], titleCtx => {
      titleCtx.effect(() => {
        const titles = installRemoteNativeTitles(titleCtx, { normalizeSessionTitle: nativeTitle?.normalizeSessionTitle,
          report: code => this.backend.diagnostics.event('title.sync', { code }) });
        const previous = this.backend.onSessionTitle;
        this.backend.onSessionTitle = titles.sync;
        return () => {
          if (this.backend.onSessionTitle === titles.sync) this.backend.onSessionTitle = previous;
          titles.dispose();
        };
      }, 'SDK 原生标题展示');
    });
    ctx.sessionProjections.register(createSessionStatusProjection(z));
    ctx.sessionProjections.register(createRunProgressProjection(z));
    ctx.sessionProjections.register(createResponseUsageProjection(z));
    ctx.sessionProjections.register(createResponseTimingProjection(z));
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
        try { unregister.replace([CLAUDE_PROVIDER]); }
        catch { ctx.logger.warn('远程模型目录刷新失败。'); }
      };
      return async () => {
        backend.onDisplayCatalogChanged = undefined;
        this.catalogRegistration = undefined;
        unregister();
        removeWorkflowGuard();
        if (typeof backend.dispose === 'function') await backend.dispose();
      };
    }, '远程会话桥接服务');
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
        backend.sessionStatus({ session }, { phase: 'unknown', toolMayHaveExecuted: true });
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
      throw new RemoteError('remote-access/denied', '仅本机所有者可管理远程会话连接。', {});
    }
  }

  @Remote('status')
  async status() {
    this.assertOwner();
    const status = await this.backend.status();
    const remotePreset = remotePresetStatus(this.ctx);
    const host = await assertDshCompatibility();
    return { ...status, remotePreset, host,
      desktopCompatibility: { version: host.version, verifiedVersions: ['0.2.1-rc.5'] },
      ...remotePresetFeatures(remotePreset) };
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
        if (Object.hasOwn(this.backend.state.value.sessions, sessionId)) return { status: 'read-only' };
      }
      throw resolved.error;
    }
    const agent = resolved?.agent;
    if (!agent?.session) throw new RemoteError('claude-bridge/invalid-session', '无法解析会话智能体。', {});
    if (agent.session.header.agentPreset !== CLAUDE_PRESET) return { status: 'not-remote' };
    return this.backend.syncSession(agent);
  }

  @Remote('recordClientTiming')
  async recordClientTiming(value) {
    this.assertOwner();
    this.clientTimingRecorder ??= createClientTimingRecorder({
      isRemoteSession: id => (this.ctx.sessions.get(id) ?? this.ctx.agents.get(id)?.session)
        ?.header.agentPreset === CLAUDE_PRESET,
      record: (event, fields) => this.backend.diagnostics.event(event, fields),
    });
    try { return this.clientTimingRecorder(value); }
    catch (error) {
      if (error.code === 'INVALID_CLIENT_TIMING') {
        throw new RemoteError('claude-bridge/invalid-client-timing', '客户端耗时诊断格式无效。', {});
      }
      throw error;
    }
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
    return { models: await this.catalogAdapter.models(true), selection: await this.backend.creationSelection(),
      modelEfforts: await this.backend.modelEffortPreferences() };
  }

  @Remote('saveModelPreferences')
  async saveModelPreferences(value) {
    this.assertOwner();
    await this.backend.saveModelPreferences(value);
    this.catalogRegistration?.replace?.([CLAUDE_PROVIDER]);
    return { saved: true };
  }

  @Remote('saveContextPreferences')
  async saveContextPreferences(value) {
    this.assertOwner();
    return this.backend.saveContextPreferences(value);
  }
}

export default ClaudeBridgeService;
