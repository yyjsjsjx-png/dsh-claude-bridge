import { randomUUID } from 'node:crypto'

const TYPE = 'dsh-observability-v1'
const unavailable = code => ({ status: 'unavailable', code })

/** Private Node IPC only; these requests never enter the client JSON-RPC wire. */
export function createObservabilityIpc(channel, { handlers = {}, timeoutMs = 20_000, maxPending = 32 } = {}) {
  const pending = new Map(), running = new Map()
  let closed = false
  const send = value => {
    if (closed || typeof channel?.send !== 'function' || channel.connected === false) return false
    try {
      if (Buffer.byteLength(JSON.stringify(value)) > 131072) return false
      channel.send(value, () => {})
      return true
    } catch { return false }
  }
  const receive = message => {
    if (closed || message?.type !== TYPE || typeof message.id !== 'string' || message.id.length > 128) return
    if (message.kind === 'reply') {
      const item = pending.get(message.id)
      if (!item) return
      clearTimeout(item.timer); pending.delete(message.id); item.resolve(message.value)
      return
    }
    if (!['request', 'notify'].includes(message.kind) || typeof message.method !== 'string') return
    const handler = Object.hasOwn(handlers, message.method) ? handlers[message.method] : undefined
    if (typeof handler !== 'function' || running.size >= maxPending || running.has(message.id)) {
      if (message.kind === 'request') send({ type: TYPE, kind: 'reply', id: message.id, value: unavailable('OBSERVABILITY_REQUEST_REFUSED') })
      return
    }
    const controller = new AbortController()
    running.set(message.id, controller)
    void Promise.resolve().then(() => handler(message.params, { signal: controller.signal }))
      .catch(() => unavailable('OBSERVABILITY_OPERATION_FAILED'))
      .then(value => { if (message.kind === 'request') send({ type: TYPE, kind: 'reply', id: message.id, value }) })
      .finally(() => running.delete(message.id))
  }
  function close() {
    if (closed) return
    closed = true
    channel?.removeListener?.('message', receive); channel?.removeListener?.('disconnect', close)
    for (const { resolve, timer } of pending.values()) { clearTimeout(timer); resolve(unavailable('OBSERVABILITY_CHANNEL_CLOSED')) }
    pending.clear()
    for (const controller of running.values()) controller.abort()
    running.clear()
  }
  channel?.on?.('message', receive); channel?.on?.('disconnect', close)
  return {
    notify(method, params) { return send({ type: TYPE, kind: 'notify', id: randomUUID(), method, params }) },
    request(method, params) {
      if (closed || pending.size >= maxPending) return Promise.resolve(unavailable('OBSERVABILITY_CHANNEL_UNAVAILABLE'))
      const id = randomUUID()
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(id); resolve(unavailable('OBSERVABILITY_REQUEST_TIMEOUT')) }, timeoutMs)
        timer.unref?.()
        pending.set(id, { resolve, timer })
        if (!send({ type: TYPE, kind: 'request', id, method, params })) {
          clearTimeout(timer); pending.delete(id); resolve(unavailable('OBSERVABILITY_CHANNEL_UNAVAILABLE'))
        }
      })
    }, close,
  }
}
