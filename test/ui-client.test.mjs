import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { decodeRemoteCreationSelection } from '../plugin/policy.mjs';

test('DSH 会话菜单先选择模型和强度，再创建远程会话', async () => {
  const source = await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8');
  let entry;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { entry = value; } } } });
  assert.equal(entry.id, 'dsh-claude-bridge-ui');
  const exports = entry.factory(name => {
    if (name === 'react') return { createElement: () => null };
    if (name === 'react-dom' || name === '@deepseek-ai/dsh-client-ui-primitives') return {};
    assert.equal(name, 'zod');
    return { z: {} };
  });
  const slots = new Map();
  const requests = [];
  const opened = [];
  const ctx = {
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w', sessionIds: ['s'] }] }) } },
    sessions: { create: async request => { requests.push(request); return 'new'; } },
    uiWorkspace: { openSession: id => opened.push(id) },
    remote: { $mount: async () => async () => {}, claudeBridge: {
      status: async () => ({ ok: true, value: { configured: false } }),
      visibleModels: async () => ({ ok: true, value: { models: [{
        id: 'haiku', name: 'Haiku', reasoning: { efforts: [{ id: 'high', name: 'high' }] },
      }] } }),
    }, session: {} },
    slots: { inject: (_name, register) => register(), register: (options, component) => {
      slots.set(options.id, { options, component }); return () => {};
    } },
    inject: (_services, callback) => callback(ctx),
    effect: () => {},
  };
  await exports.apply(ctx);
  // The hero is also shown for the very first, otherwise menu-less blank.
  await slots.get('dsh-claude-new-session').options.inject('s').show();
  const picker = slots.get('dsh-claude-session-picker').options.inject();
  await picker.submit();
  assert.equal(requests.length, 0);
  picker.chooseModel('haiku');
  picker.chooseEffort('high');
  await picker.submit();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].workspaceId, 'w');
  const selection = decodeRemoteCreationSelection(requests[0].agentPreset);
  assert.equal(selection.provider, 'claude-sdk-remote');
  assert.equal(selection.model, 'haiku');
  assert.equal(selection.reasoningEffort, 'high');
  assert.deepEqual(opened, ['new']);
});

test('设置页保存凭据后只显示状态，测试连接才读取模型目录', async () => {
  const source = await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8');
  let entry;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { entry = value; } } } });
  const client = entry.factory(name => name === 'react' ? { createElement() {} }
    : name === 'zod' ? { z: {} } : {});
  const slots = new Map();
  let configured = false;
  let catalogCalls = 0;
  let saved;
  let modelIds = ['haiku'];
  const ctx = {
    workspaces: {}, uiWorkspace: {},
    remote: { $mount: async () => async () => {}, session: {}, claudeBridge: {
      status: async () => ({ ok: true, value: { configured, url: 'wss://example.test/',
        connected: false, authentication: 'unknown', diagnosticsPath: 'local-diagnostics',
        disabledFeatures: [{ name: '规划模式', status: 'disabled', reason: '测试原因' }],
        usageSummary: { sessions: 1, runs: 2, inputTokens: 3, outputTokens: 4,
          cacheReadTokens: 5, cacheWriteTokens: 6, estimatedCostUsd: 0.01, costKind: 'sdk-estimate' } } }),
      saveConnection: async value => { saved = value; configured = true; return { ok: true, value: { configured: true } }; },
      refreshCatalog: async () => { catalogCalls++; return { ok: true, value: { models: [] } }; },
      modelPreferences: async () => ({ ok: true, value: { models: [
        { value: 'haiku', displayName: 'Haiku' }, { value: 'sonnet', displayName: 'Sonnet' },
      ], enabledIds: modelIds, usingDefaults: false } }),
      saveModelPreferences: async value => { modelIds = Array.from(value.enabledIds); return { ok: true, value: { saved: true } }; },
    } },
    slots: { inject: (_name, register) => register(), register: (options, component) => {
      slots.set(options.id, { options, component }); return () => {};
    } }, inject: (_services, callback) => callback(ctx), effect: () => {},
  };
  await client.apply(ctx);
  const settings = slots.get('dsh-claude-bridge').options.inject();
  await settings.save({ url: 'wss://example.test/', token: 'sample-not-a-real-secret' });
  assert.equal(saved.token, 'sample-not-a-real-secret');
  assert.equal(catalogCalls, 0);
  assert.equal(JSON.stringify(settings.hooks.settings.getSnapshot()).includes(saved.token), false);
  assert.equal(settings.hooks.settings.getSnapshot().disabledFeatures[0].name, '规划模式');
  assert.equal(settings.hooks.settings.getSnapshot().usageSummary.runs, 2);
  await settings.refresh();
  assert.equal(catalogCalls, 1);
  assert.equal(settings.hooks.settings.getSnapshot().models.length, 2);
  settings.toggleVisibleModel('haiku');
  settings.toggleVisibleModel('sonnet');
  await settings.saveModels();
  assert.deepEqual(modelIds, ['sonnet']);
  assert.deepEqual(Array.from(settings.hooks.settings.getSnapshot().selectedModelIds), ['sonnet']);
});

