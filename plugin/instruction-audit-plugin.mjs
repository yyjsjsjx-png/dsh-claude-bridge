/** Remote-only view of the installed native instruction loader. Discovery,
 * deduplication, rendering and native inbox ownership remain in that loader. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolveDshModule } from './compat/resolve-dsh-module.mjs'
import { createInstructionAudit } from '../src/instruction-audit.mjs'
import { assertInstructionBudget } from '../src/request-preparation.mjs'

const sessionModule = resolveDshModule('@deepseek-ai/dsh-session')
const require = createRequire(sessionModule)
const native = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-agent-instructions')).href)
const { resolveDshHome, resolveAgentsHome } = await import(resolveDshModule('@deepseek-ai/dsh-home-paths'))
const { appendPluginRecord } = await import(sessionModule)

export const Config = native.Config
export const inject = native.inject

export function apply(ctx, config) {
  if (typeof native.apply !== 'function' || !Config || !Array.isArray(inject)
    || typeof ctx.workingDirectory?.ensure !== 'function' || !Number.isFinite(config.maxBytes) || config.maxBytes <= 0) {
    throw Object.assign(new Error('无法观察原生指令加载，已停止远程预设加载。'), { code: 'INSTRUCTION_AUDIT_UNAVAILABLE' })
  }
  const fileSystem = ctx.get('fs')
  if (!fileSystem || ['resolve', 'stat', 'streamText'].some(name => typeof fileSystem[name] !== 'function')) {
    throw Object.assign(new Error('原生指令文件接口不完整，已停止远程预设加载。'), { code: 'INSTRUCTION_AUDIT_UNAVAILABLE' })
  }
  const audit = createInstructionAudit({ dshHome: resolveDshHome(), agentsHome: resolveAgentsHome(),
    maxSourceBytes: config.maxSourceBytes,
    candidates: [...(config.instructionFileCandidates ?? ['AGENTS.md', 'CLAUDE.md']),
      ...(config.localInstructionFileCandidates ?? ['AGENTS.local.md', 'CLAUDE.local.md'])] })
  const storage = new AsyncLocalStorage()
  const observedFileSystem = audit.wrapFileSystem(fileSystem, () => storage.getStore())
  const workingDirectory = new Proxy(ctx.workingDirectory, { get(target, key) {
    if (key === 'ensure') return (...args) => {
      // compose(agent) is authoritative even when a parent execution flushes
      // nested touches for another Agent. run() around every native callback
      // contains enterWith(), and its store survives compose's following await.
      const state = audit.stateFor(args[0])
      storage.enterWith(state)
      return Promise.resolve(target.ensure(...args)).then(cwd => { audit.setCwd(state, cwd); return cwd })
    }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const publish = (agent, state, report) => {
    const serialized = JSON.stringify(report)
    if (serialized === state.lastReport) return
    appendPluginRecord(agent.session, 'plugin:claude-bridge/instruction-audit', report)
    state.lastReport = serialized
  }
  const nativeContext = new Proxy(ctx, { get(target, key) {
    if (key === 'get') return (name, ...rest) => name === 'fs' ? observedFileSystem : target.get(name, ...rest)
    if (key === 'workingDirectory') return workingDirectory
    if (key === 'on') return (event, handler, ...options) => {
      if (event !== 'agent/pre-step') {
        return target.on(event, (...args) => storage.run(undefined, () => handler(...args)), ...options)
      }
      return target.on(event, (input, next) => {
        const { agent, signal } = input
        const state = audit.stateFor(agent)
        if (!state) return storage.run(undefined, () => handler(input, next))
        audit.begin(state)
        return storage.run(state, async () => {
          try {
            const decision = await handler(input, next)
            signal.throwIfAborted()
            if (decision.kind !== 'reject' && decision.messages.length) {
              assertInstructionBudget(decision.messages, input.step > 1)
              publish(agent, state, audit.accept(agent, state, decision.messages))
            }
            return decision
          } catch (error) {
            signal.throwIfAborted()
            if (state.failures.size) {
              try { audit.verify(agent, state, input.messages) } catch (diagnostic) { error = diagnostic }
            }
            if (error.code?.startsWith('INSTRUCTION_')) publish(agent, state, audit.blocked(agent, state, error.code))
            throw error
          }
        })
      }, ...options)
    }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  native.apply(nativeContext, config)
  ctx.effect(() => () => { audit.dispose(); storage.disable() }, '远程指令诊断清理')
}
