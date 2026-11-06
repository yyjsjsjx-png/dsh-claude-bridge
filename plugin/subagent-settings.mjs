/** Gate original settings initialization without replacing its entry, Config, or saved values. */
import { guardNativeSubagentSettings, SUBAGENT_SETTINGS_GATE } from './presets/subagent-settings.mjs';

const NATIVE_SETTINGS = '@deepseek-ai/dsh-tool-subagent/model-selection-settings';
const declaresGate = entry => Array.isArray(entry.options.inject)
  ? entry.options.inject.includes(SUBAGENT_SETTINGS_GATE) : Object.hasOwn(entry.options.inject ?? {}, SUBAGENT_SETTINGS_GATE);
function sourceOf(tree, id) { try { return tree?.resolve(id); } catch { return undefined; } }
export const name = 'claude-subagent-settings-gate';
export const inject = ['loader'];

export async function apply(ctx, { sourceEntry = 'subagent-model-selection-settings' } = {}) {
  const tree = ctx.fiber.entry?.parent?.tree;
  const source = sourceOf(tree, sourceEntry);
  if (!source || source.options.name !== NATIVE_SETTINGS || !declaresGate(source)) {
    throw Object.assign(new Error('远程子任务选型初始化门禁缺失；自定义 Host 子任务设置 inject 覆盖暂不支持。'),
      { code: 'REMOTE_SUBAGENT_POLICY_GATE_UNAVAILABLE' });
  }
  const disposers = new Map();
  const entries = new Set();
  const guard = entry => {
    entries.add(entry);
    for (const context of [entry.ctx, entry.fiber?.ctx]) {
      if (context && !disposers.has(context)) disposers.set(context, guardNativeSubagentSettings(context, entry));
    }
  };
  ctx.effect(() => async () => {
    for (const dispose of [...disposers.values()].reverse()) dispose();
    for (const entry of entries) {
      const fiber = entry.fiber;
      if (tree.ctx.fiber.uid === null || sourceOf(tree, sourceEntry) !== entry || !fiber || fiber.uid === null
        || declaresGate(entry) || !Object.hasOwn(fiber.inject, SUBAGENT_SETTINGS_GATE)) continue;
      // Entry.update retains the resolved injection dictionary. Withdraw only
      // our removed overlay key, then restart without a config persistence event.
      delete fiber.inject[SUBAGENT_SETTINGS_GATE];
      if (entry.fiber === fiber && fiber.uid !== null) await fiber.restart();
    }
  }, '原生子任务设置事件恢复');
  ctx.on('loader/patch-context', (entry, next) => {
    if (entry.parent.tree === tree && entry.options.id === sourceEntry && entry.options.name === NATIVE_SETTINGS) guard(entry);
    return next();
  });
  guard(source);
  const fiber = source.fiber;
  if (fiber && fiber.uid !== null && !Object.hasOwn(fiber.inject, SUBAGENT_SETTINGS_GATE)) {
    // Re-enabling an overlay also retains the old dictionary. Re-establish
    // our dependency and await the unguarded instance's teardown before ready.
    fiber.inject[SUBAGENT_SETTINGS_GATE] = null;
    await fiber.restart();
    ctx.fiber.assertActive();
  }
  // Dependency publication happens only after both pending and future contexts
  // are guarded. It never changes the native settings' config or user values.
  ctx.provide(SUBAGENT_SETTINGS_GATE, {});
}