test('清除按钮清空凭据草稿和连接缓存，迟到的状态、模型和额度响应不能恢复旧配置', async () => {
  const source = await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8');
  let entry, tokenDraft = 'unsaved-test-credential', configured = true, blocked = false, clicked;
  const replies = new Map(), slots = new Map();
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { entry = value; } } } });
  const react = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => [tokenDraft, value => { tokenDraft = value; }], useEffect() {} };
  const client = entry.factory(name => name === 'react' ? react : name === 'zod' ? { z: {} } : {});
  const status = () => ({ ok: true, value: { configured, url: configured ? 'wss://example.test/' : '',
    connected: configured, authentication: configured ? 'logged-in' : 'unknown' } });
  const pending = (name, value) => blocked ? new Promise(resolve => replies.set(name, () => resolve(value))) : Promise.resolve(value);
  const ctx = { sessions: {}, workspaces: {}, uiWorkspace: {},
    remote: { $mount: async ({ descriptors }) => {
      assert.ok(descriptors.some(item => item.method === 'clearConnection')); return () => {};
    }, session: {}, claudeBridge: {
      status: () => pending('status', status()),
      modelPreferences: () => pending('models', { ok: true, value: { models: [{ value: 'haiku' }], enabledIds: ['haiku'] } }),
      planUsage: () => pending('quota', { ok: true, value: { status: 'available', windows: [{ id: 'five_hour' }] } }),
      clearConnection: async () => { configured = false; blocked = false; return { ok: true, value: { configured: false } }; },
    } }, slots: { inject: (_name, register) => register(), register(options, component) {
      slots.set(options.id, { options, component }); return () => {};
    } }, inject: (_services, callback) => callback(ctx), effect() {} };
  await client.apply(ctx);
  const slot = slots.get('dsh-claude-bridge'), settings = slot.options.inject();
  await settings.refreshStatus(); await settings.loadModels();
  blocked = true;
  const previousStatus = settings.refreshStatus(), previousModels = settings.loadModels();
  const quota = slots.get('dsh-claude-quota').options.inject('s');
  const previousQuota = quota.readQuota('manual');
  const tree = slot.component({ ...settings, clear: () => { clicked = settings.clear(); return clicked; },
    useSettings: select => select(settings.hooks.settings.getSnapshot()) });
  const nodes = node => node == null || typeof node !== 'object' ? []
    : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.children)];
  const button = nodes(tree).find(node => node.type === 'button' && node.children.includes('清除已保存连接'));
  assert.equal(button.props.disabled, false);
  button.props.onClick(); await clicked;
  assert.equal(tokenDraft, '');
  for (const release of replies.values()) release();
  await Promise.all([previousStatus, previousModels, previousQuota]);
  const state = settings.hooks.settings.getSnapshot();
  assert.equal(state.configured, false); assert.equal(state.connected, false);
  assert.equal(state.url, ''); assert.equal(state.authentication, 'unknown');
  assert.deepEqual(Array.from(state.models), []); assert.equal(state.modelsLoaded, false);
  assert.equal(quota.hooks.quota.getSnapshot().status, 'unavailable');
  assert.match(state.message, /已清除/u);
});

