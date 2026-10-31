import test from 'node:test';
import assert from 'node:assert/strict';

const available = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES);

test('实际 rc5 服务：清除连接仅限 owner 并刷新模型注册', { skip: !available }, async () => {
  const { ClaudeBridgeService } = await import('../plugin/index.mjs');
  let cleared = 0, replaced = 0;
  const denied = new Error('owner required');
  const service = { assertOwner() { throw denied; },
    backend: { async clearConnection() { cleared++; return { configured: false, status: 'missing' }; } },
    catalogRegistration: { replace(ids) { assert.deepEqual(ids, ['claude-sdk-remote']); replaced++; } } };
  await assert.rejects(ClaudeBridgeService.prototype.clearConnection.call(service), error => error === denied);
  assert.equal(cleared, 0);
  service.assertOwner = () => {};
  assert.deepEqual(await ClaudeBridgeService.prototype.clearConnection.call(service), { configured: false, status: 'missing' });
  assert.equal(cleared, 1); assert.equal(replaced, 1);
});

test('实际 rc5 服务：同步 RPC 解包 resolveAgent 结果并保留解析错误', { skip: !available }, async () => {
  const { ClaudeBridgeService } = await import('../plugin/index.mjs');
  const agent = { id: 's', session: { header: { agentPreset: 'claude-sdk-remote' } } };
  let resolved = { agent };
  const service = { assertOwner() {}, ctx: { get: () => ({ resolveAgent: async () => resolved }) },
    backend: { async syncSession(value) { assert.equal(value, agent); return { status: 'ready', added: 0 }; } } };
  assert.deepEqual(await ClaudeBridgeService.prototype.syncSession.call(service, 's'), { status: 'ready', added: 0 });
  const missing = new Error('session unavailable');
  resolved = { error: missing };
  await assert.rejects(ClaudeBridgeService.prototype.syncSession.call(service, 's'), error => error === missing);
});

test('新建目录只显示勾选项，活动会话模型保留在原生列表', { skip: !available }, async () => {
  const { ClaudeCatalogAdapter } = await import('../plugin/index.mjs');
  const models = [
    { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku', supportedEffortLevels: ['low', 'high'] },
    { value: 'hidden', displayName: 'Hidden', supportedEffortLevels: ['medium'] },
  ];
  const active = [{ header: { agentPreset: 'claude-sdk-remote' } }];
  const adapter = new ClaudeCatalogAdapter({
    catalog: async () => ({ status: 'ok', models }),
    visibleCatalog: async () => ({ status: 'ok', models: models.slice(0, 1) }),
  }, { sessions: { list: () => active }, sessionProjections: { stateOf: () => ({
    pending: null, lastUsed: { provider: 'claude-sdk-remote', model: 'hidden' },
  }) } });
  assert.deepEqual((await adapter.models(true)).map(model => model.id), ['haiku']);
  assert.deepEqual((await adapter.resolveModel('claude-sdk-remote', 'haiku')).inputModalities, ['text', 'image']);
  assert.equal((await adapter.resolveModel('claude-sdk-remote', 'hidden')).inputModalities, undefined);
  const listed = await adapter.listModels('claude-sdk-remote');
  assert.deepEqual(listed.map(model => model.id), ['haiku', 'hidden']);
  assert.match(listed[1].name, /已有会话使用中/);
  const hidden = await adapter.resolveModel('claude-sdk-remote', 'hidden');
  assert.equal(hidden.id, 'hidden');
  assert.deepEqual(hidden.reasoning.efforts.map(level => level.id), ['medium']);
  assert.equal((await adapter.resolveModel('claude-sdk-remote', 'account-default')).id, 'account-default');
  active.length = 0;
  assert.deepEqual((await adapter.listModels('claude-sdk-remote')).map(model => model.id), ['haiku']);
});
