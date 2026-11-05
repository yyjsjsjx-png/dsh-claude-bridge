/** Detect the executor-owned batch contract without depending on a desktop version. */
export function usesToolBatches(tools) {
  return typeof tools?.resolve === 'function' && typeof tools?.setExecutor === 'function'
}

/** Dispatch one bridge call through the selected native executor, retaining bridge-owned logging. */
export async function executeDshTool(tools, input, toolSet) {
  if (!usesToolBatches(tools)) return tools.execute(input)
  const batch = await tools.execute({ calls: [{ type: 'tool-call', id: input.callId,
    name: input.name, arguments: JSON.stringify(input.arguments) }], signal: input.signal,
  agent: input.agent, ...(toolSet ? { toolSet } : {}) })
  if (batch?.results?.length !== 1 || batch.results[0].callId !== input.callId || !batch.results[0].result) {
    const error = new Error('DSH 工具执行器没有返回当前调用的唯一结果。')
    error.code = 'DSH_TOOL_RESULT_INVALID'
    throw error
  }
  const result = batch.results[0].result
  return { ...result, additionalContexts: [...(result.additionalContexts ?? []), ...(batch.additionalContexts ?? [])],
    concludesTurn: batch.concluded === true || result.concludesTurn === true }
}

/** One query owns sequential step admissions; each is closed once after its tools settle. */
export function createStepToolAdmission(initial) {
  const released = new WeakSet()
  let current = initial
  function release(value = current) {
    if (!value || released.has(value)) return
    released.add(value)
    value.dispose()
    if (value === current) current = undefined
  }
  return { get current() { return current }, release,
    replace(value) { release(); current = value },
    close() { release() } }
}

/** Prefer the driver's model snapshot; rc.5 falls back to its recorded selection. */
export function currentDshSelection(ctx, agent) {
  if (typeof agent?.model?.current === 'function') return agent.model.current()
  const state = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
  return state?.pending ?? agent.session.requestHeader?.()?.config ?? agent.options
}
