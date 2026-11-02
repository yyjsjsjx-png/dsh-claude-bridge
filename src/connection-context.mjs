/** Owns one configuration identity and its connection resources. Physical
 * reconnects do not change this identity or the separate history generation. */
export class ConnectionContext {
  #revision = 0
  #abort = new AbortController()
  #identity = this.#createIdentity()
  #transport
  #pending
  #initialized
  #retired = false

  #createIdentity() {
    return Object.freeze({ revision: this.#revision, signal: this.#abort.signal })
  }

  get transport() { return this.#transport }
  get pending() { return this.#pending }
  get initialized() { return this.#initialized }
  capture() { return this.#identity }

  current(identity, transport) {
    return !this.#retired && identity === this.#identity
      && (arguments.length < 2 || transport === this.#transport)
  }

  /** A transport can notify while initialize is still in flight. */
  accepts(identity, transport) {
    return this.current(identity) && (!this.#transport || this.#transport === transport)
  }

  beginInitialization(identity) {
    if (!this.current(identity)) return false
    this.#initialized = undefined
    return true
  }

  completeInitialization(identity, initialized) {
    if (!this.current(identity)) return false
    this.#initialized = initialized
    return true
  }

  bind(identity, transport) {
    if (!this.current(identity)) return false
    this.#transport = transport
    return true
  }

  track(pending) { this.#pending = pending }
  untrack(pending) { if (this.#pending === pending) this.#pending = undefined }

  disconnected(identity, transport) {
    if (!this.accepts(identity, transport)) return false
    this.#transport = undefined
    return true
  }

  invalidate() {
    const previous = { transport: this.#transport, pending: this.#pending }
    const abort = this.#abort
    this.#abort = new AbortController()
    this.#revision++
    this.#identity = this.#createIdentity()
    this.#transport = this.#pending = this.#initialized = undefined
    // Abort listeners may run synchronously; they must already be stale.
    abort.abort()
    return previous
  }

  retire() { this.#retired = true; this.#abort.abort() }
}
