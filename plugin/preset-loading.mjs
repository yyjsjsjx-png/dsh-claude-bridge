/** Runtime reports are confined to one Host and never saved in user configuration. */
const reports = new WeakMap();
export function remotePresetStatus(ctx) {
  return reports.get(ctx.root ?? ctx) ?? { mode: 'unchecked', disabledComponents: [], reasons: [] };
}
export function publishRemotePresetStatus(ctx, value) {
  reports.set(ctx.root ?? ctx, structuredClone(value));
}

function unavailable(message, cause) {
  return Object.assign(new Error(`远程会话插件不可用：${message}`, { cause }), { code: 'REMOTE_SHELL_UNAVAILABLE' });
}

/** Audit the actual mounted rows, including children of optional groups. */
export async function inspectPresetTree(tree) {
  await tree.await();
  const issues = [];
  for (const entry of tree.entries()) {
    if (entry.disabled) continue;
    const fiber = entry.fiber;
    let reason;
    if (!fiber) reason = '组件无法加载。';
    else {
      try { await fiber.await(); }
      catch { reason = '组件激活失败。'; }
      if (!reason) {
        const missing = Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined);
        if (missing.length) reason = `依赖尚未就绪：${missing.join('、')}；重载插件后可重新检查。`;
        else if (fiber.state !== 2) reason = '组件未进入可用状态。';
      }
    }
    if (reason) issues.push({ entry, name: entry.options.id, status: 'disabled', reason });
  }
  return issues;
}

/** Loader remove/stop are synchronous; explicitly await every owned disposer. */
async function disposeRows(tree, entries, stopAll) {
  const fibers = [...new Set(entries.map(entry => entry.fiber).filter(Boolean))];
  if (stopAll) tree.root.stop();
  else for (const entry of entries) {
    // Removing an ancestor can remove descendants as well.
    if ([...tree.entries()].includes(entry)) entry.parent.remove(entry.options.id);
  }
  const results = await Promise.allSettled(fibers.map(fiber => fiber.dispose()));
  if (results.some(result => result.status === 'rejected')) {
    throw unavailable('旧预设组件未能完成清理，已停止回退；请重载插件。');
  }
}

function ownedBy(entry, ancestor) {
  if (entry === ancestor) return true;
  if (!ancestor.fiber) return false;
  let fiber = entry.fiber ?? entry.parent?.context?.fiber;
  while (fiber) {
    if (fiber === ancestor.fiber) return true;
    const parent = fiber.parent?.fiber;
    if (parent === fiber) break;
    fiber = parent;
  }
  return false;
}

/** Testable loading policy; real EntryTrees are supplied by the scoped container. */
export async function loadRemoteComposition({ createTree, plugins, basicPlugins, shell,
  mode = 'full', reasons = [], report = () => {}, prepareRows = rows => rows }) {
  const required = new Set(['persona', 'agent-instructions', `tool-${shell}`]);
  let tree;
  const disabledComponents = [];
  const missingRequired = () => {
    const ids = new Set([...tree.entries()].filter(entry => !entry.disabled).map(entry => entry.options.id));
    return [...required].some(id => !ids.has(id));
  };
  const state = () => ({ mode, shell, reasons: [...reasons], disabledComponents: [...disabledComponents] });
  const stop = async () => {
    const closing = tree;
    tree = undefined;
    if (closing) await disposeRows(closing, [...closing.entries()], true);
  };
  try {
    for (;;) {
      tree = createTree();
      let issues;
      try {
        await tree.root.update(prepareRows(mode === 'basic' ? basicPlugins : plugins));
        issues = await inspectPresetTree(tree);
        if (missingRequired()) throw unavailable('预设缺少 shell 或必要上下文组件。');
        if (issues.some(issue => required.has(issue.entry.options.id))) throw unavailable('shell 或必要上下文组件加载失败。');
      } catch (error) {
        await stop();
        if (mode === 'basic') throw unavailable('基础 shell 预设加载失败；已停止执行。', error);
        mode = 'basic';
        reasons.push('完整预设无法加载，已回退到插件维护的基础预设。');
        continue;
      }
      // A removed provider can make another optional row unavailable. Each
      // iteration removes at least one row; no failed side effect is retried.
      let fallback = false;
      while (issues.length) {
        const entries = [...tree.entries()].filter(entry => issues.some(issue => ownedBy(entry, issue.entry)));
        await disposeRows(tree, entries, false);
        disabledComponents.push(...issues.map(({ name, status, reason }) => ({ name, status, reason })));
        issues = await inspectPresetTree(tree);
        if (missingRequired() || issues.some(issue => required.has(issue.entry.options.id))) {
          if (mode === 'basic') throw unavailable('必要上下文依赖已失效，已停止执行。');
          await stop();
          mode = 'basic';
          reasons.push('可选组件隔离后必要依赖不可用，已回退到插件维护的基础预设。');
          fallback = true;
          break;
        }
      }
      if (fallback) continue;
      if (mode === 'full' && disabledComponents.length) mode = 'degraded';
      report(state());
      return { tree, dispose: stop };
    }
  } catch (error) {
    try { await stop(); } catch (cleanup) { error = cleanup; }
    report({ ...state(), mode: 'unavailable', reasons: [...reasons, error.message] });
    throw error;
  }
}
