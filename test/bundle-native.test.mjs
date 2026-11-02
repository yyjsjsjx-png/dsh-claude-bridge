import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { HOST_FUNCTIONS, assertHostContract } from '../plugin/compat/host-contract.mjs'
import { assertSessionRestore } from '../plugin/compat/session-restore-probe.mjs'

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)

test('实际 rc5：严格恢复探针验证完整合成工具回合，损坏生命周期或编码行为明确阻断', { skip: !native }, async t => {
  const { resolveDshModule } = await import('../plugin/compat/resolve-dsh-module.mjs')
  const modules = Object.fromEntries(await Promise.all(Object.keys(HOST_FUNCTIONS)
    .map(async name => [name, await import(resolveDshModule(name))])))
  assert.deepEqual(assertHostContract(modules, '0.2.1-rc.5'), [
    { id: 'host-interfaces', evidence: 'interface', status: 'passed' },
    { id: 'session-protocol', evidence: 'synthetic', status: 'passed' },
    { id: 'session-restore', evidence: 'synthetic', status: 'passed' },
  ])
  const codecName = '@deepseek-ai/dsh-session-format-v3-to-v4'
  const catalogName = '@deepseek-ai/dsh-session-format-catalog'
  const codec = modules[codecName].releasedV4SessionFormatCodec
  await t.test('真实 strict/current 拒绝与 assistant 声明不符的工具调用', () => {
    const broken = { ...modules, [codecName]: { releasedV4SessionFormatCodec: { ...codec,
      encodeEvent(event) {
        return codec.encodeEvent(event.type === 'tool/call'
          ? { ...event, data: { ...event.data, callId: 'unadvertised-probe-call' } } : event)
      },
    } } }
    assert.throws(() => assertSessionRestore(broken),
      /tool\/call unadvertised-probe-call has no advertised tool lifecycle/)
    assert.throws(() => assertHostContract(broken, '0.2.1-rc.5'), error =>
      error.code === 'DSH_API_INCOMPATIBLE' && /原生会话严格恢复检查失败/u.test(error.message))
  })
  await t.test('codec 和 catalog 的行为失败不回显原始异常', () => {
    const sensitive = 'UNTRUSTED_PROBE_EXCEPTION'
    const reject = () => { throw new Error(sensitive) }
    for (const replacements of [
      { [codecName]: { releasedV4SessionFormatCodec: { ...codec, encodeHeader: reject } } },
      { [catalogName]: { sessionFormatCatalog: { createRestore: reject } } },
      { [catalogName]: { sessionFormatCatalog: { createRestore: () => ({}) } } },
      { [catalogName]: { sessionFormatCatalog: { createRestore: () => ({ decodeRow() {}, finish: () => ({}) }) } } },
    ]) assert.throws(() => assertHostContract({ ...modules, ...replacements }, '0.2.1-rc.5'), error => {
      assert.equal(error.code, 'DSH_API_INCOMPATIBLE')
      assert.match(error.message, /原生会话严格恢复检查失败/u)
      assert.equal(error.message.includes(sensitive), false)
      return true
    })
  })
})

test('实际 rc5：标准 bundle 接受不同版本号并检查实际 Host 能力', { skip: !native }, async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const dir = join(process.env.DSH_CLAUDE_BRIDGE_RESOURCES, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot')
  const boot = await import(pathToFileURL(join(dir, 'lib/index.js')).href)
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  for (const version of ['0.2.1-rc.5', '0.2.1-rc.6', '0.2.2', '0.3.0', '1.0.0-beta.1']) {
    assert.equal(boot.evaluatePluginCompatibility(manifest, {}, version), undefined)
  }
  const { assertDshCompatibility } = await import('../plugin/compat/resolve-dsh-module.mjs')
  const compatibility = await assertDshCompatibility()
  assert.equal(compatibility.status, 'compatible')
  const hostManifest = JSON.parse(await readFile(join(process.env.DSH_CLAUDE_BRIDGE_RESOURCES,
    'app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-loop/package.json'), 'utf8'))
  assert.equal(compatibility.version, hostManifest.version)
  await import('../plugin/compat/agent-loop.mjs')
  const files = boot.bundlePatchPaths(root, manifest.dsh.bundle)
  const patches = files.flatMap(path => boot.loadOverlayPatches('dsh', path))
  const rows = boot.composeEntries([patches.filter(patch => patch.insert)])
  assert.equal(rows.length, 5)
  const source = { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop', config: {
    agents: [{ id: 'preserved', provider: 'ordinary', model: 'fixture' }], maxParallelToolCalls: 3,
  } }
  const composed = boot.composeEntries([[{ insert: [source] }], patches])
  const inherited = composed.find(row => row.id === 'agent-loop')
  assert.equal(inherited.disabled, true)
  assert.deepEqual(inherited.config, source.config)
  assert.deepEqual(composed.find(row => row.id === 'claude-agent-loop').config, { sourceEntry: 'agent-loop' })
  for (const row of rows) {
    assert.ok(row.name === manifest.name || row.name.startsWith(manifest.name + '/'))
    await access(boot.resolvePluginResource(row.name, pathToFileURL(join(root, 'package.json')).href))
  }
  assert.equal(patches.some(row => ['session-controller', 'agent-preset-registry'].includes(row.id) && row.disabled), false)
  assert.equal(rows.some(row => row.id === 'claude-session-client'), false)
  for (const id of ['claude-bridge-ui']) {
    const row = rows.find(item => item.id === id)
    const meta = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    assert.equal(meta.dsh.client.platform, 'web')
    assert.equal(typeof meta.exports['./client'], 'string')
    await access(join(root, meta.exports['./client']))
  }
})

