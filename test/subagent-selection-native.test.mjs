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
    const { Loader } = await import(resolveDshModule('@deepseek-ai/cordis-plugin-loader'));
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
    const queries = [];
    backend = new BridgeBackend(ctx, { stateDirectory: directory }, { helpers: {
      ...runtime, appendPluginRecord, resolveDshHome: () => directory,
    }, createTransport: async options => ({ peer: {
      async request(method, params) {
        if (method === 'initialize') return { protocolVersion: 1, authenticated: true };
        if (method === 'settle') return { status: 'cancelled', toolMayHaveExecuted: false };
        assert.equal(method, 'query');
        queries.push(params);
        await options.onNotification('sdk.message', { runId: params.runId, message: { type: 'assistant',
          message: { id: `fixture-${queries.length}`, model: params.model, content: [{ type: 'text', text: 'synthetic child answer' }] } } });
        await options.onNotification('sdk.message', { runId: params.runId, message: { type: 'result', subtype: 'success' } });
        return { status: 'completed' };
      }, async drainNotifications() {},
    }, async close() {} }) });
    backend.catalog = async () => catalog;
    backend.displayCatalog = async () => catalog;
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
    const create = async (id, reasoningEffort, ordinary = false) => (await ctx.agentLoop.createAgent(ctx, {
      sessionId: id, meta: { agentPreset: ordinary ? 'standard' : 'claude-sdk-remote', cwd: directory },
      agentOptions: { provider: ordinary ? 'ordinary' : 'claude-sdk-remote', model: ordinary ? 'fixture' : 'haiku', reasoningEffort },
      setup: async inner => { await ctx.agentPresets.mount(inner, ordinary ? 'standard' : 'claude-sdk-remote'); },
    })).agent;
    const signal = new AbortController().signal;
    const assemble = agent => ctx.systemPrompt.assemble({ agent, scope: agent, signal });

    // Interleave two installations sharing the preset generation. Each native
    // policy must capture its own cached catalog, even when the first read resolves last.
    const firstCatalog = Promise.withResolvers(), firstEntered = Promise.withResolvers();
    let reads = 0;
    backend.displayCatalog = async () => { if (++reads === 1) { firstEntered.resolve(); return firstCatalog.promise; } return { status: 'ok', models: [haiku] }; };
    const pendingA = create('remote-a', 'high');
    await firstEntered.promise;
    const b = await create('remote-b', 'low');
    firstCatalog.resolve(catalog);
    const a = await pendingA;
    backend.displayCatalog = async () => catalog;
    const ordinary = await create('ordinary', undefined, true);
    await Promise.all([assemble(a), assemble(b)]);
    await assemble(ordinary);
    const policy = agent => ctx.sessionProjections.stateOf(agent.session, 'subagentModelSelectionPolicy');
    assert.deepEqual(policy(a).map(row => row.model), ['haiku', 'sonnet']);
    assert.deepEqual(policy(b).map(row => row.model), ['haiku']);
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
      return { child, query, config: child.session.requestHeader().config };
    };
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
      const nested = ctx.agents.list().find(agent => agent.session.header.origin === 'subagent');
      await assemble(nested);
      await assert.rejects(definition(nested).execute({ description: 'too deep', prompt: 'synthetic' }, { agent: nested, signal }), /depth|深度/i);
      assert.equal(ctx.tools.get('subagent_fork', a), undefined);
      const before = queries.length;
      ordinary.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic ordinary' }] }));
      await ordinary.activityDone;
      assert.equal(queries.length, before);
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
      backend.displayCatalog = async () => catalog;
      const inherited = await run(offline);
      assert.equal(inherited.query.effort, 'high');
      const recovered = await create('remote-recovered', 'low');
      assert.ok(definition(recovered).parameters.properties.reasoning_effort);
    });
  });
