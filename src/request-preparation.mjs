import { admittedRemoteAssembly, remoteCapabilityPrompt } from './remote-capabilities.mjs'

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
  if (admitted.some(message => (!continuation || message.source.kind === 'agent-instructions')
    && message.content.some(block => block.type === 'text'
      && block.text.includes('Workspace instructions were omitted or truncated to fit the configured byte budget.')))) {
    const message = continuation
      ? 'DSH 报告项目指令被省略或截断；已停止后续推理。'
      : 'DSH 报告项目指令被省略或截断；请调整专属预设的指令预算后继续。'
    throw Object.assign(new Error(`[INSTRUCTION_BUDGET_EXCEEDED] ${message}`), { code: 'INSTRUCTION_BUDGET_EXCEEDED' })
  }
  return admitted
}