test('设置页打开及可见时刷新统计，合并请求并保留地址草稿，诊断默认收起', async () => {
  const source = await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8');
  let entry;
  const timers = new Map();
  const listeners = new Map();
  const effects = [];
  const page = { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name) };
  const network = { onLine: true };
  vm.runInNewContext(source, { document: page, navigator: network, window: {
    __ModuleLoader__: { load: value => { entry = value; } },
    setInterval: (fn, delay) => { assert.equal(delay, 5000); timers.set(1, fn); return 1; },
    clearInterval: id => timers.delete(id),
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
  } });
  const react = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}], useEffect: effect => effects.push(effect) };
  const client = entry.factory(name => name === 'react' ? react : name === 'zod' ? { z: {} } : {});
  const slots = new Map();
  let reads = 0;
  let latest = { configured: false, url: 'wss://saved.test/', compatibility: [],
    diagnosticsPath: 'local-diagnostics', usageSummary: { sessions: 0, runs: 0 }, activeRuns: 0 };
  const ctx = { sessions: {}, workspaces: {}, uiWorkspace: {},
    remote: { $mount: async () => async () => {}, session: {}, claudeBridge: {
      status: async () => { reads++; return { ok: true, value: latest }; },
    } }, slots: { inject: (_name, register) => register(), register(options, component) {
      slots.set(options.id, { options, component }); return () => {};
    } }, inject: (_services, callback) => callback(ctx), effect() {} };
  await client.apply(ctx);
  const slot = slots.get('dsh-claude-bridge');
  const settings = slot.options.inject();
  await settings.refreshStatus();
  const render = () => slot.component({ ...settings,
    useSettings: select => select(settings.hooks.settings.getSnapshot()) });
  const textOf = node => node == null || typeof node === 'boolean' ? ''
    : typeof node === 'string' || typeof node === 'number' ? String(node)
      : Array.isArray(node) ? node.map(textOf).join(' ') : textOf(node.children);
  const nodesOf = node => node == null || typeof node !== 'object' ? []
    : Array.isArray(node) ? node.flatMap(nodesOf) : [node, ...nodesOf(node.children)];
  const initial = render();
  assert.match(textOf(initial), /暂无已结算的用量记录/u);
  assert.match(textOf(initial), /本次启动尚未取得工具兼容报告/u);
  assert.doesNotMatch(textOf(initial), /尚未运行。/u);
  assert.equal(nodesOf(initial).find(node => node.type === 'details').props.open, undefined);
  latest = { ...latest, usageSummary: { sessions: 1, runs: 2, inputTokens: 15, outputTokens: 8,
    cacheReadTokens: 3, cacheWriteTokens: 4, estimatedCostUsd: 0.02 } };
  const beforeMount = reads;
  const cleanup = effects.slice().map(effect => effect()).filter(value => typeof value === 'function');
  await settings.refreshStatus();
  assert.equal(reads, beforeMount + 1);
  assert.equal(settings.hooks.settings.getSnapshot().usageSummary.runs, 2);
  assert.equal(timers.size, 1);
  assert.match(textOf(render()), /会话 1，运行 2/u);
  settings.editUrl('wss://draft.test/');
  const beforePoll = reads;
  timers.get(1)();
  await settings.refreshStatus();
  assert.equal(reads, beforePoll + 1);
  assert.equal(settings.hooks.settings.getSnapshot().url, 'wss://draft.test/');
  page.hidden = true;
  timers.get(1)();
  assert.equal(reads, beforePoll + 1);
  page.hidden = false;
  network.onLine = false;
  listeners.get('focus')();
  assert.equal(reads, beforePoll + 1);
  network.onLine = true;
  latest = { ...latest, activeRuns: 1 };
  listeners.get('online')();
  await settings.refreshStatus();
  assert.match(textOf(render()), /正在执行 1 轮/u);
  for (const dispose of cleanup) dispose();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});

