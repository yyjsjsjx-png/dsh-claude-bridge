import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertHostModule, assertRpcParameters } from '../plugin/compat/host-contract.mjs';
import { resolveDshModule, readShippedStandardPreset } from '../plugin/compat/resolve-dsh-module.mjs';

test('Host 能力检查允许新版本和新增导出，缺少必需接口才拒绝', () => {
  const module = { createScope() {}, scopeOf() {}, newOptionalFeature() {} };
  for (const version of ['0.2.1-rc.6', '0.2.2', '0.3.0', '1.0.0']) {
    assert.doesNotThrow(() => assertHostModule('@deepseek-ai/dsh-scope', module, version));
  }
  assert.throws(() => assertHostModule('@deepseek-ai/dsh-scope', { createScope: null }, '0.3.0'), error => {
    assert.equal(error.code, 'DSH_API_INCOMPATIBLE');
    assert.match(error.message, /插件无法加载.*0\.3\.0.*createScope/u);
    return true;
  });
});

test('源模式 RPC 参数保持兼容，新增可选参数可用，重命名参数明确拒绝', () => {
  const same = { async select(agent, agentPreset, options = {}) {} };
  const changed = { async select(agent, preset) {} };
  assert.doesNotThrow(() => assertRpcParameters(same.select, ['agent', 'agentPreset'], 'select', '0.3.0'));
  assert.throws(() => assertRpcParameters(changed.select, ['agent', 'agentPreset'], 'select', '0.3.0'),
    error => error.code === 'DSH_API_INCOMPATIBLE' && /RPC 参数已改变/u.test(error.message));
});

test('升级后的安装版可解析新 ESM 条件导出和变更的标准预设，不再校验旧摘要', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-compat-'));
  const previous = process.env.DSH_CLAUDE_BRIDGE_RESOURCES;
  try {
    const base = join(directory, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
    for (const name of ['dsh-agent-loop', 'dsh-scope', 'dsh-web-app']) {
      await mkdir(join(base, name, 'lib'), { recursive: true });
    }
    await writeFile(join(base, 'dsh-agent-loop/package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-agent-loop', version: '0.3.0',
    }));
    await writeFile(join(base, 'dsh-scope/package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-scope', version: '0.3.0',
      exports: { '.': { types: './lib/index.d.ts', node: { import: './lib/updated.mjs' } } },
    }));
    await writeFile(join(base, 'dsh-scope/lib/updated.mjs'), 'export function createScope() {}\n');
    await writeFile(join(base, 'dsh-web-app/package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-web-app', version: '0.3.0',
    }));
    await mkdir(join(base, 'dsh-web-app/presets'));
    const content = '# A future release may add ordinary tools and comments.\n- insert: []\n';
    await writeFile(join(base, 'dsh-web-app/presets/standard.patch.yml'), content);
    process.env.DSH_CLAUDE_BRIDGE_RESOURCES = directory;
    assert.equal(resolveDshModule('@deepseek-ai/dsh-scope'),
      pathToFileURL(join(base, 'dsh-scope/lib/updated.mjs')).href);
    assert.equal(readShippedStandardPreset().content, content);
    assert.throws(() => resolveDshModule('not-allowed'), /不支持的 DSH 模块/u);
    await writeFile(join(base, 'dsh-scope/package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-scope', exports: { '.': '../outside.mjs' },
    }));
    // A fresh resolver avoids reusing the successful module resolution cache.
    const { resolveDshModule: freshResolver } = await import(`../plugin/compat/resolve-dsh-module.mjs?invalid=${Date.now()}`);
    assert.throws(() => freshResolver('@deepseek-ai/dsh-scope'), error => error.code === 'DSH_API_INCOMPATIBLE');
  } finally {
    if (previous === undefined) delete process.env.DSH_CLAUDE_BRIDGE_RESOURCES;
    else process.env.DSH_CLAUDE_BRIDGE_RESOURCES = previous;
    assert.equal(dirname(directory), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('dsh-bridge-compat-'));
    await rm(directory, { recursive: true, force: true });
  }
});
