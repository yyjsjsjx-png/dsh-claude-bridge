import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'

const native = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
const sourceId = 'subagent-model-selection-settings'
const sourceName = '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
const gateId = 'claude-subagent-settings-gate'
const gateService = 'claudeSubagentPolicyGate'

async function eventually(check) {
  const deadline = Date.now() + 5000
  let failure
  do {
    try { return check() } catch (error) { failure = error }
    await delay(20)
  } while (Date.now() < deadline)
  throw failure
}

test('实际Loader设置：原Entry动态编辑、配置热重载、冷重载及gate卸载不丢失设置归属',
  { skip: !native, timeout: 30000 }, async t => {
    // Windows runners may spell Temp with an 8.3 alias. Use one canonical
    // parent for creation and the strict cleanup ownership check.
    const temporaryRoot = await realpath(tmpdir())
    const home = await realpath(await mkdtemp(join(temporaryRoot, 'dsh-subagent-settings-loader-')))
    const beforeHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const roots = []
    t.after(async () => {
      for (const ctx of roots.reverse()) await ctx.fiber.dispose()
      if (beforeHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = beforeHome
      assert.equal(dirname(resolve(home)), temporaryRoot)
      assert.ok(basename(home).startsWith('dsh-subagent-settings-loader-'))
      await rm(home, { recursive: true, force: true })
    })
    const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'))
    const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href)
    const [app, editor, settings, timer, hmr, sessionModule, nativeTool] = await Promise.all([
      'dsh-app-boot', 'dsh-config-editor', 'dsh-settings', 'cordis-plugin-timer',
      'dsh-hmr', 'dsh-session', 'dsh-tool-subagent',
    ].map(load))
    const modern = Object.hasOwn(nativeTool.Config.dict, 'modelSelection')
    const profileDir = join(home, 'profiles', 'fixture')
    app.initProfile(profileDir, ['fixture-settings-bundle'])
    const bundleDir = join(profileDir, 'node_modules', 'fixture-settings-bundle')
    await mkdir(bundleDir, { recursive: true })
    await writeFile(join(home, 'package.json'), '{"name":"synthetic-settings-installation"}\n')
    await writeFile(join(bundleDir, 'package.json'), JSON.stringify({ name: 'fixture-settings-bundle', version: '1.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    const declared = { id: sourceId, name: sourceName, inject: [gateService],
      config: { enabled: false, allowedModels: [] } }
    await writeFile(join(bundleDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [
      { id: 'sessions', name: '@deepseek-ai/dsh-session' },
      { id: 'session-projections', name: '@deepseek-ai/dsh-session-projection' },
      { id: 'config-editor', name: 'cordis:editor' },
      { id: 'settings', name: 'cordis:settings' },
      declared,
      { id: gateId, name: new URL('../plugin/subagent-settings.mjs', import.meta.url).href },
    ] }]))
    await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
    const profile = { name: 'fixture', startedBundles: ['fixture-settings-bundle'], dir: profileDir,
      patchPath: join(profileDir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
      cwd: home, home, overlays: [], telemetryDisabledEnv: undefined }
    const start = async () => {
      const ctx = await app.boot('fixture', join(profileDir, 'cordis.yml'), app.readProfilePatches('fixture', profile), inner => {
        inner.provide('profileContext', profile)
        inner.provide('appReady', { onReady(listener) { listener(); return () => {} } })
        Object.assign(inner.loader.builtins, { editor: editor.default, settings: settings.default })
      }, resolveDshModule('@deepseek-ai/dsh-session'))
      roots.push(ctx)
      await ctx.plugin(timer.default ?? timer)
      await ctx.plugin(hmr.default ?? hmr, { root: [], ignored: [], debounce: 0 })
      await ctx.hmr.runExclusive(async () => {})
      return ctx
    }
    let ctx = await start(), serial = 0
    const entry = () => [...ctx.loader.entries()].find(row => row.options.id === sourceId)
    const gate = () => [...ctx.loader.entries()].find(row => row.options.id === gateId)
    const descriptor = () => ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === sourceId)
    const sample = async remote => {
      const { Session, SESSION_FORMAT_VERSION } = sessionModule, id = `settings-${++serial}`
      const session = Session.create(id, undefined, { version: SESSION_FORMAT_VERSION, id, createdAt: 0,
        isSeeded: false, delegationDepth: 0, agentPreset: remote ? 'claude-sdk-remote' : 'standard' })
      await ctx.serial('agent/created', { agent: { session } })
      return session.snapshotEvents().filter(event => event.type === 'subagent/model-selection-policy').map(event => event.data.allowedModels)
    }
    const routes = [{ provider: 'ordinary', model: 'fixture-a' }]
    const verify = async expected => {
      assert.deepEqual((await sample(false)), modern && expected.enabled ? [expected.allowedModels] : [])
      assert.deepEqual(await sample(true), [])
      assert.deepEqual(descriptor().value, expected)
      assert.equal(entry().options.id, declared.id)
      assert.equal(entry().options.name, declared.name)
      assert.deepEqual(entry().options.inject, declared.inject)
    }
    await t.test('官方volatile表单保留原模块/id，修改写回原profile行且不重建fiber', async () => {
      assert.ok(ctx.get(gateService)); assert.ok(ctx.get('subagentModelSelection'))
      const owner = entry().fiber, view = descriptor()
      assert.ok(view); assert.equal(view.applies, 'live')
      await ctx.settings.update(sourceId, { enabled: true, allowedModels: routes }, view.revision)
      assert.equal(entry().fiber, owner)
      await verify({ enabled: true, allowedModels: routes })
      const saved = app.loadOverlayPatches('fixture', profile.patchPath)
      assert.deepEqual(saved.filter(row => row.id === sourceId).map(row => row.config), [{ enabled: true, allowedModels: routes }])
      assert.equal(saved.some(row => row.id === gateId), false)
      assert.equal((await readFile(profile.patchPath, 'utf8')).includes('dsh-claude-bridge/subagent-settings'), false)
    })
    await t.test('真实HMR配置文件更新继续使用原生volatile值和原Entry', async () => {
      const owner = entry().fiber, changed = [{ provider: 'ordinary', model: 'fixture-hmr' }]
      await writeFile(profile.patchPath, JSON.stringify([{ id: sourceId, config: { enabled: true, allowedModels: changed } }]))
      await eventually(() => assert.deepEqual(descriptor()?.value, { enabled: true, allowedModels: changed }))
      await ctx.hmr.runExclusive(async () => {})
      assert.equal(entry().fiber, owner)
      await verify({ enabled: true, allowedModels: changed })
    })
    await t.test('原Entry重建后gate继续过滤远程回调，冷重载保持用户设置', async () => {
      const before = descriptor().value, owner = entry().fiber
      await entry().update({ disabled: true }); await ctx.loader.await()
      assert.equal(ctx.get('subagentModelSelection'), undefined)
      await entry().update({ disabled: false }); await ctx.loader.await()
      assert.notEqual(entry().fiber, owner)
      await verify(before)
      await ctx.fiber.dispose()
      ctx = await start()
      await verify(before)
    })
    await t.test('gate和整套overlay撤回再安装恢复正确策略且不改用户配置', async () => {
      const before = descriptor().value
      await gate().update({ disabled: true }); await ctx.loader.await()
      assert.equal(ctx.get(gateService), undefined)
      assert.equal(ctx.get('subagentModelSelection'), undefined)
      await gate().update({ disabled: false }); await ctx.loader.await()
      assert.ok(ctx.get(gateService)); await verify(before)
      const saved = await readFile(profile.patchPath, 'utf8')
      const withoutGate = app.readProfilePatches('fixture', profile).flatMap(patch => {
        if (patch.id === gateId) return []
        if (!patch.insert) return [patch]
        return [{ ...patch, insert: patch.insert.filter(row => row.id !== gateId).map(row => {
          if (row.id !== sourceId) return row
          const plain = { ...row }; delete plain.inject; return plain
        }) }]
      })
      await ctx.hmr.runExclusive(() => app.recomposeProfile(ctx, withoutGate, 'fixture'))
      assert.equal(entry().options.name, sourceName)
      assert.deepEqual(descriptor().value, before)
      assert.deepEqual(await sample(false), modern ? [before.allowedModels] : [])
      assert.deepEqual(await sample(true), modern ? [before.allowedModels] : [])
      assert.equal(await readFile(profile.patchPath, 'utf8'), saved)
      await ctx.hmr.runExclusive(() => app.recomposeProfile(ctx, app.readProfilePatches('fixture', profile), 'fixture'))
      assert.ok(ctx.get(gateService)); assert.ok(ctx.get('subagentModelSelection'))
      await verify(before)
      assert.equal(await readFile(profile.patchPath, 'utf8'), saved)
    })
  })
