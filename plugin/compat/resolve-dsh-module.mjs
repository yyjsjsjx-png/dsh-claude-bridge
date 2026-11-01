/** Resolve the desktop's own modules without copying Cordis singletons. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOST_FUNCTIONS, DshCompatibilityError, assertHostContract } from './host-contract.mjs';

const ALLOWED = new Set(Object.keys(HOST_FUNCTIONS));

let cached;

function readManifest(path, label, version) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    throw new DshCompatibilityError(version, `无法读取 ${label} 的模块声明`, { cause: error });
  }
}

function installation() {
  const resources = process.env.DSH_CLAUDE_BRIDGE_RESOURCES || process.resourcesPath;
  if (typeof resources !== 'string' || !isAbsolute(resources)) {
    throw new Error('无法确定 DSH 安装目录，请在 DSH Desktop 中启动桥接。');
  }
  const packed = join(resolve(resources), 'app.asar');
  const archive = existsSync(packed) ? packed : join(resolve(resources), 'app');
  if (cached?.archive === archive) return cached;
  const base = join(archive, 'dsh', 'node_modules');
  const loop = join(base, '@deepseek-ai', 'dsh-agent-loop');
  const manifest = readManifest(join(loop, 'package.json'), 'DSH AgentLoop');
  if (manifest.name !== '@deepseek-ai/dsh-agent-loop') {
    throw new DshCompatibilityError(manifest.version, '无法识别 DSH AgentLoop 模块');
  }
  cached = { archive, base, version: manifest.version, urls: new Map() };
  return cached;
}

/** Support standard nested Node/import export conditions as package layouts evolve. */
function esmEntry(exports) {
  if (typeof exports === 'string') return exports;
  if (exports && typeof exports === 'object' && !Array.isArray(exports)) {
    for (const [condition, value] of Object.entries(exports)) {
      if (['node', 'import', 'default'].includes(condition)) {
        const entry = esmEntry(value);
        if (entry !== undefined) return entry;
      }
    }
  }
}

/** Return the URL for one permitted official package's own ESM root export. */
export function resolveDshModule(name) {
  if (!ALLOWED.has(name)) throw new Error(`不支持的 DSH 模块：${String(name)}`);
  const installed = installation();
  const existing = installed.urls.get(name);
  if (existing !== undefined) return existing;
  const dir = join(installed.base, ...name.split('/'));
  const manifest = readManifest(join(dir, 'package.json'), name, installed.version);
  const exports = manifest.exports;
  const root = typeof exports === 'object' && exports !== null && Object.hasOwn(exports, '.') ? exports['.'] : exports;
  const entry = esmEntry(root) ?? (exports === undefined && manifest.type === 'module' ? manifest.module ?? manifest.main : undefined);
  if (manifest.name !== name || typeof entry !== 'string'
    || !/^\.\/[a-zA-Z0-9_./-]+$/u.test(entry) || entry.split('/').includes('..')) {
    throw new DshCompatibilityError(installed.version, `${name} 的 ESM 导出不受支持`);
  }
  const target = join(dir, ...entry.slice(2).split('/'));
  let regular;
  try { regular = statSync(target).isFile(); } catch {}
  if (!regular) throw new DshCompatibilityError(installed.version, `缺少 ${name} 模块入口`);
  const url = pathToFileURL(target).href;
  installed.urls.set(name, url);
  return url;
}

/** Run once per installation before any bridge component registers services. */
export function assertDshCompatibility() {
  const installed = installation();
  return installed.compatibility ??= (async () => {
    const modules = {};
    for (const name of ALLOWED) {
      try { modules[name] = await import(resolveDshModule(name)); }
      catch (error) {
        if (error instanceof DshCompatibilityError) throw error;
        throw new DshCompatibilityError(installed.version, `无法加载 ${name}`, { cause: error });
      }
    }
    const checks = assertHostContract(modules, installed.version);
    return Object.freeze({ version: installed.version, baselineVersion: '0.2.1-rc.5', status: 'compatible',
      // Startup probes cannot attest to a desktop interaction or an upstream SDK run.
      checks: Object.freeze([...checks,
        { id: 'desktop-acceptance', evidence: 'desktop', status: 'not-run' },
        { id: 'remote-sdk', evidence: 'real-sdk', status: 'not-run' },
      ].map(check => Object.freeze(check))) });
  })();
}

/** Read the shipped standard declaration without copying it across machines. */
export function readShippedStandardPreset() {
  const installed = installation();
  const dir = join(installed.base, '@deepseek-ai', 'dsh-web-app');
  const manifest = readManifest(join(dir, 'package.json'), 'DSH 标准预设', installed.version);
  const path = join(dir, 'presets', 'standard.patch.yml');
  let bytes;
  try { bytes = readFileSync(path); }
  catch (error) {
    throw new DshCompatibilityError(installed.version, '无法读取 DSH 标准预设', { cause: error });
  }
  if (manifest.name !== '@deepseek-ai/dsh-web-app') {
    throw new DshCompatibilityError(installed.version, '无法识别 DSH 标准预设模块');
  }
  return { content: bytes.toString('utf8'), baseUrl: pathToFileURL(path).href, version: installed.version };
}
