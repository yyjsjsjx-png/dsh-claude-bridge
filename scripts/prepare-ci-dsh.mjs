/** Download/extract the fixed official desktop only on the Windows CI runner. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, appendFile, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { inspectNativeTarget, DEFAULT_DESKTOP_VERSION, desktopVersion } from './run-regression.mjs';

/** Pin downloads to one reviewed official release instead of a moving latest. */
export function desktopDownloadUrl(version = DEFAULT_DESKTOP_VERSION) {
  return `https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-${desktopVersion(version)}-win-x64.exe`;
}
export const DESKTOP_URL = desktopDownloadUrl();
const execFileAsync = promisify(execFile);

function safeMember(root, name) {
  if (!name || isAbsolute(name) || /[:\r\n]/.test(name) || name.split(/[\\/]/).includes('..')) {
    throw new Error('安装包包含不安全的归档路径。');
  }
  const path = resolve(root, name);
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('归档路径越过临时目录。');
  return path;
}

async function existing7zip() {
  const candidates = [];
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, '7-Zip/7z.exe'));
  try {
    const { stdout } = await execFileAsync('where.exe', ['7z.exe'], { windowsHide: true, timeout: 10000 });
    candidates.push(...stdout.trim().split(/\r?\n/));
  } catch {}
  for (const candidate of candidates) {
    if (isAbsolute(candidate) && await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error('Windows runner 缺少现有 7z.exe；不会安装替代工具。');
}

async function sevenZip(binary, args) {
  const { stdout } = await execFileAsync(binary, args, { windowsHide: true, timeout: 180000,
    maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
  return stdout;
}

async function members(binary, archive) {
  const listing = await sevenZip(binary, ['l', '-slt', '-ba', archive]);
  if (/^(?:Symbolic Link|Hard Link) = /m.test(listing)) throw new Error('归档含链接，未执行提取。');
  return [...listing.matchAll(/^Path = (.+)\r?$/gm)].map(match => match[1].trim());
}

async function download(path, url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:'
    || new URL(response.url).hostname !== 'download.deepseek.com') throw new Error('固定官方安装包下载失败或跳转来源不受支持。');
  const hash = createHash('sha256');
  let bytes = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > 512 * 1024 * 1024) { done(new Error('安装包超过预期大小上限。')); return; }
    hash.update(chunk); done(null, chunk);
  } }), createWriteStream(path, { flags: 'wx' }));
  const length = Number(response.headers.get('content-length'));
  if (bytes < 1024 * 1024 || (length && length !== bytes)) throw new Error('安装包长度检查失败。');
  return { url, bytes, sha256: hash.digest('hex') };
}

export function preparationOptions(argv) {
  const options = { report: resolve('regression-results/ci-target.json'), desktopVersion: DEFAULT_DESKTOP_VERSION };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (!['--report', '--desktop-version'].includes(flag) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`未知或缺值参数：${flag}`);
    }
    options[flag === '--desktop-version' ? 'desktopVersion' : 'report'] = argv[++index];
  }
  options.report = resolve(options.report);
  options.desktopVersion = desktopVersion(options.desktopVersion);
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = preparationOptions(argv);
  const reportPath = options.report, version = options.desktopVersion;
  const url = desktopDownloadUrl(version);
  await mkdir(dirname(reportPath), { recursive: true });
  const report = { schemaVersion: 1, status: 'failed', expectedVersion: version,
    sourceUrl: url, installationExecuted: false };
  try {
    if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'Windows'
      || !process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) {
      throw new Error('此下载入口仅用于 Windows GitHub runner；本机请向 run-regression 提供现有 DSH 路径。');
    }
    const zip = await existing7zip();
    const root = await mkdtemp(join(resolve(process.env.RUNNER_TEMP), `dsh-${version}-`));
    const installer = join(root, 'installer.exe');
    report.download = await download(installer, url);
    const stage = join(root, 'installer-payload');
    await mkdir(stage);
    const candidates = (await members(zip, installer)).filter(name => /^app[^\\/]*\.7z$/i.test(basename(name.replaceAll('\\', '/'))));
    if (candidates.length !== 1) throw new Error(`无法从实际 NSIS 清单唯一定位 app*.7z（找到 ${candidates.length} 项）。`);
    const archive = safeMember(stage, candidates[0]);
    await sevenZip(zip, ['x', '-y', '-bb0', `-o${stage}`, installer, candidates[0]]);
    if (!(await stat(archive)).isFile()) throw new Error('NSIS 应用归档未实际提取。');
    const destination = join(root, 'desktop');
    await mkdir(destination);
    const paths = await members(zip, archive);
    for (const name of paths) safeMember(destination, name);
    const asars = paths.filter(name => /(?:^|[\\/])resources[\\/]app\.asar$/i.test(name));
    if (asars.length !== 1) throw new Error('应用归档没有唯一的 resources/app.asar。');
    await sevenZip(zip, ['x', '-y', '-bb0', `-o${destination}`, archive]);
    const resources = dirname(safeMember(destination, asars[0]));
    const executable = join(dirname(resources), 'DeepSeek Harness.exe');
    report.target = await inspectNativeTarget(resources, executable, version);
    report.archiveMember = candidates[0];
    for (const [key, value] of Object.entries({ DSH_CLAUDE_BRIDGE_RESOURCES: resources,
      DSH_CLAUDE_BRIDGE_EXECUTABLE: executable })) {
      if (/[\r\n]/.test(value)) throw new Error('runner 路径含换行，不能导出环境变量。');
      await appendFile(process.env.GITHUB_ENV, `${key}=${value}\n`);
    }
    report.status = 'prepared';
    console.log(`已提取并预检真实 DSH Desktop ${version}，未执行安装器。`);
  } catch (error) {
    report.error = error.message;
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
