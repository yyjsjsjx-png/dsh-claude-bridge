/** Owns the current native step and response/preparation handoff for one run.
 * The native loop already opened the first step and closes the last one using
 * _bridgeStepOpen, so that compatibility field remains visible on the agent. */
export class RunStepLifecycle {
  #agent
  #phase
  #turn
  #step
  #modelStarted = false
  #prepared = false

  constructor({ agent, phase, turn, step }) {
    this.#agent = agent
    this.#phase = phase
    this.#turn = turn
    this.#step = step
  }

  get current() { return this.#step }

  #closeCurrent() {
    this.#agent.session.append('step/end', { turn: this.#turn, step: this.#step })
    this.#agent._bridgeStepOpen = false
  }

  #openNext(phase) {
    this.#step++
    phase.step = this.#step
    this.#agent.session.append('step/start', { turn: this.#turn, step: this.#step })
    this.#agent._bridgeStepOpen = true
  }

  async modelStart({ signal, tools, beforeClose }) {
    if (signal.aborted) return
    if (!this.#modelStarted) { this.#modelStarted = true; return this.#step }
    if (this.#prepared) { this.#prepared = false; return this.#step }
    await tools
    if (signal.aborted) return
    beforeClose?.()
    this.#closeCurrent()
    this.#openNext(this.#phase)
    return this.#step
  }

  beginPreparation() {
    this.#closeCurrent()
    return { turn: this.#turn, step: this.#step + 1 }
  }

  completePreparation() {
    this.#openNext(this.#agent.phase)
    this.#prepared = true
    return this.#step
  }
}
