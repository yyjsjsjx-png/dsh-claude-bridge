import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGuardedSessionController, makeLockedPresetRegistry, installControllerGuards } from '../plugin/controller-guards.mjs';
import { encodeRemoteCreationSelection } from '../plugin/policy.mjs';

class FakeRemoteError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}

function harness() {
  let created;
  let writes = 0;
  const ctx = {
    agentPresets: { defaultId: 'standard' },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v1' }) },
    workspaceRegistry: { get: id => id === 'w' ? { path: 'fixture', sessionIds: ['s'] } : undefined,
      archivedSessionIds: [] },
    sessions: { get: () => undefined },
    sessionQuery: { observeSession: async () => { throw Object.assign(new Error('absent'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }); } },
    sessionProjections: { stateOf(session, key) {
      return key === 'agentPreset' ? session.preset : key === 'modelSelection' ? session.modelSelection : undefined;
    } },
    llm: {
      listModels: async provider => [{ provider, id: 'account-default' }],
      resolveCallConfig: async selection => selection,
    },
  };
  class Base {
    static inject = [];
    constructor() { this.agent = undefined; }
    async resolveAgent() { return { agent: this.agent }; }
    async create(request) {
      created = request;
      const session = { id: 's', preset: request.agentPreset,
        header: { agentPreset: request.agentPreset, cwd: 'fixture' }, modelSelection: { pending: null },
        requestHeader: () => undefined };
      this.agent = { id: 's', session };
      return { sessionId: 's', agentPreset: request.agentPreset };
    }
    async selectModel(request) {
      writes++;
      this.agent.session.modelSelection.pending = { provider: request.provider, model: request.model };
      return { selected: request };
    }
    async prompt() { writes++; return { accepted: true }; }
    async fork() { writes++; return { sessionId: 'fork' }; }
  }
  const Controller = makeGuardedSessionController(Base, FakeRemoteError);
  return { ctx, controller: new Controller(ctx, {}), getCreated: () => created, getWrites: () => writes };
}

test('远程新建先确认模型，自动设置预设并持久化选择', async () => {
  const { controller, getCreated, getWrites } = harness();
  await assert.rejects(controller.create({ agentPreset: 'claude-sdk-remote' }), /必须选择模型/);
  const session = await controller.create({ agentPreset: encodeRemoteCreationSelection({
    provider: 'claude-sdk-remote', model: 'account-default',
  }) });
  assert.equal(session.agentPreset, 'claude-sdk-remote');
  assert.equal(getCreated().agentPreset, 'claude-sdk-remote');
  assert.equal(getWrites(), 1);
});

test('重启可恢复已选模型的远程空白会话，不会生成无模型的新会话', async () => {
  const { controller, getCreated } = harness();
  await controller.create({ agentPreset: encodeRemoteCreationSelection({
    provider: 'claude-sdk-remote', model: 'account-default',
  }) });
  const created = getCreated();
  const restored = await controller.create({ workspaceId: 'w', sessionId: 's', agentPreset: 'claude-sdk-remote' });
  assert.equal(restored.sessionId, 's');
  assert.equal(getCreated(), created);
  controller.agent.session.modelSelection.pending = null;
  await assert.rejects(controller.create({ workspaceId: 'w', sessionId: 's', agentPreset: 'claude-sdk-remote' }), /没有有效的已选模型/);
  assert.equal(getCreated(), created);
});

test('会话锁定引擎并在写入模型选择前拒绝跨引擎', async () => {
  const { controller, getWrites } = harness();
  await controller.create({});
  await assert.rejects(controller.selectModel({ sessionId: 's', provider: 'claude-sdk-remote', model: 'account-default' }), /不能切换执行引擎/);
  assert.equal(getWrites(), 0);
});

test('旧版遗留远程全局默认在普通会话创建前给出专用入口提示', async () => {
  const { ctx, controller, getCreated } = harness();
  ctx.agentDefaultModel.currentSelection = () => ({ provider: 'claude-sdk-remote', model: 'account-default' });
  await assert.rejects(controller.create({}), error => {
    assert.equal(error.code, 'session/model-unavailable');
    assert.match(error.message, /新建远程会话/);
    return true;
  });
  assert.equal(getCreated(), undefined);
  await controller.create({ agentPreset: encodeRemoteCreationSelection({
    provider: 'claude-sdk-remote', model: 'account-default',
  }) });
  assert.equal(getCreated().agentPreset, 'claude-sdk-remote');
});

test('只有模型选择成功后记住归一化选型，失败保留上次选择', async () => {
  const { ctx, controller } = harness();
  const remembered = [];
  ctx.get = () => ({ backend: { rememberCreationSelection: async selected => remembered.push(selected) } });
  await controller.create({ agentPreset: encodeRemoteCreationSelection({
    provider: 'claude-sdk-remote', model: 'account-default', reasoningEffort: 'low',
  }) });
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0].reasoningEffort, 'low');
  await assert.rejects(controller.selectModel({ sessionId: 's', provider: 'deepseek', model: 'v1' }));
  assert.equal(remembered.length, 1);
});

