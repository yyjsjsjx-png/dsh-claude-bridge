import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_ENGINE, CLAUDE_PRESET, CLAUDE_PROVIDER, DSH_ENGINE,
  assertModelSelection, assertPresetSelection, guardModelSelection,
  guardPresetSelection, planSessionCreation, restoreSessionBinding,
} from '../plugin/policy.mjs';
import { createRemoteClaudePreset } from '../plugin/preset.mjs';

const remote = { provider: CLAUDE_PROVIDER, model: 'claude-model-from-catalog' };
const local = { provider: 'some-dsh-provider', model: 'configured-model' };
const code = expected => error => error.code === expected;

test('创建前需要模型，远程模型自动绑定专属预设', () => {
  assert.throws(() => planSessionCreation({ defaultPreset: 'standard' }), code('MODEL_REQUIRED'));
  const binding = planSessionCreation({ selection: remote, requestedPreset: 'standard' });
  assert.deepEqual(binding, {
    schemaVersion: 1, engine: CLAUDE_ENGINE, preset: CLAUDE_PRESET, initialModel: remote,
  });
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(Object.isFrozen(binding.initialModel), true);
});

test('普通模型使用解析后的 DSH 预设，不能冒用 Claude 预设', () => {
  const binding = planSessionCreation({ selection: local, defaultPreset: 'standard' });
  assert.equal(binding.engine, DSH_ENGINE);
  assert.equal(binding.preset, 'standard');
  assert.throws(() => planSessionCreation({ selection: local, requestedPreset: CLAUDE_PRESET }),
    code('PRESET_ENGINE_MISMATCH'));
  assert.throws(() => planSessionCreation({ selection: local }), code('INVALID_SELECTION'));
});

test('拒绝跨引擎模型选择，并且不调用后续写入操作', () => {
  const claude = planSessionCreation({ selection: remote });
  const dsh = planSessionCreation({ selection: local, defaultPreset: 'standard' });
  let calls = 0;
  const write = () => { calls += 1; };
  assert.throws(() => guardModelSelection(claude, local, write), code('ENGINE_LOCKED'));
  assert.throws(() => guardModelSelection(dsh, remote, write), code('ENGINE_LOCKED'));
  assert.equal(calls, 0);
  assert.equal(guardModelSelection(claude, { ...remote, model: 'another-available-model' },
    accepted => accepted.model), 'another-available-model');
});

test('会话预设从创建起锁定，重新选择相同预设不重组', () => {
  const binding = planSessionCreation({ selection: remote });
  assert.throws(() => assertPresetSelection(binding, 'standard'), code('PRESET_LOCKED'));
  assert.equal(guardPresetSelection(binding, CLAUDE_PRESET), CLAUDE_PRESET);
});

test('恢复只接受完整一致的持久绑定，不从展示记录推断', () => {
  const binding = planSessionCreation({ selection: remote });
  assert.deepEqual(restoreSessionBinding(JSON.parse(JSON.stringify(binding))), binding);
  assert.throws(() => restoreSessionBinding(undefined), code('BINDING_MISSING_OR_UNSUPPORTED'));
  assert.throws(() => restoreSessionBinding({ ...binding, schemaVersion: 2 }),
    code('BINDING_MISSING_OR_UNSUPPORTED'));
  assert.throws(() => restoreSessionBinding({ ...binding, preset: 'standard' }), code('BINDING_INVALID'));
  assert.throws(() => assertModelSelection({ ...binding, initialModel: local }, remote), code('BINDING_INVALID'));
});

test('远程预设关闭计划与分叉，保留独立子代理并继承父模型', () => {
  const standard = { plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'example {{model}}' } },
    { id: 'tool-pwsh', name: 'tool-pwsh' },
    { id: 'planning', name: 'cordis:group', group: true, config: [{ id: 'plan-mode', name: 'plan-mode' }] },
    { id: 'compaction', name: 'cordis:group', group: true, config: [] },
    { id: 'delegation', name: 'cordis:group', group: true, config: [
      { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn', modelSelectionSettings: true } },
      { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'fork', toolName: 'subagent_fork' } },
      { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
    ] },
    { id: 'tool-fs', name: 'tool-fs' },
  ] };
  const preset = createRemoteClaudePreset(standard);
  assert.equal(preset.id, CLAUDE_PRESET);
  assert.deepEqual(preset.plugins.map(entry => entry.id), ['persona', 'tool-pwsh', 'planning', 'delegation', 'tool-fs', 'claude-sdk-compact', 'claude-sdk-recovery']);
  assert.match(preset.plugins.find(entry => entry.id === 'claude-sdk-compact').name, /\/compact-command\.mjs$/);
  assert.match(preset.plugins.at(-1).name, /\/recovery-command\.mjs$/);
  assert.equal(preset.plugins.find(entry => entry.id === 'planning').disabled, true);
  assert.equal(preset.plugins.find(entry => entry.id === 'persona').config.prefix,
    'You are a coding agent powered by Claude through the remote Claude Agent SDK.');
  assert.equal(standard.plugins[0].config.prefix, 'example {{model}}');
  const children = preset.plugins.find(entry => entry.id === 'delegation').config;
  assert.equal(children.find(entry => entry.id === 'tool-subagent-fork').disabled, true);
  assert.equal(children.find(entry => entry.id === 'tool-subagent').config.modelSelectionSettings, false);
  assert.equal(children.find(entry => entry.id === 'tool-workflow').disabled, undefined);
  assert.equal(standard.plugins[4].config[0].config.modelSelectionSettings, true);
  assert.equal(standard.plugins[4].config[1].disabled, undefined);
  assert.equal(standard.plugins.length, 6);
  assert.notEqual(preset.plugins[0], standard.plugins[0]);
  assert.throws(() => createRemoteClaudePreset({ plugins: [{ id: 'bad' }] }), TypeError);
});

test('远程预设仅按原生 time-context 包名禁用，改名 id 仍关闭且不改变标准预设', () => {
  const standard = { plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'fixture' } },
    { id: 'planning', name: 'cordis:group', group: true, config: [] },
    { id: 'compaction', name: 'cordis:group', group: true, config: [] },
    { id: 'delegation', name: 'cordis:group', group: true, config: [
      { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn' } },
      { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'fork', toolName: 'subagent_fork' } },
    ] },
    { id: 'clock-renamed', name: '@deepseek-ai/dsh-time-context', config: { refreshIntervalMs: 5000 } },
    { id: 'time-context', name: 'custom-component', config: { preserved: true } },
  ] };
  const before = structuredClone(standard);
  const preset = createRemoteClaudePreset(standard);
  assert.deepEqual(preset.plugins.find(row => row.id === 'clock-renamed'), {
    ...standard.plugins[4], disabled: true,
  });
  assert.deepEqual(preset.plugins.find(row => row.id === 'time-context'), standard.plugins[5]);
  assert.deepEqual(standard, before);
});
