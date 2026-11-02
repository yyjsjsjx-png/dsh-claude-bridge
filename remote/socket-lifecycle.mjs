const owners = new WeakMap()

/** A single physical socket attempt owns no worker or replay state. */
export class SocketAttempt {
  #active = true
  #timers = new Map()
  #lastHeard = Date.now()

  constructor(socket, address) {
    Object.defineProperties(this, { socket: { value: socket }, address: { value: address } })
  }

  get active() { return this.#active }

  #clear(name) {
    const timer = this.#timers.get(name)
    if (!timer) return
    this.#timers.delete(name)
    if (timer.interval) clearInterval(timer.handle)
    else clearTimeout(timer.handle)
  }

  #schedule(name, ms, callback, interval = false) {
    this.#clear(name)
    if (!this.#active) return
    const timer = { interval }
    this.#timers.set(name, timer)
    timer.handle = (interval ? setInterval : setTimeout)(() => {
      // Clearing a timer also invalidates a callback already queued to run.
      if (!this.#active || this.#timers.get(name) !== timer) return
      if (!interval) this.#timers.delete(name)
      callback()
    }, ms)
    timer.handle.unref?.()
  }

  authenticateWithin(ms, onTimeout) { this.#schedule('auth', ms, onTimeout) }
  authenticated() { this.#clear('auth') }
  recoverWithin(ms, onTimeout) { this.#schedule('recovery', ms, onTimeout) }
  heard() { if (this.#active) this.#lastHeard = Date.now() }

  recoveryReady({ intervalMs, timeoutMs, onTimeout }) {
    this.#clear('recovery')
    this.heard()
    this.#schedule('heartbeat', intervalMs, () => {
      if (Date.now() - this.#lastHeard >= timeoutMs) onTimeout()
    }, true)
  }

  dispose() {
    if (!this.#active) return
    this.#active = false
    for (const name of this.#timers.keys()) this.#clear(name)
  }
}

/** Socket binding and offline retention live as long as the worker lease.
 * The server keeps child/device ownership until worker exit is confirmed. */
export class WorkerSocketLease {
  #attempt
  #retention

  get attempt() { return this.#attempt }
  get socket() { return this.#attempt?.socket }

  bind(attempt) {
    if (!attempt.active) throw new Error('连接尝试已结束')
    if (this.#attempt === attempt) return undefined
    const owner = owners.get(attempt)
    if (owner && owner !== this) {
      owner.#attempt = undefined
      owner.#clearRetention()
    }
    const previous = this.#attempt
    previous?.dispose()
    if (previous) owners.delete(previous)
    this.#clearRetention()
    this.#attempt = attempt
    owners.set(attempt, this)
    return previous?.socket
  }

  isCurrent(attempt) { return Boolean(attempt && this.#attempt === attempt && attempt.active) }

  detach(attempt) {
    if (!this.isCurrent(attempt)) return false
    attempt.dispose()
    return true
  }

  #clearRetention() {
    if (!this.#retention) return
    clearTimeout(this.#retention.handle)
    this.#retention = undefined
  }

  retain(ms, onTimeout) {
    if (this.#retention) return false
    const attempt = this.#attempt, retention = {}
    this.#retention = retention
    retention.handle = setTimeout(() => {
      // A detached attempt is inactive, but still owns this retention period.
      if (this.#retention !== retention || this.#attempt !== attempt) return
      this.#retention = undefined
      onTimeout()
    }, ms)
    retention.handle.unref?.()
    return true
  }

  dispose() {
    this.#attempt?.dispose()
    if (this.#attempt) owners.delete(this.#attempt)
    this.#clearRetention()
  }
}