test('实际 rc5：包及五组件使用原生展示信息，客户端只由界面组件加载', { skip: !native }, async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const base = join(process.env.DSH_CLAUDE_BRIDGE_RESOURCES, 'app.asar/dsh/node_modules/@deepseek-ai')
  const boot = await import(pathToFileURL(join(base, 'dsh-app-boot/lib/index.js')).href)
  const { ClientModuleRegistry } = await import(pathToFileURL(join(base, 'dsh-client-modules/lib/index.js')).href)
  const { ModuleLoader } = await import(pathToFileURL(join(base, 'cordis-plugin-loader/lib/index.js')).href)
  let localeEntry
  vm.runInNewContext(await readFile(join(base, 'dsh-client-locale/lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: entry => { localeEntry = entry } } },
  })
  const { LocaleRuntime } = localeEntry.factory(() => ({}))
  const locale = new LocaleRuntime({ emit: () => {} }, undefined, { languages: ['zh-CN'], preference: 'zh' })
  assert.equal(locale.getSnapshot().active, 'zh')
  const parent = pathToFileURL(join(root, 'package.json')).href
  const rows = boot.composeEntries([boot.loadOverlayPatches('dsh', join(root, 'patches/bundle.patch.yml')).filter(row => row.insert)])
  const registry = Object.create(ClientModuleRegistry.prototype)
  Object.defineProperty(registry, 'ctx', { value: { loader: { internal: ModuleLoader.fromInternal() } } })
  registry.pkgMeta = new Map()
  for (const row of rows) {
    const meta = boot.readPluginMeta(row.name, parent)
    assert.equal(meta.error, undefined)
    assert.ok(meta.title['zh-cn']?.length)
    assert.ok(meta.description['zh-cn']?.length)
    assert.ok(meta.title.en?.length)
    const chinese = JSON.parse(await readFile(boot.resolvePluginResource(`${row.name}/locale/zh-CN.json`, parent), 'utf8')).meta
    assert.equal(locale.resolveText(meta.title), chinese.title)
    assert.equal(locale.resolveText(meta.description), chinese.description)
    locale.setLocale('en')
    assert.equal(locale.resolveText(meta.title), meta.title.en)
    assert.equal(locale.resolveText(meta.description), meta.description.en)
    locale.setLocale('zh')
    assert.match(meta.icon, /^data:image\/svg\+xml;base64,/)
    const client = registry.resolveMeta(row.name, parent)
    const originalUrl = pathToFileURL(boot.resolvePluginResource(row.name, parent)).href
    const directClient = registry.resolveMeta(originalUrl, parent)
    if (row.id === 'claude-bridge-ui') {
      assert.equal(client.packageName, 'dsh-claude-bridge')
      assert.equal(resolve(client.meta.clientPath), join(root, 'plugin/ui/client.js'))
      assert.equal(directClient.packageName, client.packageName)
    } else {
      assert.equal(client, null)
      assert.equal(directClient, null)
    }
  }
})

