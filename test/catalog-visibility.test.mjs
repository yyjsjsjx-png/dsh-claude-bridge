import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const available = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES);

test('实际 rc5 服务：状态返回同一份 Host 检查，不把启动探针当作实测验收', { skip: !available }, async () => {
  const { ClaudeBridgeService } = await import('../plugin/index.mjs');
  const { assertDshCompatibility } = await import('../plugin/compat/resolve-dsh-module.mjs');
  let ownerChecks = 0;
  const service = { assertOwner() { ownerChecks++; }, ctx: {},
    backend: { async status() { return { configured: false, connected: false }; } } };
  const status = await ClaudeBridgeService.prototype.status.call(service);
  assert.equal(ownerChecks, 1);
  assert.equal(status.host, await assertDshCompatibility());
  assert.equal(status.host.checks.length, 5);
  assert.deepEqual(status.host.checks.filter(check => check.status === 'not-run'), [
    { id: 'desktop-acceptance', evidence: 'desktop', status: 'not-run' },
    { id: 'remote-sdk', evidence: 'real-sdk', status: 'not-run' },
  ]);
  assert.deepEqual(status.desktopCompatibility.verifiedVersions, ['0.2.1-rc.5']);
  assert.equal(status.connected, false);
});

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
    displayCatalog: async ({ visible }) => ({ status: 'ok', models: visible ? models.slice(0, 1) : models }),
    refreshDisplayCatalog() {},
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

test('实际原生模型聚合与旧远程选型在目录 pending 或离线时仍返回普通模型', { skip: !available, timeout: 10000 }, async t => {
  const { resolveDshModule } = await import('../plugin/compat/resolve-dsh-module.mjs');
  const [{ Context }, { LlmRuntime, LlmAdapter }, { SessionController }, { ClaudeCatalogAdapter }, { BridgeBackend }] = await Promise.all([
    import(resolveDshModule('@deepseek-ai/cordis')), import(resolveDshModule('@deepseek-ai/dsh-llm')),
    import(resolveDshModule('@deepseek-ai/dsh-api-session-controller')), import('../plugin/index.mjs'), import('../src/backend.mjs'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-catalog-'));
  const ctx = new Context();
  let release, started, catalogs = 0, offline = true, changed = 0;
  const waiting = new Promise(resolve => { started = resolve; });
  const models = [{ value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-5-5', supportedEffortLevels: ['low', 'high'] }];
  const backend = new BridgeBackend({}, { stateDirectory: directory }, { helpers: {},
    createTransport: async () => ({ peer: { async request(method) {
      if (method === 'initialize') return { protocolVersion: 1, authenticated: true };
      assert.equal(method, 'catalog'); catalogs++;
      if (offline) { started(); return new Promise((_, reject) => { release = () => reject(Object.assign(new Error('synthetic offline'), { code: 'REMOTE_OFFLINE' })); }); }
      return { status: 'ok', models };
    } }, async close() {} }),
  });
  t.after(async () => {
    backend.onDisplayCatalogChanged = undefined;
    await backend.dispose();
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await backend.state.ready;
  await ctx.plugin(LlmRuntime);
  class OrdinaryAdapter extends LlmAdapter {
    listModels(provider) { return Promise.resolve([{ provider, id: 'ordinary-model', name: 'Ordinary' }]); }
    resolveModel(provider, id) { return Promise.resolve({ provider, id, name: 'Ordinary' }); }
  }
  ctx.llm.registerAdapter(['ordinary'], new OrdinaryAdapter());
  const provider = 'claude-sdk-remote';
  const oldSession = { header: { agentPreset: provider }, requestHeader: () => ({ config: { provider, model: 'old-model' } }) };
  const adapter = new ClaudeCatalogAdapter(backend, { sessions: { list: () => [oldSession] },
    sessionProjections: { stateOf: () => undefined } });
  const registration = ctx.llm.registerAdapter([provider], adapter);
  backend.onDisplayCatalogChanged = () => { changed++; registration.replace([provider]); };
  const controller = Object.create(SessionController.prototype);
  Object.defineProperty(controller, 'ctx', { value: { llm: ctx.llm,
    agentDefaultModel: { currentSelection: () => ({ provider, model: 'old-model' }) } } });
  const first = await controller.modelCatalog();
  await waiting; // The remote RPC is still pending; release has not been called.
  assert.equal(first.groups.find(group => group.id === 'ordinary').models[0].id, 'ordinary-model');
  assert.ok(first.groups.find(group => group.id === provider).models.some(model => model.id === 'old-model'));
  const selected = await ctx.llm.resolveModelInfo(provider, 'old-model');
  assert.equal(selected.id, 'old-model');
  assert.equal(selected.reasoning, undefined); assert.equal(selected.inputModalities, undefined);
  release();
  await backend.displayCatalogRefreshPending;
  const failed = await controller.modelCatalog();
  assert.equal(failed.groups.find(group => group.id === 'ordinary').models[0].id, 'ordinary-model');
  assert.equal((await ctx.llm.resolveModelInfo(provider, 'old-model')).id, 'old-model');
  assert.equal(catalogs, 1); assert.equal(changed, 0);
  offline = false; backend.displayCatalogRefreshAfter = 0;
  backend.refreshDisplayCatalog();
  await backend.displayCatalogRefreshPending;
  const refreshed = await controller.modelCatalog();
  assert.ok(refreshed.groups.find(group => group.id === provider).models.some(model => model.id === 'haiku'));
  assert.deepEqual((await ctx.llm.resolveModelInfo(provider, 'haiku')).reasoning.efforts.map(item => item.id), ['low', 'high']);
  assert.equal(catalogs, 2); assert.equal(changed, 1);
  t.diagnostic('使用安装版 LlmRuntime 注册、resolveModelInfo 及 SessionController.modelCatalog；远端 RPC 为受控 pending/offline，无 GUI 或 SDK 请求。');
});
