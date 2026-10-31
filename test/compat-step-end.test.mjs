import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adaptAgentLoop } from '../scripts/prepare-dsh-compat.mjs';

test('兼容层仅为远程 Agent 闭合当前 step，其他会话仍闭合原始 step', async () => {
  const original = await readFile(new URL('../plugin/compat/agent-loop.original.mjs', import.meta.url));
  const emitted = await readFile(new URL('../plugin/compat/agent-loop.mjs', import.meta.url));
  const provenance = JSON.parse(await readFile(new URL('../plugin/compat/provenance.json', import.meta.url), 'utf8'));
  assert.deepEqual(adaptAgentLoop(original, provenance.officialImports), emitted);
  const altered = Buffer.from(original);
  altered[0] ^= 1;
  assert.throws(() => adaptAgentLoop(altered, provenance.officialImports), /SHA-256/);

  const source = emitted.toString('utf8');
  const begin = '/* bridge-step-end-start */';
  const finish = '/* bridge-step-end-finish */';
  assert.equal(source.split(begin).length, 2);
  assert.equal(source.split(finish).length, 2);
  const body = source.slice(source.indexOf(begin) + begin.length, source.indexOf(finish));
  const close = new Function('turn', 'step', body);
  const calls = [];
  const agent = (preset, open) => ({
    session: { header: { agentPreset: preset }, append: (type, data) => calls.push({ type, data }) },
    phase: { kind: 'running', step: 4 },
    ...(open === undefined ? {} : { _bridgeStepOpen: open }),
  });

  const ordinary = agent('standard', false);
  close.call(ordinary, 2, 1);
  assert.deepEqual(calls.splice(0), [{ type: 'step/end', data: { turn: 2, step: 1 } }]);
  const remote = agent('claude-sdk-remote');
  close.call(remote, 2, 1);
  assert.deepEqual(calls.splice(0), [{ type: 'step/end', data: { turn: 2, step: 4 } }]);
  assert.equal(remote._bridgeStepOpen, false);
  close.call(remote, 2, 1);
  assert.deepEqual(calls, []);
});
