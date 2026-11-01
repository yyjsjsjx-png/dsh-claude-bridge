/** Own the remote-session picker and ignore responses from closed revisions. */
export function createPickerController({ rpc, workspaces, sessions, uiWorkspace, createStore, textError }) {
  const REMOTE_CREATE_PREFIX = 'claude-sdk-remote+model-v1:';
  const EMPTY = Object.freeze({ open: false, loading: false, busy: false,
    workspaceId: undefined, models: [], modelEfforts: {}, model: '', effort: '', error: '' });
  const store = createStore(EMPTY);
  let generation = 0;
  let disposed = false;
  const update = patch => store.set({ ...store.getSnapshot(), ...patch });

  function close() {
    generation++;
    store.set(EMPTY);
  }

  async function open(sessionId) {
    if (disposed) return;
    const workspace = workspaces.list.getSnapshot().items
      .find(item => item.sessionIds.includes(sessionId));
    const revision = ++generation;
    if (!workspace) {
      store.set({ ...EMPTY, open: true, error: '无法确定此会话所属的工作区。' });
      return;
    }
    store.set({ ...EMPTY, open: true, loading: true, workspaceId: workspace.workspaceId });
    try {
      const response = await rpc.visibleModels();
      if (!response.ok) throw new Error(response.error.message);
      if (disposed || revision !== generation) return;
      if (!Array.isArray(response.value?.models)) throw new Error('远程模型目录格式无效。');
      const saved = response.value.selection;
      const model = response.value.models.find(item => item.id === saved?.model);
      const modelEfforts = response.value.modelEfforts && typeof response.value.modelEfforts === 'object'
        && !Array.isArray(response.value.modelEfforts) ? response.value.modelEfforts : {};
      const remembered = model && Object.hasOwn(modelEfforts, model.id) ? modelEfforts[model.id] : saved?.reasoningEffort;
      const effort = model?.reasoning?.efforts?.some(item => item.id === remembered) ? remembered : '';
      update({ loading: false, models: response.value.models, modelEfforts, model: model?.id ?? '', effort,
        error: response.value.models.length ? '' : '没有勾选可显示的模型，请在远程会话设置中选择。' });
    } catch (error) {
      if (!disposed && revision === generation) update({ loading: false, error: textError(error) });
    }
  }

  function selectModel(model) {
    if (disposed) return;
    const state = store.getSnapshot();
    const remembered = Object.hasOwn(state.modelEfforts, model) ? state.modelEfforts[model] : undefined;
    const available = state.models.find(item => item.id === model);
    const effort = available?.reasoning?.efforts?.some(item => item.id === remembered) ? remembered : '';
    update({ model, effort, error: '' });
  }
  function selectEffort(effort) { if (!disposed) update({ effort, error: '' }); }

  async function create() {
    if (disposed) return;
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
      const sessionId = await sessions.create({
        workspaceId: state.workspaceId,
        // rc.5's generated create codec keeps only declared fields; the
        // versioned marker is decoded before the Host creates the session.
        agentPreset: REMOTE_CREATE_PREFIX + encodeURIComponent(JSON.stringify({ model: state.model,
          ...(state.effort ? { reasoningEffort: state.effort } : {}) })),
      });
      if (disposed || revision !== generation) return;
      close();
      uiWorkspace.openSession(sessionId);
    } catch (error) {
      if (!disposed && revision === generation) update({ busy: false, error: textError(error) });
    }
  }

  function dispose() {
    disposed = true;
    close();
  }

  return { store, open, close, selectModel, selectEffort, create, dispose };
}
