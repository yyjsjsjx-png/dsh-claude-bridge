import { createHash } from 'node:crypto'

/** Fixed wording from verified journal state; never interpolate raw errors,
 * command arguments, credentials, or an inferred repair/permission decision. */
export function recoveryNotice(runs = {}) {
  const recovered = Object.entries(runs).filter(([, run]) => run.reconciledAt)
  if (!recovered.length) return null
  const facts = recovered.map(([id, run]) => ({ id, status: run.status,
    tools: Object.entries(run.tools).map(([callId, tool]) => ({ callId, name: tool.name, status: tool.status })) }))
  const unknown = facts.flatMap(run => run.tools.filter(tool => ['dispatched', 'unknown'].includes(tool.status)))
  const key = createHash('sha256').update(JSON.stringify(facts)).digest('hex')
  const detail = unknown.slice(0, 8).map(tool => `${tool.name}（${tool.callId}）`).join('、')
  const text = ['[桥接插件运行说明：已核实状态]',
    '已读取当前原生 Claude 会话的可用云端记录，并核对先前中断的运行；这不代表原执行已自动续跑。',
    unknown.length ? `${unknown.length} 项工具已派发但仍缺少可信结果，可能已经生效：${detail}${unknown.length > 8 ? `；其余 ${unknown.length - 8} 项同样待核实` : ''}。`
      : '已能查证的工具结果已保留，未重新执行原工具。',
    unknown.length ? '先用现有权限内的只读检查核实实际状态；不能确认未生效时，不自动重复原操作，也不因超时就当作失败。必要时向用户说明仍缺少的证据。'
      : '根据当前用户消息继续后续工作。',
    '本说明只补充环境事实和处理建议；用户停止、审批和既有权限约束继续有效。',
  ].join('\n')
  return { key, text }
}
