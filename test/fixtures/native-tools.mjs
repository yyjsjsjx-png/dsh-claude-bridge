import assert from 'node:assert/strict'

/** Execute one synthetic call through the installed tool API, preserving its outcome. */
export async function executeNativeTool(ctx, input) {
  if (typeof ctx.tools.setExecutor !== 'function') return ctx.tools.execute(input)
  const { name, callId, arguments: args, agent, signal } = input
  const toolSet = await ctx.tools.resolve({ agent, signal,
    modelSelection: agent?.model?.current?.() ?? { provider: 'fixture', model: 'no-model' } })
  try {
    const batch = await ctx.tools.execute({ calls: [{ type: 'tool-call', id: callId, name,
      arguments: JSON.stringify(args) }], agent, signal, toolSet })
    assert.equal(batch.results.length, 1)
    assert.equal(batch.results[0].callId, callId)
    return batch.results[0].result
  } finally { toolSet.dispose() }
}
