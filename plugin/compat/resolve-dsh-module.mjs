/** Resolve the desktop's own rc.5 modules without copying Cordis singletons. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_VERSION = '0.2.1-rc.5';
const EXPECTED_AGENT_LOOP_SHA256 = 'cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033';
const EXPECTED_STANDARD_PRESET_SHA256 = '0d398d2a6872a73a106cb3bd19303ecccf1637e1fcad4d0bf9d8a72d2c2c68f5';
const ALLOWED = new Set([
  '@deepseek-ai/cordis', '@deepseek-ai/schemastery', 'zod',
  '@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-util-values', '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/cordis-plugin-include', 'js-yaml',
  '@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-credentials',
]);

let cached;

function installation() {
  const resources = process.env.DSH_CLAUDE_BRIDGE_RESOURCES || process.resourcesPath;
  if (typeof resources !== 'string' || !isAbsolute(resources)) {
    throw new Error('无法确定 DSH 安装目录，请在 DSH Desktop 中启动桥接。');
  }
  const archive = join(resolve(resources), 'app.asar');
  if (cached?.archive === archive) return cached;
  const base = join(archive, 'dsh', 'node_modules');
  const loop = join(base, '@deepseek-ai', 'dsh-agent-loop');
  const manifest = JSON.parse(readFileSync(join(loop, 'package.json'), 'utf8'));
  const source = readFileSync(join(loop, 'lib', 'index.js'));
  const hash = createHash('sha256').update(source).digest('hex');
  if (manifest.name !== '@deepseek-ai/dsh-agent-loop'
    || manifest.version !== EXPECTED_VERSION || hash !== EXPECTED_AGENT_LOOP_SHA256) {
    throw new Error('DSH 安装版与桥接要求的 rc.5 不匹配，请重新核对兼容性。');
  }
  cached = { archive, base, urls: new Map() };
  return cached;
}

/** Return the URL for one permitted official package's own ESM root export. */
export function resolveDshModule(name) {
  if (!ALLOWED.has(name)) throw new Error(`不支持的 DSH 模块：${String(name)}`);
  const installed = installation();
  const existing = installed.urls.get(name);
  if (existing !== undefined) return existing;
  const dir = join(installed.base, ...name.split('/'));
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const root = manifest.exports?.['.'];
  const entry = typeof root === 'string' ? root : root?.import ?? root?.default;
  if (manifest.name !== name || typeof entry !== 'string'
    || !/^\.\/[a-zA-Z0-9_./-]+$/u.test(entry) || entry.split('/').includes('..')) {
    throw new Error(`DSH 模块的 ESM 导出不受支持：${name}`);
  }
  const target = join(dir, ...entry.slice(2).split('/'));
  if (!statSync(target).isFile()) throw new Error(`DSH 模块入口不存在：${name}`);
  const url = pathToFileURL(target).href;
  installed.urls.set(name, url);
  return url;
}

/** Read the shipped standard declaration without copying it across machines. */
export function readShippedStandardPreset() {
  const installed = installation();
  const dir = join(installed.base, '@deepseek-ai', 'dsh-web-app');
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const path = join(dir, 'presets', 'standard.patch.yml');
  const bytes = readFileSync(path);
  if (manifest.name !== '@deepseek-ai/dsh-web-app' || manifest.version !== EXPECTED_VERSION
    || createHash('sha256').update(bytes).digest('hex') !== EXPECTED_STANDARD_PRESET_SHA256) {
    throw new Error('DSH 标准预设与桥接要求的 rc.5 不匹配。');
  }
  return { content: bytes.toString('utf8'), baseUrl: pathToFileURL(path).href };
}
