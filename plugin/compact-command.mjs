/** Scoped DSH command: maintain the native SDK session, never the DSH surface. */
export const name = 'claude-sdk-compact-command'
export const inject = ['commands', 'claudeBridge']

export function apply(ctx) {
  const active = new Set()
  ctx.effect(function* () {
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      definitionId: 'dsh-claude-bridge/compact', name: 'compact', description: '压缩远端 Claude 原生上下文',
      handler(invocation) {
        if (invocation.rawInput.trim()) return { kind: 'error', text: '用法：/compact（不带参数）' }
        const operation = ctx.claudeBridge.compact(invocation.agent, invocation.signal)
        active.add(operation)
        const retire = () => { active.delete(operation) }
        void operation.then(retire, retire)
        return operation
      },
    })
  }, '远端压缩命令')
}
