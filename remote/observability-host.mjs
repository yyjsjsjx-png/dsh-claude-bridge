import { createObservabilityLedger } from './observability-ledger.mjs'
import { createQuotaCoordinator } from './observability-quota.mjs'
import { createObservabilityIpc } from './observability-ipc.mjs'
import { createHash, randomUUID } from 'node:crypto'

/** One private account store and quota gate for all device workers. */
export function createObservabilityHost({ directory, onDiagnostic = () => {} }) {
  const endpoints = new Set(), active = new Map()
  let warning = null, diagnosing = false
  const diagnose = (event, broadcast = true) => {
    if (diagnosing) return
    diagnosing = true
    warning = { code: event.code ?? 'OBSERVABILITY_WRITE_FAILED', observedAt: Date.now(), gap: event.gap === true }
    try { onDiagnostic({ event: 'observability.failed', ...warning }) } catch {}
    if (broadcast) for (const endpoint of endpoints) endpoint.notify('warning', warning)
    diagnosing = false
  }
  const ledger = createObservabilityLedger({ directory, onDiagnostic: diagnose })
  const quota = createQuotaCoordinator({ onDiagnostic: diagnose,
    fetchUsage: ({ signal } = {}) => {
      const source = [...active].find(([, keys]) => keys.size > 0)?.[0]
      return source ? source.request('fetchQuota', {}).then(value => signal?.aborted ? { status: 'unavailable', code: 'CANCELLED' } : value)
        : Promise.resolve({ status: 'unavailable', code: 'SDK_QUOTA_UNAVAILABLE' })
    },
    onObservation: row => ledger.recordQuota(row),
  })
  return {
    attach(child, deviceId) {
      const identity = row => row?.deviceId === deviceId
      const workerScope = randomUUID(), keys = new Set()
      let endpoint, released = false
      endpoint = createObservabilityIpc(child, { onDiagnostic: event => {
        diagnose(event, false)
        if (event.gap) endpoint.notify('warning', warning)
      }, handlers: {
        record({ kind, row } = {}) {
          if (!identity(row)) { diagnose({ code: 'OBSERVABILITY_IDENTITY_MISMATCH', gap: true }); return { status: 'unavailable', code: 'OBSERVABILITY_IDENTITY_MISMATCH' } }
          const write = { run: 'recordRun', response: 'recordResponse', timing: 'recordTiming' }[kind]
          if (!write) { diagnose({ code: 'OBSERVABILITY_REQUEST_REFUSED', gap: true }); return { status: 'unavailable', code: 'OBSERVABILITY_REQUEST_REFUSED' } }
          return { status: ledger[write](row) ? 'queued' : 'unavailable' }
        },
        query: filters => ledger.query(filters),
        summarize: filters => ledger.summarize(filters),
        status: () => ({ status: 'ok', ledger: ledger.status(), quota: quota.peek(), warning }),
        quota: (params, context) => quota.request({ reason: params?.reason ?? 'manual', signal: context.signal }),
      }, controls: {
        activity: params => {
          if (released) return { status: 'unavailable', code: 'OBSERVABILITY_CHANNEL_CLOSED' }
          if (typeof params?.key !== 'string' || params.key.length > 256 || typeof params.active !== 'boolean') return { status: 'unavailable', code: 'OBSERVABILITY_INVALID_RECORD' }
          const key = createHash('sha256').update(`${workerScope}:${params.key}`).digest('hex')
          if (!quota.setActive(key, params.active)) {
            diagnose({ code: 'OBSERVABILITY_ACTIVITY_REFUSED' })
            return { status: 'unavailable', code: 'OBSERVABILITY_ACTIVITY_REFUSED' }
          }
          if (params.active) keys.add(key); else keys.delete(key)
          return { status: 'ok' }
        },
      } })
      endpoints.add(endpoint)
      active.set(endpoint, keys)
      const release = () => {
        if (released) return
        released = true
        for (const key of keys) quota.setActive(key, false)
        keys.clear(); active.delete(endpoint); endpoints.delete(endpoint); endpoint.close()
        child.removeListener('exit', release); child.removeListener('disconnect', release)
      }
      child.once('exit', release)
      child.once('disconnect', release)
      return release
    },
    async close() { await quota.close(); for (const endpoint of endpoints) endpoint.close(); endpoints.clear(); active.clear(); await ledger.close() },
  }
}
