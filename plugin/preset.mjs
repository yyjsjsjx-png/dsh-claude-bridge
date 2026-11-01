import { CLAUDE_PRESET } from './policy.mjs';
import { createLegacyV024RemoteClaudePreset } from './presets/legacy-v024.mjs';

/** Explicit limits that are independent of a particular request's tool list. */
export const REMOTE_PRESET_LIMITATIONS = Object.freeze([
  Object.freeze({ name: '计划模式', status: 'disabled', reason: '暂不提供计划模式。' }),
  Object.freeze({ name: 'subagent_fork', status: 'disabled', reason: '不支持分叉子任务。' }),
  Object.freeze({ name: '子任务独立选型', status: 'disabled', reason: '子任务默认沿用父会话模型。' }),
  Object.freeze({ name: 'DSH 原生压缩', status: 'disabled', reason: '远程 Agent SDK 负责自身会话的上下文和压缩。' }),
  Object.freeze({ name: '会话分叉', status: 'disabled', reason: '请通过新建会话开始其他任务。' }),
  Object.freeze({ name: '自动时间与时区上下文', status: 'disabled', reason: '远程预设不自动发送当前时间、浏览器时区或距上条消息的时间。' }),
]);
export const REMOTE_PRESET_CONVERSIONS = Object.freeze([
  Object.freeze({ name: '/compact', status: 'converted', reason: '由远程 Agent SDK 压缩上下文，保留对话历史。' }),
  Object.freeze({ name: '身份提示', status: 'converted', reason: '云端会话使用固定的 Claude 身份提示。' }),
  Object.freeze({ name: 'Workflow 深度限制', status: 'converted', reason: '沿用 DSH 子任务深度上限。' }),
]);
const REMOTE_PERSONA_PREFIX = 'You are a coding agent powered by Claude through the remote Claude Agent SDK.';

function remoteCommands() {
  return [
    { id: 'claude-sdk-compact', name: new URL('./compact-command.mjs', import.meta.url).href },
    { id: 'claude-sdk-recovery', name: new URL('./recovery-command.mjs', import.meta.url).href },
  ];
}

/** Owned complete fallback when the installed standard cannot be adapted. */
export function createOwnedRemoteClaudePreset() {
  return createLegacyV024RemoteClaudePreset({ personaPrefix: REMOTE_PERSONA_PREFIX, commands: remoteCommands() });
}

/** UI descriptions must follow the effective preset, including basic fallback. */
export function remotePresetFeatures(report) {
  const disabled = new Set(report.disabledComponents.map(item => item.name));
  const unavailable = new Map();
  if (report.mode === 'basic' || disabled.has('tool-workflow') || disabled.has('workflow-ptc')) {
    unavailable.set('Workflow 深度限制', '当前远程预设未开启 Workflow。');
  }
  if (disabled.has('claude-sdk-compact')) unavailable.set('/compact', '压缩命令组件未就绪。');
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

/**
 * Build from the verified shipped DSH standard preset, retaining its order.
 * Plan mode cannot safely transition inside an SDK query; DSH transcript forks
 * are not SDK forks. Keep fresh child delegation but inherit the parent model.
 */
export function createRemoteClaudePreset(standard) {
  if (standard === null || typeof standard !== 'object' || Array.isArray(standard)
    || !Array.isArray(standard.plugins)) {
    throw new TypeError('需要 DSH 标准预设的完整插件列表。');
  }

  const one = (rows, id) => {
    const matches = rows.filter(row => row?.id === id);
    if (matches.length !== 1) throw new TypeError(`DSH 标准预设的 ${id} 条目不唯一或不存在。`);
    return matches[0];
  };
  const persona = one(standard.plugins, 'persona');
  const planning = one(standard.plugins, 'planning');
  const compaction = one(standard.plugins, 'compaction');
  const delegation = one(standard.plugins, 'delegation');
  if (persona.name !== '@deepseek-ai/dsh-persona' || typeof persona.config?.prefix !== 'string'
    || planning.name !== 'cordis:group' || planning.group !== true
    || compaction.name !== 'cordis:group' || compaction.group !== true
    || delegation.name !== 'cordis:group' || delegation.group !== true
    || !Array.isArray(delegation.config)) {
    throw new TypeError('DSH 标准预设的身份、规划、压缩或委托配置不受支持。');
  }
  const spawn = one(delegation.config, 'tool-subagent');
  const fork = one(delegation.config, 'tool-subagent-fork');
  if (spawn.name !== '@deepseek-ai/dsh-tool-subagent' || spawn.config?.provider !== 'spawn'
    || fork.name !== '@deepseek-ai/dsh-tool-subagent' || fork.config?.provider !== 'fork'
    || fork.config?.toolName !== 'subagent_fork') {
    throw new TypeError('DSH 标准预设的子代理配置不受支持。');
  }

  const plugins = standard.plugins
    .filter(entry => entry?.id !== 'compaction')
    .map((entry) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.name !== 'string' || entry.name.length === 0) {
        throw new TypeError('DSH 标准预设包含无效的插件条目。');
      }
      // Keep Loader-owned expression values intact; JSON cloning loses !!js.
      if (entry.id === 'persona') return { ...entry, config: { ...entry.config, prefix: REMOTE_PERSONA_PREFIX } };
      if (entry.id === 'planning') return { ...entry, disabled: true };
      if (entry.name === '@deepseek-ai/dsh-time-context') return { ...entry, disabled: true };
      if (entry.id !== 'delegation') return { ...entry };
      return {
        ...entry,
        config: entry.config.map((child) => {
          if (child.id === 'tool-subagent-fork') return { ...child, disabled: true };
          if (child.id === 'tool-subagent') {
            return { ...child, config: { ...child.config, modelSelectionSettings: false } };
          }
          return { ...child };
        }),
      };
    });
  plugins.push(...remoteCommands());

  return {
    id: CLAUDE_PRESET,
    name: '远程会话',
    description: '请通过“新建远程会话”创建会话。',
    order: 5,
    plugins,
  };
}
