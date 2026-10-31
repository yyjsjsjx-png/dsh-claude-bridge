import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
test('实际 rc5：标准 bundle 的相对组件路径、版本门禁和浏览器元数据可被原生加载', { skip: !native }, async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const dir = join(process.env.DSH_CLAUDE_BRIDGE_RESOURCES, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot')
  const boot = await import(pathToFileURL(join(dir, 'lib/index.js')).href)
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(boot.evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.5'), undefined)
  assert.ok(boot.evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.6'))
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
