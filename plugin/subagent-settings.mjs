/** Gate original settings initialization without replacing its entry, Config, or saved values. */
import { guardNativeSubagentSettings, SUBAGENT_SETTINGS_GATE } from './presets/subagent-settings.mjs';

const NATIVE_SETTINGS = '@deepseek-ai/dsh-tool-subagent/model-selection-settings';
export const name = 'claude-subagent-settings-gate';
export const inject = ['loader'];

export function apply(ctx, { sourceEntry = 'subagent-model-selection-settings' } = {}) {
  const tree = ctx.fiber.entry?.parent?.tree;
  const source = tree?.resolve(sourceEntry);
  const declared = source?.options.inject;
  if (!source || source.options.name !== NATIVE_SETTINGS || !(Array.isArray(declared)
    ? declared.includes(SUBAGENT_SETTINGS_GATE) : Object.hasOwn(declared ?? {}, SUBAGENT_SETTINGS_GATE))) {
    throw Object.assign(new Error('远程子任务选型初始化门禁缺失；自定义 Host 子任务设置 inject 覆盖暂不支持。'),
      { code: 'REMOTE_SUBAGENT_POLICY_GATE_UNAVAILABLE' });
  }
  const disposers = new Map();
  const guard = entry => {
    for (const context of [entry.ctx, entry.fiber?.ctx]) {
      if (context && !disposers.has(context)) disposers.set(context, guardNativeSubagentSettings(context, entry));
    }
  };
  ctx.effect(() => () => { for (const dispose of [...disposers.values()].reverse()) dispose(); }, '原生子任务设置事件恢复');
  ctx.on('loader/patch-context', (entry, next) => {
    if (entry.parent.tree === tree && entry.options.id === sourceEntry && entry.options.name === NATIVE_SETTINGS) guard(entry);
    return next();
  });
  guard(source);
  // Dependency publication happens only after both pending and future contexts
  // are guarded. It never changes the native settings' config or user values.
  ctx.provide(SUBAGENT_SETTINGS_GATE, {});
}
