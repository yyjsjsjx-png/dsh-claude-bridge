/** Model-list state shares the settings generation and request ownership. */
export function createModelController({ rpc, store, updateSettings, textError,
  getGeneration, isDisposed, readStatus }) {
  let modelRequest;

  async function refreshCatalog() {
    if (store.getSnapshot().busy) return;
    updateSettings({ busy: true, error: '', message: '' });
    try {
      if (modelRequest) await modelRequest;
      const response = await rpc.refreshCatalog();
      if (!response.ok) throw new Error(response.error.message);
      await readStatus(true);
      await loadModelPreferences(true);
      updateSettings({ message: `连接成功，已读取 ${response.value.models?.length ?? 0} 个账号模型。` });
    } catch (error) { updateSettings({ error: textError(error) }); }
    finally { updateSettings({ busy: false }); }
  }

  function loadModelPreferences(force = false) {
    if (!force && store.getSnapshot().busy) return Promise.resolve();
    if (modelRequest) return modelRequest;
    const revision = getGeneration();
    updateSettings({ modelsLoading: true, modelError: '' });
    const request = (async () => {
      try {
        const response = await rpc.modelPreferences();
        if (!response.ok) throw new Error(response.error.message);
        const value = response.value;
        if (!Array.isArray(value?.models) || !Array.isArray(value?.enabledIds)) {
          throw new Error('远程模型列表格式无效。');
        }
        if (!isDisposed() && revision === getGeneration()) updateSettings({ models: value.models, selectedModelIds: value.enabledIds,
          usingModelDefaults: value.usingDefaults === true, modelsLoaded: true });
      } catch (error) {
        if (!isDisposed() && revision === getGeneration()) updateSettings({ modelError: textError(error) });
      } finally {
        if (!isDisposed() && revision === getGeneration()) updateSettings({ modelsLoading: false });
      }
    })();
    modelRequest = request;
    void request.finally(() => { if (modelRequest === request) modelRequest = undefined; });
    return request;
  }

  function toggleModel(id) {
    const selected = new Set(store.getSnapshot().selectedModelIds);
    if (selected.has(id)) selected.delete(id); else selected.add(id);
    updateSettings({ selectedModelIds: [...selected], modelError: '' });
  }

  async function saveModelPreferences() {
    const state = store.getSnapshot();
    if (state.busy || state.modelsLoading || !state.modelsLoaded) return;
    updateSettings({ busy: true, modelError: '', message: '' });
    try {
      const response = await rpc.saveModelPreferences({ enabledIds: state.selectedModelIds });
      if (!response.ok) throw new Error(response.error.message);
      await loadModelPreferences(true);
      updateSettings({ message: '模型显示设置已保存。' });
    } catch (error) { updateSettings({ modelError: textError(error) }); }
    finally { updateSettings({ busy: false }); }
  }

  function invalidate() {
    modelRequest = undefined;
  }

  return { loadModelPreferences, toggleModel, saveModelPreferences, refreshCatalog, invalidate };
}
