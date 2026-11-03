import { createObservabilityIpc } from './observability-ipc.mjs'

/** Worker-side adapter. The parent alone owns the account sampler and database. */
export function createWorkerObservability(channel, { fetchQuota, onWarning = () => {} } = {}) {
  if (typeof channel?.send !== 'function') return undefined
  const endpoint = createObservabilityIpc(channel, { onDiagnostic: onWarning, handlers: {
    fetchQuota: (_params, context) => fetchQuota(context),
  }, controls: {
    warning: value => { onWarning(value); return { status: 'ok' } },
  } })
  return {
    record: (kind, row) => endpoint.notify('record', { kind, row }),
    query: filters => endpoint.request('query', filters),
    summarize: filters => endpoint.request('summarize', filters),
    status: () => endpoint.request('status', {}),
    quota: (reason = 'manual') => endpoint.request('quota', { reason }),
    activity: (key, active) => endpoint.notify('activity', { key, active }),
    // Same ordered channel as later quota requests, so no reply is needed.
    accountBoundary: () => endpoint.notify('accountBoundary', {}),
    close: endpoint.close,
  }
}
