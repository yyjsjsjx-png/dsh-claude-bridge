import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, sep } from 'node:path'
import { updatePlugin } from '../scripts/update-plugin.mjs'

const available = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)

test('实际 DSH 更新器：旧 GitHub 包缺少离线缓存时仍用具名本地链接更新并保留其他配置', { skip: !available }, async t => {
  const taskRoot = await mkdtemp(join(tmpdir(), 'dsh-bridge-offline-update-'))
  const previousHome = process.env.DSH_HOME
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    const contained = relative(resolve(tmpdir()), resolve(taskRoot))
    assert.ok(contained && contained !== '..' && !contained.startsWith(`..${sep}`))
    await rm(taskRoot, { recursive: true, force: true })
  })
  const source = join(taskRoot, 'candidate with spaces')
  const home = join(taskRoot, 'isolated home')
  const directory = join(home, 'profiles', 'desktop')
  const installed = join(directory, 'node_modules', 'dsh-claude-bridge')
  for (const dir of [join(source, 'plugin'), join(source, 'patches'), installed]) await mkdir(dir, { recursive: true })
  const candidate = { name: 'dsh-claude-bridge', version: '0.1.4-rc.2', private: true, type: 'module',
    main: './plugin/bundle.mjs', dsh: { bundle: { patch: './patches/bundle.patch.yml' } },
    engines: { node: '>=24.9', dsh: '*' } }
  await writeFile(join(source, 'package.json'), JSON.stringify(candidate))
  await writeFile(join(source, 'plugin/bundle.mjs'), 'export default []\n')
  await writeFile(join(source, 'patches/bundle.patch.yml'), '[]\n')
  const previous = { private: true, fixtureSetting: 'preserved', dependencies: { 'dsh-claude-bridge':
    'https://codeload.github.com/yyjsjsjx-png/dsh-claude-bridge/tar.gz/37a4c8245f04b6757ebaea57f9d015cf625f4bfa' } }
  const before = JSON.stringify(previous)
  await writeFile(join(directory, 'package.json'), before)
  await writeFile(join(installed, 'package.json'), JSON.stringify({ ...candidate, version: '0.1.3' }))
  await writeFile(join(directory, '.npmrc'), `store-dir=${join(taskRoot, 'empty store').replaceAll('\\', '/')}\n`)
  const result = await updatePlugin({ resources: process.env.DSH_CLAUDE_BRIDGE_RESOURCES, home, packageDirectory: source })
  assert.equal(result.updated, true)
  assert.equal(result.previousVersion, '0.1.3')
  assert.equal(result.version, candidate.version)
  assert.equal(await realpath(installed), await realpath(source))
  assert.equal(await readFile(join(result.backup, 'package.json'), 'utf8'), before)
  const after = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  assert.equal(after.fixtureSetting, previous.fixtureSetting)
  assert.match(after.dependencies['dsh-claude-bridge'], /^link:/)
  assert.deepEqual(result.history, { checked: 0, repaired: 0, changedRecords: 0 })
})
