// One SDK input pump. Resuming after yield means SDK streamInput has finished
// its transport.write and requested the next input; it is not model acceptance.
export function createPromptInput(initial, failure) {
  const queue = [{ message: initial }]
  const identities = new Map()
  const waiting = new Set()
  let begin, wake, closed = false, started = false
  const ready = new Promise(resolve => { begin = resolve })
  function close() {
    if (closed) return
    closed = true
    begin(); wake?.()
    for (const item of waiting) item.reject(failure())
    waiting.clear(); queue.length = 0
  }
  return {
    start() { if (!closed) { started = true; begin() } },
    close,
    async send(messages) {
      if (closed || !started) throw failure()
      // Validate the whole batch before queuing any member.
      const next = new Map(identities)
      for (const message of messages) {
        const serialized = JSON.stringify(message)
        if (next.has(message.uuid) && next.get(message.uuid) !== serialized) throw failure()
        next.set(message.uuid, serialized)
      }
      const delivered = []
      for (const message of messages) {
        if (identities.has(message.uuid)) continue
        identities.set(message.uuid, next.get(message.uuid))
        delivered.push(new Promise((resolve, reject) => {
          const item = { message, resolve, reject }
          queue.push(item); waiting.add(item)
        }))
      }
      wake?.()
      await Promise.all(delivered)
    },
    async *[Symbol.asyncIterator]() {
      try {
        await ready
        while (!closed) {
          const item = queue.shift()
          if (!item) { await new Promise(resolve => { wake = resolve }); wake = undefined; continue }
          yield item.message
          if (waiting.delete(item)) item.resolve()
        }
      } finally { close() }
    },
  }
}
