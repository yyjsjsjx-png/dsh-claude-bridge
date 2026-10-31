/** User-invoked acknowledgement; never a model tool or an automatic replay. */
export const name = 'claude-sdk-recovery-command'
export const inject = ['commands', 'claudeBridge']

export function apply(ctx) {
  ctx.effect(() => ctx.commands.register({
    definitionId: 'dsh-claude-bridge/recovery', name: 'bridge-recovery', description: '查看并核实中断轮次',
    handler(invocation) {
      const argument = invocation.rawInput.trim()
      if (argument && argument !== 'confirm') return { kind: 'error', text: '用法：/bridge-recovery；核实后 /bridge-recovery confirm' }
      return ctx.claudeBridge.recover(invocation.agent, argument === 'confirm', invocation.signal)
    },
  }), '中断状态核实命令')
}
