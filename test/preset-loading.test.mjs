import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRemoteComposition } from '../plugin/preset-loading.mjs';
import { createBasicRemoteClaudePreset, createOwnedRemoteClaudePreset, containRemotePreset, remotePresetFeatures } from '../plugin/preset.mjs';

const base = createBasicRemoteClaudePreset('win32').plugins;

function fixture(attempts, { cleanupError = false } = {}) {
  const events = [];
  let sequence = 0;
  const createTree = () => {
    const attempt = sequence++;
    const entries = [];
    const tree = {
      root: {
        async update(rows) {
          events.push(`load:${attempt}`);
          for (const row of rows) {
            const fault = attempts[attempt]?.[row.id];
            let disposed = false;
            const entry = { id: row.id, options: row, parent: tree.root, disabled: row.disabled === true,
              fiber: fault === 'import' ? undefined : {
                state: 2, inject: fault === 'pending' ? { absent: true } : {},
                ctx: { get: () => undefined },
                async await() { if (fault === 'activate') throw new Error('activation'); },
                async dispose() {
                  if (disposed) return;
                  await new Promise(resolve => setTimeout(resolve, 5));
                  if (cleanupError && fault) throw new Error('cleanup');
                  disposed = true;
                  events.push(`dispose:${attempt}:${row.id}`);
                },
              } };
            entries.push(entry);
          }
        },
        stop() { entries.splice(0); },
        remove(id) { entries.splice(entries.findIndex(entry => entry.id === id), 1); },
      },
      entries() { return entries.values(); }, async await() {},
      remove(id) { entries.splice(entries.findIndex(entry => entry.id === id), 1); },
    };
    return tree;
  };
  return { events, createTree, attempts: () => sequence };
}

test('基础预设独立维护 Windows shell，关闭后台提升并保留指令', () => {
  assert.deepEqual(base.map(row => row.id), ['persona', 'agent-instructions', 'tool-pwsh', 'claude-sdk-compact', 'claude-sdk-recovery']);
  assert.deepEqual(base[2].config, { enableRunInBackground: false, promoteOnTimeout: false });
  const basic = createBasicRemoteClaudePreset('linux');
  assert.ok(basic.plugins.some(row => row.id === 'tool-bash'));
  const contained = containRemotePreset(basic, { baseUrl: 'file:///app/package.json', platform: 'linux' });
  assert.equal(contained.id, basic.id);
  assert.equal(contained.plugins.length, 1);
  assert.equal(contained.plugins[0].config.shell, 'bash');
  assert.equal(basic.plugins.length, 5);
  const fallback = containRemotePreset(basic, { noticeReasons: ['声明来源已回退。'] });
  assert.deepEqual(fallback.plugins[0].config.noticeReasons, ['声明来源已回退。']);
  assert.deepEqual(fallback.plugins[0].config.reasons, []);
});

test('自有完整预设保留 v024 声明顺序和默认配置，仅显式关闭自动时间上下文', () => {
  const preset = createOwnedRemoteClaudePreset();
  assert.equal(preset.id, 'claude-sdk-remote');
  assert.deepEqual(preset.plugins.map(row => row.id), [
    'persona', 'agent-instructions', 'time-context', 'tool-bash', 'tool-pwsh', 'tool-fs',
    'tool-fs-search', 'tool-jobs', 'tool-schedule', 'skill-filesystem', 'tool-skill',
    'command-goal', 'tool-goal', 'planning', 'delegation', 'tool-ask-user', 'tool-todo',
    'tool-web', 'present', 'tool-plugin-manager', 'tool-plugin-market',
    'claude-sdk-compact', 'claude-sdk-recovery',
  ]);
  const row = id => preset.plugins.find(item => item.id === id);
  assert.deepEqual(row('tool-bash').disabled, { __jsExpr: "process.platform === 'win32'" });
  assert.deepEqual(row('tool-pwsh').disabled, { __jsExpr: "process.platform !== 'win32'" });
  assert.equal(Object.hasOwn(row('tool-pwsh'), 'config'), false);
  assert.equal(Object.hasOwn(row('tool-bash'), 'config'), false);
  assert.deepEqual(row('agent-instructions').config, { maxBytes: 65536 });
  assert.equal(row('time-context').disabled, true);
  assert.deepEqual(row('tool-fs-search').config, { sampleOverCapGlobResults: false });
  assert.deepEqual(row('tool-todo').config, { allowParallelInProgress: true });
  assert.deepEqual(row('tool-web').config, { fetch: true, searchTimeoutMs: 60000 });
  assert.equal(row('planning').disabled, true);
  assert.equal(row('tool-plugin-manager').disabled, true);
  assert.equal(row('tool-plugin-market').disabled, true);
  assert.deepEqual(row('delegation').isolate, { workflowEngine: true });
  const spawn = row('delegation').config.find(item => item.id === 'tool-subagent');
  assert.deepEqual(spawn.config, { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: false });
  assert.equal(row('delegation').config.find(item => item.id === 'tool-subagent-fork').disabled, true);
  const next = createOwnedRemoteClaudePreset();
  assert.notEqual(row('tool-pwsh').disabled, next.plugins.find(item => item.id === 'tool-pwsh').disabled);
  assert.notEqual(spawn.config, next.plugins.find(item => item.id === 'delegation').config
    .find(item => item.id === 'tool-subagent').config);
});

