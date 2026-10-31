/** Offline in-place update through DSH's installed package manager. */
import { access, copyFile, mkdir, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, delimiter } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { assertHomeIdle, repairBridgeHistories } from './repair-history.mjs'

const packageName = 'dsh-claude-bridge'
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const fail = message => { throw new Error(message) }

export async function updatePlugin({ resources, home, profile = 'desktop', packageDirectory }) {
  if (!process.versions.electron) fail('请使用 update-plugin.ps1，通过现有 DSH 运行更新。')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(profile)) fail('配置名称无效。')
  const directory = resolve(home, 'profiles', profile)
  process.env.DSH_HOME = resolve(home)
  const source = await realpath(resolve(packageDirectory))
  const inside = relative(directory, source)
  if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))) {
    fail('请从配置目录以外的解压包运行更新。')
  }
  const candidate = await json(join(source, 'package.json'))
  if (candidate.name !== packageName || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(candidate.version)
    || candidate.dsh?.bundle?.patch !== './patches/bundle.patch.yml') fail('本地插件包格式不正确。')
  await access(join(source, 'plugin/bundle.mjs'))
  await access(join(source, 'patches/bundle.patch.yml'))
  const installedPath = join(directory, 'node_modules', packageName, 'package.json')
  const previous = await json(installedPath)
  if (previous.name !== packageName) fail('目标配置未安装此插件，请先使用 DSH 安装。')

  let anchor
  for (const folder of ['app.asar', 'app']) {
    const path = join(resolve(resources), folder, 'dsh/node_modules/@deepseek-ai/dsh/package.json')
    try { await access(path); anchor = path; break } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!anchor) fail('找不到现有 DSH 运行文件。')
  const require = createRequire(anchor)
  const operations = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href)
  const atomic = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
  if (typeof operations.runProfilePnpm !== 'function' || typeof atomic.withFileLock !== 'function') {
    fail('此 DSH 版本的更新接口不兼容，请使用兼容版本。')
  }
  const pnpm = join(resolve(resources), 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
  await access(pnpm)
  return atomic.withFileLock(join(directory, 'package.json'), async () => {
    await assertHomeIdle(home)
    let desktopLock
    try { desktopLock = (await readFile(join(directory, 'lock'), 'utf8')).trim() }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (desktopLock) {
      if (!/^\d+$/.test(desktopLock)) fail('目标配置存在无法识别的运行锁，请先确认 DSH 已完全退出。')
      try { process.kill(Number(desktopLock), 0); fail('请先完全退出使用此配置的 DSH。') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const backup = join(directory, '.plugin-manager/backups',
      `claude-bridge-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`)
    await mkdir(backup, { recursive: true, mode: 0o700 })
    for (const name of ['package.json', 'pnpm-lock.yaml']) {
      try { await copyFile(join(directory, name), join(backup, name)) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const history = await repairBridgeHistories({ home, backup, require })
    const result = await operations.runProfilePnpm({ profile, home: resolve(home), dir: directory,
      installAnchor: anchor, cwd: source }, ['add', '--offline', '--ignore-scripts', `link:${source}`], {
      command: process.execPath, args: ['--expose-internals', pnpm],
      execution: 'service', outputBytes: 16_384, lockWaitMs: 5_000, lookupTimeoutMs: 5_000,
      idleTimeoutMs: 120_000,
      env: { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(resolve(resources), 'runtime/bin')}${delimiter}${process.env.PATH ?? ''}` },
    })
    if (result.exitCode !== 0) fail(`更新未完成。安装元数据备份：${backup}；安装日志：${result.logPath}。`)
    const updated = await json(installedPath)
    if (updated.name !== packageName || updated.version !== candidate.version
      || relative(source, await realpath(dirname(installedPath))) !== '') {
      fail(`更新后的版本核对失败，请保留安装元数据备份：${backup}。`)
    }
    return { updated: true, previousVersion: previous.version, version: updated.version, backup,
      dataPreserved: true, history }
  }, { waitMs: 5_000 })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {}
  const names = { '--resources': 'resources', '--home': 'home', '--profile': 'profile', '--package': 'packageDirectory' }
  try {
    for (let index = 2; index < process.argv.length; index += 2) {
      const name = names[process.argv[index]], value = process.argv[index + 1]
      if (!name || !value || Object.hasOwn(options, name)) fail('更新参数无效。')
      options[name] = value
    }
    if (!options.resources || !options.home || !options.packageDirectory) fail('缺少更新目录参数。')
    console.log(JSON.stringify(await updatePlugin(options)))
  } catch (error) {
    // Package-manager output remains in its private log, never in a shareable report.
    console.error(error instanceof Error ? error.message : '更新失败。')
    process.exitCode = 1
  }
}