test('上下文底栏只显示百分比，浮层展示同源用量与精简分类，停止状态保留', async () => {
  const source = await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8');
  let entry;
  vm.runInNewContext(source, { document: { body: {} },
    window: { __ModuleLoader__: { load: value => { entry = value; } } } });
  let open = false;
  const react = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => [open, value => { open = value; }], useRef: () => ({ current: null }), useEffect() {} };
  const client = entry.factory(name => {
    if (name === 'react') return react;
    if (name === 'react-dom') return { createPortal: child => ({ type: 'portal', children: [child] }) };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
      useAnchoredPosition: () => ({ left: 10, top: 10 }), useDismissOnOutsidePointer() {},
    };
    assert.equal(name, 'zod');
    return { z: {} };
  });
  const slots = new Map();
  let state = { model: 'claude-haiku-5-5', phase: 'completed', context: {
    status: 'known', totalTokens: 120, maxTokens: 1000, rawMaxTokens: 1200, percentage: 12,
    observedAt: 1, categories: [
      { id: 'system_prompt', name: '系统提示', tokens: 10, kind: 'used' },
      { id: 'mcp_tools', name: '本机工具', tokens: 10, kind: 'used' },
      { id: 'messages', name: '会话消息', tokens: 100, kind: 'used' },
      { id: 'free_space', name: '剩余空间', tokens: 800, kind: 'free' },
      { id: 'autocompact_buffer', name: '自动压缩预留', tokens: 80, kind: 'buffer' },
    ],
  }, compatibility: { model: 'claude-haiku-5-5', tools: [
    { name: 'unavailable_tool', status: 'disabled', reason: '当前会话不可用' },
  ] } };
  const face = { getSnapshot: () => state, subscribe: () => () => {} };
  const ctx = {
    workspaces: {}, uiWorkspace: {},
    sessions: { binding(id) {
      assert.equal(id, 'selected-session');
      return { session: { projections: { faceOf(key) { assert.equal(key, 'claudeBridge'); return face; } } } };
    } },
    remote: { $mount: async () => async () => {}, session: {}, claudeBridge: {
      status: async () => ({ ok: true, value: { configured: false } }),
    } },
    slots: { inject: (_name, register) => register(), register: (options, component) => {
      slots.set(options.id, { options, component }); return () => {};
    } }, inject: (_services, callback) => callback(ctx), effect: () => {},
  };
  await client.apply(ctx);
  const meter = slots.get('dsh-claude-context');
  assert.equal(meter.options.inject('selected-session').hooks.bridgeStatus, face);
  const textOf = node => node == null || typeof node === 'boolean' ? ''
    : typeof node === 'string' || typeof node === 'number' ? String(node)
    : Array.isArray(node) ? node.map(textOf).join(' ') : node.type === 'style' ? '' : textOf(node.children);
  const nodesOf = node => node == null || typeof node !== 'object' ? []
    : Array.isArray(node) ? node.flatMap(nodesOf) : [node, ...nodesOf(node.children)];
  const render = () => meter.component({ useBridgeStatus: select => select(state) });
  assert.equal(textOf(render()).trim(), '≈12%');
  assert.equal(nodesOf(render()).some(node => node.props?.role === 'dialog'), false);
  nodesOf(render()).find(node => node.type === 'button').props.onClick();
  const expanded = render();
  const text = textOf(expanded);
  assert.match(text, /上下文已用 ≈12% ~120 \/ 1K/);
  assert.match(text, /对话消息 ~100/);
  assert.equal(nodesOf(expanded).find(node => node.props?.role === 'dialog').props.className, 'dsh-claude-meter-panel');
  assert.doesNotMatch(text, /unavailable_tool|SDK 近似快照|剩余空间|压缩预留|原始窗口/);
  state = { ...state, phase: 'stopping', context: { status: 'unknown' }, toolMayHaveExecuted: true };
  assert.match(textOf(render()), /正在停止/);
  assert.match(textOf(render()), /未知/);
  assert.match(textOf(render()), /工具结果待核实/);
  state = { ...state, phase: 'completed', context: { ...state.context,
    status: 'known', totalTokens: 2149, maxTokens: 1_000_000, percentage: 0.2149, categories: [] } };
  assert.match(textOf(render()), /≈0.2% ~2.1K \/ 1M/);
  state = null;
  assert.equal(render(), null);
});

