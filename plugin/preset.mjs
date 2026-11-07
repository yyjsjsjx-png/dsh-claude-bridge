import { CLAUDE_PRESET } from './policy.mjs';
import { createLegacyV024RemoteClaudePreset } from './presets/legacy-v024.mjs';
import { remoteSubagentConfig } from './presets/subagent-capabilities.mjs';

/** Explicit limits that are independent of a particular request's tool list. */
export const REMOTE_PRESET_LIMITATIONS = Object.freeze([
  Object.freeze({ name: '计划模式', status: 'disabled', reason: '暂不提供计划模式。' }),
  Object.freeze({ name: 'subagent_fork', status: 'disabled', reason: '不支持分叉子任务。' }),
  Object.freeze({ name: 'DSH 原生压缩', status: 'disabled', reason: '远程 Agent SDK 负责自身会话的上下文和压缩。' }),
  Object.freeze({ name: '会话分叉', status: 'disabled', reason: '请通过新建会话开始其他任务。' }),
  Object.freeze({ name: '自动时间与时区上下文', status: 'disabled', reason: '远程预设不自动发送当前时间、浏览器时区或距上条消息的时间。' }),
]);
export const REMOTE_PRESET_CONVERSIONS = Object.freeze([
  Object.freeze({ name: '/compact', status: 'converted', reason: '由远程 Agent SDK 压缩上下文，保留对话历史。' }),
  Object.freeze({ name: '身份提示', status: 'converted', reason: '云端会话使用固定的 Claude 身份提示。' }),
  Object.freeze({ name: 'Workflow 深度限制', status: 'converted', reason: '沿用 DSH 子任务深度上限。' }),
  Object.freeze({ name: '子任务独立选型', status: 'converted', reason: '默认继承父会话，可显式选择同一 Claude 账号模型与推理强度。' }),
]);
const REMOTE_PERSONA_PREFIX = 'You are a coding agent powered by Claude through the remote Claude Agent SDK.';

function remoteCommands() {
  return [
    { id: 'claude-sdk-compact', name: new URL('./compact-command.mjs', import.meta.url).href },
    { id: 'claude-sdk-recovery', name: new URL('./recovery-command.mjs', import.meta.url).href },
  ];
}

/** Owned complete fallback when the installed standard cannot be adapted. */
export function createOwnedRemoteClaudePreset(subagentFields = { modelSelectionSettings: true }) {
  const preset = createLegacyV024RemoteClaudePreset({ personaPrefix: REMOTE_PERSONA_PREFIX, commands: remoteCommands() });
  const modern = Object.hasOwn(subagentFields, 'modelSelection');
  preset.plugins = preset.plugins.map(row => {
    if (modern && row.id === 'tool-fs') return { ...row, config: { applyPatch: false } };
    if (modern && row.id === 'tool-plugin-manager') return { ...row, disabled: { __jsExpr: "!ctx.get('profileContext')" } };
    if (row.id !== 'delegation') return row;
    return { ...row, config: row.config.filter(child => !modern || child.id !== 'tool-subagent-list-agents')
      .map(child => child.id === 'tool-subagent' ? { ...child, config: remoteSubagentConfig(child.config, subagentFields) } : child) };
  });
  return preset;
}

/** UI descriptions must follow the effective preset, including basic fallback. */
export function remotePresetFeatures(report) {
  const disabled = new Set(report.disabledComponents.map(item => item.name));
  const unavailable = new Map();
  if (report.mode === 'basic' || disabled.has('delegation') || disabled.has('tool-workflow') || disabled.has('workflow-ptc')) {
    unavailable.set('Workflow 深度限制', '当前远程预设未开启 Workflow。');
  }
  if (disabled.has('claude-sdk-compact')) unavailable.set('/compact', '压缩命令组件未就绪。');
  if (report.mode === 'basic' || disabled.has('delegation') || disabled.has('tool-subagent')) {
    unavailable.set('子任务独立选型', '当前远程预设未开启子代理。');
  }
  return {
    disabledFeatures: [...REMOTE_PRESET_LIMITATIONS.map(item => ({ ...item })), ...report.disabledComponents,
      ...[...unavailable].map(([name, reason]) => ({ name, status: 'disabled', reason })),
      ...(report.mode === 'basic' ? [{ name: '子代理与后台任务', status: 'disabled', reason: '基础预设仅保留前台 shell 与必要上下文。' }] : [])],
    convertedFeatures: REMOTE_PRESET_CONVERSIONS.filter(item => !unavailable.has(item.name)).map(item => ({ ...item })),
  };
}

/** Owned minimum composition; it does not read or copy the installed standard. */
export function createBasicRemoteClaudePreset(platform = process.platform) {
  const shell = platform === 'win32' ? 'pwsh' : 'bash';
  return {
    id: CLAUDE_PRESET,
    name: '远程会话',
    description: '基础远程预设：原生 shell、工作目录与完整项目指令。',
    order: 5,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: REMOTE_PERSONA_PREFIX } },
      { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
      { id: `tool-${shell}`, name: `@deepseek-ai/dsh-tool-${shell}`,
        config: { enableRunInBackground: false, promoteOnTimeout: false } },
      ...remoteCommands(),
    ],
  };
}

