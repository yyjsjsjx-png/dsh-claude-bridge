import { admittedRemoteAssembly, remoteCapabilityPrompt } from './remote-capabilities.mjs'

// rc.5 owns this header. Match only its leading notice, never quoted file text.
const INSTRUCTION_BUDGET_HEADER = /^(?:<system-reminder>\r?\n)?(?:Workspace instruction budget \d+(?:\.\d+)? bytes: (?:omitted|truncated)\b|Workspace instructions were omitted or truncated to fit the configured byte budget\.(?=\r?\n|$))/

/** Admit only the final callable collection; keep native declarations and prompt in sync. */
export function prepareRequestAssembly({ assembly, converted, admitShell, renderPrompt }) {
  admitShell(assembly, converted)
  const admitted = admittedRemoteAssembly(assembly, converted)
  return {
    assembly: admitted,
    toolSignature: JSON.stringify(converted.tools),
    // The initial request renders after media preparation; continuation renders
    // before changing context projections. Leave that lifecycle to the caller.
    renderSystemPrompt: () => remoteCapabilityPrompt(renderPrompt(admitted), converted),
  }
}

/** Refresh runtime facts once while retaining the accepted user/instruction messages. */
export function prepareRequestMessages({ assembly, messages, context, refreshContext,
  renderContextSections, joinContextSections, projectContext, continuation = false }) {
  const refreshed = refreshContext(assembly, context)
  const sections = renderContextSections(refreshed)
  const runtime = projectContext(joinContextSections(sections), sections)
  const admitted = []
  let contextAdmitted = false
  for (const message of messages) {
    if (message.source.kind !== 'runtime-context') admitted.push(message)
    else if (!continuation && runtime && !contextAdmitted) {
      admitted.push(runtime)
      contextAdmitted = true
    }
  }
  if (runtime && !contextAdmitted) admitted.push(runtime)
  assertInstructionBudget(admitted, continuation)
  return admitted
}

export function assertInstructionBudget(messages, continuation = false) {
  if (messages.some(message => message.source.kind === 'agent-instructions' && message.source.form === 'instructions'
    && message.content.some(block => block.type === 'text'
      && INSTRUCTION_BUDGET_HEADER.test(block.text)))) {
    const message = continuation
      ? 'DSH 报告项目指令被省略或截断；已停止后续推理。'
      : 'DSH 报告项目指令被省略或截断；已停止本轮推理，请先确认指令完整性。'
    throw Object.assign(new Error(`[INSTRUCTION_BUDGET_EXCEEDED] ${message}`), { code: 'INSTRUCTION_BUDGET_EXCEEDED' })
  }
}