test('实例守卫保留原生身份，隔离全局默认，并在卸载或失败时完整恢复', async () => {
  const { ctx, controller } = harness();
  const basePrototype = Object.getPrototypeOf(Object.getPrototypeOf(controller));
  Object.setPrototypeOf(controller, basePrototype);
  delete controller.bridgeContext;
  ctx.sessionController = controller;
  const selected = [];
  class Defaults {
    currentSelection() { return { provider: 'deepseek', model: 'v1' }; }
    async saveSelection(value) { selected.push(value); }
  }
  class Presets { defaultId = 'standard'; async select() {} }
  ctx.agentPresets = new Presets();
  ctx.agentDefaultModel = new Defaults();
  const originalCreate = controller.create, originalSave = ctx.agentDefaultModel.saveSelection;
  const dispose = installControllerGuards(ctx, FakeRemoteError);
  assert.equal(Object.getPrototypeOf(controller), basePrototype);
  await controller.create({});
  await ctx.agentDefaultModel.saveSelection({ provider: 'claude-sdk-remote', model: 'account-default' });
  await ctx.agentDefaultModel.saveSelection({ provider: 'deepseek', model: 'v2' });
  assert.deepEqual(selected, [{ provider: 'deepseek', model: 'v2' }]);
  await assert.rejects(controller.selectModel({ sessionId: 's', provider: 'claude-sdk-remote', model: 'account-default' }));
  dispose(); dispose();
  assert.equal(controller.create, originalCreate);
  assert.equal(ctx.agentDefaultModel.saveSelection, originalSave);
  assert.equal(Object.hasOwn(controller, 'create'), false);
  assert.equal(Object.hasOwn(controller, 'bridgeContext'), false);
  Object.defineProperty(ctx.agentPresets, 'select', { value: 1, configurable: true });
  assert.throws(() => installControllerGuards(ctx, FakeRemoteError), /接口不兼容/);
  assert.equal(ctx.agentDefaultModel.saveSelection, originalSave);
  assert.equal(controller.create, originalCreate);
});

test('远程消息分支在创建分叉前拒绝，不写入新会话', async () => {
  const { controller, getWrites } = harness();
  await controller.create({ agentPreset: encodeRemoteCreationSelection({
    provider: 'claude-sdk-remote', model: 'account-default',
  }) });
  const writes = getWrites();
  await assert.rejects(controller.fork({ sessionId: 's', turn: 1 }), error => {
    assert.equal(error.code, 'session/fork-unavailable');
    assert.equal(error.message, '远程会话不支持分叉，请新建会话。');
    return true;
  });
  assert.equal(getWrites(), writes);
});

test('普通 DSH 会话仍沿用原生分叉', async () => {
  const { controller, getWrites } = harness();
  await controller.create({});
  assert.deepEqual(await controller.fork({ sessionId: 's', turn: 1 }), { sessionId: 'fork' });
  assert.equal(getWrites(), 1);
});

test('远程引擎预设守卫不代替普通会话的原生预设选择', async () => {
  let calls = 0;
  class Base { async select(_agent, preset) { calls++; return preset; } }
  const Registry = makeLockedPresetRegistry(Base, FakeRemoteError);
  const session = { id: 's', header: { agentPreset: 'standard' } };
  const agent = { id: 's', session };
  const registry = new Registry({ sessionProjections: { stateOf: () => 'standard' } }, {});
  await assert.rejects(registry.select(agent, 'claude-sdk-remote'), error => {
    assert.equal(error.code, 'agent-preset/locked');
    assert.equal(error.message, '请通过“新建远程会话”创建会话。');
    return true;
  });
  assert.equal(await registry.select(agent, 'standard'), 'standard');
  assert.equal(await registry.select(agent, 'custom'), 'custom');
  assert.equal(calls, 2);
  session.header.agentPreset = 'claude-sdk-remote';
  registry.bridgeContext.sessionProjections.stateOf = () => 'claude-sdk-remote';
  await assert.rejects(registry.select(agent, 'standard'), /不能切换预设/);
  assert.equal(await registry.select(agent, 'claude-sdk-remote'), 'claude-sdk-remote');
  assert.equal(calls, 2);
});

test('普通原生预设投影切换后仍可选择普通模型、提示和分叉，跨远程引擎仍拒绝', async () => {
  const { controller, getWrites } = harness();
  await controller.create({});
  controller.agent.session.preset = 'custom';
  await controller.selectModel({ sessionId: 's', provider: 'deepseek', model: 'v1' });
  await controller.prompt({ sessionId: 's' });
  await controller.fork({ sessionId: 's', turn: 1 });
  assert.equal(getWrites(), 3);
  await assert.rejects(controller.selectModel({ sessionId: 's', provider: 'claude-sdk-remote', model: 'account-default' }));
});
