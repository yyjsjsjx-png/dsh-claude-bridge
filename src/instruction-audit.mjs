import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const prepared = new WeakMap()
const digest = (value, algorithm = 'sha1') => createHash(algorithm).update(value).digest('hex')
const remote = agent => agent?.session?.header?.agentPreset === 'claude-sdk-remote'
const missing = error => ['ENOENT', 'ENOTDIR', 'FS_NOT_FOUND'].includes(error?.code)

function targetAliases() {
  const objects = new WeakMap(), values = new Map()
  const table = target => target !== null && ['object', 'function'].includes(typeof target) ? objects : values
  return { get: target => table(target).get(target), set: (target, paths) => table(target).set(target, paths) }
}

function failure(code, detail) {
  return Object.assign(new Error(`[${code}] ${detail}；已停止远程推理，请修复后重新加载远程预设以复核指令。`), { code })
}

/** The final bridge boundary rechecks the actual messages, after other hooks.
 * Native-only tests/agents without the remote composition have no registration. */
export function assertPreparedInstructionAudit(agent, messages) {
  prepared.get(agent)?.(messages)
}

/** Observes only calls made by the installed native instruction loader. It
 * never discovers paths, reads files itself, or retains instruction bodies. */
export function createInstructionAudit({ dshHome, agentsHome, maxSourceBytes = 1048576,
  candidates = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'] }) {
  const states = new WeakMap(), names = new Set(['AGENTS.md', ...candidates])
  const homes = [resolve(dshHome), resolve(agentsHome)]
  let disposed = false

  function stateFor(agent) {
    if (!remote(agent)) return undefined
    let state = states.get(agent.session)
    if (!state) {
      state = { sources: new Map(), failures: new Map(), targets: targetAliases(), pending: new Set(), required: new Set(),
        probed: new Set(), accepted: new Set(), cwd: agent.session.header.cwd, currentCwd: agent.session.header.cwd }
      states.set(agent.session, state)
    }
    prepared.set(agent, messages => {
      // Locally appended history is not evidence that this newly prepared
      // message reached the SDK. It must remain in this actual request batch.
      const actual = new Set(messages.filter(isInstructions).map(messageDigest))
      if ([...state.accepted].some(hash => !actual.has(hash))) {
        throw failure('INSTRUCTION_CONTEXT_INCOMPLETE', '原生已准备的指令消息在请求边界丢失或被修改')
      }
      return verify(agent, state, messages)
    })
    return state
  }

  function issue(state, path, code) {
    state.failures.set(path, code)
    state.pending.add(path)
  }

  function absent(state, path) {
    state.failures.delete(path)
    if (names.has(basename(path))) {
      state.sources.set(path, { status: 'absent' })
      state.pending.add(path)
    }
  }

  function statObserved(state, path, info) {
    state.probed.add(path)
    if (info?.type !== 'file' || !names.has(basename(path))) {
      absent(state, path)
      return
    }
    const previous = state.sources.get(path)
    const sameVersion = previous?.status === 'present' && isDeepStrictEqual(previous.version, info.version)
      && previous.size === info.size
    state.sources.set(path, { ...(sameVersion ? previous : {}), status: 'present', version: info.version, size: info.size })
    state.pending.add(path)
    if (info.size > maxSourceBytes) issue(state, path, 'INSTRUCTION_SOURCE_TOO_LARGE')
    // A successful stat cannot clear a previous failed/over-limit stream.
    else if (state.failures.get(path) === 'INSTRUCTION_SOURCE_UNAVAILABLE') state.failures.delete(path)
  }

  function wrapFileSystem(fileSystem, current) {
    return new Proxy(fileSystem, { get(target, key) {
      if (!['resolve', 'stat', 'streamText'].includes(key)) {
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      return async (...args) => {
        const state = current()
        if (!state) return target[key](...args)
        const signal = key === 'resolve' ? args[1]?.signal : args[1]
        let paths = key === 'resolve' ? [resolve(args[0])] : [...(state.targets.get(args[0]) ?? [])]
        try {
          const result = await target[key](...args)
          if (key === 'resolve') {
            for (const path of paths) state.probed.add(path)
            const aliases = state.targets.get(result) ?? new Set()
            for (const path of paths) aliases.add(path)
            state.targets.set(result, aliases)
          } else if (key === 'stat') for (const path of paths) statObserved(state, path, result)
          else {
            return (async function* () {
              const hash = createHash('sha1'), trimParts = []
              let bytes = 0, complete = false
              try {
                for await (const chunk of result) {
                  const text = String(chunk)
                  bytes += Buffer.byteLength(text, 'utf8')
                  if (bytes > maxSourceBytes) {
                    for (const path of paths) issue(state, path, 'INSTRUCTION_SOURCE_TOO_LARGE')
                  } else { hash.update(text); trimParts.push(text) }
                  yield chunk
                }
                complete = true
              } catch (error) {
                if (!signal?.aborted) for (const path of paths) issue(state, path, 'INSTRUCTION_SOURCE_READ_FAILED')
                throw error
              } finally {
                if (complete && bytes <= maxSourceBytes) {
                  const contentDigest = hash.digest('hex'), trimmedDigest = digest(trimParts.join('').trim())
                  for (const path of paths) {
                    const source = state.sources.get(path)
                    if (source?.status !== 'present') continue
                    Object.assign(source, { digest: contentDigest, trimmedDigest, bytes })
                    state.failures.delete(path)
                  }
                }
              }
            })()
          }
          return result
        } catch (error) {
          if (!signal?.aborted) for (const path of paths) {
            if (missing(error)) absent(state, path)
            else issue(state, path, key === 'streamText' ? 'INSTRUCTION_SOURCE_READ_FAILED' : 'INSTRUCTION_SOURCE_UNAVAILABLE')
          }
          throw error
        }
      }
    } })
  }

  function visibleMessages(agent, messages) {
    const history = []
    for (const seq of agent.session.surface?.nodes ?? []) {
      const event = agent.session.eventAt(seq)
      if (event?.type === 'user/message') history.push(event.data)
    }
    return [...history, ...messages]
  }

  function isInstructions(message) {
    return message?.source?.kind === 'agent-instructions' && message.source.form === 'instructions'
  }

  function messageDigest(message) { return digest(JSON.stringify([message.source, message.content]), 'sha256') }

  function scopeOfPath(path, root) {
    if (path === join(homes[0], 'AGENTS.md')) return { scope: 'user-global\0AGENTS.md', group: 'user-global' }
    if (path === join(homes[1], 'AGENTS.md')) return { scope: 'agents-global\0AGENTS.md', group: 'user-global' }
    let display = relative(root, path)
    if (isAbsolute(display) || display === '..' || display.startsWith(`..${sep}`)) return undefined
    if (['user-global', 'agents-global'].includes(display.split(/[\\/]/)[0])) display = `.${sep}${display}`
    const directory = dirname(display)
    return { scope: `${directory}\0${basename(display)}`, group: directory }
  }

  function verify(agent, state, messages) {
    if (disposed) throw failure('INSTRUCTION_AUDIT_UNAVAILABLE', '指令审计组件已卸载')
    const effective = new Map()
    let identity = state.identity
    for (const message of visibleMessages(agent, messages)) {
      const source = message?.source
      if (source?.kind !== 'agent-instructions' || source.form !== 'instructions') continue
      if (source.baseline === true && typeof source.baselineIdentity === 'string') identity = source.baselineIdentity
      for (const change of source.changes ?? []) effective.set(change.scope, change)
    }
    let root
    let validIdentity = false
    try {
      const baseline = JSON.parse(identity)
      if (typeof baseline.projectRoot !== 'string') throw new Error('baseline')
      root = resolve(state.currentCwd, baseline.projectRoot)
      validIdentity = true
    } catch {
      root = resolve(state.currentCwd)
    }
    if (!validIdentity && identity !== undefined && state.sources.size) {
      throw failure('INSTRUCTION_AUDIT_UNAVAILABLE', '无法解析原生指令基线身份')
    }
    if (state.cwd !== state.currentCwd) {
      // A new native baseline does not inherit failures from an old root that
      // the native loader no longer probes. Global roots remain applicable.
      for (const path of state.pending) {
        const logical = scopeOfPath(path, root), change = logical && effective.get(logical.scope)
        if (state.probed.has(path) || logical?.group === 'user-global' || (change && change.action !== 'remove')) continue
        state.sources.delete(path); state.failures.delete(path); state.pending.delete(path)
      }
    }
    if (state.failures.size) throw failure(state.failures.values().next().value, '原生指令来源读取或探测未能完整确认')
    if (identity === undefined && [...state.sources.values()].some(source => source.status === 'present')) {
      throw failure('INSTRUCTION_AUDIT_UNAVAILABLE', '原生指令来源缺少可核对的基线身份')
    }
    const sources = []
    for (const [path, source] of state.sources) {
      const logical = scopeOfPath(path, root)
      if (!logical) continue
      const change = effective.get(logical.scope)
      if (!state.pending.has(path) && !state.required.has(path) && (!change || change.action === 'remove')) continue
      if (source.status === 'absent') {
        if (change && change.action !== 'remove') throw failure('INSTRUCTION_CONTEXT_INCOMPLETE', '已移除的指令来源仍被声明为有效')
        continue
      }
      sources.push({ path, source, ...logical, change })
    }
    const represented = sources.filter(item => item.source.digest && item.change?.action !== 'remove'
      && item.change?.digest === item.source.digest)
    const report = []
    for (const item of sources) {
      const direct = represented.includes(item)
      if (!direct && !represented.some(other => other.group === item.group
        && other.source.trimmedDigest === item.source.trimmedDigest && item.source.trimmedDigest !== undefined)) {
        throw failure('INSTRUCTION_CONTEXT_INCOMPLETE', '原生发现的指令来源未与实际上下文或同组去重结果对应')
      }
      const version = item.source.version
      report.push({ scope: item.scope, digest: item.source.digest, bytes: item.source.bytes,
        providerVersion: version === undefined ? { status: 'unknown' }
          : { status: 'known', digest: digest(JSON.stringify(version), 'sha256') },
        disposition: direct ? 'represented' : 'deduplicated' })
    }
    state.identity = identity
    state.cwd = state.currentCwd
    state.required = new Set(sources.map(item => item.path))
    state.pending.clear()
    return { version: 1, phase: 'prepared', sources: report }
  }

  return { stateFor, wrapFileSystem, verify,
    setCwd(state, cwd) {
      if (!state) return
      if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw failure('INSTRUCTION_AUDIT_UNAVAILABLE', '原生工作目录无法核对')
      state.currentCwd = cwd
    },
    accept(agent, state, messages) {
      const report = verify(agent, state, messages)
      state.accepted = new Set(messages.filter(isInstructions).map(messageDigest))
      return report
    },
    begin: state => { state.required.clear(); state.probed.clear(); state.accepted.clear() },
    blocked(agent, state, code) {
      const root = resolve(state.currentCwd)
      return { version: 1, phase: 'blocked', code, failures: [...state.failures].map(([path, code]) => ({
        scope: scopeOfPath(path, root)?.scope ?? `probe:${basename(path)}`, code,
      })) }
    },
    dispose: () => { disposed = true } }
}
