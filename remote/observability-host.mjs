import { createObservabilityLedger } from './observability-ledger.mjs'
import { createQuotaCoordinator } from './observability-quota.mjs'
import { createObservabilityIpc } from './observability-ipc.mjs'

/** One private account store and quota gate for all device workers. */
export function createObservabilityHost({ directory, onDiagnostic = () => {} }) {
  const endpoints = new Set()
  let quotaSource, warning = null
  const diagnose = event => {
    warning = { code: event.code ?? 'OBSERVABILITY_WRITE_FAILED', observedAt: Date.now(), gap: event.gap === true }
    try { onDiagnostic({ event: 'observability.failed', ...warning }) } catch {}
    for (const endpoint of endpoints) endpoint.notify('warning', warning)
  }
  const ledger = createObservabilityLedger({ directory, onDiagnostic: diagnose })
  const quota = createQuotaCoordinator({ onDiagnostic: diagnose,
    fetchUsage: ({ signal } = {}) => quotaSource
      ? quotaSource.request('fetchQuota', {}).then(value => signal?.aborted ? { status: 'unavailable', code: 'CANCELLED' } : value)
      : Promise.resolve({ status: 'unavailable', code: 'SDK_QUOTA_UNAVAILABLE' }),
    onObservation: row => ledger.recordQuota(row),
  })
  return {
    attach(child, deviceId) {
      const identity = row => row?.deviceId === deviceId
      let endpoint
      endpoint = createObservabilityIpc(child, { handlers: {
        record({ kind, row } = {}) {
          if (!identity(row)) return { status: 'unavailable', code: 'OBSERVABILITY_IDENTITY_MISMATCH' }
          const write = { run: 'recordRun', response: 'recordResponse', timing: 'recordTiming' }[kind]
          if (!write) return { status: 'unavailable', code: 'OBSERVABILITY_REQUEST_REFUSED' }
          return { status: ledger[write](row) ? 'queued' : 'unavailable' }
        },
        query: filters => ledger.query(filters),
        summarize: filters => ledger.summarize(filters),
        status: () => ({ status: 'ok', ledger: ledger.status(), quota: quota.peek(), warning }),
        quota: (params, context) => { quotaSource = endpoint; return quota.request({ reason: params?.reason ?? 'manual', signal: context.signal }) },
        activity: params => { quotaSource = endpoint; quota.noteActivity(params?.reason); return { status: 'ok' } },
      } })
      endpoints.add(endpoint)
      const release = () => { endpoints.delete(endpoint); endpoint.close(); if (quotaSource === endpoint) quotaSource = undefined }
      child.once('exit', release)
      return release
    },
    async close() { await quota.close(); for (const endpoint of endpoints) endpoint.close(); endpoints.clear(); await ledger.close() },
  }
}
