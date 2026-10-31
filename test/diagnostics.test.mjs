import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDiagnostics, diagnosticRecord } from '../src/diagnostics.mjs'

test('诊断仅记录元数据，排除正文、凭据和任意错误文本', () => {
  const record = diagnosticRecord('tool.finished', {
    runId: 'run-123', stage: 'execute', durationMs: 2, command: 'secret-command',
    token: 'sk-secret', prompt: 'private-text', error: 'Bearer private-key',
    method: 'https://host/path?token=private', toolMayHaveExecuted: true,
  })
  assert.equal(record.runId, 'run-123')
  assert.equal(record.toolMayHaveExecuted, true)
  assert.equal(record.command, undefined)
  assert.equal(record.method, undefined)
  assert.doesNotMatch(JSON.stringify(record), /secret|private|Bearer/)
})

test('诊断顺序落盘并保持有界轮转', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-diagnostic-'))
  try {
    const logger = createDiagnostics({ directory, maxBytes: 1024 })
    for (let index = 0; index < 30; index++) logger.event('rpc.finished', { requestId: `r-${index}` })
    await logger.flush()
    const latest = await readFile(logger.path, 'utf8')
    assert.ok(Buffer.byteLength(latest) <= 1024)
    const lines = latest.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(lines.at(-1).requestId, 'r-29')
    assert.match(await readFile(join(directory, 'bridge.previous.jsonl'), 'utf8'), /rpc.finished/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
