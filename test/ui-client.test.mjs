import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { decodeRemoteCreationSelection } from '../plugin/policy.mjs';

test('DSH 会话菜单先选择模型和强度，再创建远程会话', async () => {
  const source = await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8');
  let entry;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { entry = value; } } } });
  assert.equal(entry.id, 'dsh-claude-bridge');
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
  const react = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}], useEffect() {} };
  const client = entry.factory(name => name === 'react' ? react
    : name === 'zod' ? { z: {} } : {});
  const slots = new Map();
  let configured = false;
  let catalogCalls = 0;
  let catalogError;
  let saved;
  let modelIds = ['haiku'];
  let contextPreferences = { autoCompactWindowTokens: null };
  let contextSaves = 0;
  let bridgeCompatibility = { status: 'compatible', clientVersion: '0.2.3-rc.1',
    serverVersion: '9.0.0', minimumClientVersion: '0.2.0', message: '客户端符合服务端版本要求。' };
  let host = { version: '0.2.1-rc.5', baselineVersion: '0.2.1-rc.5', status: 'compatible' };
  const ctx = {
    workspaces: {}, uiWorkspace: {},
    remote: { $mount: async () => async () => {}, session: {}, claudeBridge: {
      status: async () => ({ ok: true, value: { configured, url: 'wss://example.test/',
        connected: false, authentication: 'unknown', diagnosticsPath: 'local-diagnostics',
        contextPreferences, autoCompactWindowSupported: true, bridgeCompatibility, host,
        disabledFeatures: [{ name: '规划模式', status: 'disabled', reason: '测试原因' }],
        remotePreset: { mode: 'basic', reasons: ['标准预设无法适配'], disabledComponents: [] },
        remoteCapabilities: { status: 'unavailable', shell: 'pwsh', reason: '基础执行失败' },
        desktopCompatibility: { version: '0.2.1-rc.5', verifiedVersions: ['0.2.1-rc.5'] },
        usageSummary: { sessions: 1, runs: 2, inputTokens: 3, outputTokens: 4,
          cacheReadTokens: 5, cacheWriteTokens: 6, estimatedCostUsd: 0.01, costKind: 'sdk-estimate' } } }),
      saveConnection: async value => { saved = value; configured = true; return { ok: true, value: { configured: true } }; },
      refreshCatalog: async () => { catalogCalls++; return catalogError
        ? { ok: false, error: catalogError } : { ok: true, value: { models: [] } }; },
      modelPreferences: async () => ({ ok: true, value: { models: [
        { value: 'haiku', displayName: 'Haiku' }, { value: 'sonnet', displayName: 'Sonnet' },
      ], enabledIds: modelIds, usingDefaults: false } }),
      saveModelPreferences: async value => { modelIds = Array.from(value.enabledIds); return { ok: true, value: { saved: true } }; },
      saveContextPreferences: async value => { contextSaves++; contextPreferences = { ...value }; return { ok: true, value }; },
    } },
    slots: { inject: (_name, register) => register(), register: (options, component) => {
      slots.set(options.id, { options, component }); return () => {};
    } }, inject: (_services, callback) => callback(ctx), effect: () => {},
  };
  await client.apply(ctx);
  const settings = slots.get('dsh-claude-bridge').options.inject();
  await settings.save({ url: 'wss://example.test/', token: 'sample-secret' });
  assert.equal(saved.token, 'sample-secret');
  assert.equal(catalogCalls, 0);
  assert.equal(JSON.stringify(settings.hooks.settings.getSnapshot()).includes(saved.token), false);
  assert.equal(settings.hooks.settings.getSnapshot().disabledFeatures[0].name, '规划模式');
  assert.equal(settings.hooks.settings.getSnapshot().remotePreset.mode, 'basic');
  assert.equal(settings.hooks.settings.getSnapshot().remoteCapabilities.reason, '基础执行失败');
  assert.equal(settings.hooks.settings.getSnapshot().desktopCompatibility.version, '0.2.1-rc.5');
  assert.equal(settings.hooks.settings.getSnapshot().usageSummary.runs, 2);
  const slot = slots.get('dsh-claude-bridge');
  const render = () => slot.component({ ...settings, useSettings: select => select(settings.hooks.settings.getSnapshot()) });
  const nodesOf = node => node == null || typeof node !== 'object' ? []
    : Array.isArray(node) ? node.flatMap(nodesOf) : [node, ...nodesOf(node.children)];
  const textOf = node => node == null || typeof node === 'boolean' ? ''
    : typeof node === 'string' || typeof node === 'number' ? String(node)
      : Array.isArray(node) ? node.map(textOf).join(' ') : node.type === 'style' ? '' : textOf(node.children);
  const versionAlert = tree => nodesOf(tree).find(node => node.props?.role === 'alert' && node.props['aria-label'] === '客户端版本要求');
  assert.equal(settings.hooks.settings.getSnapshot().bridgeCompatibility.status, 'compatible');
  assert.match(textOf(render()), /客户端插件 0\.2\.3-rc\.1；服务端 9\.0\.0/);
  assert.equal(versionAlert(render()), undefined);
  assert.match(textOf(render()), /本次启动尚未取得自动检查结果/);
  host = { ...host, checks: [
    { id: 'host-interfaces', evidence: 'interface', status: 'passed' },
    { id: 'session-protocol', evidence: 'synthetic', status: 'passed' },
    { id: 'session-restore', evidence: 'synthetic', status: 'passed' },
    { id: 'desktop-acceptance', evidence: 'desktop', status: 'not-run' },
    { id: 'remote-sdk', evidence: 'real-sdk', status: 'not-run' },
  ] };
  await settings.refreshStatus();
  assert.equal(settings.hooks.settings.getSnapshot().host.checks.length, 5);
  const checkText = textOf(render());
  assert.match(checkText, /DSH 0\.2\.1-rc\.5；已验证基线：0\.2\.1-rc\.5/);
  assert.match(checkText, /Host 接口（接口检查）：通过/);
  assert.match(checkText, /会话协议（内存探针）：通过/);
  assert.match(checkText, /严格会话恢复（内存探针）：通过/);
  assert.match(checkText, /当前桌面行为（桌面实测）：本次未执行/);
  assert.match(checkText, /真实远程 SDK（真实 SDK 验收）：本次未执行/);
  assert.match(checkText, /桌面行为和真实远程 SDK 未自动验收/);
  host = { ...host, checks: host.checks.map(check => check.id === 'remote-sdk'
    ? { ...check, evidence: 'synthetic', status: 'passed' } : check) };
  await settings.refreshStatus();
  assert.match(textOf(render()), /真实远程 SDK（真实 SDK 验收）：未取得/);
  host = undefined;
  await settings.refreshStatus();
  assert.equal(settings.hooks.settings.getSnapshot().host, null);
  assert.match(textOf(render()), /本次启动尚未取得自动检查结果/);
  bridgeCompatibility = { ...bridgeCompatibility, status: 'update-required', minimumClientVersion: '0.2.4',
    message: '请更新客户端插件。' };
  await settings.refreshStatus();
  const requiredBanner = versionAlert(render());
  assert.match(textOf(requiredBanner), /最低客户端版本：0\.2\.4/);
  assert.equal(nodesOf(requiredBanner).find(node => node.type === 'a').props.href,
    'https://github.com/yyjsjsjx-png/dsh-claude-bridge/blob/main/docs/updating.md');
  bridgeCompatibility = { ...bridgeCompatibility, status: 'invalid', minimumClientVersion: null,
    message: '服务端版本要求无效。' };
  await settings.refreshStatus();
  assert.match(textOf(versionAlert(render())), /服务端版本要求无效/);
  bridgeCompatibility = { status: 'legacy', clientVersion: '0.2.3-rc.1', serverVersion: null,
    minimumClientVersion: null, message: '' };
  await settings.refreshStatus();
  assert.equal(versionAlert(render()), undefined);
  assert.match(textOf(render()), /服务端未声明版本要求，按旧版兼容模式连接/);
  settings.editContextMode('custom'); settings.editContextWindow('200000');
  await settings.refreshStatus();
  assert.equal(settings.hooks.settings.getSnapshot().contextWindow, '200000');
  assert.equal(settings.hooks.settings.getSnapshot().contextMode, 'custom');
  await settings.saveContext();
  assert.equal(contextPreferences.autoCompactWindowTokens, 200000);
  assert.equal(settings.hooks.settings.getSnapshot().contextDirty, false);
  settings.editContextWindow('99999'); await settings.saveContext();
  assert.equal(contextSaves, 1);
  assert.match(settings.hooks.settings.getSnapshot().contextError, /100,000/);
  settings.editContextMode('default'); await settings.saveContext();
  assert.equal(contextPreferences.autoCompactWindowTokens, null);
  await settings.refresh();
  assert.equal(catalogCalls, 1);
  assert.equal(settings.hooks.settings.getSnapshot().models.length, 2);
  settings.toggleVisibleModel('haiku');
  settings.toggleVisibleModel('sonnet');
  await settings.saveModels();
  assert.deepEqual(modelIds, ['sonnet']);
  assert.deepEqual(Array.from(settings.hooks.settings.getSnapshot().selectedModelIds), ['sonnet']);
  catalogError = { code: 'CLIENT_UPDATE_REQUIRED', message: '请更新客户端后重新连接。' };
  bridgeCompatibility = { status: 'update-required', clientVersion: '0.2.3-rc.1', serverVersion: '9.0.0',
    minimumClientVersion: '0.2.5', message: catalogError.message };
  await settings.refresh();
  const handshakeBanner = versionAlert(render());
  assert.match(textOf(handshakeBanner), /最低客户端版本：0\.2\.5/);
  assert.equal(nodesOf(handshakeBanner).find(node => node.type === 'a').props.href,
    'https://github.com/yyjsjsjx-png/dsh-claude-bridge/blob/main/docs/updating.md');
  assert.equal(settings.hooks.settings.getSnapshot().error, catalogError.message);
});

