import { Service, RemoteError } from './compat/runtime.mjs';
import { installControllerGuards } from './controller-guards.mjs';

/** Preserve the installed SessionController and its client module identity. */
export default class ClaudeSessionPolicy extends Service {
  static inject = ['sessionController', 'agentPresets', 'agentDefaultModel', 'claudeBridge',
    'llm', 'sessions', 'sessionProjections', 'sessionQuery', 'workspaceRegistry'];

  constructor(ctx) {
    super(ctx, 'claudeSessionPolicy');
    ctx.effect(() => installControllerGuards(ctx, RemoteError), '远程 Claude 会话策略');
  }
}
