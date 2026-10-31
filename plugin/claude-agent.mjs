import { CLAUDE_PRESET, CLAUDE_PROVIDER } from './policy.mjs'

/**
 * rc.5 compatibility entry: keep the upstream factory, scope, inbox, queue,
 * lifecycle and turn framing; delegate only the external-engine step.
 * The compatibility bundle selects this constructor at its original site.
 */
export function createClaudeLoopAgent(Base, loopCtx, id, options, session) {
  if (session.header.agentPreset !== CLAUDE_PRESET) return new Base(loopCtx, id, options, session)
  // In-process subagents are created outside the SessionController. Guard the
  // inherited preset before publication, including workflow route overrides.
  // A root session selects its initial model immediately after creation, so
  // its provisional Agent options are intentionally not checked here.
  if (session.header.origin === 'subagent'
    && (options?.provider !== CLAUDE_PROVIDER || typeof options.model !== 'string' || !options.model)) {
    const error = new Error('远程会话子代理必须继承或选择远程模型。')
    error.code = 'SUBAGENT_ENGINE_MISMATCH'
    throw error
  }
  class ClaudeLoopAgent extends Base {
    async step(decision) {
      this._bridgeStepOpen = true
      const bridge = this.ctx.get('claudeBridge') ?? loopCtx.get('claudeBridge')
      if (!bridge || typeof bridge.runStep !== 'function') {
        const error = new Error('远程会话桥接服务尚未就绪；未启动模型请求。')
        error.code = 'BRIDGE_NOT_READY'
        throw error
      }
      return bridge.runStep(this, decision)
    }
  }
  return new ClaudeLoopAgent(loopCtx, id, options, session)
}
