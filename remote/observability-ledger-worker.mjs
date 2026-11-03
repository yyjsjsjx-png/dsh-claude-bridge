import { parentPort, workerData } from 'node:worker_threads'
import { mkdirSync, lstatSync, chmodSync, openSync, closeSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { normalizeObservabilityRecord, normalizeObservedQuota, QUOTA_ACCOUNT_BOUNDARY_CODES } from '../src/observability-schema.mjs'

let database
const unknown = code => ({ status: 'unavailable', code })
const columns = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
const keyOf = (kind, row) => kind === 'quota' ? row.observationId : JSON.stringify([
  row.deviceId, row.runId, ...(kind === 'responses' ? [row.responseId]
    : kind === 'timing' ? [row.level, row.responseId ?? '', row.side, row.metric] : [])])
const transaction = action => {
  database.exec('BEGIN IMMEDIATE')
  try { const value = action(); database.exec('COMMIT'); return value }
  catch (error) { try { database.exec('ROLLBACK') } catch {}; throw error }
}

function initialize() {
  const { directory, busyTimeoutMs } = workerData
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('STORAGE_UNSAFE')
  chmodSync(directory, 0o700)
  const path = join(directory, 'observability.sqlite')
  if (existsSync(path)) {
    const file = lstatSync(path)
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('STORAGE_UNSAFE')
  } else closeSync(openSync(path, 'wx', 0o600))
  chmodSync(path, 0o600)
  database = new DatabaseSync(path)
  database.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;`)
  const version = database.prepare('PRAGMA user_version').get().user_version
  if (version !== 0 && version !== 1) throw new Error('OBSERVABILITY_SCHEMA_UNSUPPORTED')
  if (version === 0) {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    if (tables.length) throw new Error('OBSERVABILITY_SCHEMA_UNSUPPORTED')
    transaction(() => {
      database.exec(`
        CREATE TABLE runs (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, sdk_session_id TEXT NOT NULL,
          model TEXT NOT NULL, observed_at INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL,
          uncached_input INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER,
          cumulative_cost REAL, cost_observed_at INTEGER, cost_delta REAL, cost_status TEXT NOT NULL);
        CREATE INDEX runs_filter ON runs(observed_at, device_id, model);
        CREATE INDEX runs_cost ON runs(sdk_session_id, cost_observed_at);
        CREATE TABLE responses (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, model TEXT NOT NULL,
          observed_at INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE INDEX responses_filter ON responses(observed_at, device_id, model);
        CREATE TABLE timing (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, model TEXT NOT NULL,
          observed_at INTEGER NOT NULL, side TEXT NOT NULL, metric TEXT NOT NULL, quality TEXT NOT NULL,
          clock TEXT NOT NULL, source TEXT NOT NULL, duration_ms REAL, output_tokens INTEGER, body TEXT NOT NULL);
        CREATE INDEX timing_filter ON timing(observed_at, device_id, model);
        CREATE TABLE quota (id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL,
          snapshot_observed_at INTEGER, status TEXT NOT NULL, body TEXT NOT NULL);
        CREATE INDEX quota_filter ON quota(observed_at);
        PRAGMA user_version=1;
      `)
    })
  }
  // DELETE journals inherit the private database mode and avoid persistent WAL sidecars.
  database.exec('PRAGMA journal_mode=DELETE')
}

function recomputeCosts(sessionId) {
  const rows = database.prepare('SELECT id, cumulative_cost, cost_observed_at FROM runs WHERE sdk_session_id=? AND cumulative_cost IS NOT NULL ORDER BY cost_observed_at,id').all(sessionId)
  const update = database.prepare('UPDATE runs SET cost_delta=?,cost_status=? WHERE id=?')
  let baseline
  for (let index = 0; index < rows.length;) {
    const group = [rows[index++]]
    while (index < rows.length && rows[index].cost_observed_at === group[0].cost_observed_at) group.push(rows[index++])
    if (group.length > 1) {
      for (const row of group) update.run(null, 'ambiguous-order', row.id)
      baseline = undefined
      continue
    }
    const row = group[0]
    const status = baseline === undefined ? 'baseline-missing'
      : row.cumulative_cost < baseline ? 'counter-reset' : 'known'
    update.run(status === 'known' ? row.cumulative_cost - baseline : null, status, row.id)
    baseline = row.cumulative_cost
  }
}

function write(kind, value) {
  const row = normalizeObservabilityRecord(kind, value), id = keyOf(kind, row)
  return transaction(() => {
    const prior = database.prepare(`SELECT * FROM ${kind} WHERE id=?`).get(id)
    let data = row
    if (prior) {
      const old = JSON.parse(prior.body)
      if (['deviceId', 'dshSessionId', 'sdkSessionId', 'runId', 'responseId', 'kind', 'level', 'side', 'metric']
        .some(key => old[key] !== row[key])) return unknown('OBSERVABILITY_IDENTITY_CONFLICT')
      if (row.observedAt < old.observedAt || kind === 'runs' && old.status !== 'unknown' && row.status === 'unknown') {
        return { status: 'ok', schemaVersion: 1, ignored: true }
      }
      data = ['runs', 'responses'].includes(kind) ? { ...old, ...row } : row
    }
    const body = JSON.stringify(data)
    if (prior?.body === body) return { status: 'ok', schemaVersion: 1, unchanged: true }
    if (kind === 'runs') {
      const cost = data.cumulativeCostUsd ?? null
      const costObservedAt = row.cumulativeCostUsd === undefined ? prior?.cost_observed_at ?? null : row.observedAt
      database.prepare(`INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        model=excluded.model,observed_at=excluded.observed_at,status=excluded.status,body=excluded.body,uncached_input=excluded.uncached_input,
        output_tokens=excluded.output_tokens,cache_read=excluded.cache_read,cache_write=excluded.cache_write,
        cumulative_cost=excluded.cumulative_cost,cost_observed_at=excluded.cost_observed_at,
        cost_delta=excluded.cost_delta,cost_status=excluded.cost_status`).run(id, data.deviceId, data.sdkSessionId,
        data.model, data.observedAt, data.status, body, ...columns.map(field => data.usage?.[field] ?? null),
        cost, costObservedAt, null, cost === null ? 'missing' : 'baseline-missing')
      recomputeCosts(data.sdkSessionId)
    } else if (kind === 'responses') {
      database.prepare(`INSERT INTO responses VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        model=excluded.model,observed_at=excluded.observed_at,body=excluded.body`).run(id, data.deviceId, data.model, data.observedAt, body)
    } else if (kind === 'timing') {
      database.prepare(`INSERT INTO timing VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        model=excluded.model,observed_at=excluded.observed_at,quality=excluded.quality,clock=excluded.clock,source=excluded.source,
        duration_ms=excluded.duration_ms,output_tokens=excluded.output_tokens,body=excluded.body`).run(id,
        data.deviceId, data.model, data.observedAt, data.side, data.metric, data.quality, data.clock, data.source,
        data.durationMs ?? null, data.outputTokens ?? null, body)
    } else {
      database.prepare(`INSERT INTO quota VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        observed_at=excluded.observed_at,snapshot_observed_at=excluded.snapshot_observed_at,
        status=excluded.status,body=excluded.body`).run(id, data.observedAt, data.snapshot?.observedAt ?? null, data.status, body)
    }
    return { status: 'ok', schemaVersion: 1 }
  })
}

function where(filters, accountOnly = false) {
  const clauses = ['observed_at>=?', 'observed_at<?'], values = [filters.from, filters.to]
  if (!accountOnly) for (const [key, column] of [['deviceId', 'device_id'], ['model', 'model']]) {
    if (filters[key] !== undefined) { clauses.push(`${column}=?`); values.push(filters[key]) }
  }
  return { clause: clauses.join(' AND '), values }
}

function query(filters) {
  const { clause, values } = where(filters, filters.kind === 'quota')
  const records = database.prepare(`SELECT * FROM ${filters.kind} WHERE ${clause} ORDER BY observed_at,id LIMIT ?`)
    .all(...values, filters.limit + 1)
  return { status: 'ok', schemaVersion: 1, kind: filters.kind, range: { from: filters.from, to: filters.to },
    hasMore: records.length > filters.limit, rows: records.slice(0, filters.limit).map(row => ({ ...JSON.parse(row.body),
      ...(filters.kind === 'runs' ? { costDeltaUsd: row.cost_delta, costDeltaStatus: row.cost_status,
        costObservedAt: row.cost_observed_at } : {}) })) }
}

const summaryFields = `COUNT(*) AS runs,SUM(uncached_input IS NOT NULL) AS known_usage_runs,
  SUM(uncached_input) AS uncached_input,SUM(output_tokens) AS output_tokens,
  SUM(cache_read) AS cache_read,SUM(cache_write) AS cache_write,
  SUM(status='completed') AS completed,SUM(status='failed') AS failed,SUM(status='cancelled') AS cancelled,
  SUM(status='unknown') AS unknown,SUM(cumulative_cost IS NOT NULL) AS cost_observations,
  SUM(cost_status='known') AS known_cost_deltas,SUM(cost_delta) AS cost_delta`
const summaryOf = row => ({ runs: row.runs, knownUsageRuns: row.known_usage_runs ?? 0,
  unknownUsageRuns: row.runs - (row.known_usage_runs ?? 0),
  statusCounts: { completed: row.completed ?? 0, failed: row.failed ?? 0, cancelled: row.cancelled ?? 0, unknown: row.unknown ?? 0 },
  usage: row.known_usage_runs ? { scope: 'current-turn-main-agent', uncachedInputTokens: row.uncached_input,
    outputTokens: row.output_tokens, cacheReadTokens: row.cache_read, cacheWriteTokens: row.cache_write } : null,
  cost: { scope: 'session-counter-interval-estimate', knownDeltaUsd: row.known_cost_deltas ? row.cost_delta : null,
    knownDeltaRuns: row.known_cost_deltas ?? 0, observations: row.cost_observations ?? 0,
    unknownDeltaRuns: row.runs - (row.known_cost_deltas ?? 0) } })

function summarize(filters) {
  const { clause, values } = where(filters)
  const totals = summaryOf(database.prepare(`SELECT ${summaryFields} FROM runs WHERE ${clause}`).get(...values))
  const group = { day: "strftime('%Y-%m-%d',observed_at/1000,'unixepoch')", model: 'model', device: 'device_id' }[filters.groupBy]
  const groups = group ? database.prepare(`SELECT ${group} AS group_key,${summaryFields} FROM runs WHERE ${clause}
    GROUP BY ${group} ORDER BY group_key LIMIT 501`).all(...values) : []
  const account = where(filters, true)
  const quota = database.prepare(`SELECT COUNT(*) AS observations,SUM(status='unavailable') AS failures,
    MAX(snapshot_observed_at) AS lastObservedAt FROM quota WHERE ${account.clause}`).get(...account.values)
  const timing = database.prepare(`SELECT side,metric,quality,clock,source,COUNT(*) AS samples,
    SUM(duration_ms) AS durationMs,SUM(output_tokens) AS outputTokens FROM timing WHERE ${clause}
    GROUP BY side,metric,quality,clock,source ORDER BY side,metric,quality,clock,source LIMIT 501`).all(...values)
  return { status: 'ok', schemaVersion: 1, range: { from: filters.from, to: filters.to }, totals,
    groupBy: filters.groupBy, groups: groups.slice(0, 500).map(row => ({ key: row.group_key, ...summaryOf(row) })),
    groupsTruncated: groups.length > 500, quota: { scope: 'account', observations: quota.observations,
      failures: quota.failures ?? 0, lastObservedAt: quota.lastObservedAt },
    timing: timing.slice(0, 500).map(row => ({ ...row })), timingTruncated: timing.length > 500 }
}

// A boundary row at the same instant wins: attribution must fail closed.
function latestQuota() {
  const none = { status: 'ok', schemaVersion: 1, snapshot: null }
  const row = database.prepare(`SELECT observed_at, body FROM quota WHERE status='available'
    ORDER BY observed_at DESC, id DESC LIMIT 1`).get()
  if (!row) return none
  const boundary = database.prepare(`SELECT MAX(observed_at) AS at FROM quota WHERE status='unavailable'
    AND json_extract(body,'$.code') IN (${QUOTA_ACCOUNT_BOUNDARY_CODES.map(() => '?').join(',')})`)
    .get(...QUOTA_ACCOUNT_BOUNDARY_CODES)
  if (boundary.at !== null && boundary.at >= row.observed_at) return none
  const snapshot = normalizeObservedQuota(JSON.parse(row.body).snapshot)
  return snapshot ? { ...none, snapshot } : none
}

try {
  initialize()
  parentPort.postMessage({ type: 'ready', ok: true })
  parentPort.on('message', message => {
    let result
    try {
      if (message.action === 'record') result = write(message.kind, message.value)
      else if (message.action === 'query') result = query(message.value)
      else if (message.action === 'summarize') result = summarize(message.value)
      else if (message.action === 'latestQuota') result = latestQuota()
      else if (message.action === 'flush') result = { status: 'ok', schemaVersion: 1 }
      else if (message.action === 'close') { database.close(); result = { status: 'ok', schemaVersion: 1 } }
      else result = unknown('OBSERVABILITY_INVALID_OPERATION')
    } catch {
      result = unknown('OBSERVABILITY_STORAGE_UNAVAILABLE')
    }
    parentPort.postMessage({ id: message.id, result })
    if (message.action === 'close') parentPort.close()
  })
} catch (error) {
  try { database?.close() } catch {}
  parentPort.postMessage({ type: 'ready', ok: false, code: error.message === 'OBSERVABILITY_SCHEMA_UNSUPPORTED'
    ? error.message : 'OBSERVABILITY_STORAGE_UNAVAILABLE' })
  parentPort.close()
}
