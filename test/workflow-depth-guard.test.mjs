import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowDepthGuard } from '../plugin/workflow-depth-guard.mjs';
import { executeNativeTool } from './fixtures/native-tools.mjs';

const agent = (preset, durableDepth, runtimeDepth) => ({
  options: { subagentDepth: runtimeDepth },
  session: { header: { agentPreset: preset, delegationDepth: durableDepth } },
});

test('远程 workflow 不能绕过当前 DSH 深度上限', () => {
  let limit = 1;
  const guard = createWorkflowDepthGuard({
    subagents: { resolveMaxDepth: () => limit },
    delegationDepthOf: current => Math.max(current.options.subagentDepth ?? 0,
      current.session.header.delegationDepth ?? 0),
  });
  const workflow = current => guard({ name: 'workflow', agent: current });
  const root = agent('claude-sdk-remote', 0);
  const resumedChild = agent('claude-sdk-remote', 1, 0);
  assert.equal(workflow(root), undefined);
  assert.match(workflow(resumedChild), /深度上限/);
  assert.equal(workflow(agent('standard', 1)), undefined);
  assert.equal(guard({ name: 'subagent', agent: resumedChild }), undefined);
  limit = 0;
  assert.match(workflow(root), /深度上限/);
  limit = 2;
  assert.equal(workflow(resumedChild), undefined);
  assert.match(workflow(agent('claude-sdk-remote', 1, 2)), /深度上限/);
  limit = undefined;
  assert.match(workflow(root), /无法确认/);
});

test('安装版 DSH 工具管道在运行 workflow 前执行深度守卫', {
  skip: !(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES),
}, async () => {
  const { resolveDshModule } = await import('../plugin/compat/resolve-dsh-module.mjs');
  const { Context } = await import(resolveDshModule('@deepseek-ai/cordis'));
  const { default: SystemPrompt } = await import(resolveDshModule('@deepseek-ai/dsh-system-prompt'));
  const { default: ToolRuntime } = await import(resolveDshModule('@deepseek-ai/dsh-tools'));
  const { delegationDepthOf } = await import(resolveDshModule('@deepseek-ai/dsh-subagent'));
  const ctx = new Context();
  try {
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    if (typeof ctx.tools.setExecutor === 'function') {
      const { createRequire } = await import('node:module');
      const { pathToFileURL } = await import('node:url');
      const require = createRequire(resolveDshModule('@deepseek-ai/dsh-tools'));
      const NativeExecutor = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-executor-native')).href);
      await ctx.plugin(NativeExecutor.default ?? NativeExecutor, {});
    }
    let ran = 0;
    ctx.tools.register({ name: 'workflow', description: '测试',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { ran++; return 'executed'; } });
    ctx.tools.guard(createWorkflowDepthGuard({ subagents: { resolveMaxDepth: () => 1 }, delegationDepthOf }));
    const run = current => executeNativeTool(ctx, { name: 'workflow', callId: 'test', arguments: {},
      signal: new AbortController().signal, agent: current });
    const result = await run(agent('claude-sdk-remote', 1, 0));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /深度上限/);
    assert.equal(ran, 0);
    assert.equal((await run(agent('claude-sdk-remote', 0))).isError, false);
    assert.equal((await run(agent('standard', 1))).isError, false);
    assert.equal(ran, 2);
  } finally {
    await ctx.fiber.dispose();
  }
});
