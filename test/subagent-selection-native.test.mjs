import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs';

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES);

test('实际 rc5：远程子代理选型按Agent隔离并进入真实spawn/header/Backend，普通委托保持原生',
  { skip: !native, timeout: 20000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-subagent-selection-'));
    const oldHome = process.env.DSH_HOME, oldAgentsHome = process.env.DSH_AGENTS_HOME;
    process.env.DSH_HOME = directory;
    process.env.DSH_AGENTS_HOME = join(directory, 'agents-home');
    const { Context, Service } = await import(resolveDshModule('@deepseek-ai/cordis'));
    const { LlmAdapter, createUserMessage } = await import(resolveDshModule('@deepseek-ai/dsh-llm'));
    const { Loader, EntryTree } = await import(resolveDshModule('@deepseek-ai/cordis-plugin-loader'));
    const { RoutedAgentLoop } = await import('../plugin/agent-loop.mjs');
    const { BridgeBackend } = await import('../src/backend.mjs');
    const { createClaudeCatalogAdapter } = await import('../plugin/catalog-adapter.mjs');
    const runtime = await import('../plugin/compat/runtime.mjs');
    const { appendPluginRecord } = await import(resolveDshModule('@deepseek-ai/dsh-session'));
    const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'));
    const official = async name => {
      const module = await import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
      return module.default ?? module;
    };
    const ctx = new Context();
    let backend;
    t.after(async () => {
      await ctx.fiber.dispose();
      await backend?.dispose();
      for (const [name, value] of [['DSH_HOME', oldHome], ['DSH_AGENTS_HOME', oldAgentsHome]]) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('dsh-subagent-selection-'));
      await rm(directory, { recursive: true, force: true });
    });
    await ctx.plugin(Loader, { baseUrl: resolveDshModule('@deepseek-ai/dsh-session') });
    for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-system-prompt', 'dsh-tools',
      'dsh-llm', 'dsh-agent-preset-registry', 'dsh-user-approval', 'dsh-fs-local', 'dsh-working-directory', 'dsh-subagent',
      'dsh-subagent-spawn-in-process']) {
      await ctx.plugin(await official(name), name === 'dsh-agent-preset-registry' ? { default: 'standard' }
        : name === 'dsh-working-directory' ? { defaultDirectory: directory }
        : name === 'dsh-fs-local' ? { cwd: directory } : {});
    }
    if (typeof ctx.tools.setExecutor === 'function') await ctx.plugin(await official('dsh-tool-executor-native'), {});
    const NativeSettings = await official('dsh-tool-subagent/model-selection-settings');
    class SettingsTree extends EntryTree { write() {} }
    const settingsTree = new SettingsTree(ctx.extend({ baseUrl: resolveDshModule('@deepseek-ai/dsh-session') }));
    const nativeSettings = enabled => ({ id: 'subagent-model-selection-settings',
      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings', inject: ['claudeSubagentPolicyGate'],
      config: { enabled, allowedModels: [{ provider: 'ordinary', model: 'fixture' }] } });
    await settingsTree.root.update([nativeSettings(true), { id: 'claude-subagent-settings-gate',
      name: new URL('../plugin/subagent-settings.mjs', import.meta.url).href }]);
    await settingsTree.await();
    ctx.effect(() => () => settingsTree.root.stop(), 'fixture settings tree');
    const settingsEntry = () => settingsTree.resolve('subagent-model-selection-settings');
    assert.equal(settingsEntry().fiber.runtime.Config, NativeSettings.Config);
    assert.ok(ctx.subagentModelSelection instanceof NativeSettings);
    await ctx.plugin(await official('dsh-session-persistence-jsonl'), { root: join(directory, 'sessions') });
    await ctx.agentPresets.register({ id: 'standard', plugins: [{ id: 'tool-subagent',
      name: pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-subagent')).href,
      config: { provider: 'spawn', modelSelectionSettings: false } }] });
    await ctx.agentPresets.register({ id: 'claude-sdk-remote', plugins: [{ id: 'tool-subagent',
      name: new URL('../plugin/remote-subagent.mjs', import.meta.url).href,
      config: { provider: 'spawn', modelSelectionSettings: true } }] });
    const haiku = { value: 'haiku', displayName: 'Fixture Haiku', supportedEffortLevels: ['low', 'high'] };
    const sonnet = { value: 'sonnet', displayName: 'Fixture Sonnet', supportedEffortLevels: ['medium', 'high'] };
    let catalog = { status: 'ok', models: [haiku, sonnet] };
    const queries = [], historyReads = [], cloudHistory = new Map();
    let historyFailure, pauseChild;
    backend = new BridgeBackend(ctx, { stateDirectory: directory }, { helpers: {
      ...runtime, appendPluginRecord, resolveDshHome: () => directory,
    }, createTransport: async options => ({ peer: {
      async request(method, params) {
        if (method === 'initialize') return { protocolVersion: 1, authenticated: true, capabilities: { historySync: true } };
        if (method === 'settle') return { status: 'cancelled', toolMayHaveExecuted: false };
        if (method === 'history') {
          historyReads.push(params);
          if (historyFailure) throw historyFailure;
          return { status: 'ok', sessionId: params.sessionId, records: cloudHistory.get(params.sessionId) ?? [],
            runs: {}, nextOffset: 1, lastUuid: 'synthetic-history', done: true };
        }
        assert.equal(method, 'query');
        queries.push(params);
        if (pauseChild && ctx.agents.get(params.dshSessionId)?.session.header.origin === 'subagent') {
          const pause = pauseChild; pauseChild = undefined;
          pause.entered.resolve();
          await pause.release.promise;
        }
        cloudHistory.set(params.sessionId, [{ type: 'assistant', uuid: 'synthetic-history',
          apiId: `fixture-${queries.length}`, model: params.model,
          content: [{ type: 'text', text: 'synthetic child answer' }] }]);
        await options.onNotification('sdk.message', { runId: params.runId, message: { type: 'assistant',
          message: { id: `fixture-${queries.length}`, model: params.model, content: [{ type: 'text', text: 'synthetic child answer' }] } } });
        await options.onNotification('sdk.message', { runId: params.runId, message: { type: 'result', subtype: 'success' } });
        return { status: 'completed' };
      }, async drainNotifications() {},
    }, async close() {} }) });
    backend.catalog = async () => catalog;
    await backend.saveModelPreferences({ enabledIds: ['haiku', 'sonnet'] });
    const cachedDisplay = async ({ visible = false } = {}) => {
      const enabled = new Set(backend.state.value.modelPreferences.enabledIds);
      return { ...catalog, models: catalog.models.filter(model => !visible || enabled.has(model.value)) };
    };
    backend.displayCatalog = cachedDisplay;
    backend.refreshDisplayCatalog = () => {};
    class Bridge extends Service {
      constructor(context) { super(context, 'claudeBridge'); this.backend = backend; }
      runStep(...args) { return backend.runStep(...args); }
    }
    await ctx.plugin(Bridge);
    const RemoteAdapter = createClaudeCatalogAdapter(LlmAdapter);
    ctx.llm.registerAdapter(['claude-sdk-remote'], new RemoteAdapter(backend, ctx));
    class OrdinaryAdapter extends LlmAdapter {
      async listModels(provider) { return [{ provider, id: 'fixture', name: 'Ordinary' }]; }
      async resolveModel(provider, id) { return { provider, id, name: 'Ordinary' }; }
      async *stream() { yield { type: 'text-delta', index: 0, text: 'ordinary' }; yield { type: 'finish', reason: { kind: 'stop' } }; }
    }
    ctx.llm.registerAdapter(['ordinary'], new OrdinaryAdapter());
    ctx.tools.register({ name: 'pwsh', description: '仅声明能力，禁止执行',
      parameters: { type: 'object', properties: { command: { type: 'string' }, workdir: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command'] },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => assert.fail('不执行真实shell') });
    await ctx.plugin(RoutedAgentLoop, { agents: [] });
    const activations = [], startActivation = ctx.subagents.startActivation;
    ctx.subagents.startActivation = function(spec) { activations.push(spec); return startActivation.call(this, spec); };
    const owners = new Map();
    const create = async (id, reasoningEffort, ordinary = false) => {
      const owner = await ctx.agentLoop.createAgent(ctx, {
        sessionId: id, meta: { agentPreset: ordinary ? 'standard' : 'claude-sdk-remote', cwd: directory },
        agentOptions: { provider: ordinary ? 'ordinary' : 'claude-sdk-remote', model: ordinary ? 'fixture' : 'haiku', reasoningEffort },
        setup: async inner => { await ctx.agentPresets.mount(inner, ordinary ? 'standard' : 'claude-sdk-remote'); },
      });
      owners.set(id, owner);
      return owner.agent;
    };
    const signal = new AbortController().signal;
    const assemble = agent => ctx.systemPrompt.assemble({ agent, scope: agent, signal });

    // Interleave two installations sharing the preset generation. Each native
    // policy must capture its own cached catalog, even when the first read resolves last.
    const firstCatalog = Promise.withResolvers(), firstEntered = Promise.withResolvers();
    let reads = 0;
    backend.displayCatalog = async options => {
      assert.equal(options, undefined); // Capture includes hidden routes, using only the cached snapshot.
      if (++reads === 1) { firstEntered.resolve(); return firstCatalog.promise; }
      return { status: 'ok', models: [haiku] };
    };
    const pendingA = create('remote-a', 'high');
    await firstEntered.promise;
    const b = await create('remote-b', 'low');
    firstCatalog.resolve(catalog);
    const a = await pendingA;
    backend.displayCatalog = cachedDisplay;
    const ordinary = await create('ordinary', undefined, true);
    await Promise.all([assemble(a), assemble(b)]);
    await assemble(ordinary);
    const policy = agent => ctx.sessionProjections.stateOf(agent.session, 'subagentModelSelectionPolicy');
    assert.deepEqual(policy(a).map(row => row.model), ['haiku', 'sonnet']);
    assert.deepEqual(policy(b).map(row => row.model), ['haiku']);
    if (typeof ctx.tools.setExecutor === 'function') assert.deepEqual(policy(ordinary), [{ provider: 'ordinary', model: 'fixture' }]);
    const definition = agent => ctx.tools.get('subagent', agent);
    assert.notEqual(definition(a), definition(b));
    assert.match(definition(a).parameters.properties.reasoning_effort.description, /model-default/);
    assert.equal(definition(ordinary).parameters.properties.reasoning_effort, undefined);
    assert.equal(ctx.tools.get('list_subagent_models', ordinary), undefined);
    const list = await ctx.tools.get('list_subagent_models', a).execute({ provider: 'claude-sdk-remote', model: 'sonnet' }, { agent: a, signal });
    assert.match(list, /medium/);
    assert.match(list, /high/);
    const run = async (parent, args = {}) => {
      const value = await definition(parent).execute({ description: 'synthetic selection', prompt: 'synthetic task', ...args }, { agent: parent, signal });
      const child = ctx.agents.get(value.subagentId);
      assert.ok(child);
      await child.activityDone;
      const query = queries.find(row => row.dshSessionId === child.id);
      assert.ok(query, child.session.snapshotEvents().filter(row => row.type.includes('error')));
      assert.deepEqual(policy(child), policy(parent));
      return { child, query, config: child.session.requestHeader().config };
    };
    await t.test('真实Host全局开关不采样远程策略，普通会话仍读取原生设置', async () => {
      await settingsEntry().update({ config: nativeSettings(false).config });
      assert.equal(policy(await create('ordinary-global-off', undefined, true)), null);
      assert.deepEqual(policy(await create('remote-global-off', 'high')).map(row => row.model), ['haiku', 'sonnet']);
      backend.displayCatalog = async () => { throw new Error('synthetic missing snapshot'); };
      try { assert.equal(policy(await create('remote-global-off-offline', 'high')), null); }
      finally { backend.displayCatalog = cachedDisplay; }
      await settingsEntry().update({ config: nativeSettings(true).config });
      const enabled = await create('ordinary-global-on', undefined, true);
      if (typeof ctx.tools.setExecutor === 'function') assert.deepEqual(policy(enabled), [{ provider: 'ordinary', model: 'fixture' }]);
    });
    await t.test('省略继承，以及同模型明确默认强度交错执行', async () => {
      const inherited = await run(a);
      assert.equal(inherited.child.options.reasoningEffort, 'high');
      assert.equal(inherited.config.reasoningEffort, 'high');
      assert.equal(inherited.query.effort, 'high');
      const defaulted = await run(a, { provider: 'claude-sdk-remote', model: 'haiku', reasoning_effort: 'model-default' });
      assert.equal(defaulted.child.options.model, 'haiku');
      assert.equal(defaulted.child.options.reasoningEffort, undefined);
      assert.equal(defaulted.config.reasoningEffort, undefined);
      assert.equal(defaulted.query.effort, undefined);
      const other = await run(b);
      assert.equal(other.config.reasoningEffort, 'low');
      assert.equal(other.query.effort, 'low');
    });
    await t.test('显式模型与强度到达child request/header/Backend，切模型省略强度使用默认', async () => {
      const picked = await run(a, { provider: 'claude-sdk-remote', model: 'sonnet', reasoning_effort: 'medium' });
      assert.equal(picked.child.options.model, 'sonnet');
      assert.equal(picked.child.options.reasoningEffort, 'medium');
      assert.equal(picked.config.model, 'sonnet');
      assert.equal(picked.config.reasoningEffort, 'medium');
      assert.equal(picked.query.model, 'sonnet');
      assert.equal(picked.query.effort, 'medium');
      const defaulted = await run(a, { provider: 'claude-sdk-remote', model: 'sonnet' });
      assert.equal(defaulted.config.reasoningEffort, undefined);
      assert.equal(defaulted.query.effort, undefined);
    });
    await t.test('allowlist与实时模型/强度、跨引擎及取消拒绝发生于子任务创建前', async () => {
      const count = ctx.agents.list().length;
      const invoke = (parent, args, callSignal = signal) => definition(parent).execute({ description: 'reject', prompt: 'synthetic', ...args }, { agent: parent, signal: callSignal });
      await assert.rejects(invoke(b, { provider: 'claude-sdk-remote', model: 'sonnet' }), /not allowed/);
      await assert.rejects(invoke(a, { provider: 'ordinary', model: 'fixture' }), /not allowed|同一 Claude/);
      await assert.rejects(invoke(a, { provider: 'claude-sdk-remote', model: 'missing' }), /not allowed/);
      await assert.rejects(invoke(a, { reasoning_effort: 'invalid-effort' }), /effort|强度/);
      catalog = { status: 'ok', models: [haiku] };
      await assert.rejects(invoke(a, { provider: 'claude-sdk-remote', model: 'sonnet' }), /目录/);
      catalog = { status: 'ok', models: [{ ...haiku, supportedEffortLevels: ['low'] }, sonnet] };
      await assert.rejects(invoke(a, { reasoning_effort: 'high' }), /effort|强度/);
      catalog = { status: 'ok', models: [haiku, sonnet] };
      const abort = new AbortController(); abort.abort();
      await assert.rejects(invoke(a, { reasoning_effort: 'model-default' }, abort.signal), { name: 'AbortError' });
      await assert.rejects(invoke(ordinary, { provider: 'claude-sdk-remote', model: 'haiku' }), /disabled/);
      assert.equal(ctx.agents.list().length, count);
    });
    await t.test('原生深度、不分叉及资源卸载仍保留', async () => {
      // A completed child may already be disposing its native scope. Hold one
      // real fake-transport query so this assertion addresses a live child.
      const pause = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
      pauseChild = pause;
      const value = await definition(a).execute({ description: 'live depth fixture', prompt: 'synthetic' }, { agent: a, signal });
      const nested = ctx.agents.get(value.subagentId);
      await pause.entered.promise;
      try {
        await assemble(nested);
        await assert.rejects(definition(nested).execute({ description: 'too deep', prompt: 'synthetic' }, { agent: nested, signal }), /depth|深度/i);
        assert.equal(ctx.tools.get('subagent_fork', a), undefined);
        const before = queries.filter(row => row.dshSessionId === ordinary.id).length;
        ordinary.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic ordinary' }] }));
        await ordinary.activityDone;
        assert.equal(queries.filter(row => row.dshSessionId === ordinary.id).length, before);
      } finally { pause.release.resolve(); await nested.activityDone; }
    });
    await t.test('缺少本机目录快照时只降级显式选择，创建与历史展示不访问live目录', async () => {
      const savedCatalog = backend.catalog;
      backend.catalog = async () => assert.fail('创建或展示不应访问live目录');
      backend.displayCatalog = async () => { throw new Error('synthetic missing snapshot'); };
      const offline = await create('remote-offline', 'high');
      const prompt = await assemble(offline);
      assert.ok(prompt.tools.some(tool => tool.name === 'subagent'));
      assert.equal(definition(offline).parameters.properties.reasoning_effort, undefined);
      assert.match(definition(offline).description, /only inherits/);
      assert.equal(ctx.tools.get('list_subagent_models', offline), undefined);
      assert.equal(policy(offline), null);
      backend.catalog = savedCatalog;
      backend.displayCatalog = cachedDisplay;
      const inherited = await run(offline);
      assert.equal(inherited.query.effort, 'high');
      const recovered = await create('remote-recovered', 'low');
      assert.ok(definition(recovered).parameters.properties.reasoning_effort);
    });
    await t.test('原生ordinary resolver拒绝live子代理，bridge历史同步复用真实owner且不改变续聊入口', async subtest => {
      const { SessionController } = await import(resolveDshModule('@deepseek-ai/dsh-api-session-controller'));
      const { ClaudeBridgeService } = await import('../plugin/index.mjs');
      // Only inert gateway/file-upload registration is supplied. The actual
      // installed controller constructs and owns its native Agent resolver.
      class Typert extends Service {
        constructor(inner) {
          super(inner, 'typert');
          this.resources = { register() {} };
          this.lookups = { configure() {} };
          this.contexts = { configureHost() {} };
        }
      }
      class Uploads extends Service {
        constructor(inner) { super(inner, 'fileUploads'); }
        registerAgentResolver() { return () => {}; }
      }
      class Queries extends Service {
        constructor(inner) { super(inner, 'sessionQuery'); }
        async observeSession(sessionId) {
          assert.equal(sessionId, 'cold-persisted-child');
          return { header: { id: sessionId, agentPreset: 'claude-sdk-remote', origin: 'subagent',
            parentSession: a.id, cwd: directory }, [Symbol.dispose]() {} };
        }
      }
      await ctx.plugin(Typert);
      await ctx.plugin(Uploads);
      await ctx.plugin(Queries);
      let controller;
      const controllerOwner = ctx.plugin({ inject: ['typert', 'sessions', 'agents', 'sessionProjections', 'fileUploads', 'sessionQuery'],
        apply: async inner => {
          controller = new SessionController(inner, {});
          // Newer Hosts install this resolver in Service.init; retain the same
          // native resolver without starting unrelated file/list/gateway services.
          if (!controller.agents) {
            const { ApiSessionAgentController } = await import(new URL('./types/agent.js',
              resolveDshModule('@deepseek-ai/dsh-api-session-controller')).href);
            controller.agents = new ApiSessionAgentController(inner);
            controller.agents.initialize();
          }
        } });
      await controllerOwner;
      // Completed managed activations may already have released their Agent.
      // This test needs a resident idle owner, so retain the native factory's
      // handle explicitly and give its real loop one fake-transport turn.
      const childOwner = await ctx.agentLoop.createAgent(ctx, {
        sessionId: 'resolver-live-child',
        meta: { agentPreset: 'claude-sdk-remote', origin: 'subagent', parentSession: a.id,
          delegationDepth: 1, cwd: directory },
        agentOptions: { provider: 'claude-sdk-remote', model: 'haiku', reasoningEffort: 'high' },
        setup: async inner => { await ctx.agentPresets.mount(inner, 'claude-sdk-remote'); },
      });
      subtest.after(() => childOwner.dispose());
      const child = childOwner.agent;
      assert.ok(child);
      child.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic resolver child' }] }));
      await child.activityDone;
      assert.equal(child.phase.kind, 'idle');
      assert.equal(ctx.agents.get(child.id), child);
      assert.equal(queries.filter(row => row.dshSessionId === child.id).length, 1);
      const nativeRejection = await controller.resolveAgent(child.id);
      assert.equal(nativeRejection.error.code, 'session/agent-busy');
      assert.equal(nativeRejection.error.details.reason, 'use subagent delivery for this child session');
      const host = Object.create(ClaudeBridgeService.prototype);
      Object.defineProperty(host, 'ctx', { value: ctx });
      host.backend = backend;
      host.assertOwner = () => {}; // No transport/principal is involved in this fixture.
      const queryCount = queries.length;
      const first = await host.syncSession(child.id);
      assert.equal(first.status, 'ready');
      assert.equal(first.added, 0);
      assert.equal(child._bridgeStatus.recovery.status, 'ready');
      assert.equal(historyReads.at(-1).dshSessionId, child.id);
      assert.equal(ctx.agents.get(child.id), child);
      assert.equal((await host.syncSession(child.id)).added, 0);
      assert.equal(queries.length, queryCount);
      assert.equal((await controller.resolveAgent(child.id)).error.code, 'session/agent-busy');
      assert.equal((await host.syncSession(ordinary.id)).status, 'not-remote');
      assert.equal((await controller.resolveAgent(a.id)).agent, a);
      historyFailure = Object.assign(new Error('synthetic history failure'), { code: 'FIXTURE_HISTORY_UNAVAILABLE' });
      await assert.rejects(host.syncSession(child.id), { code: 'FIXTURE_HISTORY_UNAVAILABLE' });
      assert.equal(child._bridgeStatus.recovery.status, 'unavailable');
      assert.equal(child._bridgeStatus.recovery.code, 'FIXTURE_HISTORY_UNAVAILABLE');
      historyFailure = undefined;
      assert.equal((await host.syncSession(child.id)).status, 'ready');
      assert.equal(child._bridgeStatus.recovery.code, undefined);

      // An attached cold child has a Session, never a replacement Agent or a
      // fabricated idle phase. Its existing history is explicitly read-only.
      const cold = ctx.sessions.create('cold-remote-child', { meta: { agentPreset: 'claude-sdk-remote',
        origin: 'subagent', parentSession: a.id, cwd: directory, delegationDepth: 1 } });
      assert.equal(ctx.agents.get(cold.id), undefined);
      const readsBeforeCold = historyReads.length;
      assert.deepEqual(await host.syncSession(cold.id), { status: 'read-only' });
      assert.equal(ctx.agents.get(cold.id), undefined);
      assert.equal(historyReads.length, readsBeforeCold);
      await backend.state.binding('cold-persisted-child', directory);
      assert.equal(ctx.sessions.get('cold-persisted-child'), undefined);
      assert.deepEqual(await host.syncSession('cold-persisted-child'), { status: 'read-only' });
      assert.equal(ctx.agents.get('cold-persisted-child'), undefined);
      assert.equal(historyReads.length, readsBeforeCold);
      assert.equal((await host.syncSession(a.id)).status, 'ready');
      await controllerOwner.dispose();
    });
    await t.test('用户勾选只过滤列表，隐藏真实型号仍能显式调用，空列表不收窄完整账号策略', async () => {
      const invoke = args => definition(a).execute({ description: 'catalog validation', prompt: 'synthetic', ...args }, { agent: a, signal });
      const listModels = args => ctx.tools.get('list_subagent_models', a).execute({ provider: 'claude-sdk-remote', ...args }, { agent: a, signal });
      assert.deepEqual(policy(a).map(row => row.model), ['haiku', 'sonnet']);
      await backend.saveModelPreferences({ enabledIds: ['haiku'] });
      const listed = await listModels({});
      assert.match(listed, /haiku/);
      assert.doesNotMatch(listed, /sonnet/);
      assert.match(await listModels({ model: 'sonnet' }), /sonnet[\s\S]*medium/);
      const selected = await run(a, { provider: 'claude-sdk-remote', model: 'sonnet', reasoning_effort: 'medium' });
      assert.equal(selected.query.model, 'sonnet');
      assert.equal(selected.query.effort, 'medium');
      assert.equal(selected.config.model, 'sonnet');
      const activationCount = activations.length;
      for (const args of [{ provider: 'claude-sdk-remote' }, { model: 'sonnet' }]) {
        await assert.rejects(invoke(args), /must be supplied together/);
      }
      await assert.rejects(invoke({ provider: 'claude-sdk-remote', model: 'missing' }), /not allowed/);
      await assert.rejects(listModels({ model: 'missing' }), /not allowed/);
      assert.equal(activations.length, activationCount);
      // New Sessions capture every cached account route, including hidden ones,
      // without making a live call or expanding an existing durable policy.
      const savedCatalog = backend.catalog;
      backend.catalog = async () => assert.fail('捕获完整账号快照不应读取live目录');
      const captured = await create('remote-full-capture', 'high');
      assert.deepEqual(policy(captured).map(row => row.model), ['haiku', 'sonnet']);
      backend.catalog = savedCatalog;
      await backend.saveModelPreferences({ enabledIds: [] });
      assert.match(await listModels({}), /no advertised models/);
      const allHidden = await create('remote-all-hidden', 'high');
      assert.deepEqual(policy(allHidden).map(row => row.model), ['haiku', 'sonnet']);
      assert.ok(definition(allHidden).parameters.properties.reasoning_effort);
      assert.match(await ctx.tools.get('list_subagent_models', allHidden).execute({ provider: 'claude-sdk-remote' }, { agent: allHidden, signal }), /no advertised models/);
      const hidden = await run(allHidden, { provider: 'claude-sdk-remote', model: 'sonnet', reasoning_effort: 'medium' });
      assert.equal(hidden.query.model, 'sonnet');
      assert.equal(hidden.query.effort, 'medium');
      const defaulted = await run(a, { reasoning_effort: 'model-default' });
      assert.equal(defaulted.query.model, 'haiku');
      assert.equal(defaulted.query.effort, undefined);
      const inherited = await run(a);
      assert.equal(inherited.query.model, 'haiku');
      assert.equal(inherited.query.effort, 'high');
      assert.equal(a.options.model, 'haiku');
      assert.equal(a.options.reasoningEffort, 'high');
      await backend.saveModelPreferences({ enabledIds: ['haiku', 'sonnet'] });
      assert.match(await listModels({}), /sonnet/);
    });
    await t.test('目录中已失效的捕获型号和不支持的强度明确拒绝，不创建child或回退其它型号', async () => {
      const invoke = args => definition(a).execute({ description: 'invalid catalog choice', prompt: 'synthetic', ...args }, { agent: a, signal });
      const activationCount = activations.length;
      try {
        await assert.rejects(invoke({ provider: 'claude-sdk-remote', model: 'sonnet', reasoning_effort: 'low' }), /effort|强度/);
        catalog = { status: 'ok', models: [haiku] };
        await assert.rejects(invoke({ provider: 'claude-sdk-remote', model: 'sonnet', reasoning_effort: 'medium' }), /目录/);
        await assert.rejects(ctx.tools.get('list_subagent_models', a).execute({ provider: 'claude-sdk-remote', model: 'sonnet' }, { agent: a, signal }), /目录/);
        assert.equal(activations.length, activationCount);
        assert.equal(a.options.model, 'haiku');
        assert.equal(a.options.reasoningEffort, 'high');
      } finally {
        catalog = { status: 'ok', models: [haiku, sonnet] };
        await backend.saveModelPreferences({ enabledIds: ['haiku', 'sonnet'] });
      }
    });
    await t.test('恢复既有策略或无策略seeded历史时，不采样全局或扩展Claude允许列表', async () => {
      const restore = async id => {
        await owners.get(id).dispose();
        const owner = await ctx.agentLoop.resume(ctx, { resumeSessionId: id,
          agentOptions: { provider: 'claude-sdk-remote', model: 'haiku' },
          setup: async inner => { await ctx.agentPresets.mount(inner, 'claude-sdk-remote'); } });
        owners.set(id, owner);
        return owner.agent;
      };
      const captured = await create('remote-policy-restored', 'high');
      const before = policy(captured);
      backend.displayCatalog = async () => ({ status: 'ok', models: [haiku] });
      try {
        const restored = await restore(captured.id);
        assert.deepEqual(policy(restored), before);
        assert.equal(restored.session.snapshotEvents().filter(row => row.type === 'subagent/model-selection-policy').length, 1);
      } finally { backend.displayCatalog = cachedDisplay; }
      for (const allowedModels of [undefined, [{ provider: 'claude-sdk-remote', model: 'haiku' }]]) {
        const id = allowedModels ? 'remote-seeded-policy' : 'remote-seeded-no-policy';
        const record = allowedModels
          ? { type: 'subagent/model-selection-policy', data: { allowedModels } }
          : { type: 'plugin:fixture/seed', ignorable: true, data: { version: 1 } };
        const owner = await ctx.agentLoop.createAgent(ctx, { sessionId: id, seed: [{ seq: 0, time: 0, ...record }],
          meta: { agentPreset: 'claude-sdk-remote', cwd: directory },
          agentOptions: { provider: 'claude-sdk-remote', model: 'haiku' },
          setup: async inner => { await ctx.agentPresets.mount(inner, 'claude-sdk-remote'); } });
        owners.set(id, owner);
        assert.deepEqual(policy(owner.agent), allowedModels ?? null);
        assert.deepEqual(policy(await restore(id)), allowedModels ?? null);
      }
      // Disposing the wrapper releases the real native service and its listener;
      // remounting the original service restores ordinary Host behavior.
      const original = nativeSettings(true);
      delete original.inject;
      await settingsTree.root.update([original]);
      await settingsTree.await();
      const ordinaryRestored = await create('ordinary-native-restored', undefined, true);
      if (typeof ctx.tools.setExecutor === 'function') assert.deepEqual(policy(ordinaryRestored), [{ provider: 'ordinary', model: 'fixture' }]);
      await settingsTree.root.update([nativeSettings(true), { id: 'claude-subagent-settings-gate',
        name: new URL('../plugin/subagent-settings.mjs', import.meta.url).href }]);
      await settingsTree.await();
      assert.deepEqual(policy(await create('remote-gate-reinstalled', 'high')).map(row => row.model), ['haiku', 'sonnet']);
      const ordinaryReinstalled = await create('ordinary-gate-reinstalled', undefined, true);
      if (typeof ctx.tools.setExecutor === 'function') assert.deepEqual(policy(ordinaryReinstalled), [{ provider: 'ordinary', model: 'fixture' }]);
      await settingsTree.root.update([]);
      await settingsTree.await();
      assert.equal(ctx.get('claudeSubagentPolicyGate'), undefined);
    });
  });
