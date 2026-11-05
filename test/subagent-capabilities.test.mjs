import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteSubagentConfig, captureRemoteSubagentPolicy } from '../plugin/presets/subagent-capabilities.mjs';
import { createOwnedRemoteClaudePreset, createRemoteClaudePreset } from '../plugin/preset.mjs';

test('子任务按原生schema字段启用选择和发现，移除另一代配置且不改入参', () => {
  const config = { provider: 'spawn', modelSelectionSettings: true, modelSelection: false, modelDiscovery: false };
  assert.deepEqual(remoteSubagentConfig(config, { modelSelectionSettings: {} }), { provider: 'spawn', modelSelectionSettings: true });
  assert.deepEqual(remoteSubagentConfig(config, { modelSelection: {}, modelDiscovery: {} }), {
    provider: 'spawn', modelSelection: true, modelDiscovery: true });
  assert.deepEqual(remoteSubagentConfig(config, { modelSelection: {}, modelDiscovery: {} }, false), {
    provider: 'spawn', modelSelection: false, modelDiscovery: false });
  assert.equal(config.modelSelection, false);
  assert.throws(() => remoteSubagentConfig(config, {}), TypeError);
});

test('新完整兜底移除已合并list-agents入口，保留旧声明及标准适配一致', () => {
  const fields = { modelSelection: {}, modelDiscovery: {} };
  const legacy = createOwnedRemoteClaudePreset();
  const modern = createOwnedRemoteClaudePreset(fields);
  const children = modern.plugins.find(row => row.id === 'delegation').config;
  assert.equal(children.some(row => row.id === 'tool-subagent-list-agents'), false);
  assert.deepEqual(children.find(row => row.id === 'tool-subagent').config,
    { provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true });
  assert.equal(legacy.plugins.find(row => row.id === 'delegation').config.some(row => row.id === 'tool-subagent-list-agents'), true);
  const standard = { ...modern, plugins: [{ ...modern.plugins.find(row => row.id === 'persona') },
    { id: 'planning', name: 'cordis:group', group: true }, { id: 'compaction', name: 'cordis:group', group: true },
    modern.plugins.find(row => row.id === 'delegation')] };
  assert.deepEqual(createRemoteClaudePreset(standard).plugins.find(row => row.id === 'delegation').config, children);
});

const routes = [{ provider: 'claude-sdk-remote', model: 'haiku' }];
function session({ fresh = true, child = false, existing } = {}) {
  const rows = existing ? [{ type: 'subagent/model-selection-policy', data: { allowedModels: existing } }] : [];
  return { header: child ? { origin: 'subagent' } : {}, firstLiveSeq: fresh ? 0 : 2,
    snapshotEvents: () => rows, eventAt: () => fresh ? undefined : { type: 'session/end-seed' },
    append: (type, data) => { rows.push({ type, data }); }, rows };
}
test('新原生policy只捕获首次创建、继承父策略，恢复会话与既有策略绝不静默覆盖', () => {
  const fresh = session(); captureRemoteSubagentPolicy(fresh, undefined, routes);
  assert.deepEqual(fresh.rows[0].data.allowedModels, routes);
  assert.notEqual(fresh.rows[0].data.allowedModels, routes);
  captureRemoteSubagentPolicy(fresh, undefined, [{ provider: 'other', model: 'other' }]);
  assert.equal(fresh.rows.length, 1);
  const resumed = session({ fresh: false }); captureRemoteSubagentPolicy(resumed, undefined, routes);
  assert.equal(resumed.rows.length, 0);
  const child = session({ child: true }); captureRemoteSubagentPolicy(child, fresh, undefined);
  assert.deepEqual(child.rows[0].data.allowedModels, routes);
  const noParent = session({ child: true }); captureRemoteSubagentPolicy(noParent, undefined, routes);
  assert.equal(noParent.rows.length, 0);
});
