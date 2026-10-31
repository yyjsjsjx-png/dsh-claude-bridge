import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
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
  assert.equal(rows.length, 7)
  for (const row of rows) {
    assert.ok(row.name.startsWith(pathToFileURL(resolve(root)).href + '/'))
    await access(fileURLToPath(row.name))
  }
  for (const id of ['claude-bridge-ui', 'claude-session-client']) {
    const row = rows.find(item => item.id === id)
    const meta = JSON.parse(await readFile(join(dirname(fileURLToPath(row.name)), 'package.json'), 'utf8'))
    assert.equal(meta.dsh.client.platform, 'web')
    assert.equal(typeof meta.exports['./client'], 'string')
    await access(join(dirname(fileURLToPath(row.name)), meta.exports['./client']))
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
    await writePackage('@deepseek-ai/dsh-agent-loop', '// Changed upstream implementation; bridge uses its own adapted loop.\n')
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
    const { default: PresetService } = await import('../plugin/preset-service.mjs')
    const presetScope = new PresetService({ extend: () => ({ agentPresets: {
      register: async preset => { assert.equal(preset.id, 'claude-sdk-remote'); return () => {} },
    } }) })
    const registration = presetScope[Service.init]()
    assert.equal((await registration.next()).done, false)
    await registration.return()

    // A removed required export is a breaking change even with the same version number.
    await writePackage('@deepseek-ai/dsh-scope', 'export const unrelated = true;\n', 'breaking.mjs')
    const fresh = await import(`../plugin/compat/resolve-dsh-module.mjs?breaking=${Date.now()}`)
    await assert.rejects(fresh.assertDshCompatibility(), error =>
      error.code === 'DSH_API_INCOMPATIBLE' && /createScope/u.test(error.message))

    await writeFile(join(base, '@deepseek-ai/dsh-web-app/presets/standard.patch.yml'), '- insert: []\n')
    await assert.rejects(presetScope[Service.init]().next(), error =>
      error.code === 'DSH_API_INCOMPATIBLE' && /标准预设结构不兼容/u.test(error.message))
  } finally {
    process.env.DSH_CLAUDE_BRIDGE_RESOURCES = originalResources
    assert.equal(dirname(directory), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('dsh-bridge-native-compat-'))
    await rm(directory, { recursive: true, force: true })
  }
})