test('额度底栏默认只显示 5h，浮层含周和 Fable 明细，过期不展示旧百分比', async () => {
  const source = await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8');
  let entry;
  vm.runInNewContext(source, { document: { body: {} },
    window: { __ModuleLoader__: { load: value => { entry = value; } } } });
  const states = [];
  let cursor = 0;
  const react = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = value; }];
    }, useRef: () => ({ current: null }), useEffect() {} };
  const client = entry.factory(name => name === 'react' ? react : name === 'react-dom'
    ? { createPortal: child => child } : name === '@deepseek-ai/dsh-client-ui-primitives'
      ? { useAnchoredPosition: () => ({ top: 10, left: 10 }), useDismissOnOutsidePointer() {} } : { z: {} });
  const slots = new Map();
  const ctx = { sessions: {}, workspaces: {}, uiWorkspace: {},
    remote: { $mount: async () => async () => {}, session: {}, claudeBridge: {
      status: async () => ({ ok: true, value: { configured: false } }),
    } }, slots: { inject: (_name, register) => register(), register(options, component) {
      slots.set(options.id, component); return () => {};
    } }, inject: (_services, callback) => callback(ctx), effect() {} };
  await client.apply(ctx);
  let bridge = { phase: 'completed' };
  let quota = { status: 'available', observedAt: Date.now(), expiresAt: Date.now() + 120_000,
    windows: [{ id: 'five_hour', name: '5 小时', scope: 'session', usedPercent: 88, resetsAt: null },
      { id: 'seven_day', name: '周额度', scope: 'weekly', usedPercent: 76, resetsAt: null },
      { id: 'model_weekly_0', name: 'Fable', scope: 'model-weekly', usedPercent: 40, resetsAt: null }] };
  const textOf = node => node == null || typeof node === 'boolean' ? ''
    : typeof node === 'string' || typeof node === 'number' ? String(node)
    : Array.isArray(node) ? node.map(textOf).join(' ') : node.type === 'style' ? '' : textOf(node.children);
  const nodesOf = node => node == null || typeof node !== 'object' ? []
    : Array.isArray(node) ? node.flatMap(nodesOf) : [node, ...nodesOf(node.children)];
  const render = () => { cursor = 0; return slots.get('dsh-claude-quota')({
    useBridgeStatus: select => select(bridge), useQuota: select => select(quota), readQuota() {},
  }); };
  assert.equal(textOf(render()).trim(), '5h 剩余 12%');
  assert.doesNotMatch(textOf(render()), /周额度|Fable/);
  nodesOf(render()).find(node => node.type === 'button').props.onClick();
  assert.match(textOf(render()), /周额度 24%/);
  assert.match(textOf(render()), /Fable · 周额度 60%/);
  assert.equal(nodesOf(render()).find(node => node.props?.role === 'dialog').props['aria-label'], '剩余额度');
  quota = { ...quota, expiresAt: Date.now() - 1 };
  assert.match(textOf(render()), /5h 待刷新/);
  assert.doesNotMatch(textOf(render()), /12%|24%|60%|100%/);
  bridge = null;
  assert.equal(render(), null);
});

test('额度刷新合并请求、自动间隔 30 秒，失败按 1/2/5 分钟退避，手动可立即更新', async () => {
  const source = await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8');
  let clock = Date.now();
  const startedAt = clock;
  class TestDate extends Date { static now() { return clock; } }
  let entry;
  const network = { onLine: true };
  const page = { hidden: false };
  vm.runInNewContext(source, { Date: TestDate, navigator: network, document: page,
    window: { __ModuleLoader__: { load: value => { entry = value; } } } });
  const client = entry.factory(name => name === 'react' ? { createElement() {} } : name === 'zod' ? { z: {} } : {});
  const slots = new Map();
  const reads = [];
  let fail = false;
  let blocked = false;
  const ctx = { sessions: {}, workspaces: {}, uiWorkspace: {},
    remote: { $mount: async () => async () => {}, session: {}, claudeBridge: {
      status: async () => ({ ok: true, value: { configured: false } }),
      async planUsage(refresh) {
        reads.push(refresh);
        if (blocked) return { ok: true, value: { status: 'unavailable', code: 'AUTH_EXPIRED' } };
        return fail ? { ok: false } : { ok: true, value: { status: 'available', observedAt: clock,
          expiresAt: clock + 120_000, windows: [{ id: 'five_hour', usedPercent: 12, resetsAt: null }] } };
      },
    } }, slots: { inject: (_name, register) => register(), register(options, component) {
      slots.set(options.id, { options, component }); return () => {};
    } }, inject: (_services, callback) => callback(ctx), effect() {} };
  await client.apply(ctx);
  const quota = slots.get('dsh-claude-quota').options.inject('selected-session');
  await Promise.all([quota.readQuota('visible'), quota.readQuota('visible')]);
  assert.equal(reads.length, 1);
  clock += 10_000;
  await quota.readQuota('open');
  await quota.readQuota('activity');
  assert.equal(reads.length, 1);
  assert.equal(quota.hooks.quota.getSnapshot().nextRefreshAt, startedAt + 30_000);
  clock = startedAt + 30_000;
  await quota.readQuota('queued');
  assert.equal(reads.length, 2);
  fail = true;
  clock = startedAt + 60_000;
  await quota.readQuota('manual');
  assert.equal(quota.hooks.quota.getSnapshot().nextRefreshAt, clock + 60_000);
  clock += 30_000;
  await quota.readQuota('poll');
  assert.equal(reads.length, 3);
  clock = quota.hooks.quota.getSnapshot().nextRefreshAt;
  await quota.readQuota('queued');
  assert.equal(quota.hooks.quota.getSnapshot().nextRefreshAt, clock + 120_000);
  clock = quota.hooks.quota.getSnapshot().nextRefreshAt;
  await quota.readQuota('queued');
  assert.equal(quota.hooks.quota.getSnapshot().nextRefreshAt, clock + 300_000);
  fail = false;
  clock += 1000;
  await quota.readQuota('manual');
  assert.equal(reads.length, 6);
  assert.equal(quota.hooks.quota.getSnapshot().nextRefreshAt, 0);
  assert.deepEqual(reads, [false, false, true, false, false, true]);
  network.onLine = false;
  clock += 60_000;
  await quota.readQuota('poll');
  await quota.readQuota('manual');
  assert.equal(reads.length, 6);
  assert.equal(quota.hooks.quota.getSnapshot().paused, 'offline');
  network.onLine = true;
  await quota.readQuota('online');
  assert.equal(reads.length, 7);
  page.hidden = true;
  clock += 60_000;
  await quota.readQuota('poll');
  assert.equal(reads.length, 7);
  page.hidden = false;
  blocked = true;
  await quota.readQuota('visible');
  assert.equal(reads.length, 8);
  assert.equal(quota.hooks.quota.getSnapshot().paused, 'auth');
  assert.equal(quota.hooks.quota.getSnapshot().nextRefreshAt, 0);
  clock += 600_000;
  await quota.readQuota('open');
  await quota.readQuota('poll');
  assert.equal(reads.length, 8);
  blocked = false;
  await quota.readQuota('manual');
  assert.equal(reads.length, 9);
  assert.equal(quota.hooks.quota.getSnapshot().status, 'available');
});

