/** Extract and adapt the installed DSH rc.5 AgentLoop without changing it. */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_PRESET } from '../plugin/policy.mjs';

const RELEASE = '0.2.1-rc.5';
const COMMIT = 'b830ec950faba0a46dda564be3e2d854afed94f1';
const UPSTREAM_SHA256 = 'cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033';
const LICENSE_SHA256 = 'ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be';
const PACKAGE_BASE = 'dsh/node_modules/@deepseek-ai/dsh-agent-loop';
const SESSION_PACKAGE = '@deepseek-ai/dsh-api-session-controller';
const SESSION_BASE = `dsh/node_modules/${SESSION_PACKAGE}`;
const SESSION_CLIENT_SHA256 = '82f2301c18f0e51340c1eedf8ecdfb939e873b3770a80632e438b86e82887d0e';
const CONSTRUCTION = 'const created = machine = new ReactLoopAgent(loopCtx, id, options, session);';
const REPLACEMENT = 'const created = machine = createClaudeLoopAgent(ReactLoopAgent, loopCtx, id, options, session);';
const STEP_END = 'this.session.append("step/end", {\n\t\t\t\t\t\tturn,\n\t\t\t\t\t\tstep\n\t\t\t\t\t});';
const STEP_END_REPLACEMENT = [
  '/* bridge-step-end-start */',
  `\t\t\t\t\tif (this.session.header.agentPreset === ${JSON.stringify(CLAUDE_PRESET)}) {`,
  '\t\t\t\t\t\tif (this._bridgeStepOpen !== false) {',
  '\t\t\t\t\t\t\tthis.session.append("step/end", { turn, step: this.phase.step });',
  '\t\t\t\t\t\t\tthis._bridgeStepOpen = false;',
  '\t\t\t\t\t\t}',
  '\t\t\t\t\t} else {',
  '\t\t\t\t\t\tthis.session.append("step/end", { turn, step });',
  '\t\t\t\t\t}',
  '\t\t\t\t\t/* bridge-step-end-finish */',
].join('\n');
const IMPORT = "import { createClaudeLoopAgent } from '../claude-agent.mjs';\n";
const RESOLVER_IMPORT = "import { resolveDshModule } from './resolve-dsh-module.mjs';\n";
const COMPATIBILITY_IMPORT = "import './check-host.mjs';\n";
// These are the exact external imports in the verified rc.5 bundle. Using
// the packaged ESM entry points preserves DSH's real module singletons.
const OFFICIAL_MODULES = [
  '@deepseek-ai/cordis', '@deepseek-ai/schemastery', 'zod',
  '@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-persistence', '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-util-values', '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools',
];
const RUNTIME_MODULES = [
  '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-agent-preset-registry',
  '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/cordis-plugin-include', 'js-yaml',
  '@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-credentials',
];

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readExactly(handle, position, size) {
  const out = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const result = await handle.read(out, read, size - read, position + read);
    if (result.bytesRead === 0) throw new Error('ASAR 文件不完整。');
    read += result.bytesRead;
  }
  return out;
}

