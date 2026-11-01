/** Settings own drafts, status generations, and connection-change boundaries. */
export function createSettingsController({ rpc, createStore, textError, createModelController, onConnectionChange }) {
  const store = createStore({ url: '', configured: false, connected: false, authentication: 'unknown',
    compatibility: [], disabledFeatures: [], convertedFeatures: [], usageSummary: null,
    remotePreset: null, remoteCapabilities: null, desktopCompatibility: null, bridgeCompatibility: null, host: null,
    diagnosticsPath: '', activeRuns: 0, busy: false, error: '', statusError: '', message: '',
    models: [], selectedModelIds: [], modelsLoaded: false, modelsLoading: false, modelCatalog: null,
    modelError: '', usingModelDefaults: true, contextMode: 'default', contextWindow: '200000',
    contextDirty: false, contextError: '', contextMessage: '', autoCompactWindowSupported: null });
  const updateSettings = patch => store.set({ ...store.getSnapshot(), ...patch });
  let disposed = false;
  let statusRequest;
  let statusGeneration = 0;
  let urlEdited = false;
  let contextEdited = false;
  let contextRevision = 0;
  const models = createModelController({ rpc, store, updateSettings, textError,
    getGeneration: () => statusGeneration, isDisposed: () => disposed, readStatus });

  function readStatus(force = false) {
    if (!force && store.getSnapshot().busy) return Promise.resolve();
    if (statusRequest) return statusRequest;
    const generation = statusGeneration;
    const contextGeneration = contextRevision;
    const request = (async () => {
      try {
        const response = await rpc.status();
        if (!response.ok) throw new Error(response.error.message);
        if (disposed || generation !== statusGeneration) return;
        const status = response.value;
        updateSettings({ ...(!urlEdited ? { url: status.url ?? '' } : {}), configured: status.configured === true,
          connected: status.connected === true, authentication: status.authentication ?? 'unknown',
          compatibility: status.compatibility ?? [], disabledFeatures: status.disabledFeatures ?? [],
          convertedFeatures: status.convertedFeatures ?? [], activeRuns: status.activeRuns ?? 0,
          modelCatalog: status.modelCatalog ?? null,
          remotePreset: status.remotePreset ?? null, remoteCapabilities: status.remoteCapabilities ?? null,
          desktopCompatibility: status.desktopCompatibility ?? null,
          bridgeCompatibility: status.bridgeCompatibility ?? null,
          host: status.host ?? null,
          usageSummary: status.usageSummary ?? null, diagnosticsPath: status.diagnosticsPath ?? '', statusError: '',
          autoCompactWindowSupported: status.autoCompactWindowSupported ?? null,
          ...(!contextEdited && contextGeneration === contextRevision ? { contextMode: status.contextPreferences?.autoCompactWindowTokens == null ? 'default' : 'custom',
            contextWindow: String(status.contextPreferences?.autoCompactWindowTokens ?? 200000), contextDirty: false } : {}) });
      } catch (error) {
        if (!disposed && generation === statusGeneration) updateSettings({ statusError: textError(error) });
      }
    })();
    statusRequest = request;
    void request.finally(() => { if (statusRequest === request) statusRequest = undefined; });
    return request;
  }

  async function saveConnection(value) {
    return changeConnection(() => rpc.saveConnection(value), false);
  }

  async function clearConnection() {
    return changeConnection(() => rpc.clearConnection(), true);
  }

  async function changeConnection(request, clearing) {
    if (store.getSnapshot().busy) return;
    statusGeneration++;
    statusRequest = undefined;
    models.invalidate();
    onConnectionChange();
    updateSettings({ busy: true, modelsLoading: false, modelCatalog: null, error: '', message: '' });
    try {
      const response = await request();
      if (!response.ok) throw new Error(response.error.message);
      urlEdited = false;
      if (clearing) updateSettings({ url: '', configured: false, connected: false, authentication: 'unknown',
        models: [], selectedModelIds: [], modelsLoaded: false, modelError: '', usingModelDefaults: true });
      await readStatus(true);
      if (!clearing && store.getSnapshot().modelsLoaded) await models.loadModelPreferences(true);
      updateSettings({ message: clearing ? '已清除本机服务器地址和连接凭据。' : '连接设置已保存。' });
    } catch (error) { updateSettings({ error: textError(error) }); }
    finally { updateSettings({ busy: false }); }
  }

  function editUrl(url) {
    urlEdited = true;
    updateSettings({ url });
  }

  function editContext(patch) {
    contextEdited = true;
    contextRevision++;
    updateSettings({ ...patch, contextDirty: true, contextError: '', contextMessage: '' });
  }

  function editContextMode(mode) {
    editContext({ contextMode: mode });
  }

  function editContextWindow(value) {
    editContext({ contextWindow: value });
  }

  async function saveContextPreferences() {
    const state = store.getSnapshot();
    if (state.busy) return;
    const tokens = state.contextMode === 'default' ? null : Number(state.contextWindow);
    if (tokens !== null && (!/^\d+$/.test(state.contextWindow) || !Number.isSafeInteger(tokens) || tokens < 100000 || tokens > 1000000)) {
      updateSettings({ contextError: '请输入 100,000–1,000,000 之间的整数。' }); return;
    }
    updateSettings({ busy: true, contextError: '', contextMessage: '' });
    try {
      const response = await rpc.saveContextPreferences({ autoCompactWindowTokens: tokens });
      if (!response.ok) throw new Error(response.error.message);
      contextEdited = false;
      updateSettings({ contextMode: tokens === null ? 'default' : 'custom', contextWindow: String(tokens ?? 200000), contextDirty: false });
      await readStatus(true);
      updateSettings({ contextMessage: '已保存；从下一轮远程会话运行起生效。' });
    } catch (error) { updateSettings({ contextError: textError(error) }); }
    finally { updateSettings({ busy: false }); }
  }

  function authenticationRequired() {
    updateSettings({ authentication: 'login-required' });
  }

  function dispose() {
    disposed = true;
  }

  return { store, readStatus, saveConnection, clearConnection, editUrl, editContextMode, editContextWindow,
    saveContextPreferences, authenticationRequired, models, dispose };
}
