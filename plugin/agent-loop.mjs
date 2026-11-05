import './compat/check-host.mjs'
import { resolveDshModule } from './compat/resolve-dsh-module.mjs'
import { DshCompatibilityError } from './compat/host-contract.mjs'
import { makeSessionRoutedAgentLoop } from './session-loop-routing.mjs'

const { AgentLoop: NativeAgentLoop } = await import(resolveDshModule('@deepseek-ai/dsh-agent-loop'))
const { AgentLoop: CompatAgentLoop } = await import(typeof NativeAgentLoop.prototype.prepare === 'function'
  ? './compat/agent-loop.mjs' : './compat/desktop-022/agent-loop.mjs')
const { Entry, interpolate } = await import(resolveDshModule('@deepseek-ai/cordis-plugin-loader'))
export const RoutedAgentLoop = makeSessionRoutedAgentLoop(NativeAgentLoop, CompatAgentLoop)

/** rc.5 overlay names are match guards, not rename operations. Keep the original
 * disabled row as the configuration source and create one native factory under
 * this bootstrap's ownership. Removing it drains both kinds of owned agents. */
export function apply(ctx, { sourceEntry = 'agent-loop' } = {}) {
  const tree = ctx.fiber.entry?.parent?.tree
  let source
  try { source = tree?.resolve(sourceEntry) } catch {}
  if (!source || source.options.name !== '@deepseek-ai/dsh-agent-loop' || source.options.disabled !== true) {
    throw new DshCompatibilityError(undefined, '原生 agent-loop 配置来源缺失或未停用')
  }
  // A disabled Entry was never initialized, so source.ctx can still inherit
  // the loader root rather than its actual group. Restore the original scope
  // and entry symbol for expression evaluation without mutating that Entry.
  const configContext = source.parent.ctx.extend({ [Entry.key]: source })
  const config = interpolate(configContext, source.options.config ?? {})
  ctx.plugin(RoutedAgentLoop, config)
}
apply.inject = ['loader', ...NativeAgentLoop.inject]
export default apply
