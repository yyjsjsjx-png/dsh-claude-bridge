/** Mount only the remote preset in an independently audited, disposable tree. */
import { resolveDshModule } from './compat/resolve-dsh-module.mjs';
import { loadRemoteComposition, publishRemotePresetStatus } from './preset-loading.mjs';
import { installShellFailureGuard } from './shell-failure-guard.mjs';

const { EntryTree } = await import(resolveDshModule('@deepseek-ai/cordis-plugin-loader'));
const { prepareProfileEntries } = await import(resolveDshModule('@deepseek-ai/dsh-app-boot'));
const { scopeOf } = await import(resolveDshModule('@deepseek-ai/dsh-scope'));
const { HarnessError } = await import(resolveDshModule('@deepseek-ai/dsh-llm'));

export const inject = ['loader', 'tools', 'systemPrompt', 'shell', 'shellEnv', 'workingDirectory',
  'approval', 'sessionProjections', 'fs'];

class RemoteTree extends EntryTree {
  constructor(ctx) {
    const owner = ctx.fiber.entry;
    const subtree = owner?.subtree;
    const subgroup = owner?.subgroup;
    super(ctx);
    // Match rc.5 PresetTree: an internal tree does not replace its Host entry.
    if (owner) {
      if (subtree === undefined) delete owner.subtree;
      else owner.subtree = subtree;
      if (subgroup === undefined) delete owner.subgroup;
      else owner.subgroup = subgroup;
    }
  }
  write() {}
}

export async function apply(ctx, config) {
  let composition;
  let currentStatus;
  let disposed = false;
  // Register teardown before loading so partial activation is also owned.
  ctx.effect(() => async () => { disposed = true; await composition?.dispose(); }, '远程预设组件清理');
  const remoteEntries = rows => rows.map(row => {
    if (row.id === 'agent-instructions') {
      if (row.name !== '@deepseek-ai/dsh-agent-instructions') {
        throw Object.assign(new Error('远程预设的原生指令组件无法审计。'), { code: 'INSTRUCTION_AUDIT_UNAVAILABLE' });
      }
      return { ...row, name: new URL('./instruction-audit-plugin.mjs', import.meta.url).href };
    }
    if (row.id === 'tool-subagent' && row.name === '@deepseek-ai/dsh-tool-subagent') {
      return { ...row, name: new URL('./remote-subagent.mjs', import.meta.url).href };
    }
    if (row.id === 'tool-web' && row.name === '@deepseek-ai/dsh-tool-web') {
      return { ...row, name: new URL('./remote-web.mjs', import.meta.url).href };
    }
    return row.group && Array.isArray(row.config) ? { ...row, config: remoteEntries(row.config) } : row;
  });
  composition = await loadRemoteComposition({ ...config,
    createTree: () => new RemoteTree(ctx.extend({ baseUrl: config.baseUrl })),
    prepareRows: rows => prepareProfileEntries(ctx, remoteEntries(rows), config.baseUrl),
    report: status => {
      currentStatus = status;
      // Declaration-source notices are visible to the user. Only actual
      // capability changes below contribute to the model's system prompt.
      publishRemotePresetStatus(ctx, { ...status, reasons: [...status.reasons, ...(config.noticeReasons ?? [])] });
    },
  });
  if (disposed) { await composition.dispose(); return; }
  // Publish the successful inner tree to native composition inspection. Failed
  // rows have already been removed, so the outer preset audit stays truthful.
  const owner = ctx.fiber.entry;
  const previousTree = owner?.subtree;
  if (owner) {
    owner.subtree = composition.tree;
    ctx.effect(() => () => {
      if (owner.subtree !== composition.tree) return;
      if (previousTree === undefined) delete owner.subtree;
      else owner.subtree = previousTree;
    }, '远程预设清单清理');
  }
  ctx.effect(() => installShellFailureGuard(ctx, config.shell, scopeOf(ctx), HarnessError), '基础 shell 故障守卫');
  ctx.systemPrompt.section({ name: 'claude-bridge:preset-capabilities', order: 10300, interpolate: false,
    text: [
      `Remote session preset: ${currentStatus.mode}. Only tools in the current tool catalog are available.`,
      ...currentStatus.reasons,
      ...currentStatus.disabledComponents.map(item => `Disabled component ${item.name}: ${item.reason}`),
      ...(currentStatus.mode === 'basic' ? ['基础预设仅提供原生 shell 与必要上下文；子代理、后台任务和其他扩展未开启。'] : []),
    ].join('\n'),
  });
}
