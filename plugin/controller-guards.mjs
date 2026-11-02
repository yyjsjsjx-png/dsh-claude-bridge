/** rc.5 controller wrappers. They act before the upstream mutating methods. */
import {
  CLAUDE_PRESET, CLAUDE_PROVIDER, EnginePolicyError, planSessionCreation, decodeRemoteCreationSelection,
  assertModelForPreset, assertPresetUnchanged,
} from './policy.mjs';

function remoteFailure(RemoteError, code, message, data = {}) {
  return new RemoteError(code, message, data);
}

function policyFailure(RemoteError, error, sessionId) {
  if (!(error instanceof EnginePolicyError)) throw error;
  throw remoteFailure(RemoteError, 'agent-preset/locked', error.message,
    sessionId === undefined ? {} : { sessionId });
}

function checkedPreset(RemoteError, session, projected) {
  const original = session?.header?.agentPreset;
  if (typeof original !== 'string' || !original || typeof projected !== 'string' || !projected
    || (original === CLAUDE_PRESET) !== (projected === CLAUDE_PRESET)) {
    throw remoteFailure(RemoteError, 'agent-preset/locked',
      '会话创建预设与当前预设不一致，不能继续操作。', { sessionId: session?.id });
  }
  return projected;
}

async function attachedAgent(controller, sessionId) {
  const result = await controller.resolveAgent(sessionId);
  if (result?.error) throw result.error;
  if (!result?.agent?.session) throw new Error('无法解析会话智能体。');
  return result.agent;
}

function presetForAgent(ctx, RemoteError, agent) {
  return checkedPreset(RemoteError, agent.session,
    ctx.sessionProjections.stateOf(agent.session, 'agentPreset'));
}

/** Read a preset without exposing or logging the session transcript. */
async function existingPreset(ctx, RemoteError, sessionId) {
  const attached = ctx.sessions.get(sessionId);
  if (attached) return checkedPreset(RemoteError, attached,
    ctx.sessionProjections.stateOf(attached, 'agentPreset'));
  let observation;
  try {
    observation = await ctx.sessionQuery.observeSession(sessionId);
  } catch (error) {
    if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return undefined;
    throw error;
  }
  try {
    return checkedPreset(RemoteError, { id: sessionId, header: observation.header },
      observation.projections?.values?.agentPreset);
  } finally {
    if (typeof observation[Symbol.asyncDispose] === 'function') await observation[Symbol.asyncDispose]();
    else observation[Symbol.dispose]?.();
  }
}

/** Restore a named remote blank without allowing upstream create to mint a new unselected Session. */
async function restoreRemoteBlank(controller, ctx, RemoteError, input) {
  const sessionId = input.sessionId;
  if (sessionId === undefined) {
    throw remoteFailure(RemoteError, 'session/model-unavailable', '创建远程会话前必须选择模型。');
  }
  if (input.workspaceId !== undefined && input.cwd !== undefined) {
    throw remoteFailure(RemoteError, 'gateway/bad-request', '工作区和目录不能同时指定。');
  }
  const workspace = input.workspaceId === undefined ? undefined : ctx.workspaceRegistry.get(input.workspaceId);
  if (input.workspaceId !== undefined && workspace === undefined) {
    throw remoteFailure(RemoteError, 'workspace/not-found', '无法找到指定工作区。', { workspaceId: input.workspaceId });
  }
  if (ctx.workspaceRegistry.archivedSessionIds.includes(sessionId)
    || (workspace !== undefined && !workspace.sessionIds.includes(sessionId))) {
    throw remoteFailure(RemoteError, 'session/model-unavailable', '原会话已归档或不属于该工作区，不能恢复为空白会话。', { sessionId });
  }
  const agent = await attachedAgent(controller, sessionId);
  if (presetForAgent(ctx, RemoteError, agent) !== CLAUDE_PRESET) {
    throw remoteFailure(RemoteError, 'agent-preset/locked', '原会话不是远程会话。', { sessionId });
  }
  const cwd = workspace?.path ?? input.cwd;
  if (cwd !== undefined && agent.session.header.cwd !== cwd) {
    throw remoteFailure(RemoteError, 'session/model-unavailable', '原会话的工作目录与当前工作区不一致。', { sessionId });
  }
  const boundary = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary');
  if (boundary !== undefined && (boundary.openTurnStartSeq !== null || boundary.lastTurn !== 0)) {
    throw remoteFailure(RemoteError, 'session/model-unavailable', '该会话已开始，不能作为新建会话复用。', { sessionId });
  }
  const state = ctx.sessionProjections.stateOf(agent.session, 'modelSelection');
  const selection = state?.pending ?? state?.lastUsed;
  try { assertModelForPreset(CLAUDE_PRESET, selection); }
  catch (error) {
    if (!(error instanceof EnginePolicyError)) throw error;
    throw remoteFailure(RemoteError, 'session/model-unavailable', '原远程会话没有有效的已选模型，不能恢复。', { sessionId });
  }
  return { sessionId, agentPreset: CLAUDE_PRESET };
}