/** Read the bounded ASAR pickle header and selected regular files only. */
export async function readArchiveEntries(archivePath, wanted) {
  const handle = await open(archivePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 16) throw new Error('ASAR 文件无效。');
    const first = await readExactly(handle, 0, 16);
    const sizePayload = first.readUInt32LE(0);
    const headerSize = first.readUInt32LE(4);
    const headerPayload = first.readUInt32LE(8);
    const jsonSize = first.readUInt32LE(12);
    if (sizePayload !== 4 || headerSize < 8 || headerSize > 64 * 1024 * 1024
      || headerPayload !== headerSize - 4 || jsonSize > headerSize - 8
      || 8 + headerSize > stat.size) {
      throw new Error('不支持的 ASAR 头部格式。');
    }
    const header = JSON.parse((await readExactly(handle, 16, jsonSize)).toString('utf8'));
    const entries = new Map();
    for (const path of wanted) {
      let node = header;
      for (const part of path.split('/')) {
        node = node?.files?.[part];
        if (node === undefined) throw new Error(`安装包缺少文件：${path}`);
      }
      if (node.unpacked === true || node.link !== undefined
        || !Number.isSafeInteger(node.size) || node.size < 0 || node.size > 20 * 1024 * 1024
        || typeof node.offset !== 'string' || !/^\d+$/u.test(node.offset)) {
        throw new Error(`安装包文件格式不受支持：${path}`);
      }
      const offset = Number(node.offset);
      const position = 8 + headerSize + offset;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(position)
        || position + node.size > stat.size) {
        throw new Error(`安装包文件越界：${path}`);
      }
      entries.set(path, await readExactly(handle, position, node.size));
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** Verify the exact installed bundle and apply the two reviewed loop seams. */
export function adaptAgentLoop(source, officialImports, profile = {}) {
  const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  if (digest(bytes) !== (profile.sourceSha256 ?? UPSTREAM_SHA256)) {
    throw new Error('DSH AgentLoop SHA-256 不匹配，拒绝生成兼容包。');
  }
  const original = bytes.toString('utf8');
  const construction = profile.construction ?? CONSTRUCTION;
  const replacement = profile.replacement ?? REPLACEMENT;
  const first = original.indexOf(construction);
  if (first < 0 || original.indexOf(construction, first + construction.length) >= 0
    || original.includes(IMPORT)) {
    throw new Error('DSH AgentLoop 的构造点不唯一或已被修改。');
  }
  const closing = profile.stepEnd ?? STEP_END;
  const stepEnd = original.indexOf(closing);
  if (stepEnd < 0 || original.indexOf(closing, stepEnd + closing.length) >= 0
    || original.includes('/* bridge-step-end-start */')) {
    throw new Error('DSH AgentLoop 的 step/end 闭合点不唯一或已被修改。');
  }
  let adapted = (profile.imports ?? (COMPATIBILITY_IMPORT + RESOLVER_IMPORT + IMPORT))
    + original.slice(0, first) + replacement + original.slice(first + construction.length);
  adapted = adapted.replace(closing, STEP_END_REPLACEMENT);
  if (officialImports === null || typeof officialImports !== 'object') {
    throw new Error('缺少安装版 DSH 模块映射。');
  }
  for (const name of OFFICIAL_MODULES) {
    const entry = officialImports[name];
    if (typeof entry !== 'string' || !entry.startsWith('dsh/node_modules/')) {
      throw new Error(`缺少安装版 DSH 模块映射：${name}`);
    }
    const before = `from ${JSON.stringify(name)};`;
    const at = adapted.indexOf(before);
    if (at < 0 || adapted.indexOf(before, at + before.length) >= 0) {
      throw new Error(`DSH AgentLoop 模块导入不唯一：${name}`);
    }
    const start = adapted.lastIndexOf('\n', at) + 1;
    const line = adapted.slice(start, at + before.length);
    const match = /^import (.+) from "[^"]+";$/u.exec(line);
    if (!match) throw new Error(`DSH AgentLoop 模块导入格式异常：${name}`);
    const clause = match[1].startsWith('{')
      ? match[1].replace(/\s+as\s+/gu, ': ')
      : `{ default: ${match[1]} }`;
    const replacement = `const ${clause} = await import(resolveDshModule(${JSON.stringify(name)}));`;
    adapted = adapted.slice(0, start) + replacement + adapted.slice(at + before.length);
  }
  return Buffer.from(adapted, 'utf8');
}

