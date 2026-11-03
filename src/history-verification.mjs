/**
 * Records which sessions already have verified cloud history for one
 * connection generation. Any connection change fences earlier verification.
 */
export class HistoryVerification {
  constructor() {
    this.generation = 0
    this.verified = new WeakMap()
  }

  /** Invalidate every verification taken before this point. */
  fence() { this.generation++ }

  /** Whether the session was verified on this exact transport and generation. */
  matches(session, transport) {
    const verified = this.verified.get(session)
    return Boolean(verified) && verified.transport === transport && verified.generation === this.generation
  }

  forget(session) { this.verified.delete(session) }

  remember(session, transport, generation) { this.verified.set(session, { transport, generation }) }
}