/** Preserve every upstream Session API while guarding the public mutators. */
export function makeGuardedSessionController(Base, RemoteError) {
  return class GuardedSessionController extends Base {
    static inject = [...new Set([...(Base.inject ?? []), 'agentPresets'])];

    constructor(ctx, config, ...rest) {
      super(ctx, config, ...rest);
      this.bridgeContext = ctx;
    }

    async create(request) {
      const ctx = this.bridgeContext;
      const { initialModel: suppliedModel, ...input } = request;
      let encodedModel;
      try { encodedModel = decodeRemoteCreationSelection(input.agentPreset); }
      catch (error) { policyFailure(RemoteError, error); }
      if (encodedModel !== undefined && suppliedModel !== undefined) {
        throw remoteFailure(RemoteError, 'gateway/bad-request', '创建会话的模型选择重复。');
      }
      const initialModel = encodedModel ?? suppliedModel;
      let target = input.agentPreset ?? ctx.agentPresets.defaultId;
      if (initialModel !== undefined) {
        let plan;
        try {
          plan = planSessionCreation({ selection: initialModel, requestedPreset: input.agentPreset,
            defaultPreset: ctx.agentPresets.defaultId });
        } catch (error) { policyFailure(RemoteError, error); }
        target = plan.preset;
        // Check catalog and call controls before creating or reusing a session.
        const models = await ctx.llm.listModels(plan.initialModel.provider);
        if (!models.some(model => model.id === plan.initialModel.model)) {
          throw remoteFailure(RemoteError, 'session/model-unavailable', '所选模型不在当前目录中。');
        }
        await ctx.llm.resolveCallConfig(plan.initialModel);
      } else if (target === CLAUDE_PRESET) {
        return restoreRemoteBlank(this, ctx, RemoteError, input);
      } else if (ctx.agentDefaultModel.currentSelection().provider === CLAUDE_PROVIDER) {
        // Older bridge versions saved remote selections as DSH's global default.
        // Refuse before minting a standard Session with a remote model.
        throw remoteFailure(RemoteError, 'session/model-unavailable',
          '当前默认模型为远程会话，请通过“新建远程会话”创建会话；普通 DSH 会话请选择普通模型。');
      }

      // The rc.5 upstream can recompose an existing *cold* blank session in
      // create(), bypassing select(). Remote engine transitions stay guarded;
      // ordinary blank recomposition belongs to the native controller.
      if (input.sessionId !== undefined) {
        const current = await existingPreset(ctx, RemoteError, input.sessionId);
        if ((current === CLAUDE_PRESET || target === CLAUDE_PRESET) && current !== target) delete input.sessionId;
      }
      const created = await super.create({ ...input, agentPreset: target });
      if (target === CLAUDE_PRESET && created.agentPreset !== target) {
        throw remoteFailure(RemoteError, 'agent-preset/locked', '创建结果的会话预设不一致。',
          { sessionId: created.sessionId });
      }
      if (initialModel !== undefined) {
        try {
          await this.selectModel({ sessionId: created.sessionId, ...initialModel,
            // Creation carries an explicit choice, including model default.
            // This own undefined value stays inside the Host, outside RPC codecs.
            ...(initialModel.provider === CLAUDE_PROVIDER ? { reasoningEffort: initialModel.reasoningEffort } : {}) });
        } catch (error) {
          // The upstream has already published this identity; never imply it
          // was rolled back, or silently use a different model.
          throw remoteFailure(RemoteError, 'session/model-unavailable',
            '会话已创建，但初始模型未能写入；请检查模型或新建会话。', { sessionId: created.sessionId });
        }
      }
      return created;
    }

    async selectModel(request) {
      const agent = await attachedAgent(this, request.sessionId);
      const preset = presetForAgent(this.bridgeContext, RemoteError, agent);
      try { assertModelForPreset(preset, request); }
      catch (error) { policyFailure(RemoteError, error, request.sessionId); }
      const backend = preset === CLAUDE_PRESET ? this.bridgeContext.get?.('claudeBridge')?.backend : undefined;
      if (typeof backend?.applyModelEffortPreference === 'function') {
        const state = this.bridgeContext.sessionProjections.stateOf(agent.session, 'modelSelection');
        const current = state?.pending ?? state?.lastUsed ?? agent.session.requestHeader?.()?.config;
        request = { ...request, ...await backend.applyModelEffortPreference(request, current) };
      }
      const selected = await super.selectModel(request);
      if (preset === CLAUDE_PRESET) {
        try { await backend?.rememberCreationSelection(selected.selected); }
        catch { this.bridgeContext.logger?.warn('上次模型选择保存失败，下次新建时请重新选择。'); }
      }
      return selected;
    }

    async prompt(request, signal) {
      const ctx = this.bridgeContext;
      const agent = await attachedAgent(this, request.sessionId);
      const preset = presetForAgent(ctx, RemoteError, agent);
      const state = ctx.sessionProjections.stateOf(agent.session, 'modelSelection');
      if (state === undefined) throw new Error('模型选择投影尚未就绪。');
      const header = agent.session.requestHeader();
      const selection = state.pending ?? header?.config ?? ctx.agentDefaultModel.currentSelection();
      if (preset === CLAUDE_PRESET && state.pending === null && header === undefined) {
        throw remoteFailure(RemoteError, 'session/model-unavailable', '远程会话尚未记录初始模型。',
          { sessionId: request.sessionId });
      }
      try { assertModelForPreset(preset, selection); }
      catch (error) { policyFailure(RemoteError, error, request.sessionId); }
      return super.prompt(request, signal);
    }

    async fork(request) {
      const agent = await attachedAgent(this, request.sessionId);
      if (presetForAgent(this.bridgeContext, RemoteError, agent) === CLAUDE_PRESET) {
        throw remoteFailure(RemoteError, 'session/fork-unavailable',
          '远程会话不支持分叉，请新建会话。', { sessionId: request.sessionId });
      }
      return super.fork(request);
    }
  };
}

