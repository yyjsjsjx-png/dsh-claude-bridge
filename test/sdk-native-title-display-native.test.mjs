import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { installRemoteNativeTitles } from '../plugin/remote-native-titles.mjs'
import { strictSession } from './fixtures/native-persistence.mjs'

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
test('实际rc5：SDK标题与迟到fallback竞争、手动固定、安装前pending及普通标题隔离', { skip: !native, timeout: 10000 }, async t => {
  const { Context } = await import(resolveDshModule('@deepseek-ai/cordis'))
  const { LlmAdapter, createUserMessage } = await import(resolveDshModule('@deepseek-ai/dsh-llm'))
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'))
  const official = async name => {
    const module = await import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
    return module.default ?? module
  }
  const { normalizeSessionTitle } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-title')).href)
  const directory = await mkdtemp(join(tmpdir(), 'bridge-sdk-title-'))
  const ctx = new Context()
  let titles
  t.after(async () => { titles?.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-llm']) await ctx.plugin(await official(name), {})
  await ctx.plugin(await official('dsh-session-persistence-jsonl'), { root: join(directory, 'sessions') })
  await ctx.plugin(await official('dsh-session-title'), { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
  let ordinaryCalls = 0
  class Ordinary extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id } }
    async *stream() {
      ordinaryCalls++
      yield { type: 'text-delta', index: 0, text: '普通原生标题' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['ordinary'], new Ordinary())
  await ctx.plugin(await official('dsh-session-title-first-prompt-llm'), { provider: 'ordinary', model: 'fixture',
    targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 128, timeoutMs: 1000 })
  const create = (id, preset) => {
    const session = ctx.sessions.create(id, { meta: { agentPreset: preset, cwd: directory, delegationDepth: 0 } })
    session.append('turn/start', { turn: 1 }); return session
  }
  const prompt = session => session.append('user/message', createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: 'https://synthetic.invalid 请整理测试任务' }] }), { surfaceOp: 'append' })
  const header = (session, provider) => session.append('request/header', { reason: 'initial', header: {
    config: { provider, model: provider === 'ordinary' ? 'fixture' : 'haiku' } } })
  // Reproduce an actual native pending title before the remote seam exists.
  const pending = create('pending-remote', 'claude-sdk-remote')
  header(pending, 'claude-sdk-remote'); prompt(pending)
  const methods = ['onUserMessage', 'onRequestHeader', 'onMainRequest', 'refresh']
  const owner = ctx.sessionTitle[Symbol.for('cordis.original')]
  const originals = methods.map(name => owner[name])
  const codes = []
  titles = installRemoteNativeTitles(ctx, { normalizeSessionTitle, report: code => codes.push(code) })
  header(pending, 'claude-sdk-remote')
  await delay(10); assert.equal(ordinaryCalls, 0)
  const remote = create('remote-title', 'claude-sdk-remote')
  header(remote, 'claude-sdk-remote'); prompt(remote)
  assert.equal(titles.sync(remote, 'SDK 原生标题'), true)
  await delay(10)
  assert.equal(ctx.sessionTitle.get(remote).title, 'SDK 原生标题')
  assert.deepEqual(ctx.sessionTitle.get(remote).source, { kind: 'provider', provider: 'claude-bridge-sdk-title' })
  assert.equal(titles.sync(remote, 'SDK 原生标题'), false)
  ctx.sessionTitle.rename(remote, '手动固定')
  assert.equal(titles.sync(remote, '后来的SDK标题'), false)
  assert.equal((await ctx.sessionTitle.refresh(remote)).title, '手动固定')
  assert.equal(ordinaryCalls, 0)
  await strictSession(remote)
  const ordinary = create('ordinary-title', 'standard')
  prompt(ordinary); header(ordinary, 'ordinary')
  const end = Date.now() + 3000
  while (ctx.sessionTitle.get(ordinary)?.source.kind !== 'provider') {
    if (Date.now() > end) assert.fail('普通原生标题未完成')
    await delay(5)
  }
  assert.equal(ctx.sessionTitle.get(ordinary).title, '普通原生标题')
  assert.equal(ordinaryCalls, 1)
  assert.equal(titles.sync(ordinary, 'SDK 不应覆盖普通'), false)
  assert.deepEqual(codes, [])
  titles.dispose()
  methods.forEach((name, index) => assert.equal(owner[name], originals[index]))
  const restored = create('restored-remote', 'claude-sdk-remote')
  prompt(restored); header(restored, 'claude-sdk-remote')
  while (ctx.sessionTitle.get(restored)?.source.kind !== 'provider') {
    if (Date.now() > end) assert.fail('卸载后原生标题路径未恢复')
    await delay(5)
  }
  assert.equal(ordinaryCalls, 2)
  assert.equal(ctx.sessionTitle.get(restored).title, '普通原生标题')
})