test('远程新建默认沿用上次模型和强度，目录失效时要求重新选择', async () => {
  let entry;
  vm.runInNewContext(await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load: value => { entry = value; } } } });
  const client = entry.factory(name => name === 'react' ? { createElement() {} } : name === 'zod' ? { z: {} } : {});
  const slots = new Map();
  let selection = { provider: 'claude-sdk-remote', model: 'haiku', reasoningEffort: 'high' };
  const models = [{ id: 'haiku', reasoning: { efforts: [{ id: 'high' }] } }];
  const ctx = {
    workspaces: { list: { getSnapshot: () => ({ items: [{ workspaceId: 'w', sessionIds: ['s'] }] }) } },
    sessions: {}, uiWorkspace: {},
    remote: { $mount: async () => async () => {}, session: {}, claudeBridge: {
      status: async () => ({ ok: true, value: { configured: false } }),
      visibleModels: async () => ({ ok: true, value: { models, selection } }),
    } },
    slots: { inject: (_name, register) => register(), register(options) { slots.set(options.id, options); return () => {}; } },
    inject: (_services, callback) => callback(ctx), effect() {},
  };
  await client.apply(ctx);
  const show = slots.get('dsh-claude-new-session').inject('s').show;
  const picker = slots.get('dsh-claude-session-picker').inject();
  await show();
  assert.equal(picker.hooks.dialog.getSnapshot().model, 'haiku');
  assert.equal(picker.hooks.dialog.getSnapshot().effort, 'high');
  selection = { ...selection, reasoningEffort: 'removed' };
  await show();
  assert.equal(picker.hooks.dialog.getSnapshot().model, 'haiku');
  assert.equal(picker.hooks.dialog.getSnapshot().effort, '');
  selection = { ...selection, model: 'hidden' };
  await show();
  assert.equal(picker.hooks.dialog.getSnapshot().model, '');
  assert.equal(picker.hooks.dialog.getSnapshot().effort, '');
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
    connected: configured, authentication: configured ? 'logged-in' : 'unknown',
    modelCatalog: configured ? { status: 'failed', code: 'MODEL_CATALOG_UNAVAILABLE' } : undefined } });
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
  assert.equal(settings.hooks.settings.getSnapshot().modelCatalog.status, 'failed');
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
  assert.equal(state.modelCatalog, null);
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
  assert.match(textOf(render()), /会话\s+1\s+运行\s+2/u);
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
  latest = { ...latest, configured: true, modelCatalog: { status: 'failed', code: 'MODEL_CATALOG_UNAVAILABLE' } };
  await settings.refreshStatus();
  assert.equal(settings.hooks.settings.getSnapshot().modelCatalog.status, 'failed');
  const catalogAlert = () => nodesOf(render()).find(node => node.props?.role === 'alert'
    && node.props['aria-label'] === '模型目录刷新状态');
  assert.match(textOf(catalogAlert()), /远程模型目录刷新失败（MODEL_CATALOG_UNAVAILABLE）/u);
  assert.match(textOf(catalogAlert()), /稍后重试；不影响其他模型使用/u);
  assert.doesNotMatch(textOf(catalogAlert()), /缓存/u);
  latest = { ...latest, modelCatalog: { status: 'ready' } };
  await settings.refreshStatus();
  assert.equal(settings.hooks.settings.getSnapshot().modelCatalog.status, 'ready');
  assert.equal(catalogAlert(), undefined);
  const warning = { code: 'USAGE_LEDGER_WRITE_FAILED', observedAt: Date.now(), gap: true };
  latest = { ...latest, observabilityWarning: warning };
  await settings.refreshStatus();
  assert.deepEqual(settings.hooks.settings.getSnapshot().observabilityWarning, warning);
  const diagnostics = nodesOf(render()).find(node => node.type === 'details');
  const warningAlert = () => nodesOf(render()).find(node => node.props?.role === 'alert'
    && node.props['aria-label'] === '统计记录状态');
  assert.equal(nodesOf(diagnostics).filter(node => node.props?.role === 'alert'
    && node.props['aria-label'] === '统计记录状态').length, 1);
  assert.match(textOf(diagnostics), /统计记录异常（USAGE_LEDGER_WRITE_FAILED），对话仍可继续；记录可能有缺口/u);
  assert.match(textOf(warningAlert()), /USAGE_LEDGER_WRITE_FAILED/u);
  latest = { ...latest, observabilityWarning: { code: 'arbitrary private message', gap: true } };
  await settings.refreshStatus();
  assert.doesNotMatch(textOf(warningAlert()), /arbitrary private message/u);
  latest = { ...latest, observabilityWarning: null };
  await settings.refreshStatus();
  assert.equal(settings.hooks.settings.getSnapshot().observabilityWarning, null);
  assert.equal(warningAlert(), undefined);
  for (const dispose of cleanup) dispose();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});

