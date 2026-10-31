/* DSH rc.5 client bundle: register one lazy factory with the existing shell. */
window.__ModuleLoader__.load({ id: 'dsh-claude-bridge-ui', factory: (require) => {
const module = { exports: {} };
const exports = module.exports;
const React = require('react');
const { createPortal } = require('react-dom');
const { useAnchoredPosition, useDismissOnOutsidePointer } = require('@deepseek-ai/dsh-client-ui-primitives');
const { z } = require('zod');

const REMOTE_CREATE_PREFIX = 'claude-sdk-remote+model-v1:';
const EMPTY = Object.freeze({ open: false, loading: false, busy: false,
  workspaceId: undefined, models: [], model: '', effort: '', error: '' });
const ABSENT_STATUS = Object.freeze({ getSnapshot: () => undefined, subscribe: () => () => {} });
const CONTEXT_GROUPS = [
  { name: '系统与指令', color: 'var(--dsw-static-neutral-bluish-400, #aeb4bd)',
    ids: ['system_prompt', 'mcp_instructions', 'memory_files', 'custom_agents', 'skills'] },
  { name: '工具定义', color: 'rgb(167, 139, 250)',
    ids: ['system_tools', 'mcp_tools', 'system_tools_deferred', 'mcp_tools_deferred'] },
  { name: '对话消息', color: 'var(--dsw-static-blue-450, #4e8cff)', ids: ['messages'] },
];
const METER_CSS = `
.dsh-claude-meter { display:inline-flex; align-items:center; gap:8px; flex:none;
  color:var(--dsw-alias-label-tertiary, #858992); font-size:var(--dsh-content-font-size-secondary, 13px); }
.dsh-claude-meter-trigger { display:inline-flex; align-items:center; gap:6px; flex:none;
  padding:1px 8px; border:0; border-radius:var(--dsw-radius-sm, 6px); background:transparent;
  color:inherit; font:inherit; font-variant-numeric:tabular-nums; line-height:20px;
  white-space:nowrap; cursor:pointer; }
.dsh-claude-meter-trigger:hover, .dsh-claude-meter-trigger[aria-expanded="true"] {
  background:var(--dsw-alias-interactive-bg-hover, #f1f1f2); color:var(--dsw-alias-label-secondary, #666); }
.dsh-claude-meter-panel { position:fixed; z-index:1100; box-sizing:border-box;
  width:min(280px, calc(100vw - 24px)); padding:12px; border:0;
  border-radius:var(--dsw-radius-lg, 14px); background:var(--dsw-specific-menu, #fafafa);
  backdrop-filter:var(--dsw-menu-backdrop-filter); --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent, 0 4px 20px #0002); font-family:inherit; font-size:12px; line-height:20px;
  color:var(--dsw-alias-label-secondary, #666); }
.dsh-claude-meter-head { display:flex; align-items:center; gap:6px; font-size:12px; line-height:20px; }
.dsh-claude-meter-head strong, .dsh-claude-meter-count { font-weight:500;
  font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-primary, #222); }
.dsh-claude-meter-count { margin-left:auto; white-space:nowrap; }
.dsh-claude-meter-bar { display:flex; gap:1px; height:4px; border-radius:999px;
  margin:10px 0 12px; background:var(--dsw-alias-interactive-bg-hover, #eee); overflow:hidden; }
.dsh-claude-meter-segment { flex:none; min-width:2px; height:100%; border-radius:1px; }
.dsh-claude-meter-rows { margin:6px 0 0; font-size:12px; line-height:20px; }
.dsh-claude-meter-row { display:flex; justify-content:space-between; gap:12px; padding:2px 0; }
.dsh-claude-meter-row dd { margin:0; font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary, #222); }
.dsh-claude-meter-swatch { display:inline-block; width:8px; height:8px; margin-right:6px; border-radius:2px; }
.dsh-claude-quota-row { margin-top:12px; font-size:12px; line-height:20px; }
.dsh-claude-quota-line { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.dsh-claude-quota-reset { color:var(--dsw-alias-label-tertiary, #858992); font-size:11px; }
.dsh-claude-quota-bar { height:4px; margin:5px 0 3px; border-radius:999px;
  background:var(--dsw-alias-interactive-bg-hover, #eee); overflow:hidden; }
.dsh-claude-quota-refresh { border:0; border-radius:4px; background:transparent; color:inherit;
  font:inherit; cursor:pointer; margin-left:auto; padding:0 4px; }
.dsh-claude-quota-refresh:hover { background:var(--dsw-alias-interactive-bg-hover, #eee); }
`;

function compactTokens(value) {
  const scaled = number => String(Math.round(number * (number >= 100 ? 1 : 10)) / (number >= 100 ? 1 : 10));
  return value < 1000 ? String(value) : value < 1_000_000 ? `${scaled(value / 1000)}K` : `${scaled(value / 1_000_000)}M`;
}

function createStore() {
  let snapshot = EMPTY;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next) { snapshot = next; for (const listener of listeners) listener(); },
  };
}

function textError(error) {
  return error instanceof Error ? error.message : String(error || '操作失败');
}

exports.inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'remote', 'remote.session'];