/** Keep all loading and degradation inside this remote preset's scope. */
export function containRemotePreset(preset, { baseUrl, mode = 'full', reasons = [], noticeReasons = [], platform = process.platform } = {}) {
  return { ...preset, plugins: [{
    id: 'claude-remote-composition', name: new URL('./remote-composition.mjs', import.meta.url).href,
    config: { plugins: preset.plugins, basicPlugins: createBasicRemoteClaudePreset(platform).plugins,
      baseUrl, mode, reasons, noticeReasons, shell: platform === 'win32' ? 'pwsh' : 'bash' },
  }] };
}

const PACKAGE = Object.freeze({
  persona: '@deepseek-ai/dsh-persona',
  instructions: '@deepseek-ai/dsh-agent-instructions',
  planMode: '@deepseek-ai/dsh-plan-mode',
  timeContext: '@deepseek-ai/dsh-time-context',
  subagent: '@deepseek-ai/dsh-tool-subagent',
  web: '@deepseek-ai/dsh-tool-web',
});
const COMPACTION_PACKAGE = /^@deepseek-ai\/dsh-(?:compaction(?:-|$)|command-compact$)/u;
const SHELL_PACKAGE = /^@deepseek-ai\/dsh-tool-(bash|pwsh)$/u;

function childRows(row) {
  return row.group === true && Array.isArray(row.config) ? row.config : undefined;
}

function isPresetRow(row) {
  return row !== null && typeof row === 'object' && !Array.isArray(row)
    && typeof row.name === 'string' && row.name.length > 0;
}

function isSpawnRow(row) {
  return row.name === PACKAGE.subagent && row.config?.provider === 'spawn';
}

function* walkRows(rows) {
  for (const row of rows) {
    if (!isPresetRow(row)) throw new TypeError('DSH 标准预设包含无效的插件条目。');
    yield row;
    const children = childRows(row);
    if (children) yield* walkRows(children);
  }
}

/** Downstream loading and status reports address these capabilities by stable ids. */
function stableId(row) {
  if (row.name === PACKAGE.persona) return 'persona';
  if (row.name === PACKAGE.instructions) return 'agent-instructions';
  if (row.name === PACKAGE.web) return 'tool-web';
  if (isSpawnRow(row)) return 'tool-subagent';
  const shell = SHELL_PACKAGE.exec(row.name)?.[1];
  if (shell) return `tool-${shell}`;
  if (childRows(row)?.some(child => isPresetRow(child) && isSpawnRow(child))) return 'delegation';
  return row.id;
}

/**
 * Build from the installed DSH standard preset, retaining its order. Components
 * are recognized by package, so compatible moves and renames keep following it.
 * Plan mode cannot safely transition inside an SDK query; DSH transcript forks
 * are not SDK forks. Fresh children inherit the parent unless explicitly selected.
 */
export function createRemoteClaudePreset(standard, subagentFields) {
  if (standard === null || typeof standard !== 'object' || Array.isArray(standard)
    || !Array.isArray(standard.plugins)) {
    throw new TypeError('需要 DSH 标准预设的完整插件列表。');
  }

  const rows = [...walkRows(standard.plugins)];
  const personas = rows.filter(row => row.name === PACKAGE.persona);
  if (personas.length !== 1 || typeof personas[0].config?.prefix !== 'string') {
    throw new TypeError('DSH 标准预设的身份配置不受支持。');
  }
  const spawn = rows.find(isSpawnRow);
  subagentFields ??= Object.hasOwn(spawn?.config ?? {}, 'modelSelection')
    ? { modelSelection: true, modelDiscovery: true } : { modelSelectionSettings: true };

  const adapt = (row) => {
    if (row.id === 'compaction' || COMPACTION_PACKAGE.test(row.name)) return undefined;
    const children = childRows(row);
    const id = stableId(row);
    // Keep Loader-owned expression values intact; JSON cloning loses !!js.
    const entry = id === undefined ? { ...row } : { ...row, id };
    if (row.id === 'planning' || row.name === PACKAGE.planMode
      || (children?.length && children.every(child => child.name === PACKAGE.planMode))
      || row.name === PACKAGE.timeContext) return { ...entry, disabled: true };
    if (row.name === PACKAGE.persona) return { ...entry, config: { ...row.config, prefix: REMOTE_PERSONA_PREFIX } };
    if (isSpawnRow(row)) return { ...entry, config: remoteSubagentConfig(row.config, subagentFields) };
    // Forks and unknown providers have no verified remote execution path.
    if (row.name === PACKAGE.subagent) return { ...entry, disabled: true };
    if (!children) return entry;
    const adapted = children.map(adapt).filter(Boolean);
    return children.length > 0 && adapted.length === 0 ? undefined : { ...entry, config: adapted };
  };
  const plugins = standard.plugins.map(adapt).filter(Boolean);
  plugins.push(...remoteCommands());

  // A collision would make a stable id address the wrong component downstream.
  const ids = [...walkRows(plugins)].map(row => row.id).filter(id => id !== undefined);
  if (new Set(ids).size !== ids.length) throw new TypeError('DSH 标准预设的组件 id 不唯一。');

  return {
    id: CLAUDE_PRESET,
    name: '远程会话',
    description: '请通过“新建远程会话”创建会话。',
    order: 5,
    plugins,
  };
}