/** Guard remote engine boundaries; ordinary preset selection stays native. */
export function makeLockedPresetRegistry(Base, RemoteError) {
  return class LockedPresetRegistry extends Base {
    constructor(ctx, config, ...rest) {
      super(ctx, config, ...rest);
      this.bridgeContext = ctx;
    }

    async select(agent, agentPreset) {
      const current = presetForAgent(this.bridgeContext, RemoteError, agent);
      if (current !== CLAUDE_PRESET && agentPreset !== CLAUDE_PRESET) return super.select(agent, agentPreset);
      try { assertPresetUnchanged(current, agentPreset); }
      catch (error) { policyFailure(RemoteError, error, agent.id); }
      // Re-selecting the same preset is a no-op; do not recompose or append.
      return current;
    }
  };
}

/** Attach policies without replacing the native Services or their browser graph. */
export function installControllerGuards(ctx, RemoteError) {
  const restorers = [];
  const install = (target, makeGuarded, names) => {
    class Delegate {}
    for (const name of names) {
      let owner = target, descriptor;
      while (owner && !(descriptor = Object.getOwnPropertyDescriptor(owner, name))) owner = Object.getPrototypeOf(owner);
      if (typeof descriptor?.value !== 'function') {
        throw new Error(`远程会话插件无法加载：DSH ${name}() 接口不兼容。`);
      }
      Object.defineProperty(Delegate.prototype, name, { value: descriptor.value });
    }
    const guarded = makeGuarded(Delegate, RemoteError).prototype;
    for (const [name, value] of [['bridgeContext', ctx], ...names.map(name => [name, guarded[name]])]) {
      const previous = Object.getOwnPropertyDescriptor(target, name);
      Object.defineProperty(target, name, { value, configurable: true, writable: true });
      restorers.push(() => {
        if (Object.getOwnPropertyDescriptor(target, name)?.value !== value) return;
        if (previous) Object.defineProperty(target, name, previous);
        else delete target[name];
      });
    }
  };
  const dispose = () => { for (const restore of restorers.splice(0).reverse()) restore(); };
  try {
    // The native selector writes the global default asynchronously. Keep that
    // native path for ordinary models; remote choices have separate storage.
    install(ctx.agentDefaultModel, Base => class extends Base {
      async saveSelection(selection) {
        if (selection.provider === CLAUDE_PROVIDER) return;
        return super.saveSelection(selection);
      }
    }, ['saveSelection']);
    install(ctx.sessionController, makeGuardedSessionController, ['create', 'selectModel', 'prompt', 'fork']);
    install(ctx.agentPresets, makeLockedPresetRegistry, ['select']);
    return dispose;
  } catch (error) { dispose(); throw error; }
}