test('前台空闲每 30 秒核对历史，合并请求，离线隐藏及执行中暂停并清理', async () => {
  const source = await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8');
  let entry, nextTimer = 0, reads = 0, release;
  const timers = new Map(), listeners = new Map(), effects = [];
  const page = { hidden: false, body: {}, addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name) };
  const network = { onLine: true };
  const setTimer = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; };
  vm.runInNewContext(source, { document: page, navigator: network, setTimeout: setTimer,
    clearTimeout: id => timers.delete(id), window: { __ModuleLoader__: { load: value => { entry = value; } },
      addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) } });
  const react = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [value, () => {}], useRef: () => ({ current: null }), useEffect: effect => effects.push(effect) };
  const client = entry.factory(name => name === 'react' ? react : name === 'react-dom'
    ? { createPortal: value => value } : name === '@deepseek-ai/dsh-client-ui-primitives'
      ? { useAnchoredPosition: () => ({}), useDismissOnOutsidePointer() {} } : { z: {} });
  const slots = new Map();
  const ctx = { sessions: {}, workspaces: {}, uiWorkspace: {},
    remote: { $mount: async () => async () => {}, session: {}, claudeBridge: {
      status: async () => ({ ok: true, value: { configured: false } }),
      syncSession: async () => { reads++; if (reads === 1) await new Promise(resolve => { release = resolve; });
        return { ok: true, value: { status: 'ready' } }; },
    } }, slots: { inject: (_name, register) => register(), register(options, component) {
      slots.set(options.id, { options, component }); return () => {};
    } }, inject: (_services, callback) => callback(ctx), effect() {} };
  await client.apply(ctx);
  const meter = slots.get('dsh-claude-context');
  const render = phase => meter.component({ useBridgeStatus: select => select({ phase }), syncSession: meter.options.inject('test').syncSession });
  render('completed');
  const cleanup = effects.splice(0).map(effect => effect()).filter(value => typeof value === 'function');
  assert.equal(reads, 1);
  listeners.get('online')();
  assert.equal(reads, 1);
  release();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal([...timers.values()][0].delay, 30_000);
  await [...timers.values()][0].fn();
  assert.equal(reads, 2);
  page.hidden = true;
  await listeners.get('visibilitychange')();
  assert.equal(timers.size, 0);
  assert.equal(reads, 2);
  page.hidden = false; network.onLine = false;
  await listeners.get('visibilitychange')();
  assert.equal(reads, 2);
  network.onLine = true;
  await listeners.get('online')();
  assert.equal(reads, 3);
  for (const dispose of cleanup) dispose();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
  render('running');
  for (const effect of effects.splice(0)) effect();
  assert.equal(reads, 3);
  assert.equal(timers.size, 0);
});
