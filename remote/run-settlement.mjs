const summaryOf = outcome => outcome
  ? { status: outcome.status, ...(outcome.code ? { code: outcome.code } : {}),
      ...(outcome.toolMayHaveExecuted ? { toolMayHaveExecuted: true } : {}) }
  : { status: 'unknown', code: 'UNKNOWN_EXECUTION_OUTCOME', toolMayHaveExecuted: true }

/** One query's callback drain and durable finalization, without a shared response. */
export function createRunSettlement() {
  const callbacks = new Set()
  return Object.freeze({
    track(promise) {
      callbacks.add(promise)
      promise.finally(() => callbacks.delete(promise)).catch(() => {})
      return promise
    },
    async drain() { await Promise.allSettled([...callbacks]) },
    async finish(candidate, { save, release, onReleaseFailure } = {}) {
      // Priority and order are intentional:
      // 1. Runtime validates the SDK candidate, drains callbacks, then maps any
      //    callback problem (ahead of cancellation / an iterator error).
      // 2. A failed durable save downgrades that candidate to unknown.
      // 3. A subsequent release failure wins, followed by a best-effort repair
      //    of the saved record. A failed repair cannot establish persistence.
      // Query, observations and settle only receive the result of these steps.
      let outcome = candidate
      if (save) {
        try { await save(outcome) } catch {
          if (outcome) outcome = { ...outcome, status: 'unknown', code: 'RECOVERY_SAVE_FAILED',
            message: '云端执行结果未能可靠登记，请等待恢复核对。', toolMayHaveExecuted: true }
        }
      }
      if (release) {
        try { await release() } catch {
          onReleaseFailure?.()
          if (outcome) outcome = { ...outcome, status: 'unknown', code: 'LOCK_RELEASE_FAILED',
            message: '远程会话锁无法确认释放，执行状态需核实', toolMayHaveExecuted: true }
          if (save) await save(outcome).catch(() => {})
        }
      }
      return { outcome, summary: summaryOf(outcome) }
    },
  })
}
