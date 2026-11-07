import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDshModule, readShippedStandardPreset } from '../plugin/compat/resolve-dsh-module.mjs';
import { createBasicRemoteClaudePreset, createOwnedRemoteClaudePreset as ownedPreset, createRemoteClaudePreset as adaptedPreset } from '../plugin/preset.mjs';
import { remotePresetStatus } from '../plugin/preset-loading.mjs';
import { toMcpToolDefinitions, toSdkPrompt } from '../src/dsh-content.mjs';
import { prepareRequestAssembly } from '../src/request-preparation.mjs';
import { executeNativeTool } from './fixtures/native-tools.mjs';

const native = Boolean(process.platform === 'win32' && process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES);

test('实际 rc5：远程组件隔离、基础回退及卸载不改变普通会话', { skip: !native, timeout: 30000 }, async t => {
  const { Context } = await import(resolveDshModule('@deepseek-ai/cordis'));
  const { createScope } = await import(resolveDshModule('@deepseek-ai/dsh-scope'));
  const { Session, SESSION_FORMAT_VERSION } = await import(resolveDshModule('@deepseek-ai/dsh-session'));
  const { Loader, Group, EntryTree } = await import(resolveDshModule('@deepseek-ai/cordis-plugin-loader'));
  const { loadYaml, entryListSchema, renderPrompt } = await import('../plugin/compat/runtime.mjs');
  const { resolvePluginResource } = await import(resolveDshModule('@deepseek-ai/dsh-app-boot'));
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'));
  const official = async name => {
    const module = await import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
    return module.default ?? module;
  };
  const nativeSubagent = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-subagent')).href);
  const createOwnedRemoteClaudePreset = () => ownedPreset(nativeSubagent.Config.dict);
  const createRemoteClaudePreset = standard => adaptedPreset(standard, nativeSubagent.Config.dict);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-preset-'));
  const workdir = join(directory, 'workspace');
  await mkdir(workdir);
  const ctx = new Context();
  try {
    const shipped = readShippedStandardPreset();
    await ctx.plugin(Loader, { baseUrl: shipped.baseUrl });
    ctx.loader.builtins.group = Group;
    for (const [name, config] of [
      ['dsh-system-prompt', {}], ['dsh-tools', {}], ['dsh-session-projection', {}],
      ['dsh-agent', {}],
      ['dsh-fs-local', { cwd: workdir }], ['dsh-working-directory', { defaultDirectory: workdir }],
      ['dsh-shell-env', { dshHome: directory }], ['dsh-subprocess-local', {}],
      ['dsh-pwsh-local', { cwd: workdir }], ['dsh-user-approval', { policy: 'ask' }],
    ]) await ctx.plugin(await official(name), config);
    if (typeof ctx.tools.setExecutor === 'function') await ctx.plugin(await official('dsh-tool-executor-native'), {});
    ctx.systemPrompt.section({ name: 'ordinary-canary', order: -2000, text: 'ordinary-preserved' });
    const ordinaryBefore = await ctx.systemPrompt.assemble();
    const basicPlugins = createBasicRemoteClaudePreset('win32').plugins;
    const broken = join(directory, 'broken.mjs');
    await writeFile(broken, `export const inject = ['systemPrompt'];
export function apply(ctx) {
  ctx.systemPrompt.section({name:'failed-extension',order:1234,text:'MUST-BE-CLEANED'});
  throw new Error('controlled optional failure');
}
`);
    const mount = async (plugins, mode = 'full', baseUrl = shipped.baseUrl, noticeReasons = [], fallbackPlugins = basicPlugins) => {
      const key = { id: 'native-preset-agent', inject() {} };
      const scope = createScope(ctx, key);
      key.ctx = scope.ctx;
      key.session = Session.create(key.id, undefined, { version: SESSION_FORMAT_VERSION,
        id: key.id, createdAt: 0, isSeeded: false, agentPreset: 'claude-sdk-remote',
        delegationDepth: 0, cwd: workdir });
      try {
        class OuterTree extends EntryTree { write() {} }
        let tree;
        await scope.ctx.inject(['loader'], async child => {
          tree = new OuterTree(child.extend({ baseUrl }));
          child.effect(() => () => tree.root.stop());
          await tree.root.update([{ id: 'remote-container', name: new URL('../plugin/remote-composition.mjs', import.meta.url).href,
            config: { plugins, basicPlugins: fallbackPlugins, shell: 'pwsh', baseUrl, mode, reasons: [], noticeReasons } }]);
        });
        await tree.await();
        const entry = [...tree.entries()].find(row => row.options.id === 'remote-container');
        assert.ok(entry?.fiber);
        await entry.fiber.await();
        assert.ok([...tree.entries()].some(row => row.options.id === 'tool-pwsh'));
        return { scope, key, tree, assembly: await ctx.systemPrompt.assemble({ scope: key }) };
      } catch (error) { await scope.dispose(); throw error; }
    };

    await t.test('远程指令审计映射由加载回退管理，不检查未使用的基础组合', async () => {
      const unsupported = basicPlugins.map(row => row.id === 'agent-instructions'
        ? { ...row, name: 'unsupported-instruction-component' } : row);
      const control = await mount(basicPlugins);
      const expectedMode = remotePresetStatus(ctx).mode;
      const expectedTools = control.assembly.tools;
      await control.scope.dispose();
      const normal = await mount(basicPlugins, 'full', shipped.baseUrl, [], unsupported);
      try {
        assert.equal(remotePresetStatus(ctx).mode, expectedMode);
        assert.deepEqual(normal.assembly.tools, expectedTools);
      }
      finally { await normal.scope.dispose(); }
      const fallback = await mount(unsupported);
      try {
        assert.equal(remotePresetStatus(ctx).mode, 'basic');
        assert.ok(fallback.assembly.tools.some(tool => tool.name === 'pwsh'));
      } finally { await fallback.scope.dispose(); }
    });

    await t.test('可选组件抛错后其提示词被清理，shell 保留', async () => {
      const mounted = await mount([...basicPlugins, { id: 'optional-broken', name: pathToFileURL(broken).href }]);
      try {
        assert.equal(remotePresetStatus(ctx).mode, 'degraded');
        assert.ok(remotePresetStatus(ctx).disabledComponents.some(item => item.name === 'optional-broken'));
        assert.ok(mounted.assembly.tools.some(tool => tool.name === 'pwsh'));
        assert.equal(mounted.assembly.sections.some(section => section.name === 'failed-extension'), false);
      } finally { await mounted.scope.dispose(); }
    });
    await t.test('完整预设的 shell 无法导入后，基础 shell 真正挂载', async () => {
      const mounted = await mount(basicPlugins.map(row => row.id === 'tool-pwsh'
        ? { ...row, name: pathToFileURL(join(directory, 'absent-shell.mjs')).href } : row));
      try {
        assert.equal(remotePresetStatus(ctx).mode, 'basic');
        assert.equal(mounted.assembly.tools.filter(tool => tool.name === 'pwsh').length, 1);
        assert.match(mounted.assembly.sections.find(section => section.name === 'claude-bridge:preset-capabilities').text, /基础预设/);
      } finally { await mounted.scope.dispose(); }
    });
    await t.test('自有完整声明与标准适配含同一显式时间隐私覆盖，其余声明与原生最终提示及工具全量等价', async () => {
      const patches = loadYaml(shipped.content, { schema: entryListSchema });
      const standard = patches.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-standard').config;
      const legacy = createRemoteClaudePreset(standard);
      const owned = createOwnedRemoteClaudePreset();
      const standardClock = standard.plugins.find(row => row.name === '@deepseek-ai/dsh-time-context');
      assert.equal(standardClock.id, 'time-context');
      assert.equal(standardClock.disabled, undefined);
      assert.deepEqual(owned.plugins.find(row => row.id === 'time-context'), { ...standardClock, disabled: true });
      assert.deepEqual(owned, legacy);
      const nativeBaseUrl = resolveDshModule('@deepseek-ai/cordis');
      const nativeNames = new Set();
      const collectNames = rows => {
        for (const row of rows) {
          if (row.name.startsWith('@deepseek-ai/')) nativeNames.add(row.name);
          if (row.group === true && Array.isArray(row.config)) collectNames(row.config);
        }
      };
      collectNames(owned.plugins);
      for (const name of nativeNames) {
        assert.equal(resolvePluginResource(name, nativeBaseUrl), resolvePluginResource(name, shipped.baseUrl), name);
      }
      const snapshots = [];
      for (const [preset, baseUrl] of [[legacy, shipped.baseUrl], [owned, nativeBaseUrl]]) {
        const mounted = await mount(preset.plugins, 'full', baseUrl);
        try {
          // This fixture mounts the real available components, isolating optional
          // dependencies it does not provide. It is not a full desktop acceptance.
          const status = structuredClone(remotePresetStatus(ctx));
          assert.ok(['full', 'degraded'].includes(status.mode));
          const converted = toMcpToolDefinitions(mounted.assembly.tools);
          const prepared = prepareRequestAssembly({ assembly: mounted.assembly, converted, renderPrompt,
            admitShell: (assembly, tools) => {
              assert.equal(assembly.tools.filter(tool => tool.name === 'pwsh').length, 1);
              assert.equal(tools.tools.filter(tool => tool.name === 'pwsh').length, 1);
            } });
          snapshots.push({ prompt: prepared.renderSystemPrompt(), tools: prepared.assembly.tools,
            converted, status, entries: [...mounted.tree.entries()]
              .filter(entry => entry.options.id !== 'remote-container')
              .map(entry => ({ id: entry.options.id, disabled: entry.disabled, config: entry.options.config })) });
        } finally { await mounted.scope.dispose(); }
      }
      assert.deepEqual(snapshots[1], snapshots[0]);
      t.diagnostic(`原生夹具可用工具 ${snapshots[0].tools.length} 个；隔离组件：${snapshots[0].status.disabledComponents.map(row => row.name).join('、') || '无'}。`);
    });
    await t.test('等价完整兜底仅向用户展示声明来源提示，模型系统提示字节不变', async () => {
      const patches = loadYaml(shipped.content, { schema: entryListSchema });
      const standard = patches.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-standard').config;
      const notice = '安装版标准预设无法读取或适配，已采用插件维护的完整预设。';
      const snapshots = [];
      for (const [preset, baseUrl, notices] of [
        [createRemoteClaudePreset(standard), shipped.baseUrl, []],
        [createOwnedRemoteClaudePreset(), resolveDshModule('@deepseek-ai/cordis'), [notice]],
      ]) {
        const mounted = await mount(preset.plugins, 'full', baseUrl, notices);
        try {
          const converted = toMcpToolDefinitions(mounted.assembly.tools);
          const prepared = prepareRequestAssembly({ assembly: mounted.assembly, converted, renderPrompt,
            admitShell: (_assembly, tools) => assert.equal(tools.tools.filter(tool => tool.name === 'pwsh').length, 1) });
          snapshots.push({ prompt: prepared.renderSystemPrompt(), tools: converted.tools,
            status: structuredClone(remotePresetStatus(ctx)) });
        } finally { await mounted.scope.dispose(); }
      }
      assert.deepEqual(Buffer.from(snapshots[1].prompt), Buffer.from(snapshots[0].prompt));
      assert.deepEqual(snapshots[1].tools, snapshots[0].tools);
      assert.deepEqual(snapshots[1].status, { ...snapshots[0].status,
        reasons: [...snapshots[0].status.reasons, notice] });
      assert.equal(snapshots[1].prompt.includes(notice), false);
    });
    await t.test('远程关闭原生时间注入，旧系统提示及工具字节不变，普通会话保留原生时间能力', async () => {
      const { AgentRegistry, agentEvents } = await import(resolveDshModule('@deepseek-ai/dsh-agent'));
      if (!ctx.agents) await ctx.plugin(AgentRegistry);
      const previousHomes = [process.env.DSH_HOME, process.env.DSH_AGENTS_HOME];
      const homes = [join(directory, 'clock-dsh-home'), join(directory, 'clock-agents-home')];
      for (const home of homes) await mkdir(home);
      await mkdir(join(workdir, '.git'));
      [process.env.DSH_HOME, process.env.DSH_AGENTS_HOME] = homes;
      const messages = [{ id: 'synthetic-clock-user', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '合成时间注入检查' }] }];
      const step = key => {
        key.inbox ??= { nextStep: [], remove() {}, prepend() {}, replace() {} };
        return agentEvents(ctx, key).waterfall('agent/pre-step', {
          messages, turn: 1, step: 1, signal: new AbortController().signal,
        }, () => Promise.resolve({ kind: 'enter', messages }));
      };
      let ordinaryScope;
      try {
        const patches = loadYaml(shipped.content, { schema: entryListSchema });
        const standard = patches.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-standard').config;
        const originalClock = standard.plugins.find(row => row.name === '@deepseek-ai/dsh-time-context');
        const ordinary = { id: 'ordinary-clock', inject() {} };
        ordinaryScope = createScope(ctx, ordinary);
        ordinary.ctx = ordinaryScope.ctx;
        ordinary.session = Session.create(ordinary.id, undefined, { version: SESSION_FORMAT_VERSION,
          id: ordinary.id, createdAt: 0, isSeeded: false, agentPreset: 'standard', delegationDepth: 0, cwd: workdir });
        await ordinaryScope.ctx.plugin(await official('dsh-time-context'), originalClock.config ?? {});
        assert.ok((await step(ordinary)).messages.some(message => message.source.kind === 'time-context'));

        const adapted = createRemoteClaudePreset(standard);
        // Restore only the original clock row to construct the pre-overlay
        // control. Every other declaration remains subject to deep equality.
        const beforePrivacy = { ...adapted, plugins: adapted.plugins.map(row =>
          row.name === '@deepseek-ai/dsh-time-context' ? { ...originalClock } : row) };
        assert.deepEqual(adapted, { ...beforePrivacy, plugins: beforePrivacy.plugins.map(row =>
          row.name === '@deepseek-ai/dsh-time-context' ? { ...row, disabled: true } : row) });
        const snapshots = [];
        for (const preset of [beforePrivacy, adapted, createOwnedRemoteClaudePreset(), createBasicRemoteClaudePreset('win32')]) {
          const mounted = await mount(preset.plugins);
          try {
            const converted = toMcpToolDefinitions(mounted.assembly.tools);
            const prepared = prepareRequestAssembly({ assembly: mounted.assembly, converted, renderPrompt,
              admitShell: (_assembly, tools) => assert.equal(tools.tools.filter(tool => tool.name === 'pwsh').length, 1) });
            const decision = await step(mounted.key);
            const wire = await toSdkPrompt(decision.messages);
            snapshots.push({ prompt: prepared.renderSystemPrompt(), tools: converted.tools,
              clocks: decision.messages.filter(message => message.source.kind === 'time-context').length,
              automaticClockText: wire.some(block => block.type === 'text'
                && /Time sampled while preparing turn|Browser time zone for this request|Elapsed since the preceding/.test(block.text)) });
          } finally { await mounted.scope.dispose(); }
        }
        assert.equal(snapshots[0].clocks, 1);
        assert.equal(snapshots[0].automaticClockText, true);
        for (const snapshot of snapshots.slice(1)) {
          assert.equal(snapshot.clocks, 0);
          assert.equal(snapshot.automaticClockText, false);
        }
        for (const snapshot of snapshots.slice(1, 3)) {
          assert.deepEqual(Buffer.from(snapshot.prompt), Buffer.from(snapshots[0].prompt));
          assert.deepEqual(snapshot.tools, snapshots[0].tools);
        }
        assert.ok((await step(ordinary)).messages.some(message => message.source.kind === 'time-context'));
        assert.deepEqual(standard.plugins.find(row => row.id === originalClock.id), originalClock);
      } finally {
        await ordinaryScope?.dispose();
        for (const [index, key] of ['DSH_HOME', 'DSH_AGENTS_HOME'].entries()) {
          if (previousHomes[index] === undefined) delete process.env[key];
          else process.env[key] = previousHomes[index];
        }
      }
    });
    await t.test('兼容的标准预设新增工具保留适配，实际原生目录及工具提示可用', async () => {
      const futureTool = join(directory, 'future-tool.mjs');
      await writeFile(futureTool, `export const inject = ['tools', 'systemPrompt'];
export function apply(ctx) {
  ctx.tools.register({ name: 'future_compatible', description: '验证兼容新增工具',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: value => value },
    async execute() { throw new Error('该验例不执行工具'); } });
  ctx.systemPrompt.section({ name: 'tool:future_compatible', order: 4000, text: 'Future compatible tool guidance.' });
}
`);
      const patches = loadYaml(shipped.content, { schema: entryListSchema });
      const standard = patches.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-standard').config;
      const added = { id: 'future-compatible-tool', name: pathToFileURL(futureTool).href };
      standard.plugins.push(added);
      const adapted = createRemoteClaudePreset(standard);
      assert.deepEqual(adapted.plugins.find(row => row.id === added.id), added);
      const mounted = await mount(adapted.plugins);
      try {
        assert.ok(mounted.assembly.tools.some(tool => tool.name === 'future_compatible'));
        assert.ok(toMcpToolDefinitions(mounted.assembly.tools).tools.some(tool => tool.name === 'future_compatible'));
        assert.ok(renderPrompt(mounted.assembly).includes('Future compatible tool guidance.'));
        assert.equal(remotePresetStatus(ctx).disabledComponents.some(row => row.name === added.id), false);
      } finally { await mounted.scope.dispose(); }
    });
    await t.test('实际标准预设可隔离未就绪扩展，核心 shell 和指令仍挂载', async () => {
      const patches = loadYaml(shipped.content, { schema: entryListSchema });
      const standard = patches.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-standard').config;
      const mounted = await mount(createRemoteClaudePreset(standard).plugins);
      try {
        assert.ok(['full', 'degraded'].includes(remotePresetStatus(ctx).mode));
        assert.equal(mounted.assembly.tools.filter(tool => tool.name === 'pwsh').length, 1);
        assert.ok(mounted.assembly.sections.some(section => section.name === 'claude-bridge:preset-capabilities'));
      } finally { await mounted.scope.dispose(); }
    });
    await t.test('实际标准预设的组件改名后，挂载结果与原声明等价', async () => {
      const read = () => loadYaml(shipped.content, { schema: entryListSchema })
        .flatMap(row => row.insert ?? []).find(row => row.id === 'preset-standard').config;
      const summary = assembly => ({ tools: assembly.tools.map(tool => tool.name).sort(),
        sections: assembly.sections.map(section => section.name).sort() });
      const original = await mount(createRemoteClaudePreset(read()).plugins);
      let expected;
      try { expected = { ...summary(original.assembly), status: remotePresetStatus(ctx) }; }
      finally { await original.scope.dispose(); }
      const renamedRows = rows => rows.map(row => ({ ...row, id: `upstream-${row.id}`,
        ...(row.group === true && Array.isArray(row.config) ? { config: renamedRows(row.config) } : {}) }));
      const standard = read();
      standard.plugins = renamedRows(standard.plugins);
      const renamed = await mount(createRemoteClaudePreset(standard).plugins);
      try {
        assert.deepEqual(summary(renamed.assembly), { tools: expected.tools, sections: expected.sections });
        assert.equal(remotePresetStatus(ctx).mode, expected.status.mode);
        assert.deepEqual(remotePresetStatus(ctx).disabledComponents.map(row => row.reason),
          expected.status.disabledComponents.map(row => row.reason));
      } finally { await renamed.scope.dispose(); }
    });
    await t.test('真实 PowerShell 启动失败经原生工具层保留可停止执行的错误码', async () => {
      const mounted = await mount(basicPlugins);
      const previous = ctx.shell.config;
      try {
        // Only this fresh test Context's executor configuration is changed.
        const missing = Object.create(previous);
        Object.defineProperty(missing, 'pwshPath', { value: { get: () => join(directory, 'missing-pwsh.exe') } });
        ctx.shell.config = missing;
        const result = await executeNativeTool(ctx, { name: 'pwsh', callId: 'spawn-failure',
          arguments: { description: '验证启动失败', command: 'Write-Output unused' },
          agent: mounted.key, signal: new AbortController().signal });
        assert.equal(result.isError, true);
        assert.equal(result.error?.info?.code, 'REMOTE_SHELL_EXECUTOR_FAILED');
      } finally { ctx.shell.config = previous; await mounted.scope.dispose(); }
    });
    await t.test('错误工作目录不会被误判为基础 shell 失效', async () => {
      const mounted = await mount(basicPlugins);
      try {
        const execute = args => executeNativeTool(ctx, { name: 'pwsh', callId: 'cwd-check',
          arguments: { description: '验证工作目录', command: "Write-Output 'cwd-valid'", ...args },
          agent: mounted.key, signal: new AbortController().signal });
        const result = await execute({ workdir: join(directory, 'missing-workdir') });
        assert.equal(result.isError, true);
        assert.notEqual(result.error?.info?.code, 'REMOTE_SHELL_EXECUTOR_FAILED');
        const corrected = await execute({ workdir });
        assert.equal(corrected.isError, false);
        assert.equal(corrected.value.exitCode, 0);
      } finally { await mounted.scope.dispose(); }
    });
    await t.test('Windows ACL 环境故障保留原生工具错误，不误判插件不可用', async () => {
      const mounted = await mount(basicPlugins);
      const previous = ctx.shell.execute;
      try {
        ctx.shell.execute = async () => { throw Object.assign(new Error('controlled preparation failure'), {
          name: 'Win32Error', api: 'SetNamedSecurityInfoW', win32Code: 5,
        }); };
        const result = await executeNativeTool(ctx, { name: 'pwsh', callId: 'acl-start-failure',
          arguments: { description: '验证沙箱准备故障', command: 'Write-Output unused' },
          agent: mounted.key, signal: new AbortController().signal });
        assert.equal(result.isError, true);
        assert.notEqual(result.error?.info?.code, 'REMOTE_SHELL_EXECUTOR_FAILED');
      } finally { ctx.shell.execute = previous; await mounted.scope.dispose(); }
    });
    const ordinaryAfter = await ctx.systemPrompt.assemble();
    assert.deepEqual(ordinaryAfter.tools, ordinaryBefore.tools);
    assert.deepEqual(ordinaryAfter.sections, ordinaryBefore.sections);
  } finally {
    await ctx.fiber.dispose();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('dsh-bridge-preset-'));
    await rm(directory, { recursive: true, force: true });
  }
});
