import test from 'node:test'
import assert from 'node:assert/strict'
import { REMOTE_PROMPT_POLICY, applyRemotePromptPolicy } from '../src/remote-prompt-policy.mjs'

// Independent fixtures from the reviewed rc.5 / 0.2.2-rc.1 first-party sources.
const identity = { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' }
const source = { name: 'harness:source', interpolate: false,
  text: 'The runtime context names the DeepSeek Harness implementation checkout. '
    + 'The checkout location and current working directory are separate values and may differ; '
    + 'never infer the working directory from the checkout path. Use pwd to determine the current working directory. '
    + 'Use this checkout only to inspect or extend DSH itself.' }
const webGuidance = 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
  + 'The browser provides no implicit DOM, route, or screenshot context. '
  + 'The client-plugin HMR receiver is active, but client-plugin changes reload without a refresh only while '
  + '`pnpm run dev:web` is also running from this same checkout to rebuild their bundles; verify that watcher before promising automatic updates. '
  + 'Every other change — the apps/web shell and plain packages — requires rebuilding the affected Web artifacts and verifying this existing URL after a page refresh. '
  + 'Starting another server does not update this GUI. '
  + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
  + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'
const web = { name: 'app:web-surface', interpolate: false,
  text: `You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. ${webGuidance}` }
const path = String.raw`C:\synthetic-harness`, url = 'http://127.0.0.1:1234/'
const contexts = [
  { name: source.name, interpolate: false, text: `Current DeepSeek Harness implementation checkout: ${JSON.stringify(path)}.` },
  { name: web.name, interpolate: false, text: `Current DeepSeek Harness Web GUI URL: ${JSON.stringify(url)}.` },
]
const render = assembly => assembly.sections.map(section => section.text).join('\n\n')

test('缺省和显式 legacy 返回原 assembly，原文与引用保持不变', () => {
  const assembly = Object.freeze({ sections: Object.freeze([identity, source, web]), contexts })
  const before = render(assembly)
  for (const policy of [undefined, 'legacy']) {
    assert.equal(applyRemotePromptPolicy(assembly, policy), assembly)
    assert.equal(render(assembly), before)
  }
  assert.equal(applyRemotePromptPolicy(undefined), undefined)
})

test('未知显式策略明确失败，不按 falsy 值隐式改成 legacy', () => {
  assert.equal(REMOTE_PROMPT_POLICY, 'remote-v1')
  for (const policy of ['remote-v2', '', null, false, {}, 1]) {
    assert.throws(() => applyRemotePromptPolicy({ sections: [] }, policy), { code: 'REMOTE_PROMPT_POLICY_UNSUPPORTED' })
  }
})

test('remote-v1 只去除已核实的固定 section/context，保留 persona、必要规则与全部工具', () => {
  const kept = [
    { name: 'deployment:persona-prefix', text: 'You are a coding agent powered by Claude through the remote Claude Agent SDK.' },
    { name: 'deployment:persona-suffix', text: '用户自定义 suffix，不得改写。' },
    { name: 'user:instructions', text: source.text, origin: 'user' },
    { name: 'tool:pwsh', text: '审批/取消/超时必须传播；副作用未知不能自动重试。' },
    { name: 'tool:schedule', text: '仅用户明确授权时修改计划，rrule 参数必须符合原生约束。' },
    { name: 'tool:workflow', text: '仅在明确请求大规模编排时使用，保留深度限制。' },
    { name: 'claude-bridge:preset-capabilities', text: '关闭的工具不得调用或绕过。' },
    { name: 'skill-catalog', text: '<available_skills>保留技能目录</available_skills>' },
  ]
  const cwd = { name: 'working-directory', text: 'cwd: synthetic', required: true }
  const tools = [{ name: 'pwsh', description: '完整说明', parameters: { command: { type: 'string' } }, deferLoading: true }]
  const variables = { model: 'fixture', unknown: undefined }, extra = { untouched: true }
  const marker = Symbol('metadata'), assembly = { sections: [identity, source, web, ...kept],
    contexts: [...contexts, cwd], tools, variables, extra, [marker]: extra }
  Object.defineProperty(assembly, 'hidden', { value: extra })
  const before = JSON.stringify(assembly)
  Object.freeze(assembly.sections); Object.freeze(assembly.contexts); Object.freeze(assembly)
  const result = applyRemotePromptPolicy(assembly, REMOTE_PROMPT_POLICY)
  assert.deepEqual(result.sections, kept)
  assert.deepEqual(result.contexts, [cwd])
  kept.forEach((entry, index) => assert.equal(result.sections[index], entry))
  assert.equal(result.contexts[0], cwd)
  for (const field of ['tools', 'variables', 'extra', 'hidden']) assert.equal(result[field], assembly[field])
  assert.equal(result[marker], extra)
  assert.deepEqual(Object.getOwnPropertyDescriptor(result, 'hidden'), Object.getOwnPropertyDescriptor(assembly, 'hidden'))
  assert.equal(Object.getPrototypeOf(result), Object.getPrototypeOf(assembly))
  assert.equal(Object.isExtensible(result), false)
  assert.equal(JSON.stringify(assembly), before)
  assert.equal(applyRemotePromptPolicy(result, REMOTE_PROMPT_POLICY), result)
})

test('同名自定义、附加指令、不同原生签名均保留，不搜索或删改正文片段', () => {
  const custom = [
    { ...identity, text: `${identity.text}\n用户附加规则。` },
    { ...identity, text: '自定义身份。' },
    { ...identity, origin: 'user' },
    { ...source, text: `${source.text} Keep user-owned details.` },
    { ...source, interpolate: true },
    { name: source.name, text: source.text },
    { ...web, text: `用户引用：${web.text}` },
    { ...web, text: `${web.text}\n` },
  ]
  const customContexts = [
    { ...contexts[0], text: `${contexts[0].text} User text.` },
    { ...contexts[1], text: 'Current DeepSeek Harness Web GUI URL: "not a URL".' },
    { ...contexts[0], required: true },
    { ...contexts[1], interpolate: true },
    { name: 'user:instructions', text: contexts[0].text },
  ]
  const assembly = { sections: custom, contexts: customContexts }
  assert.equal(applyRemotePromptPolicy(assembly, REMOTE_PROMPT_POLICY), assembly)
  assert.deepEqual(assembly.sections, custom)
  assert.deepEqual(assembly.contexts, customContexts)
})

test('兼容已知旧值型段落，仅接受原生完整格式与 canonical JSON 路径/URL', () => {
  const legacySource = { ...source,
    text: `The DeepSeek Harness implementation checkout is at ${JSON.stringify(path)}. `
      + 'The checkout location and current working directory are separate values and may differ; '
      + 'never infer the working directory from this path. Use pwd to determine the current working directory. '
      + 'Use this checkout only to inspect or extend DSH itself.' }
  const legacyWeb = { ...web,
    text: `You are interacting with the user through the DeepSeek Harness Web GUI at ${JSON.stringify(url)}. ${webGuidance}` }
  const customSource = { ...legacySource, text: legacySource.text.replace(JSON.stringify(path), '"relative/path"') }
  const customWeb = { ...legacyWeb, text: `${legacyWeb.text} 用户追加要求。` }
  const assembly = { sections: [legacySource, legacyWeb, customSource, customWeb], contexts: [
    ...contexts,
    { ...contexts[0], text: 'Current DeepSeek Harness implementation checkout: "relative/path".' },
    { ...contexts[1], text: 'Current DeepSeek Harness Web GUI URL: "http:\\/\\/127.0.0.1:1234/".' },
  ] }
  const result = applyRemotePromptPolicy(assembly, REMOTE_PROMPT_POLICY)
  assert.deepEqual(result.sections, [customSource, customWeb])
  assert.deepEqual(result.contexts, assembly.contexts.slice(2))
})

test('无候选数组时原值返回，refresh的旧空数组和缺省列表不凭空改写', () => {
  const assembly = { sections: [], variables: { untouched: 'yes' } }
  assert.equal(applyRemotePromptPolicy(assembly, REMOTE_PROMPT_POLICY), assembly)
  assert.equal(Object.hasOwn(assembly, 'contexts'), false)
  for (const value of [null, undefined, [], { sections: 'opaque', contexts: null }]) {
    assert.equal(applyRemotePromptPolicy(value, REMOTE_PROMPT_POLICY), value)
  }
})