test('基础或降级预设不向界面宣称未开启的 Workflow 和压缩命令已转换', () => {
  const status = remotePresetFeatures({ mode: 'basic', disabledComponents: [
    { name: 'claude-sdk-compact', status: 'disabled', reason: '缺少命令服务' },
  ] });
  assert.deepEqual(status.convertedFeatures.map(item => item.name), ['身份提示']);
  assert.ok(status.disabledFeatures.some(item => item.name === '/compact'));
  assert.ok(status.disabledFeatures.some(item => item.name === '子代理与后台任务'));
  assert.ok(status.disabledFeatures.some(item => item.name === '自动时间与时区上下文'
    && item.status === 'disabled' && item.reason.includes('浏览器时区')));
});

test('可选组件导入、激活或依赖失败只关闭该组件，先等待清理', async () => {
  const f = fixture([{ 'tool-a': 'import', 'tool-b': 'activate', 'tool-c': 'pending' }]);
  let status;
  const mounted = await loadRemoteComposition({ ...f, plugins: [...base,
    { id: 'tool-a', name: 'missing' }, { id: 'tool-b', name: 'broken' }, { id: 'tool-c', name: 'waiting' }],
    basicPlugins: base, shell: 'pwsh', report: value => { status = value; } });
  assert.equal(status.mode, 'degraded');
  assert.deepEqual(status.disabledComponents.map(item => item.name), ['tool-a', 'tool-b', 'tool-c']);
  assert.match(status.disabledComponents.at(-1).reason, /依赖尚未就绪/);
  assert.deepEqual([...mounted.tree.entries()].map(entry => entry.id), base.map(row => row.id));
  assert.ok(f.events.includes('dispose:0:tool-b'));
  await mounted.dispose();
  assert.ok(f.events.includes('dispose:0:tool-pwsh'));
});

test('完整预设的 shell 失败后等待所有旧组件清理再加载基础预设', async () => {
  const f = fixture([{ 'tool-pwsh': 'activate' }, {}]);
  let status;
  const mounted = await loadRemoteComposition({ ...f, plugins: base, basicPlugins: base,
    shell: 'pwsh', report: value => { status = value; } });
  assert.equal(status.mode, 'basic');
  assert.match(status.reasons[0], /回退/);
  assert.ok(f.events.indexOf('dispose:0:tool-pwsh') < f.events.indexOf('load:1'));
  assert.equal(f.attempts(), 2);
  await mounted.dispose();
});

test('基础 shell 仍失败时明确不可用，不反复尝试执行', async () => {
  const f = fixture([{ 'tool-pwsh': 'import' }, { 'tool-pwsh': 'activate' }]);
  let status;
  await assert.rejects(loadRemoteComposition({ ...f, plugins: base, basicPlugins: base,
    shell: 'pwsh', report: value => { status = value; } }), error =>
    error.code === 'REMOTE_SHELL_UNAVAILABLE' && /插件不可用/.test(error.message));
  assert.equal(status.mode, 'unavailable');
  assert.equal(f.attempts(), 2);
});

test('旧组件无法清理时停止，不加载第二份工具与提示词', async () => {
  const f = fixture([{ 'tool-pwsh': 'activate' }], { cleanupError: true });
  let status;
  await assert.rejects(loadRemoteComposition({ ...f, plugins: base, basicPlugins: base, shell: 'pwsh',
    report: value => { status = value; } }),
    error => error.code === 'REMOTE_SHELL_UNAVAILABLE' && /清理/.test(error.message));
  assert.equal(f.attempts(), 1);
  assert.equal(status.mode, 'unavailable');
  assert.match(status.reasons.at(-1), /清理/);
});