test('上下文底栏只显示百分比，浮层展示同源用量与精简分类，停止状态保留', async () => {
  const source = await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8');
  let entry;
  vm.runInNewContext(source, { document: { body: {} },
    window: { __ModuleLoader__: { load: value => { entry = value; } } } });
  const states = [];
  let cursor = 0;
  const react = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = value; }];
    }, useRef: () => ({ current: null }), useEffect() {} };
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
  let progress = null;
  const progressFace = { getSnapshot: () => progress, subscribe: () => () => {} };
  const ctx = {
    workspaces: {}, uiWorkspace: {},
    sessions: { binding(id) {
      assert.equal(id, 'selected-session');
      return { session: { projections: { faceOf(key) {
        assert.ok(['claudeBridge', 'claudeBridgeProgress'].includes(key));
        return key === 'claudeBridge' ? face : progressFace;
      } } } };
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
  const render = () => { cursor = 0; return meter.component({ useBridgeStatus: select => select(state),
    useBridgeProgress: select => select(progress) }); };
  assert.equal(textOf(render()).trim(), '≈12%');
  state = { ...state, recovery: { status: 'syncing' } };
  assert.equal(textOf(render()).trim(), '≈12%');
  state = { ...state, recovery: { status: 'ready', interrupted: true, added: 2, unresolvedTools: 0 } };
  assert.equal(textOf(render()).trim(), '≈12%');
  state = { ...state, phase: 'failed', recovery: { status: 'unavailable', code: 'HISTORY_READ_FAILED' } };
  assert.match(textOf(render()), /运行失败.*同步待重试/u);
  state = { ...state, recovery: { status: 'syncing', code: 'HISTORY_READ_FAILED' } };
  assert.match(textOf(render()), /运行失败.*同步待重试/u);
  state = { ...state, recovery: { status: 'waiting', code: 'HISTORY_READ_FAILED' } };
  assert.match(textOf(render()), /运行失败.*同步待重试/u);
  state = { ...state, recovery: { status: 'ready' } };
  assert.match(textOf(render()), /运行失败/u);
  assert.doesNotMatch(textOf(render()), /同步待重试/u);
  state = { ...state, phase: 'completed', connection: 'disconnected' };
  assert.equal(nodesOf(render()).some(node => node.props?.role === 'dialog'), false);
  nodesOf(render()).find(node => node.type === 'button').props.onClick();
  const expanded = render();
  const text = textOf(expanded);
  assert.match(text, /上下文已用 ≈12% ~120 \/ 1K/);
  assert.match(text, /对话消息 ~100/);
  assert.match(text, /上次快照：.*非实时/u);
  assert.match(text, /离线可查看已保存快照；执行仍需连接服务器/u);
  assert.equal(nodesOf(expanded).find(node => node.props?.role === 'dialog').props.className, 'dsh-claude-meter-panel');
  assert.doesNotMatch(text, /unavailable_tool|SDK 近似快照|剩余空间|压缩预留|原始窗口/);
  state = { ...state, phase: 'unknown', toolMayHaveExecuted: true };
  assert.match(textOf(render()), /状态待核实.*工具结果待核实.*≈12%/u);
  state = { ...state, phase: 'stopping', context: { status: 'unknown' }, toolMayHaveExecuted: true };
  assert.match(textOf(render()), /正在停止/);
  assert.match(textOf(render()), /未知/);
  assert.match(textOf(render()), /工具结果待核实/);
  state = { ...state, phase: 'completed', context: { ...state.context,
    status: 'known', totalTokens: 2149, maxTokens: 1_000_000, percentage: 0.2149, observedAt: 1000, categories: [] } };
  assert.match(textOf(render()), /≈0.2% ~2.1K \/ 1M/);
  state = { ...state, phase: 'compacting', runId: 'current-run' };
  progress = { model: state.model, runId: 'current-run', compaction: { trigger: 'auto', status: 'running' } };
  assert.match(textOf(render()), /正在自动压缩/u);
  state = { ...state, phase: 'running' };
  progress = { ...progress, compaction: { trigger: 'auto', status: 'completed', durationMs: 61876 },
    contextUpdate: { status: 'unavailable', code: 'CONTEXT_SUMMARY_TIMEOUT' } };
  assert.match(textOf(render()), /上下文更新失败/u);
  assert.match(textOf(render()), /最近自动压缩已完成，耗时 61.9 秒/u);
  assert.doesNotMatch(textOf(render()), /正在自动压缩/u);
  progress = { ...progress, contextUpdate: { status: 'updated' } };
  assert.doesNotMatch(textOf(render()), /上下文更新失败/u);
  progress = { ...progress, runId: 'previous-run', contextUpdate: { status: 'unavailable' } };
  assert.doesNotMatch(textOf(render()), /上下文更新失败/u);
  state = null;
  assert.equal(render(), null);
});

test('额度底栏同时显示 5h 和有效周剩余，浮层保留明细，过期或未返回不造百分比', async () => {
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
  const fullQuota = quota;
  const textOf = node => node == null || typeof node === 'boolean' ? ''
    : typeof node === 'string' || typeof node === 'number' ? String(node)
    : Array.isArray(node) ? node.map(textOf).join(' ') : node.type === 'style' ? '' : textOf(node.children);
  const nodesOf = node => node == null || typeof node !== 'object' ? []
    : Array.isArray(node) ? node.flatMap(nodesOf) : [node, ...nodesOf(node.children)];
  const render = () => { cursor = 0; return slots.get('dsh-claude-quota')({
    useBridgeStatus: select => select(bridge), useQuota: select => select(quota), readQuota() {},
  }); };
  assert.equal(textOf(render()).trim(), '5h 剩余 12% · 周剩余 24%');
  assert.doesNotMatch(textOf(render()), /周额度|Fable/);
  nodesOf(render()).find(node => node.type === 'button').props.onClick();
  assert.match(textOf(render()), /周额度 24%/);
  assert.match(textOf(render()), /Fable · 周额度 60%/);
  assert.equal(nodesOf(render()).find(node => node.props?.role === 'dialog').props['aria-label'], '剩余额度');
  const lastObservedAt = fullQuota.observedAt - 300_000;
  quota = { ...fullQuota, sampling: { fresh: false, lastObservedAt,
    nextAllowedAt: Date.now() + 300_000, inFlight: false,
    error: { code: 'PLAN_USAGE_SAMPLE_FAILED', observedAt: Date.now(), message: 'private upstream failure' } } };
  assert.match(textOf(render()), /5h 剩余 12% · 周剩余 24%/);
  assert.match(textOf(render()), /更新于 .* · 缓存读数 · 非实时/u);
  assert.ok(textOf(render()).includes(new Date(lastObservedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })));
  assert.match(textOf(nodesOf(render()).find(node => node.props?.role === 'alert')),
    /额度采样失败（PLAN_USAGE_SAMPLE_FAILED），保留上次读数/u);
  assert.doesNotMatch(textOf(render()), /private upstream failure/u);
  nodesOf(render()).find(node => node.type === 'button').props.onClick();
  assert.equal(textOf(render()).trim(), '5h 剩余 12% · 周剩余 24%');
  nodesOf(render()).find(node => node.type === 'button').props.onClick();
  quota = { ...quota, sampling: { ...quota.sampling, error: { code: 'private raw error' } } };
  assert.doesNotMatch(textOf(render()), /private raw error/u);
  quota = { ...quota, sampling: { ...quota.sampling, fresh: true, error: null } };
  assert.doesNotMatch(textOf(render()), /缓存读数|非实时|额度采样失败/u);
  quota = { ...quota, sampling: { ...quota.sampling, active: false } };
  assert.match(textOf(render()), /无运行任务，暂停查询；仅显示缓存读数/u);
  const cachedRefresh = nodesOf(render()).find(node => node.props?.['aria-label'] === '读取缓存额度');
  assert.equal(cachedRefresh.props.title, '无运行任务，仅查看缓存额度');
  quota = { ...quota, refreshing: true };
  assert.match(textOf(render()), /正在读取缓存/u);
  assert.doesNotMatch(textOf(render()), /正在刷新|刷新成功/u);
  quota = { ...quota, refreshing: false };
  nodesOf(render()).find(node => node.type === 'button').props.onClick();
  assert.equal(textOf(render()).trim(), '5h 剩余 12% · 周剩余 24%');
  nodesOf(render()).find(node => node.type === 'button').props.onClick();
  quota = { ...quota, sampling: { ...quota.sampling, active: true } };
  assert.doesNotMatch(textOf(render()), /无运行任务|暂停查询/u);
  assert.ok(nodesOf(render()).find(node => node.props?.['aria-label'] === '刷新额度'));
  quota = fullQuota;
  nodesOf(render()).find(node => node.type === 'button').props.onClick();
  quota = { ...fullQuota, windows: fullQuota.windows.filter(row => row.id === 'five_hour') };
  assert.equal(textOf(render()).trim(), '5h 剩余 12%');
  quota = { ...fullQuota, windows: fullQuota.windows.filter(row => row.id === 'seven_day') };
  assert.equal(textOf(render()).trim(), '周剩余 24%');
  quota = { ...fullQuota, windows: [] };
  assert.equal(textOf(render()).trim(), '5h 额度未知');
  assert.doesNotMatch(textOf(render()), /%/);
  quota = { ...fullQuota, windows: fullQuota.windows.map(row => row.id === 'seven_day'
    ? { ...row, resetsAt: Date.now() - 1 } : row) };
  assert.equal(textOf(render()).trim(), '5h 剩余 12%');
  assert.doesNotMatch(textOf(render()), /周剩余|24%/);
  quota = { ...fullQuota, windows: fullQuota.windows.map(row => row.id === 'five_hour'
    ? { ...row, resetsAt: Date.now() - 1 } : row) };
  assert.equal(textOf(render()).trim(), '周剩余 24%');
  quota = { ...fullQuota, expiresAt: Date.now() - 1 };
  assert.match(textOf(render()), /5h 待刷新/);
  assert.doesNotMatch(textOf(render()), /12%|24%|60%|100%/);
  quota = { status: 'unavailable', paused: 'version', code: 'CLIENT_UPDATE_REQUIRED',
    minimumClientVersion: '0.2.5', windows: [] };
  assert.equal(textOf(render()).trim(), '客户端需更新');
  nodesOf(render()).find(node => node.type === 'button').props.onClick();
  assert.match(textOf(render()), /最低客户端版本：0\.2\.5/);
  assert.doesNotMatch(textOf(render()), /12%|24%|60%|100%/);
  assert.equal(nodesOf(render()).find(node => node.type === 'a').props.href,
    'https://github.com/yyjsjsjx-png/dsh-claude-bridge/blob/main/docs/updating.md');
  quota = { ...quota, code: 'SERVER_COMPATIBILITY_INVALID', minimumClientVersion: null };
  assert.match(textOf(render()), /版本校验失败/);
  assert.match(textOf(render()), /服务端版本要求无效，请核对版本声明后重试/);
  assert.doesNotMatch(textOf(render()), /请更新后重试/);
  bridge = null;
  assert.equal(render(), null);
});

