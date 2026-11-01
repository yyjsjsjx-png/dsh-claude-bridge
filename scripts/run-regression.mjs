/** No-key regression entry; native checks require the actual rc.5 desktop. */
import { spawn, execFile } from 'node:child_process';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const RC5_VERSION = '0.2.1-rc.5';
export const RC5_NATIVE_TESTS = Object.freeze([
  'test/bundle-native.test.mjs', 'test/catalog-visibility.test.mjs',
  'test/controller-native.test.mjs', 'test/history-native.test.mjs',
  'test/preset-native.test.mjs', 'test/sdk-projection.test.mjs',
  'test/shell-native.test.mjs', 'test/workflow-depth-guard.test.mjs',
  'test/session-status.test.mjs', 'test/compact-command.test.mjs',
  'test/recovery-command.test.mjs', 'test/update-plugin.test.mjs',
]);
const project = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

function requireNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (process.versions.electron || major < 24 || (major === 24 && minor < 9)) {
    throw new Error('统一入口须由现有 Node.js >=24.9 运行；Electron 仅用于原生子进程。');
  }
}

/** Node cannot read ASAR contents; the real packaged Electron must do so. */
export async function inspectNativeTarget(resourcesValue, executableValue) {
  if (process.platform !== 'win32') throw new Error('rc.5 原生层要求真实 Windows，不能用 npm 包代替。');
  if (!resourcesValue) throw new Error('缺少 DSH resources 路径，请传 --resources 或设置 DSH_CLAUDE_BRIDGE_RESOURCES。');
  const resources = await realpath(resolve(resourcesValue));
  const executable = await realpath(resolve(executableValue ?? join(dirname(resources), 'DeepSeek Harness.exe')));
  if (dirname(executable).toLowerCase() !== dirname(resources).toLowerCase()) {
    throw new Error('桌面 EXE 与 resources 必须来自同一安装目录，不能混用不同 Electron 运行时。');
  }
  if (!(await stat(resources)).isDirectory() || !(await stat(join(resources, 'app.asar'))).isFile()
    || !(await stat(executable)).isFile() || !executable.toLowerCase().endsWith('.exe')) {
    throw new Error('原生层要求实际桌面 EXE 和文件形式的 resources/app.asar。');
  }
  const probe = `
    const fs = require('node:fs'), path = require('node:path');
    const resources = process.env.DSH_CLAUDE_BRIDGE_RESOURCES;
    try {
      if (process.platform !== 'win32' || !process.versions.electron) throw Error('不是 Windows Electron 运行时');
      const app = JSON.parse(fs.readFileSync(path.join(resources, 'app.asar/package.json'), 'utf8'));
      const loop = JSON.parse(fs.readFileSync(path.join(resources, 'app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-loop/package.json'), 'utf8'));
      if (app.version !== '${RC5_VERSION}' || loop.version !== '${RC5_VERSION}'
        || loop.name !== '@deepseek-ai/dsh-agent-loop') throw Error('桌面或 AgentLoop 版本不是 ${RC5_VERSION}');
      process.stdout.write(JSON.stringify({ platform: process.platform, electron: process.versions.electron,
        node: process.versions.node, desktopVersion: app.version, agentLoopVersion: loop.version }));
    } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
  `;
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_CLAUDE_BRIDGE_RESOURCES: resources, NODE_OPTIONS: '' };
  let stdout;
  try {
    ({ stdout } = await execFileAsync(executable, ['--expose-internals', '-e', probe], {
      env, windowsHide: true, timeout: 20000, maxBuffer: 128 * 1024, encoding: 'utf8',
    }));
  } catch (error) {
    throw new Error(`rc.5 Electron／ASAR 预检失败：${String(error.stderr || error.code || '无法启动桌面运行时').trim()}`);
  }
  const target = JSON.parse(stdout);
  return { ...target, resources, executable, archive: 'app.asar', expectedVersion: RC5_VERSION };
}

