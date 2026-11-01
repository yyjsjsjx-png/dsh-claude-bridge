import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createWebSocketTransport } from '../src/websocket-transport.mjs'

/** Read-only personal bridge query. Never scans transcripts or refreshes quota. */
async function main() {
  const flags = {}
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]
    if (!['--connection', '--kind', '--from', '--to', '--device', '--model', '--limit', '--summary'].includes(key)
      || !process.argv[i + 1] || flags[key] !== undefined) throw Error('OBSERVABILITY_ARGUMENT_INVALID')
    flags[key] = process.argv[i + 1]
  }
  if (!flags['--connection']) throw Error('OBSERVABILITY_CONNECTION_REQUIRED')
  const connection = JSON.parse(await readFile(flags['--connection'], 'utf8'))
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const filters = {}
  for (const [flag, key] of [['--from', 'from'], ['--to', 'to']]) if (flags[flag]) {
    const value = /^[0-9]+$/.test(flags[flag]) ? Number(flags[flag]) : Date.parse(flags[flag])
    if (!Number.isSafeInteger(value) || value < 0) throw Error('OBSERVABILITY_TIME_INVALID')
    filters[key] = value
  }
  for (const [flag, key] of [['--device', 'deviceId'], ['--model', 'model']]) if (flags[flag]) filters[key] = flags[flag]
  if (flags['--limit']) filters.limit = Number(flags['--limit'])
  if (flags['--summary']) filters.groupBy = flags['--summary']
  else filters.kind = flags['--kind'] ?? 'runs'
  let transport
  try {
    transport = await createWebSocketTransport({ url: connection.url, token: connection.token, deviceId: randomUUID() })
    const initialized = await transport.peer.request('initialize', { protocolVersion: 1, clientVersion: version }, { timeoutMs: 30000 })
    if (initialized.clientCompatible === false || initialized.capabilities?.observability !== true) throw Error('OBSERVABILITY_UNSUPPORTED')
    const result = await transport.peer.request('observabilityQuery', { operation: flags['--summary'] ? 'summarize' : 'query', filters }, { timeoutMs: 5000 })
    console.log(JSON.stringify(result))
    if (result.status !== 'ok') process.exitCode = 1
  } finally { await transport?.close() }
}
main().catch(error => {
  console.error(/^[A-Z][A-Z0-9_]{0,79}$/.test(error?.message ?? '') ? error.message : 'OBSERVABILITY_QUERY_FAILED')
  process.exitCode = 1
})
