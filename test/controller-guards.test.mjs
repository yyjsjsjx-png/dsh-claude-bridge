import test from 'node:test';
import assert from 'node:assert/strict';
import { makeGuardedSessionController, makeLockedPresetRegistry } from '../plugin/controller-guards.mjs';
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

test('远程消息分支在创建分叉前拒绝，不写入新会话', async () => {
  const { controller, getWrites } = harness();
  await controller.create({ agentPreset: encodeRemoteCreationSelection({
    provider: 'claude-sdk-remote', model: 'account-default',
  }) });
  const writes = getWrites();
  await assert.rejects(controller.fork({ sessionId: 's', turn: 1 }), error => {
    assert.equal(error.code, 'session/fork-unavailable');
    assert.equal(error.message, '远程 Claude 会话不支持分叉，请新建会话。');
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

test('预设守卫在首轮之前也拒绝更改且不会重组', async () => {
  let calls = 0;
  class Base { async select() { calls++; } }
  const Registry = makeLockedPresetRegistry(Base, FakeRemoteError);
  const session = { id: 's', header: { agentPreset: 'standard' } };
  const agent = { id: 's', session };
  const registry = new Registry({ sessionProjections: { stateOf: () => 'standard' } }, {});
  await assert.rejects(registry.select(agent, 'claude-sdk-remote'), error => {
    assert.equal(error.code, 'agent-preset/locked');
    assert.equal(error.message, '请通过“新建远程 Claude”创建会话。');
    return true;
  });
  assert.equal(await registry.select(agent, 'standard'), 'standard');
  assert.equal(calls, 0);
});
