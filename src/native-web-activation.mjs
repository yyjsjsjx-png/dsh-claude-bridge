import { DSH_WEB_TOOLS } from './native-web.mjs'

// Only the remote wrapper of the official web plugin contributes entries.
const localConditions = new WeakMap()

/** Replace provider readiness only after the SDK's native web route is confirmed. */
export function remoteWebRegistration(definition, options, nativeReady) {
  if (!DSH_WEB_TOOLS.includes(definition.name) || typeof options?.when !== 'function') return options
  localConditions.set(definition, options.when)
  return { ...options, when: async context => await nativeReady(context) || options.when(context) }
}

/** Do not expose a native-only admission as a local tool after a route/capability change. */
export async function unavailableLocalWebTools({ tools, agent, toolSet, modelSelection, signal, nativeWebTools }) {
  const unavailable = new Set()
  if (nativeWebTools || !agent || typeof tools?.get !== 'function') return unavailable
  for (const name of DSH_WEB_TOOLS) {
    const condition = localConditions.get(tools.get(name, agent, toolSet))
    if (condition && !await condition({ agent, modelSelection, signal })) unavailable.add(name)
    signal?.throwIfAborted()
  }
  return unavailable
}
