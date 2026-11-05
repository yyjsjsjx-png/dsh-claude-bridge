/** Select only fields supported by the installed native delegation schema. */
export function remoteSubagentConfig(config, fields, enabled = true) {
  const { modelSelectionSettings: _legacy, modelSelection: _selection, modelDiscovery: _discovery, ...rest } = config;
  if (Object.hasOwn(fields ?? {}, 'modelSelection') && Object.hasOwn(fields, 'modelDiscovery')) {
    return { ...rest, modelSelection: enabled, modelDiscovery: enabled };
  }
  if (Object.hasOwn(fields ?? {}, 'modelSelectionSettings')) return { ...rest, modelSelectionSettings: enabled };
  throw new TypeError('原生子任务选型配置接口不受支持。');
}

/** Mirror native creation-time policy boundaries after its initializer moved out of the tool. */
export function captureRemoteSubagentPolicy(session, parent, allowedModels) {
  const policy = target => target?.snapshotEvents().find(event => event.type === 'subagent/model-selection-policy')?.data.allowedModels;
  if (policy(session) !== undefined) return;
  let routes;
  if (session.header.origin === 'subagent') routes = policy(parent);
  else if (session.firstLiveSeq === 0 && session.eventAt(0)?.type !== 'session/end-seed') routes = allowedModels;
  if (routes !== undefined) session.append('subagent/model-selection-policy', { allowedModels: routes.map(route => ({ ...route })) });
}
