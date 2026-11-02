import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_DEFAULT_EFFORT, subagentModels, withModelDefault, assertRemoteSubagentRoute } from '../plugin/subagent-selection.mjs';

test('子代理目录解析保留传入路由且不推断默认强度', () => {
  const models = subagentModels({ status: 'ok', models: [
    { value: 'haiku', displayName: 'Fixture Haiku', supportedEffortLevels: ['low', 'high'] },
    { value: 'sonnet', displayName: 'Fixture Sonnet' },
  ] });
  assert.deepEqual(models.map(model => model.id), ['haiku', 'sonnet']);
  assert.deepEqual(models[0].reasoning, { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }] });
  assert.equal(models[1].reasoning, undefined);
  for (const rows of [[], [{ value: 'account-default', displayName: 'Default' }],
    [{ value: 'haiku', displayName: 'Haiku', supportedEffortLevels: [MODEL_DEFAULT_EFFORT] }]]) {
    assert.throws(() => subagentModels(rows));
  }
});

test('明确模型默认强度保留own undefined，未选择时不改变继承', () => {
  const inherit = { provider: 'claude-sdk-remote', model: 'haiku', reasoningEffort: 'high' };
  assert.equal(withModelDefault(inherit), inherit);
  assert.equal(withModelDefault(undefined), undefined);
  const selected = withModelDefault({ ...inherit, reasoningEffort: MODEL_DEFAULT_EFFORT });
  assert.ok(Object.hasOwn(selected, 'reasoningEffort'));
  assert.equal(selected.reasoningEffort, undefined);
  assert.doesNotThrow(() => assertRemoteSubagentRoute(inherit));
  assert.throws(() => assertRemoteSubagentRoute({ provider: 'ordinary' }), { code: 'SUBAGENT_ENGINE_MISMATCH' });
});
