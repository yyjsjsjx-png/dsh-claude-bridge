import { join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { createBridgeServer } from '../../remote/server.mjs'

const root = process.env.BRIDGE_REMOTE_ROOT
if (!root || process.getuid?.() === 0) throw new Error('FIXTURE_CONFIG_INVALID')
const server = await createBridgeServer({ remoteRoot: root,
  workerPath: join(root, 'test/fixtures/recovery-worker.mjs'),
  tokenFile: join(root, 'private/fixture-token'), port: Number(process.env.BRIDGE_PORT),
  onDiagnostic: event => appendFile(join(root, 'fixture-server.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }),
})
process.once('SIGTERM', () => { void server.close().catch(() => { process.exitCode = 1 }) })
process.once('SIGINT', () => { void server.close().catch(() => { process.exitCode = 1 }) })
