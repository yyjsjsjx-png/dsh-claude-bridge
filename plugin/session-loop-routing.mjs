import { CLAUDE_PRESET } from './policy.mjs'

/** One native factory owns both routes; choose the driver before construction. */
export function makeSessionRoutedAgentLoop(NativeAgentLoop, CompatAgentLoop) {
  return class SessionRoutedAgentLoop extends NativeAgentLoop {
    initializeAgent(ownerCtx, ...args) {
      // The current factory publishes a prepared Session only after setup;
      // delegate its whole lifecycle instead of imitating registry publication.
      const options = args[0]
      if (typeof NativeAgentLoop.prototype.prepare !== 'function' && options?.session?.header?.agentPreset === CLAUDE_PRESET) {
        return CompatAgentLoop.prototype.initializeAgent.call(this, ownerCtx, ...args)
      }
      return super.initializeAgent(ownerCtx, ...args)
    }
    prepare(ownerCtx, id, options, session, callerSignal, handle, parentAgent) {
      if (session.header.agentPreset !== CLAUDE_PRESET) {
        return super.prepare(ownerCtx, id, options, session, callerSignal, handle, parentAgent)
      }
      if (!this.runtime?.ctx || typeof this.ownership?.isActive !== 'function'
        || !this.ownership.signal || typeof this.ownership.track !== 'function') {
        const error = new Error('远程会话插件无法加载：原生执行循环所有权接口不兼容。')
        error.code = 'DSH_API_INCOMPATIBLE'
        throw error
      }
      return CompatAgentLoop.prototype.prepare.call(this,
        ownerCtx, id, options, session, callerSignal, handle, parentAgent)
    }
  }
}
