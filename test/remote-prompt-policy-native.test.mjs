import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { REMOTE_PROMPT_POLICY, applyRemotePromptPolicy } from '../src/remote-prompt-policy.mjs'

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
const scaffold = ['harness:identity', 'harness:source', 'app:web-surface']
const count = entries => entries.filter(entry => scaffold.includes(entry.name)).length

// Only a fresh in-memory Session is used. No persisted session store, user
// instructions, SDK, provider credentials, HTTP server, or model is loaded.
test('实际原生提示策略：已知原文、scoped自定义和必需cwd在两版接口中保持边界',
  { skip: !native, timeout: 15000 }, async t => {
    const temporaryRoot = await realpath(tmpdir())
    const directory = await mkdtemp(join(temporaryRoot, 'dsh-remote-prompt-policy-'))
    const { Context } = await import(resolveDshModule('@deepseek-ai/cordis'))
    const { Session, SESSION_FORMAT_VERSION } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
    const { createScope } = await import(resolveDshModule('@deepseek-ai/dsh-scope'))
    const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'))
    const official = async name => {
      const module = await import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
      return module.default ?? module
    }
    const ctx = new Context()
    t.after(async () => {
      await ctx.fiber.dispose()
      assert.equal(dirname(resolve(directory)), temporaryRoot)
      assert.ok(basename(directory).startsWith('dsh-remote-prompt-policy-'))
      await rm(directory, { recursive: true, force: true })
    })
    await ctx.plugin(await official('dsh-system-prompt'), { personaPrefix: 'synthetic global persona' })
    await ctx.plugin(await official('dsh-session-projection'), {})
    await ctx.plugin(await official('dsh-tools'), {})
    if (typeof ctx.tools.setExecutor === 'function') await ctx.plugin(await official('dsh-tool-executor-native'), {})
    await ctx.plugin(await official('dsh-fs-local'), { cwd: directory })
    await ctx.plugin(await official('dsh-working-directory'), { defaultDirectory: directory })
    ctx.provide('webApp', { getAdvertisedUrl: () => 'http://127.0.0.1:12345/' })
    await ctx.plugin(await official('dsh-harness-dev-context'), {})
    const id = 'remote-prompt-policy-fixture'
    const session = Session.create(id, undefined, { id, version: SESSION_FORMAT_VERSION, createdAt: 0,
      isSeeded: false, agentPreset: 'claude-sdk-remote', cwd: directory })
    const agent = { id, session, inject() { assert.fail('已存在的临时cwd不应触发恢复通知') } }
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    let scopedPrompt
    await scope.ctx.inject(['systemPrompt'], inner => { scopedPrompt = inner.systemPrompt })
    const persona = 'You are a coding agent powered by Claude through the remote Claude Agent SDK.'
    const suffix = '用户自定义 suffix：必须保持。'
    await scope.ctx.plugin(await official('dsh-persona'), { prefix: persona, suffix })
    ctx.tools.register({ name: 'synthetic_prompt_tool', description: '保留原生工具schema；此工具不可执行。',
      parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute() { assert.fail('提示组装不得执行工具') },
    })
    ctx.systemPrompt.section({ name: 'tool:synthetic_prompt_tool', order: 4000,
      text: '保留审批、取消、超时及未知副作用不得重试；不可绕过禁用工具。' })
    const { renderPrompt } = await import(resolveDshModule('@deepseek-ai/dsh-system-prompt'))
    const assemble = () => ctx.systemPrompt.assemble({ agent, scope: agent, signal: new AbortController().signal })
    const cwdOf = assembly => assembly.contexts.find(entry => entry.name === 'working-directory:current')

    await t.test('真实原生3个section和2个context精确命中，legacy原样，persona及工具保留', async () => {
      const original = await assemble()
      assert.equal(count(original.sections), 3)
      assert.equal(count(original.contexts), 2)
      assert.equal(applyRemotePromptPolicy(original), original)
      assert.equal(applyRemotePromptPolicy(original, 'legacy'), original)
      assert.ok(original.sections.some(entry => entry.text === persona))
      assert.ok(original.sections.some(entry => entry.text === suffix))
      assert.equal(renderPrompt(original).includes('synthetic global persona'), false)
      assert.equal(original.tools.length, 1)
      assert.equal(original.tools[0].name, 'synthetic_prompt_tool')
      const rendered = renderPrompt(original)
      const filtered = applyRemotePromptPolicy(original, REMOTE_PROMPT_POLICY)
      assert.equal(count(filtered.sections), 0)
      assert.equal(count(filtered.contexts), 0)
      assert.equal(filtered.tools, original.tools)
      assert.equal(filtered.variables, original.variables)
      assert.equal(cwdOf(filtered), cwdOf(original))
      assert.equal(cwdOf(filtered).text, `Current working directory: ${JSON.stringify(directory)}.`)
      assert.ok(filtered.sections.some(entry => entry.text === persona))
      assert.ok(filtered.sections.some(entry => entry.text === suffix))
      assert.ok(renderPrompt(filtered).includes('不可绕过禁用工具'))
      assert.equal(renderPrompt(original), rendered)
    })

    await t.test('原生可选runtime抑制不移除必需cwd，新策略亦完整保留它', async () => {
      const dispose = scopedPrompt.suppressRuntimeContext()
      try {
        const original = await assemble()
        assert.equal(count(original.contexts), 0)
        assert.equal(original.contexts.length, 1)
        assert.equal(cwdOf(original).text, `Current working directory: ${JSON.stringify(directory)}.`)
        const filtered = applyRemotePromptPolicy(original, REMOTE_PROMPT_POLICY)
        assert.deepEqual(filtered.contexts, original.contexts)
        assert.equal(filtered.contexts, original.contexts)
        assert.equal(filtered.tools, original.tools)
      } finally { dispose() }
    })

    await t.test('原生scoped同名自定义覆盖保持，不能仅按section/context名字删除', async () => {
      const disposers = []
      for (const name of scaffold) disposers.push(scopedPrompt.section({ name, order: 100,
        interpolate: false, text: `用户自定义 ${name}：必须完整保留。` }))
      for (const name of scaffold.slice(1)) disposers.push(scopedPrompt.context({ name, order: 100,
        interpolate: false, text: `用户自定义运行时 ${name}：必须完整保留。` }))
      try {
        const original = await assemble()
        assert.equal(count(original.sections), 3)
        assert.equal(count(original.contexts), 2)
        assert.ok(original.sections.filter(entry => scaffold.includes(entry.name)).every(entry => entry.text.startsWith('用户自定义 ')))
        assert.equal(applyRemotePromptPolicy(original, REMOTE_PROMPT_POLICY), original)
        assert.equal(cwdOf(original).text, `Current working directory: ${JSON.stringify(directory)}.`)
      } finally { for (const dispose of disposers.reverse()) dispose() }
    })
  })
