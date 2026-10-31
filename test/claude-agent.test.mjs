import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeLoopAgent } from '../plugin/claude-agent.mjs';

test('远程子代理在创建前拒绝跨引擎模型，根会话和普通会话不受影响', () => {
  let constructed = 0;
  class Base { constructor() { constructed++; } }
  const session = (preset, origin) => ({ header: { agentPreset: preset, ...(origin ? { origin } : {}) } });
  createClaudeLoopAgent(Base, {}, 'ordinary', { provider: 'dsh', model: 'x' }, session('standard'));
  // rc.5 创建根 Agent 时的 options 可能是之前的默认模型，真正选型随后持久化。
  createClaudeLoopAgent(Base, {}, 'root', { provider: 'dsh', model: 'x' }, session('claude-sdk-remote'));
  createClaudeLoopAgent(Base, {}, 'child', { provider: 'claude-sdk-remote', model: 'haiku' },
    session('claude-sdk-remote', 'subagent'));
  assert.equal(constructed, 3);
  assert.throws(() => createClaudeLoopAgent(Base, {}, 'bad', { provider: 'dsh', model: 'x' },
    session('claude-sdk-remote', 'subagent')), error => error.code === 'SUBAGENT_ENGINE_MISMATCH');
  assert.throws(() => createClaudeLoopAgent(Base, {}, 'bad', { provider: 'claude-sdk-remote' },
    session('claude-sdk-remote', 'subagent')), error => error.code === 'SUBAGENT_ENGINE_MISMATCH');
  assert.equal(constructed, 3);
});
