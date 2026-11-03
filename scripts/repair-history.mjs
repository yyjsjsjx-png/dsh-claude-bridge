/** Offline migration of the bridge's known V4 journal mistakes. No message
 * bodies or authentication files are emitted in reports. */
import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { migrateBridgeHistory } from '../src/history-migration.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const missing = async (operation, fallback) => {
  try { return await operation() } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
}

export async function assertHomeIdle(home) {
  const profiles = join(resolve(home), 'profiles')
  for (const item of await missing(() => readdir(profiles, { withFileTypes: true }), [])) {
    if (!item.isDirectory()) continue
    const pid = (await missing(() => readFile(join(profiles, item.name, 'lock'), 'utf8'), '')).trim()
    if (!pid) continue
    if (!/^[1-9]\d*$/.test(pid)) throw new Error('DSH 数据目录存在无法识别的运行锁，请完全退出后重试。')
    try { process.kill(Number(pid), 0); throw new Error('同一数据目录的 DSH 仍在运行，请完全退出后更新。') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

function decodeFrames(bytes) {
  const rows = [], utf8 = new TextDecoder('utf-8', { fatal: true })
  let offset = 0, decodedBytes = 0
  while (offset < bytes.length) {
    const result = zstdDecompressSync(bytes.subarray(offset), { info: true, maxOutputLength: 64 * 1024 * 1024 })
    const consumed = result.engine.bytesWritten
    if (!Number.isSafeInteger(consumed) || consumed < 1 || consumed > bytes.length - offset) {
      throw new Error('现有运行时无法可靠读取 Zstandard 帧，保留原日志。')
    }
    decodedBytes += result.buffer.length
    if (decodedBytes > 64 * 1024 * 1024) throw new Error('会话超过自动迁移上限，保留原日志。')
    const text = utf8.decode(result.buffer)
    if (!text.endsWith('\n')) throw new Error('会话含有不完整 JSONL 行，保留原日志。')
    for (const line of text.slice(0, -1).split('\n')) rows.push(JSON.parse(line))
    offset += consumed
  }
  return rows
}

function encodeFrames(header, events, catalog) {
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const frames = [zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n'), options)]
  let lines = [], bytes = 0
  for (const event of events) {
    const line = JSON.stringify(catalog.encodeCurrentEvent(event)) + '\n'
    if (bytes && bytes + Buffer.byteLength(line) > 1024 * 1024) {
      frames.push(zstdCompressSync(Buffer.from(lines.join('')), options)); lines = []; bytes = 0
    }
    lines.push(line); bytes += Buffer.byteLength(line)
  }
  if (lines.length) frames.push(zstdCompressSync(Buffer.from(lines.join('')), options))
  return Buffer.concat(frames)
}

export async function repairBridgeHistories({ home, backup, require }) {
  await assertHomeIdle(home)
  const root = join(resolve(home), 'sessions')
  const workspaces = await missing(() => readdir(root, { withFileTypes: true }), [])
  if (!workspaces.length) return { checked: 0, repaired: 0, changedRecords: 0 }
  const { sessionFormatCatalog: catalog } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const { releasedV4SessionFormatCodec: codec } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-v3-to-v4')).href)
  if (catalog.currentVersion !== 4 || typeof codec?.createDecoder !== 'function') {
    throw new Error('此 DSH 的历史迁移接口尚不兼容，未修改历史。')
  }
  const report = { checked: 0, repaired: 0, changedRecords: 0 }
  const rootPath = await realpath(root)
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    for (const item of await readdir(join(root, workspace.name), { withFileTypes: true })) {
      if (!item.isDirectory()) continue
      const file = join(root, workspace.name, item.name, 'session.v4.jsonl.zstd')
      const info = await missing(() => stat(file), undefined)
      if (!info) continue
      const actual = await realpath(file)
      if (!actual.startsWith(rootPath + sep) || !info.isFile() || info.size > 64 * 1024 * 1024) {
        throw new Error('历史文件路径或大小不适合自动迁移，保留原文件。')
      }
      try {
        const original = await readFile(file)
        const [header, ...rows] = decodeFrames(original)
        if (header?.version !== 4 || header?.agentPreset !== 'claude-sdk-remote') continue
        if (header.id !== item.name) throw new Error('历史文件身份不匹配。')
        const decoder = codec.createDecoder(header, 'strict'), events = []
        const collector = { emitEvent: event => events.push(event), emitRun() { throw new Error('不支持的历史行。') } }
        for (const row of rows) decoder.decodeRow(row, collector)
        decoder.finish(collector)
        report.checked++
        const migrated = migrateBridgeHistory(decoder.header, events)
        const validate = candidateRows => {
          const restore = catalog.createRestore(header, { recovery: 'strict', validation: 'current' })
          for (const row of candidateRows) restore.decodeRow(row)
          return restore.finish()
        }
        if (!migrated.changed) {
          try { validate(rows) } catch (error) {
            // Only the original journal can qualify. A rejected migration stays fatal.
            if (error?.name !== 'SessionFormatError'
              || !/^step\/end leaves unresolved tool call [^\s]+$/.test(error.message)) throw error
            if (digest(await readFile(file)) !== digest(original)) throw error
            report.skipped ??= []
            report.skipped.push({ sessionId: item.name, code: 'PREEXISTING_UNRESOLVED_TOOL_CALL' })
          }
          continue
        }
        validate(migrated.events.map(event => catalog.encodeCurrentEvent(event)))
        const candidate = encodeFrames(header, migrated.events, catalog)
        const [roundTripHeader, ...roundTrip] = decodeFrames(candidate)
        if (JSON.stringify(roundTripHeader) !== JSON.stringify(header)) throw new Error('历史头部核对失败。')
        const restored = validate(roundTrip)
        if (restored.events.length !== migrated.events.length) throw new Error('迁移后事件数不一致。')
        await assertHomeIdle(home)
        const saved = join(resolve(backup), 'histories', relative(root, file))
        await mkdir(dirname(saved), { recursive: true, mode: 0o700 })
        await copyFile(file, saved, fsConstants.COPYFILE_EXCL)
        if (digest(await readFile(saved)) !== digest(original) || digest(await readFile(file)) !== digest(original)) {
          throw new Error('历史在迁移期间发生变化，未写回。')
        }
        const temp = join(dirname(file), `.claude-bridge-repair-${randomUUID()}.tmp`)
        try {
          const handle = await open(temp, 'wx', 0o600)
          try { await handle.writeFile(candidate); await handle.sync() } finally { await handle.close() }
          if (digest(await readFile(temp)) !== digest(candidate) || digest(await readFile(file)) !== digest(original)) {
            throw new Error('历史写回前核对失败，保留备份。')
          }
          await rename(temp, file)
          if (digest(await readFile(file)) !== digest(candidate)) throw new Error('历史写回后核对失败，请恢复备份。')
        } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
        report.repaired++; report.changedRecords += migrated.changed
      } catch {
        // Do not echo parser errors which might contain a private JSON snippet.
        throw new Error(`历史校验或迁移未完成：${item.name}。请保留原文件与备份，暂勿启动 DSH。`)
      }
    }
  }
  return report
}