exports.apply = async function apply(ctx) {
  const json = { mode: 'src-json' };
  const descriptor = (method, parameters = []) => ({
    id: `dsh-claude-bridge-ui#claudeBridge/${method}`, service: 'claudeBridge',
    namespace: 'claudeBridge', method, invocation: { kind: 'direct' }, parameters, result: json,
  });
  const disposeRemote = await ctx.remote.$mount({ package: 'dsh-claude-bridge-ui', descriptors: [
    descriptor('status'),
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
    descriptor('refreshCatalog'),
    descriptor('modelPreferences'),
    descriptor('visibleModels'),
    descriptor('saveModelPreferences', [{ name: 'value', wire: 'value', source: 'json', codec: {
      mode: 'strict', typeSymbol: 'dsh-claude-bridge-ui#ModelPreferences',
      create: () => z.object({ enabledIds: z.array(z.string().min(1)) }),
    } }]),
  ] });
  // This namespace is created by the mount above, so declaring it in the
  // outer inject list would deadlock. Its child scope owns every UI closure.
  ctx.inject(['remote.claudeBridge'], (ctx) => {
  const store = createStore();
  const settingsStore = createStore();
  const quotaStore = createStore();
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
  const UNKNOWN_QUOTA = { status: 'unavailable', windows: [], refreshing: false, nextRefreshAt: 0 };
  quotaStore.set(UNKNOWN_QUOTA);
  settingsStore.set({ url: '', configured: false, connected: false, authentication: 'unknown',
    compatibility: [], disabledFeatures: [], convertedFeatures: [], usageSummary: null,
    diagnosticsPath: '', activeRuns: 0, busy: false, error: '', statusError: '', message: '',
    models: [], selectedModelIds: [], modelsLoaded: false, modelsLoading: false,
    modelError: '', usingModelDefaults: true });
  let generation = 0;
  let disposed = false;
  let modelRequest;
  let quotaRequest;
  let quotaGeneration = 0;
  let quotaLastAttemptAt = 0;
  let quotaFailures = 0;
  let quotaRetryAt = 0;
  const quotaAuthCodes = new Set(['AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_METHOD_UNSUPPORTED',
    'AUTHORIZATION_DENIED', 'ACCOUNT_ON_HOLD']);
  const update = patch => store.set({ ...store.getSnapshot(), ...patch });
  const updateSettings = patch => settingsStore.set({ ...settingsStore.getSnapshot(), ...patch });

  function readPlanUsage(reason = 'poll') {
    const now = Date.now();
    const previous = quotaStore.getSnapshot();
    const manual = reason === 'manual';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (!['auth', 'unsupported'].includes(previous.paused)
        && (previous.paused !== 'offline' || previous.nextRefreshAt)) {
        quotaStore.set({ ...previous, paused: 'offline', nextRefreshAt: 0 });
      }
      return Promise.resolve();
    }
    if (!manual && (typeof document !== 'undefined' && document.hidden
      || ['auth', 'unsupported'].includes(previous.paused))) return Promise.resolve();
    if (quotaRequest) return quotaRequest;
    if (previous.paused === 'offline') quotaStore.set({ ...previous, paused: undefined });
    if (reason === 'online') quotaRetryAt = 0;
    if (!manual && ['open', 'visible', 'online'].includes(reason) && previous.status === 'available'
      && previous.expiresAt > now && now - previous.observedAt < 30_000
      && previous.windows.every(row => row.resetsAt === null || row.resetsAt > now)) return Promise.resolve();
    const earliest = manual ? now : Math.max(quotaLastAttemptAt + 30_000,
      reason === 'reset' || previous.status !== 'available' ? 0 : previous.observedAt + 30_000,
      quotaRetryAt);
    if (earliest > now) {
      if (['activity', 'online', 'reset'].includes(reason) || previous.status !== 'available') {
        const queued = previous.nextRefreshAt > now ? Math.min(previous.nextRefreshAt, earliest) : earliest;
        if (queued !== previous.nextRefreshAt) quotaStore.set({ ...previous, nextRefreshAt: queued });
      }
      return Promise.resolve();
    }
    const revision = quotaGeneration;
    quotaLastAttemptAt = now;
    quotaStore.set({ ...previous, refreshing: true, paused: undefined, nextRefreshAt: 0 });
    const request = (async () => {
      let value;
      try {
        const response = await ctx.remote.claudeBridge.planUsage(manual);
        value = response.ok && response.value ? response.value
          : { ...UNKNOWN_QUOTA, code: response.error?.code ?? 'QUOTA_READ_FAILED' };
      } catch { value = { ...UNKNOWN_QUOTA, code: 'QUOTA_READ_FAILED' }; }
      if (disposed || revision !== quotaGeneration) return;
      if (value.status === 'available') {
        quotaFailures = 0; quotaRetryAt = 0;
        quotaStore.set({ ...value, refreshing: false, nextRefreshAt: 0 });
        return;
      }
      const paused = quotaAuthCodes.has(value.code) ? 'auth'
        : value.code === 'SDK_QUOTA_UNAVAILABLE' ? 'unsupported' : undefined;
      if (paused) {
        quotaRetryAt = 0;
        quotaStore.set({ ...UNKNOWN_QUOTA, code: value.code, paused });
        if (paused === 'auth') updateSettings({ authentication: 'login-required' });
      } else {
        quotaFailures++;
        quotaRetryAt = Date.now() + [60_000, 120_000, 300_000][Math.min(quotaFailures - 1, 2)];
        quotaStore.set({ ...(previous.status === 'available' ? previous : UNKNOWN_QUOTA),
          code: value.code, refreshing: false, paused: undefined, nextRefreshAt: quotaRetryAt });
      }
    })();
    quotaRequest = request;
    void request.finally(() => { if (quotaRequest === request) quotaRequest = undefined; });
    return request;
  }

  let statusRequest;
  let statusGeneration = 0;
  let urlEdited = false;
  function readStatus() {
    if (statusRequest) return statusRequest;
    const generation = statusGeneration;
    const request = (async () => {
      try {
        const response = await ctx.remote.claudeBridge.status();
        if (!response.ok) throw new Error(response.error.message);
        if (disposed || generation !== statusGeneration) return;
        const status = response.value;
        updateSettings({ ...(!urlEdited ? { url: status.url ?? '' } : {}), configured: status.configured === true,
          connected: status.connected === true, authentication: status.authentication ?? 'unknown',
          compatibility: status.compatibility ?? [], disabledFeatures: status.disabledFeatures ?? [],
          convertedFeatures: status.convertedFeatures ?? [], activeRuns: status.activeRuns ?? 0,
          usageSummary: status.usageSummary ?? null, diagnosticsPath: status.diagnosticsPath ?? '', statusError: '' });
      } catch (error) {
        if (!disposed && generation === statusGeneration) updateSettings({ statusError: textError(error) });
      }
    })();
    statusRequest = request;
    void request.finally(() => { if (statusRequest === request) statusRequest = undefined; });
    return request;
  }

  async function saveConnection(value) {
    statusGeneration++;
    quotaGeneration++;
    quotaLastAttemptAt = 0; quotaFailures = 0; quotaRetryAt = 0;
    quotaStore.set(UNKNOWN_QUOTA);
    updateSettings({ busy: true, error: '', message: '' });
    try {
      if (modelRequest) await modelRequest;
      if (quotaRequest) await quotaRequest;
      const response = await ctx.remote.claudeBridge.saveConnection(value);
      if (!response.ok) throw new Error(response.error.message);
      urlEdited = false;
      if (statusRequest) await statusRequest;
      await readStatus();
      if (settingsStore.getSnapshot().modelsLoaded) await loadModelPreferences();
      updateSettings({ message: '连接设置已保存。' });
    } catch (error) { updateSettings({ error: textError(error) }); }
    finally { updateSettings({ busy: false }); }
  }

  async function refreshCatalog() {
    updateSettings({ busy: true, error: '', message: '' });
    try {
      if (modelRequest) await modelRequest;
      const response = await ctx.remote.claudeBridge.refreshCatalog();
      if (!response.ok) throw new Error(response.error.message);
      await readStatus();
      await loadModelPreferences();
      updateSettings({ message: `连接成功，已读取 ${response.value.models?.length ?? 0} 个账号模型。` });
    } catch (error) { updateSettings({ error: textError(error) }); }
    finally { updateSettings({ busy: false }); }
  }

  function loadModelPreferences() {
    if (modelRequest) return modelRequest;
    updateSettings({ modelsLoading: true, modelError: '' });
    const request = (async () => {
      try {
        const response = await ctx.remote.claudeBridge.modelPreferences();
        if (!response.ok) throw new Error(response.error.message);
        const value = response.value;
        if (!Array.isArray(value?.models) || !Array.isArray(value?.enabledIds)) {
          throw new Error('远程模型列表格式无效。');
        }
        if (!disposed) updateSettings({ models: value.models, selectedModelIds: value.enabledIds,
          usingModelDefaults: value.usingDefaults === true, modelsLoaded: true });
      } catch (error) {
        if (!disposed) updateSettings({ modelError: textError(error) });
      } finally {
        if (!disposed) updateSettings({ modelsLoading: false });
      }
    })();
    modelRequest = request;
    void request.finally(() => { if (modelRequest === request) modelRequest = undefined; });
    return request;
  }

  function toggleModel(id) {
    const selected = new Set(settingsStore.getSnapshot().selectedModelIds);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    updateSettings({ selectedModelIds: [...selected], modelError: '' });
  }

  async function saveModelPreferences() {
    const state = settingsStore.getSnapshot();
    if (state.busy || state.modelsLoading || !state.modelsLoaded) return;
    updateSettings({ busy: true, modelError: '', message: '' });
    try {
      const response = await ctx.remote.claudeBridge.saveModelPreferences({ enabledIds: state.selectedModelIds });
      if (!response.ok) throw new Error(response.error.message);
      await loadModelPreferences();
      updateSettings({ message: '模型显示设置已保存。' });
    } catch (error) { updateSettings({ modelError: textError(error) }); }
    finally { updateSettings({ busy: false }); }
  }

  function close() {
    generation++;
    store.set(EMPTY);
  }

  async function open(sessionId) {
    const workspace = ctx.workspaces.list.getSnapshot().items
      .find(item => item.sessionIds.includes(sessionId));
    const revision = ++generation;
    if (!workspace) {
      store.set({ ...EMPTY, open: true, error: '无法确定此会话所属的工作区。' });
      return;
    }
    store.set({ ...EMPTY, open: true, loading: true, workspaceId: workspace.workspaceId });
    try {
      const response = await ctx.remote.claudeBridge.visibleModels();
      if (!response.ok) throw new Error(response.error.message);
      if (disposed || revision !== generation) return;
      if (!Array.isArray(response.value?.models)) throw new Error('远程 Claude 模型目录格式无效。');
      update({ loading: false, models: response.value.models,
        error: response.value.models.length ? '' : '没有勾选可显示的模型，请在远程 Claude 设置中选择。' });
    } catch (error) {
      if (!disposed && revision === generation) update({ loading: false, error: textError(error) });
    }
  }

  function selectModel(model) { update({ model, effort: '', error: '' }); }
  function selectEffort(effort) { update({ effort, error: '' }); }

  async function create() {
    const state = store.getSnapshot();
    if (state.busy || !state.workspaceId || !state.model) return;
    const model = state.models.find(item => item.id === state.model);
    if (!model || (state.effort && !model.reasoning?.efforts.some(item => item.id === state.effort))) {
      update({ error: '请选择可用模型和推理强度。' });
      return;
    }
    const revision = generation;
    update({ busy: true, error: '' });
    try {
      const sessionId = await ctx.sessions.create({
        workspaceId: state.workspaceId,
        // rc.5's generated create codec keeps only declared fields; the
        // versioned marker is decoded before the Host creates the session.
        agentPreset: REMOTE_CREATE_PREFIX + encodeURIComponent(JSON.stringify({ model: state.model,
          ...(state.effort ? { reasoningEffort: state.effort } : {}) })),
      });
      if (disposed || revision !== generation) return;
      close();
      ctx.uiWorkspace.openSession(sessionId);
    } catch (error) {
      if (!disposed && revision === generation) update({ busy: false, error: textError(error) });
    }
  }

  function MenuItem({ sessionId, useMenuOpenState, show }) {
    const [, setOpen] = useMenuOpenState();
    return React.createElement('button', { type: 'button', role: 'menuitem',
      onClick: () => { setOpen(false); void show(sessionId); },
      style: { display: 'block', width: '100%', padding: '7px 12px',
        textAlign: 'left', background: 'transparent', border: 0, cursor: 'pointer' } },
    '新建远程 Claude 会话');
  }

  function HeroButton({ show }) {
    return React.createElement('button', { type: 'button', onClick: () => { void show(); },
      style: { padding: '5px 9px', border: '1px solid var(--border-primary, #ddd)',
        borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' } },
    '新建远程 Claude');
  }

  function SessionMeter({ useBridgeStatus, syncSession }) {
    const state = useBridgeStatus(value => value);
    React.useEffect(() => {
      if (state == null || !syncSession || ['running', 'compacting', 'stopping'].includes(state.phase)) return;
      let cancelled = false, timer, failures = 0;
      const deadline = Date.now() + 120_000;
      const sync = async () => {
        if (cancelled || document.hidden || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
        clearTimeout(timer);
        let result;
        try { result = await syncSession(); } catch { result = { status: 'unavailable' }; }
        if (!cancelled && Date.now() < deadline && ['waiting', 'unavailable', 'active'].includes(result.status)) {
          timer = setTimeout(sync, Math.min(15_000, 2000 * 2 ** failures++));
        }
      };
      void sync();
      window.addEventListener('online', sync);
      document.addEventListener('visibilitychange', sync);
      return () => { cancelled = true; clearTimeout(timer); window.removeEventListener('online', sync);
        document.removeEventListener('visibilitychange', sync); };
    }, [syncSession, state == null, state?.phase, state?.connection]);
    const [open, setOpen] = React.useState(false);
    const rootRef = React.useRef(null);
    const panelRef = React.useRef(null);
    const position = useAnchoredPosition({ open: open && state != null,
      anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 });
    useDismissOnOutsidePointer(rootRef, open && state != null, setOpen, panelRef);
    React.useEffect(() => { setOpen(false); }, [state?.model]);
    React.useEffect(() => {
      if (!open) return;
      const dismiss = event => { if (event.key === 'Escape') setOpen(false); };
      document.addEventListener('keydown', dismiss);
      return () => document.removeEventListener('keydown', dismiss);
    }, [open]);
    if (state == null) return null;
    const snapshot = state.context;
    const known = snapshot?.status === 'known';
    const phases = { stopping: '正在停止…', stopped: '已停止', unknown: '状态待核实',
      failed: '运行失败', compacting: '正在压缩…' };
    const recovery = state.recovery;
    const recoveryText = { syncing: '同步记录…', waiting: '等待云端收尾…', unavailable: '同步待重试' }[recovery?.status]
      ?? (recovery?.status === 'ready' && recovery.interrupted ? '已恢复，可继续' : null);
    const reading = !known ? '未知' : snapshot.percentage > 0 && snapshot.percentage < 0.1 ? '<0.1%'
      : `≈${Math.round(snapshot.percentage * (snapshot.percentage < 1 ? 10 : 1)) / (snapshot.percentage < 1 ? 10 : 1)}%`;
    const percent = known ? Math.min(100, snapshot.percentage) : 0;
    // Group only SDK-provided used categories. Free space, reserves and
    // deferred definitions are not occupied context; absent rows stay absent.
    const rows = known ? CONTEXT_GROUPS.map(group => ({ ...group,
      tokens: snapshot.categories.filter(item => item.kind === 'used' && group.ids.includes(item.id))
        .reduce((sum, item) => sum + item.tokens, 0),
    })).filter(row => row.tokens > 0) : [];
    const categoryTotal = rows.reduce((sum, row) => sum + row.tokens, 0);
    const segments = rows.length ? rows.map(row => ({ ...row, width: percent * row.tokens / categoryTotal }))
      : [{ name: '已用', color: 'var(--dsw-static-blue-450, #4e8cff)', width: percent }];
    return React.createElement('span', { ref: rootRef, className: 'dsh-claude-meter' },
      React.createElement('style', null, METER_CSS),
      !recoveryText && phases[state.phase] && React.createElement('span', { role: 'status' }, phases[state.phase]),
      recoveryText && React.createElement('button', { type: 'button', className: 'dsh-claude-meter-trigger',
        'aria-label': '同步云端记录', title: recovery.status === 'ready'
          ? `已补齐 ${recovery.added} 条消息。${recovery.unresolvedTools ? `${recovery.unresolvedTools} 个工具结果仍待核实；继续对话时会告知 Claude。` : '可以直接在输入框继续对话。'}`
          : '自动同步原生 Claude 会话；点击可立即重试。', onClick: () => { void syncSession?.().catch(() => {}); } }, recoveryText),
      state.connection === 'reconnecting' && React.createElement('span', { role: 'status',
        title: '短暂断线，正在恢复原连接；不会重新发送整轮请求。' }, '连接恢复中…'),
      state.toolMayHaveExecuted && React.createElement('span', { role: 'status',
        title: '工具可能已执行，停止不代表撤销。' }, '工具结果待核实'),
      React.createElement('button', { type: 'button', className: 'dsh-claude-meter-trigger',
        'aria-label': `上下文已用 ${reading}`, 'aria-haspopup': 'dialog', 'aria-expanded': open,
        title: state.phase === 'running' ? 'SDK 上一轮近似快照，完成本轮后更新' : 'SDK 上下文近似值',
        onClick: () => setOpen(!open) },
        React.createElement('svg', { viewBox: '0 0 14 14', width: 14, height: 14, 'aria-hidden': true },
          React.createElement('circle', { cx: 7, cy: 7, r: 5.5, fill: 'none', strokeWidth: 2,
            stroke: 'var(--dsw-alias-border-l3, #ddd)' }),
          React.createElement('circle', { cx: 7, cy: 7, r: 5.5, fill: 'none', strokeWidth: 2,
            stroke: 'currentColor', strokeLinecap: 'round', transform: 'rotate(-90 7 7)',
            strokeDasharray: `${2 * Math.PI * 5.5 * percent / 100} ${2 * Math.PI * 5.5}` })),
        reading),
      open && createPortal(React.createElement('div', { ref: panelRef,
        className: 'dsh-claude-meter-panel', role: 'dialog', 'aria-label': '上下文已用',
        style: position ?? { visibility: 'hidden', left: 0, top: 0 } },
        React.createElement('div', { className: 'dsh-claude-meter-head' },
          React.createElement('span', null, '上下文已用'), React.createElement('strong', null, reading),
          known && React.createElement('span', { className: 'dsh-claude-meter-count' },
            `~${compactTokens(snapshot.totalTokens)} / ${compactTokens(snapshot.maxTokens)}`)),
        known ? React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'dsh-claude-meter-bar', role: 'meter',
            'aria-label': '上下文占用', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent },
            ...segments.filter(segment => segment.width > 0).map(segment => React.createElement('span', {
              key: segment.name, className: 'dsh-claude-meter-segment',
              style: { width: `${segment.width}%`, background: segment.color } }))),
          rows.length > 0 && React.createElement('dl', { className: 'dsh-claude-meter-rows' },
            ...rows.map(row => React.createElement('div', { key: row.name, className: 'dsh-claude-meter-row' },
              React.createElement('dt', null, React.createElement('span', { className: 'dsh-claude-meter-swatch',
                'aria-hidden': true, style: { background: row.color } }), row.name),
              React.createElement('dd', null, `~${compactTokens(row.tokens)}`)))))
          : React.createElement('p', { style: { margin: '8px 0 0' } }, '完成一轮对话后更新。')), document.body));
  }

  function QuotaMeter({ useBridgeStatus, useQuota, readQuota }) {
    const bridge = useBridgeStatus(value => value);
    const quota = useQuota(value => value);
    const remoteSession = bridge != null;
    const [open, setOpen] = React.useState(false);
    const [now, setNow] = React.useState(() => Date.now());
    const currentTime = Math.max(now, Date.now());
    const rootRef = React.useRef(null);
    const panelRef = React.useRef(null);
    const previousPhase = React.useRef(bridge?.phase);
    const position = useAnchoredPosition({ open: open && remoteSession,
      anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 });
    useDismissOnOutsidePointer(rootRef, open && remoteSession, setOpen, panelRef);
    React.useEffect(() => {
      if (!remoteSession) { setOpen(false); return; }
      void readQuota('visible');
      const refresh = () => { if (!document.hidden) void readQuota('visible'); };
      const online = () => { if (!document.hidden) void readQuota('online'); };
      const offline = () => { void readQuota('offline'); };
      const poll = setInterval(() => { if (!document.hidden) void readQuota('poll'); }, 60_000);
      const clock = setInterval(() => setNow(Date.now()), 15_000);
      document.addEventListener('visibilitychange', refresh);
      window.addEventListener('online', online);
      window.addEventListener('offline', offline);
      return () => {
        clearInterval(poll); clearInterval(clock); document.removeEventListener('visibilitychange', refresh);
        window.removeEventListener('online', online); window.removeEventListener('offline', offline);
      };
    }, [remoteSession, readQuota]);
    React.useEffect(() => {
      const previous = previousPhase.current;
      previousPhase.current = bridge?.phase;
      if (!remoteSession || !['running', 'compacting', 'stopping'].includes(previous)
        || !['completed', 'stopped', 'failed', 'unknown'].includes(bridge.phase)) return;
      const timer = setTimeout(() => { if (!document.hidden) void readQuota('activity'); }, 3000);
      return () => clearTimeout(timer);
    }, [remoteSession, bridge?.phase, readQuota]);
    React.useEffect(() => {
      if (remoteSession && quota.status === 'available' && (quota.expiresAt <= now
        || quota.windows.some(row => row.resetsAt !== null && row.resetsAt <= now)) && !document.hidden) void readQuota('reset');
    }, [remoteSession, quota, now, readQuota]);
    React.useEffect(() => {
      if (!remoteSession || !quota.nextRefreshAt) return;
      const timer = setTimeout(() => { if (!document.hidden) void readQuota('queued'); },
        Math.max(1, quota.nextRefreshAt - Date.now()));
      return () => clearTimeout(timer);
    }, [remoteSession, quota.nextRefreshAt, readQuota]);
    React.useEffect(() => {
      if (!remoteSession || quota.status !== 'available') return;
      const expiry = Math.min(quota.expiresAt, ...quota.windows.flatMap(row => row.resetsAt === null ? [] : [row.resetsAt]));
      const delay = expiry - Date.now();
      if (delay <= 0) { if (!document.hidden) void readQuota('reset'); return; }
      const timer = setTimeout(() => { setNow(Date.now()); if (!document.hidden) void readQuota('reset'); }, delay + 1);
      return () => clearTimeout(timer);
    }, [remoteSession, quota, readQuota]);
    React.useEffect(() => {
      if (!open) return;
      const dismiss = event => { if (event.key === 'Escape') setOpen(false); };
      document.addEventListener('keydown', dismiss);
      return () => document.removeEventListener('keydown', dismiss);
    }, [open]);
    if (!remoteSession) return null;
    const rows = quota.status === 'available' && quota.expiresAt > currentTime
      ? quota.windows.filter(row => row.resetsAt === null || row.resetsAt > currentTime) : [];
    const fiveHour = rows.find(row => row.id === 'five_hour');
    const remaining = row => {
      const value = 100 - row.usedPercent;
      return value > 0 && value < 0.1 ? '<0.1%' : `${Math.round(value * 10) / 10}%`;
    };
    const staleFiveHour = quota.status === 'available' && quota.windows.some(row => row.id === 'five_hour');
    const reading = fiveHour ? `5h 剩余 ${remaining(fiveHour)}` : staleFiveHour ? '5h 待刷新' : '5h 额度未知';
    const resetTime = row => {
      if (row.resetsAt === null) return '';
      const minutes = Math.max(1, Math.ceil((row.resetsAt - currentTime) / 60_000));
      if (minutes < 60) return `${minutes} 分钟后重置`;
      if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后重置`;
      return `${new Date(row.resetsAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置`;
    };
    return React.createElement('span', { ref: rootRef, className: 'dsh-claude-meter' },
      React.createElement('style', null, METER_CSS),
      React.createElement('button', { type: 'button', className: 'dsh-claude-meter-trigger',
        'aria-label': `额度明细，${reading}`, 'aria-haspopup': 'dialog', 'aria-expanded': open,
        title: 'Claude 账号额度，来自 SDK', onClick: () => {
          setNow(Date.now()); setOpen(!open); if (!open) void readQuota('open');
        } },
        React.createElement('svg', { viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
          React.createElement('circle', { cx: 7, cy: 7, r: 5.3 }),
          React.createElement('path', { d: 'M7 3.7V7l2.2 1.4', strokeLinecap: 'round', strokeLinejoin: 'round' })),
        reading),
      open && createPortal(React.createElement('div', { ref: panelRef, role: 'dialog', 'aria-label': '剩余额度',
        className: 'dsh-claude-meter-panel',
        style: { ...position ?? { visibility: 'hidden', left: 0, top: 0 }, maxHeight: 'min(420px, calc(100vh - 24px))', overflowY: 'auto' } },
        React.createElement('div', { className: 'dsh-claude-meter-head' },
          React.createElement('strong', null, '剩余额度'),
          React.createElement('button', { type: 'button', className: 'dsh-claude-quota-refresh',
            'aria-label': '刷新额度', title: '刷新额度', disabled: quota.refreshing || quota.paused === 'offline',
            onClick: () => { void readQuota('manual'); } }, quota.refreshing ? '…' : '↻')),
        ...rows.map(row => React.createElement('div', { key: row.id, className: 'dsh-claude-quota-row' },
          React.createElement('div', { className: 'dsh-claude-quota-line' },
            React.createElement('span', null, row.scope === 'model-weekly' ? `${row.name} · 周额度` : row.name),
            React.createElement('strong', { style: { fontWeight: 500, fontVariantNumeric: 'tabular-nums',
              color: 'var(--dsw-alias-label-primary, #222)' } }, remaining(row))),
          React.createElement('div', { className: 'dsh-claude-quota-bar', role: 'meter',
            'aria-label': `${row.name}剩余额度`, 'aria-valuemin': 0, 'aria-valuemax': 100,
            'aria-valuenow': 100 - row.usedPercent },
            React.createElement('div', { style: { height: '100%', width: `${100 - row.usedPercent}%`,
              borderRadius: 'inherit', background: 'var(--dsw-static-blue-450, #4e8cff)' } })),
          row.resetsAt !== null && React.createElement('div', { className: 'dsh-claude-quota-reset' }, resetTime(row)))),
        !rows.length && React.createElement('p', { style: { margin: '10px 0 0' } },
          quota.refreshing ? '正在读取额度…' : quota.paused === 'auth' ? '请在服务器重新登录后刷新。'
            : quota.paused === 'unsupported' ? '当前服务器不支持额度查询。'
              : quota.paused === 'offline' ? '网络离线，恢复后自动刷新。' : '暂时无法获取有效额度。'),
        rows.length > 0 && React.createElement('div', { className: 'dsh-claude-quota-reset', style: { marginTop: 10 } },
          quota.refreshing ? '正在刷新…'
            : `${quota.paused === 'offline' ? '离线 · ' : quota.code ? '刷新失败 · ' : ''}更新于 ${new Date(quota.observedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`)), document.body));
  }

  function Picker({ useDialog, dismiss, chooseModel, chooseEffort, submit }) {
    const state = useDialog(value => value);
    if (!state.open) return null;
    const model = state.models.find(item => item.id === state.model);
    const efforts = model?.reasoning?.efforts ?? [];
    const field = { display: 'block', width: '100%', margin: '8px 0 14px', padding: '7px' };
    return React.createElement('div', { role: 'presentation', style: { position: 'fixed', inset: 0,
      zIndex: 10000, background: 'rgba(0,0,0,.35)', display: 'grid', placeItems: 'center' } },
    React.createElement('div', { role: 'dialog', 'aria-modal': true, 'aria-label': '新建远程 Claude 会话',
      style: { background: 'var(--bg-primary, white)', color: 'var(--text-primary, #222)',
        borderRadius: 12, padding: 20, width: 'min(460px, 90vw)', boxShadow: '0 8px 36px #0003' } },
    React.createElement('h2', { style: { margin: '0 0 14px', fontSize: 18 } }, '新建远程 Claude 会话'),
    React.createElement('label', null, '模型',
      React.createElement('select', { style: field, value: state.model, disabled: state.loading || state.busy,
        onChange: event => chooseModel(event.target.value) },
      React.createElement('option', { value: '' }, state.loading ? '正在读取模型…' : '请选择模型'),
      ...state.models.map(item => React.createElement('option', { key: item.id, value: item.id }, item.name)))),
    efforts.length > 0 && React.createElement('label', null, '推理强度',
      React.createElement('select', { style: field, value: state.effort, disabled: state.busy,
        onChange: event => chooseEffort(event.target.value) },
      React.createElement('option', { value: '' }, '模型默认'),
      ...efforts.map(item => React.createElement('option', { key: item.id, value: item.id }, item.name)))),
    state.error && React.createElement('p', { role: 'alert', style: { color: '#c43c3c' } }, state.error),
    React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
      React.createElement('button', { type: 'button', disabled: state.busy, onClick: dismiss }, '取消'),
      React.createElement('button', { type: 'button', disabled: state.busy || state.loading || !state.model,
        onClick: () => { void submit(); } }, state.busy ? '正在创建…' : '创建'))));
  }

  function Settings({ useSettings, editUrl, save, refresh, refreshStatus, loadModels, toggleVisibleModel, saveModels }) {
    const state = useSettings(value => value);
    const [token, setToken] = React.useState('');
    React.useEffect(() => { if (state.configured) void loadModels(); }, [state.configured, loadModels]);
    React.useEffect(() => {
      const page = typeof document === 'undefined' ? undefined : document;
      const refreshVisible = () => {
        if (page?.hidden || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
        void refreshStatus();
      };
      refreshVisible();
      const timer = window.setInterval?.(refreshVisible, 5000);
      page?.addEventListener?.('visibilitychange', refreshVisible);
      window.addEventListener?.('focus', refreshVisible);
      window.addEventListener?.('online', refreshVisible);
      return () => {
        if (timer !== undefined) window.clearInterval(timer);
        page?.removeEventListener?.('visibilitychange', refreshVisible);
        window.removeEventListener?.('focus', refreshVisible);
        window.removeEventListener?.('online', refreshVisible);
      };
    }, [refreshStatus]);
    const authentication = state.authentication === 'logged-in' ? '已登录'
      : state.authentication === 'login-required' ? '需在服务器完成登录' : '未验证';
    const statuses = { preserved: '原样支持', converted: '已转换', disabled: '已关闭' };
    const displayNumber = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
    const usage = state.usageSummary;
    const submit = () => {
      const value = { url: state.url, ...(token ? { token } : {}) };
      setToken('');
      void save(value);
    };
    const field = { display: 'block', width: '100%', maxWidth: 560, margin: '6px 0 14px', padding: 7 };
    return React.createElement('section', { style: { padding: '8px 0', maxWidth: 720 } },
      React.createElement('h2', null, '远程 Claude'),
      React.createElement('p', null, '连接远程服务器；Claude Code 与 SDK 在服务器运行。'),
      React.createElement('label', null, '服务器地址', React.createElement('input', {
        type: 'url', autoComplete: 'url', placeholder: 'wss://…', value: state.url,
        disabled: state.busy, onChange: event => editUrl(event.target.value), style: field,
      })),
      React.createElement('label', null, '连接凭据', React.createElement('input', {
        type: 'password', autoComplete: 'new-password', value: token, disabled: state.busy,
        placeholder: state.configured ? '已保存；留空则保留原凭据' : '输入服务器连接凭据',
        onChange: event => setToken(event.target.value), style: field,
      })),
      React.createElement('div', { style: { display: 'flex', gap: 8, marginBottom: 14 } },
        React.createElement('button', { type: 'button', disabled: state.busy, onClick: submit }, '保存'),
        React.createElement('button', { type: 'button', disabled: state.busy,
          onClick: () => { void refreshStatus(); } }, '刷新状态'),
        React.createElement('button', { type: 'button', disabled: state.busy || !state.configured,
          onClick: () => { void refresh(); } }, '测试连接并刷新模型')),
      React.createElement('p', null, `配置：${state.configured ? '已配置' : '未配置'}；连接：${state.connected ? '已连接' : '未连接'}；官方登录（最近验证）：${authentication}`),
      state.message && React.createElement('p', { role: 'status' }, state.message),
      (state.error || state.statusError) && React.createElement('p', { role: 'alert', style: { color: '#c43c3c' } }, state.error || state.statusError),
      React.createElement('h3', null, '显示的模型'),
      React.createElement('p', null, '选择模型列表中显示的模型；隐藏不会停止已有会话，正在使用的模型会暂时保留在原生列表中。'),
      !state.configured && React.createElement('p', null, '请先保存连接设置，再读取账号模型。'),
      state.modelsLoading && React.createElement('p', null, '正在读取模型…'),
      state.modelError && React.createElement('p', { role: 'alert', style: { color: '#c43c3c' } }, state.modelError),
      state.modelsLoaded && React.createElement('div', null,
        ...state.models.map(model => React.createElement('label', { key: model.value,
          style: { display: 'block', padding: '4px 0' } },
          React.createElement('input', { type: 'checkbox', checked: state.selectedModelIds.includes(model.value),
            disabled: state.busy || state.modelsLoading, onChange: () => toggleVisibleModel(model.value),
            style: { marginRight: 8 } }),
          model.displayName,
          model.resolvedModel && model.resolvedModel !== model.displayName
            ? React.createElement('span', { style: { opacity: 0.65, marginLeft: 6 } }, `(${model.resolvedModel})`) : null)),
        state.models.length === 0 && React.createElement('p', null, '账号当前没有返回可用模型。'),
        React.createElement('button', { type: 'button', disabled: state.busy || state.modelsLoading,
          onClick: () => { void saveModels(); } }, '保存模型显示设置')),
      state.configured && !state.modelsLoading && !state.modelsLoaded
        && React.createElement('button', { type: 'button', disabled: state.busy,
          onClick: () => { void loadModels(); } }, '读取模型列表'),
      React.createElement('h3', null, '本设备用量'),
      state.activeRuns > 0 && React.createElement('p', { role: 'status' }, `正在执行 ${displayNumber(state.activeRuns)} 轮，用量在运行结束后计入。`),
      usage === null ? React.createElement('p', null, '暂无统计。')
        : usage.runs === 0 ? React.createElement('p', null, '暂无已结算的用量记录。')
          : React.createElement('div', null,
          React.createElement('p', null, `会话 ${displayNumber(usage.sessions)}，运行 ${displayNumber(usage.runs)}；输入 ${displayNumber(usage.inputTokens)}，输出 ${displayNumber(usage.outputTokens)} tokens。`),
          React.createElement('p', null, `缓存读取 ${displayNumber(usage.cacheReadTokens)}，缓存写入 ${displayNumber(usage.cacheWriteTokens)} tokens。`),
          React.createElement('p', null, `SDK 估算 ${Number.isFinite(usage.estimatedCostUsd) ? `$${usage.estimatedCostUsd.toFixed(6)}` : '—'}；本设备统计，不是账单。`)),
      React.createElement('details', { style: { marginTop: 20 } },
        React.createElement('summary', { style: { cursor: 'pointer' } }, '兼容性与诊断'),
        state.disabledFeatures.length > 0 && React.createElement('ul', null, ...state.disabledFeatures.map((item, index) =>
          React.createElement('li', { key: `disabled-${item.name}-${index}` }, `${item.name}：已关闭（${item.reason}）`))),
        state.convertedFeatures.length > 0 && React.createElement('ul', null, ...state.convertedFeatures.map((item, index) =>
          React.createElement('li', { key: `converted-${item.name}-${index}` }, `${item.name}：已转换（${item.reason}）`))),
        React.createElement('p', null, '工具报告来自本次启动后最近一次运行，仅供排查。'),
        state.compatibility.length === 0 ? React.createElement('p', null, '本次启动尚未取得工具兼容报告。')
          : React.createElement('ul', null, ...state.compatibility.map((item, index) =>
            React.createElement('li', { key: `${item.name}-${index}` },
              `${item.name}：${statuses[item.status] ?? '未知'}${item.reason ? `（${item.reason}）` : ''}`))),
        React.createElement('p', null, `诊断记录：${state.diagnosticsPath || '尚未确定'}`)));
  }

  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item', id: 'dsh-claude-new-session', order: 250,
    inject: () => ({ show: open }),
  }, MenuItem));
  // Empty new-session rows have no action menu. The official hero options
  // slot is visible as soon as a workspace has its first blank session.
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
    name: 'conversation.hero.options', id: 'dsh-claude-new-session', order: 100,
    inject: sessionId => ({ show: () => open(sessionId) }),
  }, HeroButton));
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'dsh-claude-context', order: 100,
    inject: sessionId => ({ hooks: { bridgeStatus:
      ctx.sessions.binding?.(sessionId)?.session.projections.faceOf('claudeBridge') ?? ABSENT_STATUS },
      syncSession: () => synchronize(sessionId) }),
  }, SessionMeter));
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
    name: 'conversation.composer.dock', id: 'dsh-claude-quota', order: 110,
    inject: sessionId => ({ hooks: { bridgeStatus:
      ctx.sessions.binding?.(sessionId)?.session.projections.faceOf('claudeBridge') ?? ABSENT_STATUS,
      quota: quotaStore }, readQuota: readPlanUsage }),
  }, QuotaMeter));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'dsh-claude-session-picker',
    inject: () => ({ hooks: { dialog: store }, dismiss: close,
      chooseModel: selectModel, chooseEffort: selectEffort, submit: create }),
  }, Picker));
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'dsh-claude-bridge', order: 15, label: '远程 Claude',
    inject: () => ({ hooks: { settings: settingsStore }, editUrl: url => { urlEdited = true; updateSettings({ url }); },
      save: saveConnection, refresh: refreshCatalog, refreshStatus: readStatus,
      loadModels: loadModelPreferences, toggleVisibleModel: toggleModel, saveModels: saveModelPreferences }),
  }, Settings));
  void readStatus();
  ctx.effect(() => () => { disposed = true; close(); }, '远程 Claude 会话选择器');
  });
  return disposeRemote;
};
return module.exports;
} });