/** Resolve only the root ESM exports declared by the verified installation. */
function esmEntry(manifest, expectedName) {
  if (manifest.name !== expectedName) throw new Error(`安装包模块名称不匹配：${expectedName}`);
  const root = manifest.exports?.['.'];
  const entry = typeof root === 'string' ? root : root?.import ?? root?.default;
  if (typeof entry !== 'string' || !/^\.\/[a-zA-Z0-9_./-]+$/u.test(entry)
    || entry.split('/').includes('..')) {
    throw new Error(`不支持的 DSH ESM 导出：${expectedName}`);
  }
  return entry.slice(2);
}

async function ensureFile(path, expected) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !(await readFile(path)).equals(expected)) {
      throw new Error(`目标文件已存在且内容不同：${path}`);
    }
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const file = await open(path, 'wx');
  try {
    await file.writeFile(expected);
  } finally {
    await file.close();
  }
}

export async function prepareCompatibility(archivePath) {
  if (typeof archivePath !== 'string' || archivePath.trim() === '') {
    throw new Error('请提供 DSH Desktop rc.5 的 app.asar 路径。');
  }
  const sourcePath = `${PACKAGE_BASE}/lib/index.js`;
  const licensePath = `${PACKAGE_BASE}/LICENSE`;
  const packagePath = `${PACKAGE_BASE}/package.json`;
  const archive = resolve(archivePath);
  const modules = [...OFFICIAL_MODULES, ...RUNTIME_MODULES];
  const manifestPaths = modules.map(name => `dsh/node_modules/${name}/package.json`);
  const sessionClientPath = `${SESSION_BASE}/lib/client.js`;
  const sessionLicensePath = `${SESSION_BASE}/LICENSE`;
  const entries = await readArchiveEntries(archive, [sourcePath, licensePath, packagePath,
    sessionClientPath, sessionLicensePath, ...manifestPaths]);
  const source = entries.get(sourcePath);
  const license = entries.get(licensePath);
  const manifest = JSON.parse(entries.get(packagePath).toString('utf8'));
  if (manifest.name !== '@deepseek-ai/dsh-agent-loop' || manifest.version !== RELEASE
    || manifest.license !== 'MIT' || digest(license) !== LICENSE_SHA256) {
    throw new Error('安装包不是已核对的 DSH AgentLoop rc.5。');
  }
  const sessionManifest = JSON.parse(entries.get(`${SESSION_BASE}/package.json`).toString('utf8'));
  const sessionClient = entries.get(sessionClientPath);
  const sessionLicense = entries.get(sessionLicensePath);
  if (sessionManifest.name !== SESSION_PACKAGE || sessionManifest.version !== RELEASE
    || sessionManifest.license !== 'MIT' || sessionManifest.dsh?.client?.platform !== 'web'
    || digest(sessionClient) !== SESSION_CLIENT_SHA256 || digest(sessionLicense) !== LICENSE_SHA256) {
    throw new Error('安装包不是已核对的 DSH 会话客户端 rc.5。');
  }
  const officialImports = {};
  const officialEntryPaths = [];
  for (let index = 0; index < modules.length; index++) {
    const name = modules[index];
    const packageManifest = JSON.parse(entries.get(manifestPaths[index]).toString('utf8'));
    const entryPath = `dsh/node_modules/${name}/${esmEntry(packageManifest, name)}`;
    officialEntryPaths.push(entryPath);
    officialImports[name] = entryPath;
  }
  // Ensure every declared target is a packed regular file before emitting URLs.
  await readArchiveEntries(archive, officialEntryPaths);
  const adapted = adaptAgentLoop(source, officialImports);
  const specifier = name => `await import(resolveDshModule(${JSON.stringify(name)}))`;
  const runtime = Buffer.from([
    '// Generated from the installed rc.5 ASAR; do not edit.',
    COMPATIBILITY_IMPORT.trimEnd(),
    RESOLVER_IMPORT.trimEnd(),
    `export const { Service } = ${specifier('@deepseek-ai/cordis')};`,
    `export const { default: schema } = ${specifier('@deepseek-ai/schemastery')};`,
    `export const { LlmAdapter, createAssistantMessage, createToolResultMessage, createSystemMessage, AssistantStreamAccumulator, BlockAssembler } = ${specifier('@deepseek-ai/dsh-llm')};`,
    `export const { renderPrompt, renderContextSections, joinContextSections } = ${specifier('@deepseek-ai/dsh-system-prompt')};`,
    `export const { assembleContextFor } = ${specifier('@deepseek-ai/dsh-agent')};`,
    `export const { SessionController } = ${specifier('@deepseek-ai/dsh-api-session-controller')};`,
    `export const { AgentPresetRegistry } = ${specifier('@deepseek-ai/dsh-agent-preset-registry')};`,
    `export const { RemoteError, Remote, TypertRemoteService, principalOf, remoteMethods } = ${specifier('@deepseek-ai/dsh-typert-protocol')};`,
    `export const { entryListSchema } = ${specifier('@deepseek-ai/cordis-plugin-include')};`,
    `export const { load: loadYaml } = ${specifier('js-yaml')};`,
    `export const { resolveDshHome } = ${specifier('@deepseek-ai/dsh-home-paths')};`,
    `export const { credentialKey } = ${specifier('@deepseek-ai/dsh-credentials')};`,
    '',
  ].join('\n'));
  const provenance = Buffer.from(`${JSON.stringify({
    package: manifest.name,
    version: RELEASE,
    license: manifest.license,
    repository: 'https://github.com/deepseek-ai/deepseek-harness',
    commit: COMMIT,
    sourceSha256: UPSTREAM_SHA256,
    adaptedSha256: digest(adapted),
    runtimeSha256: digest(runtime),
    officialImports,
    changes: ['导入桥接构造器', '替换唯一 Agent 构造调用', '仅远程 Agent 按动态 step 闭合', '将官方依赖绑定到安装版 ESM 单例', '加载前按 Host 能力检查兼容性'],
  }, null, 2)}\n`);
  const output = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'compat');
  const sessionOutput = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'session-client');
  await mkdir(output, { recursive: true });
  await mkdir(sessionOutput, { recursive: true });
  await ensureFile(join(output, 'agent-loop.original.mjs'), source);
  await ensureFile(join(output, 'agent-loop.mjs'), adapted);
  await ensureFile(join(output, 'runtime.mjs'), runtime);
  await ensureFile(join(output, 'LICENSE'), license);
  await ensureFile(join(output, 'provenance.json'), provenance);
  const sessionPackage = Buffer.from(`${JSON.stringify({
    name: SESSION_PACKAGE,
    version: RELEASE,
    private: true,
    type: 'module',
    exports: { '.': './index.mjs', './client': './client.js', './package.json': './package.json' },
    dsh: { client: sessionManifest.dsh.client },
    license: 'MIT',
  }, null, 2)}\n`);
  const sessionProvenance = Buffer.from(`${JSON.stringify({
    package: SESSION_PACKAGE,
    version: RELEASE,
    license: 'MIT',
    repository: 'https://github.com/deepseek-ai/deepseek-harness',
    commit: COMMIT,
    clientSha256: SESSION_CLIENT_SHA256,
    source: `${SESSION_BASE}/lib/client.js`,
  }, null, 2)}\n`);
  await ensureFile(join(sessionOutput, 'package.json'), sessionPackage);
  await ensureFile(join(sessionOutput, 'client.js'), sessionClient);
  await ensureFile(join(sessionOutput, 'LICENSE'), sessionLicense);
  await ensureFile(join(sessionOutput, 'provenance.json'), sessionProvenance);
  return { directory: output, sourceSha256: UPSTREAM_SHA256, adaptedSha256: digest(adapted) };
}

const invoked = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invoked === resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length !== 3) throw new Error('用法：node scripts/prepare-dsh-compat.mjs <app.asar 路径>');
    const result = await prepareCompatibility(process.argv[2]);
    process.stdout.write(`已准备 DSH rc.5 兼容源码：${result.directory}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
