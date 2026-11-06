import { CLAUDE_PRESET } from './policy.mjs';

const CONTEXT_NAME = 'claude-bridge:client-environment';

function literal(value) {
  if (typeof value !== 'string' || !value) return '未确认';
  // Paths are data, including text that resembles prompt variables or context delimiters.
  return JSON.stringify(value).replace(/[<>]/g, character => character === '<' ? '\\u003c' : '\\u003e');
}

/** Describe the client tool environment without claiming the SDK's process directory. */
export function remoteEnvironmentText({ platform, shell, projectRoot, cwd }) {
  return [
    '[远程会话客户端环境]',
    `客户端工具平台：${literal(platform)}；本机命令工具：${literal(shell)}。`,
    `初始项目目录（会话创建时）：${literal(projectRoot)}。`,
    `当前 DSH 工具工作目录：${literal(cwd)}。`,
    '初始项目目录不代表当前工作目录；文件与命令操作应遵循 DSH 当前工作目录及各工具的显式工作目录参数。未确认的目录不得从其他环境推测。',
    'Claude SDK/CLI 附带的 Environment、平台或 cwd 描述远端 SDK 进程与会话存储环境，不是客户端项目或本机工具环境。请通过提供的 DSH 工具操作客户端项目。',
  ].join('\n');
}

/** Add required runtime context in the remote composition's native disposable scope. */
export function installRemoteEnvironmentContext(ctx, { scope, shell, platform = process.platform }) {
  const order = ctx.systemPrompt?.getContextOrder?.('WORKING_DIRECTORY');
  if (scope == null || typeof ctx.systemPrompt?.context !== 'function'
    || typeof ctx.workingDirectory?.get !== 'function' || !Number.isFinite(order)) {
    throw Object.assign(new Error('远程会话的客户端环境上下文接口不可用。'), { code: 'REMOTE_ENVIRONMENT_UNAVAILABLE' });
  }
  return ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: order + 1,
    required: true,
    interpolate: false,
    text: context => {
      const session = context.agent?.session;
      if (session?.header?.agentPreset !== CLAUDE_PRESET) return '';
      return remoteEnvironmentText({ platform, shell, projectRoot: session.header.cwd,
        cwd: ctx.workingDirectory.get(session) });
    },
  });
}
