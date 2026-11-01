import { Worker } from 'node:worker_threads'
import { isAbsolute, normalize, sep } from 'node:path'
import { normalizeObservabilityRecord, normalizeObservabilityFilters } from '../src/observability-schema.mjs'

const unavailable = code => ({ status: 'unavailable', code })

/** One parent-server writer. DatabaseSync is isolated from conversation I/O. */
export function createObservabilityLedger({ directory, onDiagnostic = () => {}, maxQueue = 128,
  busyTimeoutMs = 50, operationTimeoutMs = 1000, startupTimeoutMs = 2000, now = Date.now } = {}) {
  let worker, state = 'starting', lastError = null, gaps = 0, dropped = 0, sequence = 0, active, startupTimer
  const queue = []
  let resolveReady, readyResolved = false, closing
  const ready = new Promise(resolve => { resolveReady = resolve })
  const settleReady = value => { if (!readyResolved) { readyResolved = true; resolveReady(value) } }
  const report = (code, gap = false) => {
    lastError = code
    if (gap) gaps++
    try { Promise.resolve(onDiagnostic({ code, gap })).catch(() => {}) } catch {}
  }
  const fail = code => {
    if (state === 'closed' || state === 'unavailable') return
    state = 'unavailable'
    clearTimeout(startupTimer)
    settleReady(false)
    const lost = [active, ...queue].filter(Boolean)
    if (active) clearTimeout(active.timer)
    active = undefined; queue.length = 0
    dropped += lost.filter(job => job.action === 'record').length
    report(code, lost.some(job => job.action === 'record'))
    for (const job of lost) job.resolve?.(unavailable(code))
    void worker?.terminate().catch(() => {})
  }
  const dispatch = () => {
    if (state !== 'ready' || active || !queue.length) return
    active = queue.shift()
    worker.ref()
    const job = active
    job.timer = setTimeout(() => fail('OBSERVABILITY_OPERATION_TIMEOUT'), operationTimeoutMs)
    try { worker.postMessage({ id: job.id, action: job.action, kind: job.kind, value: job.value }) }
    catch { fail('OBSERVABILITY_WORKER_FAILED') }
  }
  function enqueue(action, value, kind, resolve) {
    if (!['starting', 'ready'].includes(state) || closing && action !== 'close') {
      if (action === 'record') { dropped++; report(lastError ?? 'OBSERVABILITY_CLOSED', true) }
      resolve?.(unavailable(lastError ?? 'OBSERVABILITY_CLOSED'))
      return false
    }
    if (action !== 'close' && queue.length + Number(Boolean(active)) >= maxQueue) {
      if (action === 'record') dropped++
      report('OBSERVABILITY_QUEUE_FULL', action === 'record')
      resolve?.(unavailable('OBSERVABILITY_QUEUE_FULL'))
      return false
    }
    queue.push({ id: ++sequence, action, value, kind, resolve })
    dispatch()
    return true
  }
  function record(kind, value) {
    let row
    try { row = normalizeObservabilityRecord(kind, value) }
    catch { dropped++; report('OBSERVABILITY_INVALID_RECORD', true); return false }
    return enqueue('record', row, kind)
  }
  function read(action, value) {
    let filters
    try { filters = normalizeObservabilityFilters(value, { now: now(), summary: action === 'summarize' }) }
    catch { return Promise.resolve(unavailable('OBSERVABILITY_INVALID_FILTER')) }
    return new Promise(resolve => { enqueue(action, filters, undefined, resolve) })
  }
  try {
    const forbidden = new Set(['sessions', 'claude-config', 'private'])
    if (typeof directory !== 'string' || !isAbsolute(directory)
      || normalize(directory).split(sep).some(part => forbidden.has(part.toLowerCase()))
      || !Number.isSafeInteger(maxQueue) || maxQueue < 1 || maxQueue > 4096
      || !Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 2000
      || !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 30_000
      || !Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 30_000) {
      throw new Error('OBSERVABILITY_CONFIG_INVALID')
    }
    worker = new Worker(new URL('./observability-ledger-worker.mjs', import.meta.url), {
      workerData: { directory: normalize(directory), busyTimeoutMs },
    })
    startupTimer = setTimeout(() => fail('OBSERVABILITY_STARTUP_TIMEOUT'), startupTimeoutMs)
    worker.on('error', () => fail('OBSERVABILITY_WORKER_FAILED'))
    worker.on('exit', () => { if (state !== 'closed') fail('OBSERVABILITY_WORKER_FAILED') })
    worker.on('message', message => {
      if (message?.type === 'ready') {
        if (state !== 'starting') return
        clearTimeout(startupTimer)
        if (message.ok !== true) { fail(message.code === 'OBSERVABILITY_SCHEMA_UNSUPPORTED'
          ? message.code : 'OBSERVABILITY_STORAGE_UNAVAILABLE'); return }
        state = 'ready'; settleReady(true)
        if (queue.length) dispatch(); else worker.unref()
        return
      }
      if (!active || message?.id !== active.id || state !== 'ready') return
      const job = active
      clearTimeout(job.timer); active = undefined
      const result = message.result?.status ? message.result : unavailable('OBSERVABILITY_WORKER_FAILED')
      if (result.status === 'unavailable') {
        if (job.action === 'record') dropped++
        report(result.code, job.action === 'record')
      }
      job.resolve?.(result)
      if (job.action === 'close') { state = 'closed'; worker.unref(); return }
      if (queue.length) dispatch(); else worker.unref()
    })
  } catch {
    fail('OBSERVABILITY_CONFIG_INVALID')
  }
  return {
    ready,
    recordRun: value => record('runs', value), recordResponse: value => record('responses', value),
    recordTiming: value => record('timing', value), recordQuota: value => record('quota', value),
    status: () => ({ status: state, pending: queue.length + Number(Boolean(active)), gaps, dropped, lastError }),
    query: filters => read('query', filters), summarize: filters => read('summarize', filters),
    flush: () => new Promise(resolve => { enqueue('flush', undefined, undefined, resolve) }),
    close() {
      if (closing) return closing
      closing = new Promise(resolve => {
        if (!enqueue('close', undefined, undefined, resolve)) {
          fail('OBSERVABILITY_CLOSE_FAILED')
          resolve(unavailable(lastError ?? 'OBSERVABILITY_CLOSED'))
        }
      })
      return closing
    },
  }
}