test('未来兼容模拟：沿用实际接口的新版包、入口和预设可加载，破坏性接口被拒绝', { skip: !native }, async () => {
  const { HOST_FUNCTIONS } = await import('../plugin/compat/host-contract.mjs')
  const resolver = await import('../plugin/compat/resolve-dsh-module.mjs')
  const originalResources = process.env.DSH_CLAUDE_BRIDGE_RESOURCES
  const targets = Object.fromEntries(Object.keys(HOST_FUNCTIONS).map(name => [name, resolver.resolveDshModule(name)]))
  const standard = resolver.readShippedStandardPreset()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-native-compat-'))
  try {
    // An unpacked app keeps the fixture writable under Electron's ASAR filesystem.
    const base = join(directory, 'app/dsh/node_modules')
    const version = '0.3.0'
    const writePackage = async (name, source, filename = 'next.mjs') => {
      const dir = join(base, name)
      await mkdir(join(dir, 'lib'), { recursive: true })
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, type: 'module',
        exports: { '.': { node: { import: `./lib/${filename}` } } } }))
      await writeFile(join(dir, 'lib', filename), source)
    }
    for (const [name, url] of Object.entries(targets)) {
      const module = await import(url)
      await writePackage(name, `export * from ${JSON.stringify(url)};\n`
        + (Object.hasOwn(module, 'default') ? `export { default } from ${JSON.stringify(url)};\n` : '')
        + 'export const newOptionalFeature = true;\n')
    }
    // The routed factory now requires the installation's real AgentLoop API;
    // the compatible future-package shim above preserves it without a hash lock.
    await writePackage('@deepseek-ai/dsh-web-app', 'export {};\n')
    await mkdir(join(base, '@deepseek-ai/dsh-web-app/presets'))
    const content = `# Compatible future preset change\n${standard.content}`
    await writeFile(join(base, '@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), content)
    process.env.DSH_CLAUDE_BRIDGE_RESOURCES = directory
    const result = await resolver.assertDshCompatibility()
    assert.equal(result.version, version)
    assert.equal(result.status, 'compatible')
    const { Service, loadYaml, entryListSchema } = await import('../plugin/compat/runtime.mjs')
    const { createRemoteClaudePreset } = await import('../plugin/preset.mjs')
    const patches = loadYaml(resolver.readShippedStandardPreset().content, { schema: entryListSchema })
    const standardConfig = patches.flatMap(row => row.insert ?? []).find(row => row.id === 'preset-standard').config
    standardConfig.plugins.push({ id: 'future-tool', name: 'future-tool' })
    assert.ok(createRemoteClaudePreset(standardConfig).plugins.some(row => row.id === 'future-tool'))
    const futureContent = content.replace(/^(\s*)- id: tool-plugin-market/m,
      '$1- id: future-tool\n$1  name: future-tool\n$1- id: tool-plugin-market')
    assert.notEqual(futureContent, content)
    await writeFile(join(base, '@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), futureContent)
    const { default: PresetService } = await import('../plugin/preset-service.mjs')
    let registeredPreset
    const presetScope = new PresetService({ extend: () => ({ agentPresets: {
      register: async preset => { registeredPreset = preset; assert.equal(preset.id, 'claude-sdk-remote'); return () => {} },
    } }) })
    const registration = presetScope[Service.init]()
    assert.equal((await registration.next()).done, false)
    assert.equal(registeredPreset.plugins[0].config.mode, 'full')
    assert.equal(registeredPreset.plugins[0].config.plugins.some(row => row.id === 'future-tool'), true)
    await registration.return()

    // A removed required export is a breaking change even with the same version number.
    await writePackage('@deepseek-ai/dsh-scope', 'export const unrelated = true;\n', 'breaking.mjs')
    const fresh = await import(`../plugin/compat/resolve-dsh-module.mjs?breaking=${Date.now()}`)
    await assert.rejects(fresh.assertDshCompatibility(), error =>
      error.code === 'DSH_API_INCOMPATIBLE' && /createScope/u.test(error.message))

    await writeFile(join(base, '@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), '- insert: []\n')
    // An invalid declaration falls back to the equal owned full composition.
    const independent = presetScope[Service.init]()
    assert.equal((await independent.next()).done, false)
    assert.equal(registeredPreset.plugins[0].config.mode, 'full')
    assert.deepEqual(registeredPreset.plugins[0].config.reasons, [])
    assert.equal(registeredPreset.plugins[0].config.noticeReasons.length, 1)
    assert.ok(registeredPreset.plugins[0].config.plugins.some(row => row.id === 'tool-pwsh'))
    assert.equal(registeredPreset.plugins[0].config.plugins.some(row => row.id === 'future-tool'), false)
    await independent.return()
  } finally {
    process.env.DSH_CLAUDE_BRIDGE_RESOURCES = originalResources
    assert.equal(dirname(directory), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('dsh-bridge-native-compat-'))
    await rm(directory, { recursive: true, force: true })
  }
})