test('旧服务端额度刷新保留退避，新采样目录遵守服务端冷却且手动不绕过', async () => {
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
  let noLimits = false;
  let versionCode;
  let sampling;
  const ctx = { sessions: {}, workspaces: {}, uiWorkspace: {},
    remote: { $mount: async () => async () => {}, session: {}, claudeBridge: {
      status: async () => ({ ok: true, value: { configured: false } }),
      async planUsage(refresh) {
        reads.push(refresh);
        if (versionCode) return { ok: true, value: { status: 'unavailable', code: versionCode, minimumClientVersion: '0.2.5' } };
        if (blocked) return { ok: true, value: { status: 'unavailable', code: 'AUTH_EXPIRED' } };
        if (noLimits) return { ok: true, value: { status: 'unavailable', code: 'PLAN_LIMITS_UNAVAILABLE',
          ...(sampling ? { sampling } : {}) } };
        return fail ? { ok: false } : { ok: true, value: { status: 'available', observedAt: sampling?.lastObservedAt ?? clock,
          expiresAt: clock + (sampling ? 1_800_000 : 120_000),
          windows: [{ id: 'five_hour', usedPercent: 12, resetsAt: null }], ...(sampling ? { sampling } : {}) } };
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
  noLimits = true;
  await quota.readQuota('manual');
  assert.equal(quota.hooks.quota.getSnapshot().status, 'unavailable');
  assert.equal(quota.hooks.quota.getSnapshot().windows.length, 0);
  noLimits = false;
  versionCode = 'CLIENT_UPDATE_REQUIRED';
  await quota.readQuota('manual');
  assert.equal(quota.hooks.quota.getSnapshot().code, 'CLIENT_UPDATE_REQUIRED');
  assert.equal(quota.hooks.quota.getSnapshot().paused, 'version');
  assert.equal(quota.hooks.quota.getSnapshot().minimumClientVersion, '0.2.5');
  assert.equal(quota.hooks.quota.getSnapshot().windows.length, 0);
  assert.equal(quota.hooks.quota.getSnapshot().nextRefreshAt, 0);
  const beforeVersionPause = reads.length;
  clock += 600_000;
  await quota.readQuota('poll'); await quota.readQuota('open'); await quota.readQuota('online');
  network.onLine = false;
  await quota.readQuota('manual');
  assert.equal(quota.hooks.quota.getSnapshot().paused, 'version');
  assert.equal(reads.length, beforeVersionPause);
  network.onLine = true;
  versionCode = 'SERVER_COMPATIBILITY_INVALID';
  await quota.readQuota('manual');
  assert.equal(quota.hooks.quota.getSnapshot().code, 'SERVER_COMPATIBILITY_INVALID');
  assert.equal(quota.hooks.quota.getSnapshot().paused, 'version');
  assert.equal(reads.length, beforeVersionPause + 1);
  clock += 600_000;
  await quota.readQuota('poll');
  assert.equal(reads.length, beforeVersionPause + 1);
  versionCode = undefined;
  await quota.readQuota('manual');
  assert.equal(quota.hooks.quota.getSnapshot().status, 'available');
  assert.equal(reads.length, beforeVersionPause + 2);
  const firstObservedAt = clock;
  sampling = { fresh: true, lastObservedAt: firstObservedAt, nextAllowedAt: clock + 300_000,
    error: null, inFlight: false };
  await quota.readQuota('manual');
  const beforeCooldown = reads.length;
  assert.equal(quota.hooks.quota.getSnapshot().nextRefreshAt, sampling.nextAllowedAt);
  clock += 60_000;
  await quota.readQuota('manual'); await quota.readQuota('poll'); await quota.readQuota('activity');
  assert.equal(reads.length, beforeCooldown);
  assert.equal(quota.hooks.quota.getSnapshot().observedAt, firstObservedAt);
  clock = sampling.nextAllowedAt;
  sampling = { ...sampling, fresh: false, nextAllowedAt: clock + 300_000,
    error: { code: 'PLAN_USAGE_SAMPLE_FAILED', observedAt: clock } };
  await quota.readQuota('queued');
  const failedSample = quota.hooks.quota.getSnapshot();
  assert.equal(reads.length, beforeCooldown + 1);
  assert.equal(reads.at(-1), false);
  assert.equal(failedSample.status, 'available');
  assert.equal(failedSample.observedAt, firstObservedAt);
  assert.equal(failedSample.windows[0].usedPercent, 12);
  assert.equal(failedSample.sampling.error.code, 'PLAN_USAGE_SAMPLE_FAILED');
  assert.equal(failedSample.nextRefreshAt, sampling.nextAllowedAt);
  await quota.readQuota('manual');
  assert.equal(reads.length, beforeCooldown + 1);
  clock = sampling.nextAllowedAt;
  sampling = { fresh: true, lastObservedAt: clock, nextAllowedAt: clock + 300_000,
    error: null, inFlight: false };
  await quota.readQuota('manual');
  assert.equal(reads.length, beforeCooldown + 2);
  assert.equal(quota.hooks.quota.getSnapshot().sampling.error, null);
  assert.equal(quota.hooks.quota.getSnapshot().observedAt, clock);
  clock = sampling.nextAllowedAt;
  sampling = { fresh: false, active: false, lastObservedAt: null, nextAllowedAt: clock + 300_000,
    error: null, inFlight: false };
  noLimits = true;
  await quota.readQuota('manual');
  assert.equal(quota.hooks.quota.getSnapshot().status, 'unavailable');
  assert.equal(quota.hooks.quota.getSnapshot().sampling.active, false);
  assert.equal(quota.hooks.quota.getSnapshot().nextRefreshAt, sampling.nextAllowedAt);
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

test('后台同步仅 RPC 失败也显示错误，重试等待不清除，成功和换会话正确隔离', async () => {
  const source = await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8');
  let entry, nextTimer = 0, cursor = 0;
  const timers = new Map(), listeners = new Map(), hooks = [], effects = [];
  const page = { hidden: false, body: {}, addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name) };
  vm.runInNewContext(source, { document: page, navigator: { onLine: true },
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id), window: { __ModuleLoader__: { load: value => { entry = value; } },
      addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) } });
  const react = { createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = cursor++;
      hooks[index] ??= { value: initial };
      return [hooks[index].value, value => { hooks[index].value = value; }];
    }, useRef(initial) {
      const index = cursor++;
      hooks[index] ??= { current: initial };
      return hooks[index];
    }, useEffect(effect, deps) {
      const index = cursor++, previous = hooks[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        const hook = hooks[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { hook.cleanup?.(); hook.cleanup = effect(); });
      }
    } };
  const client = entry.factory(name => name === 'react' ? react : name === 'react-dom'
    ? { createPortal: value => value } : name === '@deepseek-ai/dsh-client-ui-primitives'
      ? { useAnchoredPosition: () => ({}), useDismissOnOutsidePointer() {} } : { z: {} });
  const slots = new Map(), calls = [];
  let reply = { ok: false }, throwRpc = false;
  const ctx = { sessions: {}, workspaces: {}, uiWorkspace: {},
    remote: { $mount: async () => async () => {}, session: {}, claudeBridge: {
      status: async () => ({ ok: true, value: { configured: false } }),
      syncSession: async sessionId => { calls.push(sessionId);
        if (throwRpc) throw new Error('合成 RPC 连接中断');
        return await reply; },
    } }, slots: { inject: (_name, register) => register(), register(options, component) {
      slots.set(options.id, { options, component }); return () => {};
    } }, inject: (_services, callback) => callback(ctx), effect() {} };
  await client.apply(ctx);
  const meter = slots.get('dsh-claude-context');
  const first = meter.options.inject('first-session').syncSession;
  const second = meter.options.inject('second-session').syncSession;
  // The Host projection deliberately remains ready for every RPC failure.
  const state = { phase: 'completed', recovery: { status: 'ready' }, context: { status: 'unknown' } };
  const render = syncSession => { cursor = 0; return meter.component({
    useBridgeStatus: select => select(state), syncSession }); };
  const textOf = node => node == null || typeof node === 'boolean' ? ''
    : typeof node === 'string' || typeof node === 'number' ? String(node)
      : Array.isArray(node) ? node.map(textOf).join(' ') : node.type === 'style' ? '' : textOf(node.children);
  const flush = async () => { for (const effect of effects.splice(0)) effect();
    for (let i = 0; i < 12; i++) await Promise.resolve(); };
  render(first); await flush();
  assert.match(textOf(render(first)), /同步待重试/u);
  let release;
  reply = new Promise(resolve => { release = resolve; });
  const retry = listeners.get('online')();
  assert.match(textOf(render(first)), /同步待重试/u);
  release({ ok: true, value: { status: 'waiting' } });
  await retry;
  assert.match(textOf(render(first)), /同步待重试/u);
  reply = { ok: true, value: { status: 'active' } };
  await listeners.get('online')();
  assert.match(textOf(render(first)), /同步待重试/u);
  reply = { ok: true, value: { status: 'ready' } };
  await listeners.get('online')();
  assert.doesNotMatch(textOf(render(first)), /同步待重试/u);
  throwRpc = true;
  await listeners.get('online')();
  assert.match(textOf(render(first)), /同步待重试/u);
  throwRpc = false;
  reply = new Promise(resolve => { release = resolve; });
  const late = listeners.get('online')();
  assert.doesNotMatch(textOf(render(second)), /同步待重试/u);
  reply = { ok: true, value: { status: 'empty' } };
  await flush();
  release({ ok: false });
  await late;
  assert.doesNotMatch(textOf(render(second)), /同步待重试/u);
  assert.equal(calls.at(-1), 'second-session');
  for (const hook of hooks) hook?.cleanup?.();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
});
