/** Per-query tool facts. SDK hooks and RPC wiring never receive the collections. */
export function createToolCalls({ signal, eventTimeoutMs, createError }) {
  const pendingIds = new Map()
  const pendingKeys = new Map()
  const pendingEffects = new Map()
  const completedIds = new Set()
  const batchedIds = new Set()
  const forwardedIds = new Set()
  const eventWaiters = new Map()
  // Both a confirmed tool conclusion and step.prepare's explicit stop use this
  // one flag. The caller reports the latter through conclude(), without a copy.
  let concluded = false

  const canonicalJson = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
    if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    }
    throw createError('INVALID_TOOL_ARGUMENTS', '工具参数不是有效的 JSON 值')
  }
  const keyFor = (name, args) => `${name}\0${canonicalJson(args)}`
  const forget = id => {
    const key = pendingKeys.get(id)
    if (key !== undefined && pendingIds.get(key) === id) pendingIds.delete(key)
    pendingKeys.delete(id)
  }
  const hasUnconfirmedBatch = () => [...completedIds].some(id => !batchedIds.has(id))

  return Object.freeze({
    register(name, args, id) {
      const key = keyFor(name, args)
      if (pendingIds.has(key) || pendingKeys.has(id)) return false
      pendingIds.set(key, id)
      pendingKeys.set(id, key)
      return true
    },
    rebind(name, args, id) {
      const previous = typeof id === 'string' ? pendingKeys.get(id) : undefined
      const next = keyFor(name, args)
      if (previous === undefined || (next !== previous && pendingIds.has(next))) {
        if (typeof id === 'string') forget(id)
        return false
      }
      pendingIds.delete(previous)
      pendingIds.set(next, id)
      pendingKeys.set(id, next)
      return true
    },
    take(name, args) {
      const id = pendingIds.get(keyFor(name, args))
      if (id) forget(id)
      return id
    },
    forget,
    markForwarded(id) {
      forwardedIds.add(id)
      eventWaiters.get(id)?.resolve()
    },
    async waitForEvent(id) {
      if (forwardedIds.has(id)) return
      if (signal.aborted) throw createError('CANCELLED', '请求已取消')
      let timer, onAbort
      try {
        await new Promise((resolve, reject) => {
          eventWaiters.set(id, { resolve, reject })
          onAbort = () => reject(createError('CANCELLED', '请求已取消'))
          signal.addEventListener('abort', onAbort, { once: true })
          timer = setTimeout(() => reject(createError('TOOL_EVENT_ORDER_UNAVAILABLE',
            'SDK 未及时转发对应工具调用，未派发本机工具')), eventTimeoutMs)
          if (forwardedIds.has(id)) resolve()
          else if (signal.aborted) onAbort()
        })
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        eventWaiters.delete(id)
      }
    },
    recordResult(id, effects) {
      completedIds.add(id)
      if (effects.concludesTurn || effects.additionalContexts.length) pendingEffects.set(id, effects)
    },
    confirmEffects(id, hookEventName) {
      forget(id)
      const effects = pendingEffects.get(id)
      if (!effects) return undefined
      pendingEffects.delete(id)
      if (hookEventName !== 'PostToolUse' && hookEventName !== 'PostToolUseFailure') {
        throw createError('TOOL_EFFECT_UNCONFIRMED', '无法确认工具后处理类型', { toolMayHaveExecuted: true })
      }
      if (effects.concludesTurn) concluded = true
      return effects
    },
    assertBatch(ids) {
      if ([...completedIds].some(id => !batchedIds.has(id) && !ids.has(id))
        || [...ids].some(id => pendingEffects.has(id))) {
        throw createError('STEP_BOUNDARY_UNCONFIRMED', 'SDK 工具批次与本机执行结果不一致', { toolMayHaveExecuted: true })
      }
    },
    confirmBatch(ids) {
      for (const id of ids) if (completedIds.has(id)) batchedIds.add(id)
    },
    conclude() { concluded = true },
    get concluded() { return concluded },
    get hasUnconfirmedBatch() { return hasUnconfirmedBatch() },
    assertComplete({ successful, terminalReason }) {
      if (pendingEffects.size) {
        throw createError('TOOL_EFFECT_UNCONFIRMED', 'SDK 未确认工具后处理已执行', { toolMayHaveExecuted: true })
      }
      if (concluded && terminalReason !== 'hook_stopped') {
        throw createError('TOOL_CONCLUSION_UNCONFIRMED', 'SDK 未确认工具结束了本轮', { toolMayHaveExecuted: true })
      }
      if (successful && !concluded && hasUnconfirmedBatch()) {
        throw createError('STEP_BOUNDARY_UNCONFIRMED', 'SDK 未确认工具批次已更新本机上下文', { toolMayHaveExecuted: true })
      }
    },
    dispose() {
      for (const waiter of eventWaiters.values()) waiter.reject(createError('CANCELLED', '请求已取消'))
      eventWaiters.clear()
    },
  })
}
