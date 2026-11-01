import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDshModule, readShippedStandardPreset } from '../plugin/compat/resolve-dsh-module.mjs';
import { createBasicRemoteClaudePreset, createRemoteClaudePreset } from '../plugin/preset.mjs';
import { remotePresetStatus } from '../plugin/preset-loading.mjs';

const native = Boolean(process.platform === 'win32' && process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES);

test('实际 rc5：远程组件隔离、基础回退及卸载不改变普通会话', { skip: !native, timeout: 30000 }, async t => {
  const { Context } = await import(resolveDshModule('@deepseek-ai/cordis'));
  const { createScope } = await import(resolveDshModule('@deepseek-ai/dsh-scope'));
  const { Session, SESSION_FORMAT_VERSION } = await import(resolveDshModule('@deepseek-ai/dsh-session'));
  const { Loader, Group, EntryTree } = await import(resolveDshModule('@deepseek-ai/cordis-plugin-loader'));
  const { loadYaml, entryListSchema } = await import('../plugin/compat/runtime.mjs');
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'));
  const official = async name => {
    const module = await import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
    return module.default ?? module;
  };
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
      ['dsh-fs-local', { cwd: workdir }], ['dsh-working-directory', { defaultDirectory: workdir }],
      ['dsh-shell-env', { dshHome: directory }], ['dsh-subprocess-local', {}],
      ['dsh-pwsh-local', { cwd: workdir }], ['dsh-user-approval', { policy: 'ask' }],
    ]) await ctx.plugin(await official(name), config);
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
    const mount = async (plugins, mode = 'full') => {
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
          tree = new OuterTree(child.extend({ baseUrl: shipped.baseUrl }));
          child.effect(() => () => tree.root.stop());
          await tree.root.update([{ id: 'remote-container', name: new URL('../plugin/remote-composition.mjs', import.meta.url).href,
            config: { plugins, basicPlugins, shell: 'pwsh', baseUrl: shipped.baseUrl, mode, reasons: [] } }]);
        });
        await tree.await();
        const entry = [...tree.entries()].find(row => row.options.id === 'remote-container');
        assert.ok(entry?.fiber);
        await entry.fiber.await();
        assert.ok([...tree.entries()].some(row => row.options.id === 'tool-pwsh'));
        return { scope, key, tree, assembly: await ctx.systemPrompt.assemble({ scope: key }) };
      } catch (error) { await scope.dispose(); throw error; }
    };

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
    await t.test('真实 PowerShell 启动失败经原生工具层保留可停止执行的错误码', async () => {
      const mounted = await mount(basicPlugins);
      const previous = ctx.shell.config;
      try {
        // Only this fresh test Context's executor configuration is changed.
        const missing = Object.create(previous);
        Object.defineProperty(missing, 'pwshPath', { value: { get: () => join(directory, 'missing-pwsh.exe') } });
        ctx.shell.config = missing;
        const result = await ctx.tools.execute({ name: 'pwsh', callId: 'spawn-failure',
          arguments: { description: '验证启动失败', command: 'Write-Output unused' },
          agent: mounted.key, signal: new AbortController().signal });
        assert.equal(result.isError, true);
        assert.equal(result.error?.info?.code, 'REMOTE_SHELL_EXECUTOR_FAILED');
      } finally { ctx.shell.config = previous; await mounted.scope.dispose(); }
    });
    await t.test('错误工作目录不会被误判为基础 shell 失效', async () => {
      const mounted = await mount(basicPlugins);
      try {
        const execute = args => ctx.tools.execute({ name: 'pwsh', callId: 'cwd-check',
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
        const result = await ctx.tools.execute({ name: 'pwsh', callId: 'acl-start-failure',
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
