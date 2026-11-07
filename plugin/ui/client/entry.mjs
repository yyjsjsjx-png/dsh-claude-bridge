/** DSH wiring: mount RPC first, then create one controller set per child scope. */
export function createClient({ React, z, createPortal, useAnchoredPosition, useDismissOnOutsidePointer, MarkdownText,
  createStore, textError, createSettingsController, createModelController, createQuotaController,
  createPickerController, createMeterViews, createFormViews, createUsageProjectionBridge, createClientReceiveTiming,
  createCompactionHistory, createCompactionSummaryRules, createModelRouteDisplay }) {
const exports = {};
const ABSENT_STATUS = Object.freeze({ getSnapshot: () => undefined, subscribe: () => () => {} });

// Interpret display-only repairs through the installed native renderers. They
// retain their original Step without changing the native model/tool journal.
exports.installTranscriptOrder = function installTranscriptOrder(ctx) {
  const registry = ctx.uiConversation.events;
  if (!registry || !['entries', 'subscribe', 'refresh', 'forEvent'].every(name => typeof registry[name] === 'function')) {
    throw new Error('远程会话插件无法加载：DSH 对话排序接口不兼容。');
  }
  const repairs = {
    'plugin:claude-bridge/history-assistant': 'assistant/message',
    'plugin:claude-bridge/history-tool-result': 'tool/result',
  };
  const eventView = event => repairs[event.type] && event.ignorable === true
    ? { ...event, type: repairs[event.type], surfaceOp: 'append' } : event;
  const matchView = match => match && eventView(match.event) !== match.event
    ? { ...match, event: eventView(match.event) } : match;
  const contextView = context => context.matches.some(match => repairs[match.event.type])
    ? { ...context, start: matchView(context.start), matches: context.matches.map(matchView) } : context;
  const installed = new Map();
  const originalForEvent = registry.forEvent;
  const wrappedForEvent = function(type) {
    const routes = originalForEvent.call(this, repairs[type] ?? type);
    const kinds = repairs[type] === 'assistant/message' ? ['assistant-step', 'process-evidence']
      : ['tool-call', 'process-evidence'];
    return repairs[type] ? new Set([...routes].filter(route => kinds.includes(route.definition.kind)).map(({ definition, match }) => ({
      definition, match: event => match(eventView(event)),
    }))) : routes;
  };
  registry.forEvent = wrappedForEvent;
  const reconcile = () => {
    let changed = false;
    for (const definition of registry.entries()) {
      if (!['assistant-step', 'tool-call', 'process-evidence'].includes(definition.kind) || installed.has(definition)) continue;
      if (typeof definition.update !== 'function' || definition.kind !== 'process-evidence'
        && typeof definition.buildViewNode !== 'function') {
        throw new Error('远程会话插件无法加载：DSH 消息展示接口不兼容。');
      }
      const methods = new Map();
      for (const name of ['start', 'update', 'buildViewNode', 'buildLocationData', 'publication']) {
        const original = definition[name];
        if (typeof original !== 'function') continue;
        const wrapped = function(context, ...args) {
          if (name === 'publication') return original.call(this, matchView(context), ...args);
          context = contextView(context);
          const result = original.call(this, context, ...(['start', 'update'].includes(name)
            ? args.map((arg, index) => index === 0 ? matchView(arg) : arg) : args));
          if (name !== 'buildViewNode' || definition.kind !== 'assistant-step' || !result
            || !context.matches.some(({ event }) => event.type === 'assistant/message'
              && (event.data.message.source?.provider === 'claude-sdk-remote'
                || event.data.message.id?.startsWith('claude-sdk:')))) return result;
          const process = result.location?.kind === 'step' ? result.location.turn.data.get('turn-process') : undefined;
          // The native answer boundary also controls whole-turn disclosure. Moving
          // its answer before that boundary hides both the reply and its toggle.
          if (process?.answerStep === result.data.step && Number.isFinite(process.answerAnchorSeq)) {
            return result.anchorSeq >= process.answerAnchorSeq ? result : { ...result, anchorSeq: process.answerAnchorSeq };
          }
          const start = context.start?.event.type === 'step/start' ? context.start.event
            : result.location?.kind === 'step' ? result.location.step.start : undefined;
          // A real message or stream owns its chronological position. Moving it
          // back to step/start could cross a preceding SDK compaction boundary.
          // Only a display repair without original evidence needs that fallback.
          const first = context.matches.find(({ event }) => event.type === 'assistant/message'
            && event.ignorable !== true);
          const streamed = context.matches.some(({ event }) => event.type === 'assistant/live-chunk');
          const anchor = first ? Math.min(result.anchorSeq, first.event.seq)
            : streamed ? result.anchorSeq : start ? start.seq + 0.25 : result.anchorSeq;
          return Number.isFinite(anchor) && result.anchorSeq !== anchor ? { ...result, anchorSeq: anchor } : result;
        };
        definition[name] = wrapped;
        methods.set(name, { original, wrapped });
      }
      installed.set(definition, methods);
      changed = true;
    }
    if (changed) registry.refresh();
  };
  const unsubscribe = registry.subscribe(reconcile);
  reconcile();
  return () => {
    unsubscribe();
    for (const [definition, methods] of installed) {
      for (const [name, { original, wrapped }] of methods) if (definition[name] === wrapped) definition[name] = original;
    }
    if (registry.forEvent === wrappedForEvent) registry.forEvent = originalForEvent;
    installed.clear();
    registry.refresh();
  };
};

exports.inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'remote', 'remote.session'];
exports.installUsageProjection = createUsageProjectionBridge({ React, getClientTiming: () => exports.clientReceiveTiming });

