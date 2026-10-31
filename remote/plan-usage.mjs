import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { planUsageSnapshot } from '../src/plan-usage.mjs'
import { sdkErrorDetail } from './errors.mjs'

/** Read the SDK's structured /usage without a prompt or transcript scan. */
export function createPlanUsageReader({ sdk, sessionRoot, cliPath, childEnv, timeoutMs = 15_000 }) {
  const active = new Map()

  async function read({ signal } = {}) {
    if (signal?.aborted) return { status: 'unavailable', code: 'CANCELLED' }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, timeoutMs)
    timer.unref?.()
    let query, finish
    const settled = new Promise(resolve => { finish = resolve })
    active.set(controller, settled)
    try {
      const cwd = join(sessionRoot, '_usage')
      await mkdir(cwd, { recursive: true, mode: 0o700 })
      if (signal?.aborted) cancel()
      if (controller.signal.aborted) return { status: 'unavailable', code: 'CANCELLED' }
      async function* noPrompt() {
        if (!controller.signal.aborted) await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }))
      }
      query = sdk.query({ prompt: noPrompt(), options: {
        cwd, pathToClaudeCodeExecutable: cliPath, env: childEnv, settingSources: [],
        strictMcpConfig: true, tools: [], persistSession: false, abortController: controller,
      } })
      if (typeof query?.initializationResult !== 'function' || typeof query?.close !== 'function'
        || typeof query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') {
        return { status: 'unavailable', code: 'SDK_QUOTA_UNAVAILABLE' }
      }
      const aborted = new Promise((_, reject) => {
        const onAbort = () => reject(new Error('QUOTA_READ_ABORTED'))
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      const reply = await Promise.race([(async () => {
        await query.initializationResult()
        return query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })
      })(), aborted])
      return controller.signal.aborted ? { status: 'unavailable', code: 'CANCELLED' } : planUsageSnapshot(reply)
    } catch (error) {
      return { status: 'unavailable', code: signal?.aborted ? 'CANCELLED'
        : sdkErrorDetail(error)?.code ?? 'QUOTA_READ_FAILED' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      controller.abort()
      try { query?.close() } catch { /* No prompt was sent, no operation is retried. */ }
      active.delete(controller)
      finish()
    }
  }

  async function close() {
    const pending = [...active.values()]
    for (const controller of active.keys()) controller.abort()
    await Promise.allSettled(pending)
  }
  return { read, close }
}
