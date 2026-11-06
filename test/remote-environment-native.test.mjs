import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs';
import { installRemoteEnvironmentContext } from '../plugin/remote-environment.mjs';
import { CLAUDE_PRESET } from '../plugin/policy.mjs';

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES);
const environmentName = 'claude-bridge:client-environment';
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

async function fixture(t) {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'dsh-remote-environment-'));
  const project = join(directory, 'project'), subdir = join(project, 'subdir');
  await mkdir(subdir, { recursive: true });
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'));
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
  const [{ Context }, { createScope, scopeOf }, { Session, SESSION_FORMAT_VERSION }, prompt]
    = await Promise.all([load('cordis'), load('dsh-scope'), load('dsh-session'), load('dsh-system-prompt')]);
  const ctx = new Context(), scopes = [];
  t.after(async () => {
    try {
      for (const scope of scopes.reverse()) await scope.dispose();
      await ctx.fiber.dispose();
    } finally {
      if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('dsh-remote-environment-')) {
        throw new Error('测试目录归属无效');
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  for (const [name, config] of [['dsh-system-prompt', {}], ['dsh-session-projection', {}],
    ['dsh-fs-local', { cwd: project }], ['dsh-working-directory', { defaultDirectory: project }]]) {
    const module = await load(name);
    await ctx.plugin(module.default ?? module, config);
  }
  ctx.systemPrompt.section({ name: 'synthetic-global-user-rules', order: 1, text: 'SYNTHETIC_USER_RULES_REMAIN' });
  const generation = {}, remote = createScope(ctx, generation);
  scopes.push(remote);
  let nextId = 0;
  function agent(ordinary = false) {
    const key = { id: `environment-agent-${++nextId}` };
    const scope = createScope(ctx, key, ordinary ? undefined : { parent: generation });
    scopes.push(scope);
    key.ctx = scope.ctx;
    key.session = Session.create(key.id, undefined, { id: key.id, version: SESSION_FORMAT_VERSION,
      createdAt: 0, delegationDepth: 0, isSeeded: false, agentPreset: ordinary ? 'standard' : CLAUDE_PRESET, cwd: project });
    return key;
  }
  const context = agent => ({ scope: agent, agent, signal: new AbortController().signal });
  const assemble = agent => ctx.systemPrompt.assemble(context(agent));
  const mount = () => remote.ctx.plugin({ name: 'synthetic-remote-environment', inject: ['systemPrompt', 'workingDirectory'], apply(inner) {
    installRemoteEnvironmentContext(inner, { scope: scopeOf(inner), shell: 'pwsh' });
  } });
  return { ctx, remote, prompt, project, subdir, agent, context, assemble, mount };
}

test('实际原生动态客户端环境：目录变化与续步刷新不改变系统提示hash，普通作用域及卸载保持',
  { skip: !native, timeout: 30000 }, async t => {
    const f = await fixture(t), remote = f.agent(), ordinary = f.agent(true);
    const beforeRemote = await f.assemble(remote), beforeOrdinary = await f.assemble(ordinary);
    const systemPrompt = f.prompt.renderPrompt(beforeRemote), beforeHash = sha256(systemPrompt);
    const mounted = f.mount();
    await mounted;
    const initial = await f.assemble(remote);
    const index = initial.contexts.findIndex(row => row.name === 'working-directory:current');
    assert.ok(index >= 0);
    assert.equal(initial.contexts[index + 1].name, environmentName);
    const initialText = initial.contexts[index + 1].text;
    assert.ok(initialText.includes(`初始项目目录（会话创建时）：${JSON.stringify(f.project)}`));
    assert.ok(initialText.includes(`当前 DSH 工具工作目录：${JSON.stringify(f.project)}`));
    assert.match(initialText, /SDK 进程与会话存储环境/);
    assert.equal(f.prompt.renderPrompt(initial), systemPrompt);
    assert.equal(sha256(f.prompt.renderPrompt(initial)), beforeHash);
    assert.deepEqual(await f.assemble(ordinary), beforeOrdinary);
    const global = await f.ctx.systemPrompt.assemble();
    assert.equal(global.contexts.some(row => row.name === environmentName), false);

    remote.session.append('working-directory/change', { cwd: f.subdir });
    const refreshed = f.ctx.systemPrompt.refreshContext(initial, f.context(remote));
    const refreshedText = refreshed.contexts.find(row => row.name === environmentName).text;
    assert.notEqual(refreshedText, initialText);
    assert.ok(refreshedText.includes(`初始项目目录（会话创建时）：${JSON.stringify(f.project)}`));
    assert.ok(refreshedText.includes(`当前 DSH 工具工作目录：${JSON.stringify(f.subdir)}`));
    assert.equal(remote.session.header.cwd, f.project);
    assert.equal(sha256(f.prompt.renderPrompt(refreshed)), beforeHash);
    const restored = f.ctx.systemPrompt.refreshContext({ ...initial, contexts: [] }, f.context(remote));
    assert.equal(restored.contexts.find(row => row.name === environmentName).text, refreshedText);

    const suppressed = remote.ctx.plugin({ name: 'synthetic-context-suppression', inject: ['systemPrompt'], apply(inner) {
      inner.systemPrompt.suppressRuntimeContext();
    } });
    await suppressed;
    const required = await f.assemble(remote);
    assert.equal(required.contexts.find(row => row.name === environmentName).text, refreshedText);
    assert.equal(sha256(f.prompt.renderPrompt(required)), beforeHash);
    await suppressed.dispose();

    await mounted.dispose();
    const after = await f.assemble(remote);
    assert.equal(after.contexts.some(row => row.name === environmentName), false);
    assert.equal(sha256(f.prompt.renderPrompt(after)), beforeHash);
    assert.deepEqual(await f.assemble(ordinary), beforeOrdinary);
  });