exports.apply = async function apply(ctx) {
  const installModelRoute = createModelRouteDisplay({ React });
  ctx.inject(['uiConversation'], ctx => {
    if (ctx.uiConversation) ctx.effect(() => installModelRoute(ctx), '远程会话模型路由显示');
    if (ctx.uiConversation) ctx.effect(() => exports.installTranscriptOrder(ctx), '远程会话对话排序');
    if (ctx.uiConversation) ctx.effect(() => createCompactionHistory({ React, MarkdownText,
      summaryRules: createCompactionSummaryRules() })(ctx), '远程会话压缩记录');
  });
  const json = { mode: 'src-json' };
  const descriptor = (method, parameters = []) => ({
    id: `dsh-claude-bridge-ui#claudeBridge/${method}`, service: 'claudeBridge',
    namespace: 'claudeBridge', method, invocation: { kind: 'direct' }, parameters, result: json,
  });
  const disposeRemote = await ctx.remote.$mount({ package: 'dsh-claude-bridge-ui', descriptors: [
    descriptor('status'),
    descriptor('modelRequestStats', [{ name: 'value', wire: 'value', source: 'json', codec: {
      mode: 'strict', typeSymbol: 'dsh-claude-bridge-ui#ModelRequestStats',
      create: () => z.object({ sessionId: z.string().min(1).max(160), offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional() }).strict(),
    } }]),
    descriptor('recordClientTiming', [{ name: 'value', wire: 'value', source: 'json', codec: {
      mode: 'strict', typeSymbol: 'dsh-claude-bridge-ui#ClientTiming',
      create: () => z.object({ version: z.literal(1), requestId: z.string().min(1).max(160),
        sessionId: z.string().min(1).max(160), metric: z.enum(['submission', 'first-output']),
        quality: z.enum(['precise', 'unknown']), durationMs: z.number().finite().min(0).max(1800000).optional(),
        reason: z.enum(['BACKGROUND', 'QUEUED', 'STEERING', 'OVERLAPPING_SUBMISSION', 'HISTORY_REPLACED',
          'STREAM_REBASELINE', 'SUBMISSION_FAILED', 'TURN_ENDED_WITHOUT_OUTPUT', 'SESSION_DISPOSED',
          'OBSERVER_DISPOSED', 'TIMING_TIMEOUT', 'TIMING_UNAVAILABLE', 'REQUEST_UNCORRELATED',
          'REMOTE_SESSION_CHANGED']).optional(),
        condition: z.enum(['foreground', 'background', 'queued', 'steering']),
        source: z.literal('client-session-receive'), clock: z.literal('client-monotonic') }).strict(),
    } }]),
    descriptor('planUsage', [{ name: 'refresh', wire: 'refresh', source: 'json', codec: {
      mode: 'strict', typeSymbol: 'dsh-claude-bridge-ui#RefreshPlanUsage', create: () => z.boolean(),
    } }]),
    descriptor('syncSession', [{ name: 'sessionId', wire: 'sessionId', source: 'json', codec: {
      mode: 'strict', typeSymbol: 'dsh-claude-bridge-ui#SyncSession', create: () => z.string().min(1).max(160),
    } }]),
    descriptor('saveConnection', [{ name: 'value', wire: 'value', source: 'json', codec: {
      mode: 'strict', typeSymbol: 'dsh-claude-bridge-ui#Connection',
      create: () => z.object({ url: z.string(), token: z.string().optional() }),
    } }]),
    descriptor('clearConnection'),
    descriptor('refreshCatalog'),
    descriptor('modelPreferences'),
    descriptor('visibleModels'),
    descriptor('saveModelPreferences', [{ name: 'value', wire: 'value', source: 'json', codec: {
      mode: 'strict', typeSymbol: 'dsh-claude-bridge-ui#ModelPreferences',
      create: () => z.object({ enabledIds: z.array(z.string().min(1)) }),
    } }]),
    descriptor('saveContextPreferences', [{ name: 'value', wire: 'value', source: 'json', codec: {
      mode: 'strict', typeSymbol: 'dsh-claude-bridge-ui#ContextPreferences',
      create: () => z.object({ autoCompactWindowTokens: z.number().int().min(100000).max(1000000).nullable(),
        promptCacheTtl: z.enum(['5m', '1h']).optional(), webToolProvider: z.enum(['claude', 'dsh']).optional() }),
    } }]),
  ] });
  // This namespace is created by the mount above, so declaring it in the
  // outer inject list would deadlock. Its child scope owns every UI closure.
  ctx.inject(['remote.claudeBridge'], (ctx) => {
  const rpc = ctx.remote.claudeBridge;
  if (typeof createClientReceiveTiming === 'function') ctx.effect(() => {
    const timing = createClientReceiveTiming({ report: row => rpc.recordClientTiming(row) });
    exports.clientReceiveTiming = timing;
    timing.install(ctx.sessions);
    return () => { timing.dispose(); if (exports.clientReceiveTiming === timing) delete exports.clientReceiveTiming; };
  }, '远程会话客户端接收计时');
  ctx.effect(() => exports.installUsageProjection(ctx), '远程会话用量展示');
  const settings = createSettingsController({ rpc, createStore, textError, createModelController,
    onConnectionChange: () => { quota.reset(); picker.close(); } });
  const quota = createQuotaController({ rpc, createStore,
    isBusy: () => settings.store.getSnapshot().busy,
    onAuthenticationRequired: settings.authenticationRequired });
  const picker = createPickerController({ rpc, workspaces: ctx.workspaces, sessions: ctx.sessions,
    uiWorkspace: ctx.uiWorkspace, createStore, textError });
  const { SessionMeter, QuotaMeter, SessionModelBadge } = createMeterViews({ React, createPortal,
    useAnchoredPosition, useDismissOnOutsidePointer });
  const { MenuItem, HeroButton, Picker, Settings } = createFormViews({ React });
  const historyTasks = new Map();
  async function synchronize(sessionId) {
    if (historyTasks.has(sessionId)) return historyTasks.get(sessionId);
    const task = (async () => {
      const reply = await ctx.remote.claudeBridge.syncSession(sessionId);
      if (!reply.ok) return { status: 'unavailable' };
      return reply.value;
    })();
    historyTasks.set(sessionId, task);
    try { return await task; }
    finally { if (historyTasks.get(sessionId) === task) historyTasks.delete(sessionId); }
  }

  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item', id: 'dsh-claude-new-session', order: 250,
    inject: () => ({ show: picker.open }),
  }, MenuItem));
  // The hero also covers empty sessions without an action menu.
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options', id: 'dsh-claude-new-session', order: 100,
    inject: sessionId => ({ show: () => picker.open(sessionId) }),
  }, HeroButton));
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'dsh-claude-context', order: 100,
    inject: sessionId => ({ hooks: { bridgeStatus:
      ctx.sessions.binding?.(sessionId)?.session.projections.faceOf('claudeBridge') ?? ABSENT_STATUS,
      bridgeProgress: ctx.sessions.binding?.(sessionId)?.session.projections.faceOf('claudeBridgeProgress') ?? ABSENT_STATUS },
      syncSession: () => synchronize(sessionId) }),
  }, SessionMeter));
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'dsh-claude-quota', order: 110,
    inject: sessionId => ({ hooks: { bridgeStatus:
      ctx.sessions.binding?.(sessionId)?.session.projections.faceOf('claudeBridge') ?? ABSENT_STATUS,
      quota: quota.store }, readQuota: quota.readPlanUsage }),
  }, QuotaMeter));
  // Both full and embedded child pages render this same native dock. Read the
  // pane's standard Session hooks rather than looking up a root binding.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'dsh-claude-child-model', order: 90,
    inject: sessionId => {
      let directory;
      try { directory = ctx.get?.('modelDirectories')?.directoryFor(sessionId).store; } catch {}
      return { sessionId, hooks: { modelDirectory: directory ?? ABSENT_STATUS } };
    },
  }, SessionModelBadge));
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'dsh-claude-model-route', order: 95,
    inject: sessionId => ({ sessionId }),
  }, installModelRoute.Marker));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'dsh-claude-session-picker',
    inject: () => ({ hooks: { dialog: picker.store }, dismiss: picker.close,
      chooseModel: picker.selectModel, chooseEffort: picker.selectEffort, submit: picker.create }),
  }, Picker));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'dsh-claude-bridge', order: 15, label: '远程会话',
    inject: () => ({ hooks: { settings: settings.store }, editUrl: settings.editUrl,
      save: settings.saveConnection, clear: settings.clearConnection,
      refresh: settings.models.refreshCatalog, refreshStatus: settings.readStatus,
      loadModels: settings.models.loadModelPreferences, toggleVisibleModel: settings.models.toggleModel,
      saveModels: settings.models.saveModelPreferences, editContextMode: settings.editContextMode,
      editContextWindow: settings.editContextWindow, editPromptCacheTtl: settings.editPromptCacheTtl,
      editWebToolProvider: settings.editWebToolProvider, saveContext: settings.saveContextPreferences }),
  }, Settings));
  void settings.readStatus();
  ctx.effect(() => () => { settings.dispose(); quota.dispose(); picker.dispose(); }, '远程会话界面状态');
  });
  return disposeRemote;
};
return exports;
}
