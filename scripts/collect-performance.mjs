import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { analyzePerformance, formatPerformanceReport, sanitizePerformanceRecord } from '../src/performance-report.mjs'

const args = process.argv.slice(2), roots = []
const LOG_NAMES = new Set(['bridge.previous.jsonl', 'bridge.jsonl', 'diagnostics.sanitized.jsonl'])
let output
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--logs' && args[index + 1]) roots.push(resolve(args[++index]))
  else if (args[index] === '--out' && args[index + 1]) output = resolve(args[++index])
  else if (args[index] === '--help') {
    console.log('用法：node scripts/collect-performance.mjs --logs <桥接 diagnostics 目录> [--logs <另一份目录>] --out <新建输出目录>\n仅提取 bridge.jsonl / bridge.previous.jsonl 或已有脱敏包的 diagnostics.sanitized.jsonl，不读取认证、连接配置或会话正文。')
    process.exit(0)
  } else throw new Error('参数无效，请用 --help 查看说明。')
}
if (!roots.length || !output) throw new Error('需要 --logs 和 --out，请用 --help 查看说明。')
const files = [], known = new Set()
async function collect(path, depth = 0) {
  const info = await lstat(path)
  if (info.isSymbolicLink()) throw new Error('不读取符号链接。')
  if (info.isDirectory()) {
    if (depth > 2) return
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), detail = await lstat(child)
      if (detail.isSymbolicLink()) continue
      if (detail.isDirectory()) await collect(child, depth + 1)
      else if (LOG_NAMES.has(name)) await collect(child, depth + 1)
    }
  } else if (info.isFile() && LOG_NAMES.has(basename(path))) {
    if (!known.has(path)) { known.add(path); files.push({ path, bytes: info.size }) }
  }
}
for (const root of roots) await collect(root)
if (!files.length) throw new Error('指定目录未找到桥接诊断日志。')
if (files.length > 128 || files.some(file => file.bytes > 16 * 1024 * 1024)
  || files.reduce((sum, file) => sum + file.bytes, 0) > 64 * 1024 * 1024) throw new Error('日志超过单次收集上限，请缩小到本次测试的诊断目录。')
const rows = [], fingerprints = new Set()
let invalidLines = 0, ignoredLines = 0
for (const file of files) {
  for (const line of (await readFile(file.path, 'utf8')).split(/\r?\n/)) {
    if (!line.trim()) continue
    let row
    try { row = sanitizePerformanceRecord(JSON.parse(line)) } catch { invalidLines++; continue }
    if (!row) { ignoredLines++; continue }
    const key = JSON.stringify(row)
    if (!fingerprints.has(key)) { fingerprints.add(key); rows.push(row) }
  }
}
rows.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''))
const report = analyzePerformance(rows)
const bridgePackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
report.collection = { files: files.length, invalidLines, ignoredLines, bridgeVersion: bridgePackage.version,
  runtime: { node: process.versions.node, electron: process.versions.electron, platform: process.platform, arch: process.arch,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } }
await mkdir(output, { recursive: false, mode: 0o700 })
const artifacts = [
  ['diagnostics.sanitized.jsonl', rows.map(row => JSON.stringify(row)).join('\n') + '\n'],
  ['performance-report.json', JSON.stringify(report, null, 2) + '\n'],
  ['performance-report.md', formatPerformanceReport(report)],
]
const manifest = []
for (const [name, body] of artifacts) {
  await writeFile(join(output, name), body, { flag: 'wx', mode: 0o600 })
  manifest.push({ name, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') })
}
await writeFile(join(output, 'collection-manifest.json'), JSON.stringify({ format: 1, files: manifest,
  privacy: '仅诊断白名单；轮次 ID 已匿名；未读取连接配置、认证或聊天文件。' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ files: files.length, diagnosticRecords: rows.length, runs: report.coverage.runs,
  pairedFirstToken: report.coverage.pairedFirstToken, invalidLines, ignoredLines }))
