import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createInstructionAudit } from '../src/instruction-audit.mjs'

test('存在已发现来源时，非法或缺projectRoot的原生基线明确拒绝而不猜测cwd', async () => {
  const root = resolve('synthetic-instruction-root'), cwd = join(root, 'sub')
  const audit = createInstructionAudit({ dshHome: join(root, 'global'), agentsHome: join(root, 'agents') })
  const agent = { session: { header: { agentPreset: 'claude-sdk-remote', cwd }, surface: { nodes: [] } } }
  const state = audit.stateFor(agent), content = 'SYNTHETIC_INSTRUCTION'
  const fs = audit.wrapFileSystem({ async resolve(path) { return path },
    async stat() { return { type: 'file', size: content.length, version: 'synthetic-v1' } },
    async *streamText() { yield content } }, () => state)
  const target = await fs.resolve(join(root, 'AGENTS.md'))
  await fs.stat(target)
  for await (const _chunk of await fs.streamText(target)) { /* Consume the native-facing stream. */ }
  const message = identity => ({ source: { kind: 'agent-instructions', form: 'instructions', baseline: true,
    baselineIdentity: identity, changes: [{ action: 'set', scope: '.\0AGENTS.md', path: 'AGENTS.md',
      digest: createHash('sha1').update(content).digest('hex') }] }, content: [{ type: 'text', text: content }] })
  for (const identity of ['not-json', '{}']) {
    assert.throws(() => audit.verify(agent, state, [message(identity)]), { code: 'INSTRUCTION_AUDIT_UNAVAILABLE' })
  }
  assert.equal(audit.verify(agent, state, [message(JSON.stringify({ projectRoot: '..' }))]).sources.length, 1)
})