function tapSummary(output) {
  const values = {};
  for (const match of output.matchAll(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([0-9.]+)\s*$/gm)) {
    values[match[1]] = Number(match[2]);
  }
  if (!Number.isSafeInteger(values.tests) || values.tests < 1
    || !['pass', 'fail', 'cancelled', 'skipped', 'todo'].every(key => Number.isSafeInteger(values[key]))) {
    throw new Error('未取得完整 TAP 汇总，不能判定回归通过。');
  }
  return values;
}

async function execute(binary, args, env, outputDirectory, label, shell = false) {
  let stdout = '', stderr = '';
  const child = spawn(binary, args, { cwd: project, env, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
  const collect = (key, chunk) => {
    if (key === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    if (stdout.length + stderr.length > 16 * 1024 * 1024) child.kill();
  };
  child.stdout.on('data', chunk => collect('stdout', chunk));
  child.stderr.on('data', chunk => collect('stderr', chunk));
  let outcome;
  try {
    outcome = await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => accept({ exitCode, signal }));
    });
  } finally {
    clearTimeout(timer);
    await writeFile(join(outputDirectory, `${label}.tap`), stdout);
    await writeFile(join(outputDirectory, `${label}.stderr.log`), stderr);
  }
  return { ...outcome, summary: tapSummary(stdout) };
}

function options(argv) {
  const parsed = { layer: 'node', output: resolve(project, '.local/regression') };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--preflight-only') { parsed.preflightOnly = true; continue; }
    if (!['--layer', '--resources', '--executable', '--output'].includes(flag) || !argv[index + 1]) {
      throw new Error(`未知或缺值参数：${flag}`);
    }
    parsed[flag.slice(2)] = argv[++index];
  }
  if (!['node', 'native', 'all'].includes(parsed.layer)) throw new Error('--layer 只接受 node、native 或 all。');
  parsed.output = resolve(parsed.output);
  parsed.resources ??= process.env.DSH_CLAUDE_BRIDGE_RESOURCES;
  parsed.executable ??= process.env.DSH_CLAUDE_BRIDGE_EXECUTABLE;
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  const config = options(argv);
  await mkdir(config.output, { recursive: true });
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'failed',
    baseline: RC5_VERSION, host: { platform: process.platform, node: process.versions.node },
    ...( /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? '') ? { commit: process.env.GITHUB_SHA } : {}), layers: [] };
  try {
    requireNode();
    for (const layer of config.layer === 'all' ? ['node', 'native'] : [config.layer]) {
      const result = { layer, status: 'failed', realModelRequests: 0 };
      report.layers.push(result);
      try {
        const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
        delete env.ELECTRON_RUN_AS_NODE;
        delete env.DSH_CLAUDE_BRIDGE_RESOURCES;
        delete env.DSH_CLAUDE_BRIDGE_EXECUTABLE;
        if (layer === 'native') result.target = await inspectNativeTarget(config.resources, config.executable);
        if (config.preflightOnly) { result.status = 'preflight-passed'; continue; }
        let execution;
        if (layer === 'node') {
          // Preserve the package's full test command; do not append flags after its file glob.
          env.NODE_OPTIONS = '--test-reporter=tap';
          result.command = 'npm test';
          execution = await execute(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], env,
            config.output, layer, process.platform === 'win32');
        } else {
          Object.assign(env, { NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1', DSH_CLAUDE_BRIDGE_RESOURCES: result.target.resources });
          result.files = RC5_NATIVE_TESTS;
          execution = await execute(result.target.executable, ['--expose-internals', '--test', '--test-reporter=tap',
            '--test-concurrency=1', ...RC5_NATIVE_TESTS], env, config.output, layer);
        }
        Object.assign(result, execution);
        if (execution.exitCode !== 0 || execution.summary.fail || execution.summary.cancelled
          || (layer === 'native' && (execution.summary.skipped || execution.summary.todo))) {
          throw new Error(layer === 'native' ? '原生回归失败或存在跳过／TODO。' : 'Node 回归失败。');
        }
        result.status = 'passed';
        console.log(`${layer}：${execution.summary.pass} 通过，${execution.summary.skipped} 跳过，${execution.summary.fail} 失败。`);
      } catch (error) { result.error = error.message; throw error; }
    }
    report.status = config.preflightOnly ? 'preflight-passed' : 'passed';
  } catch (error) {
    report.error = error.message;
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(join(config.output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
