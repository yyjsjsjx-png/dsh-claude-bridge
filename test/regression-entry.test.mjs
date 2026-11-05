import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_DESKTOP_VERSION, DESKTOP_VERSIONS, desktopVersion, regressionOptions } from '../scripts/run-regression.mjs';
import { DESKTOP_URL, desktopDownloadUrl, preparationOptions } from '../scripts/prepare-ci-dsh.mjs';

test('原生证据入口默认新版，旧版可明确选择，不接受未经审查的版本或注入文本', () => {
  assert.equal(DEFAULT_DESKTOP_VERSION, '0.2.2-rc.1');
  assert.deepEqual(DESKTOP_VERSIONS, ['0.2.1-rc.5', '0.2.2-rc.1']);
  assert.equal(regressionOptions([]).desktopVersion, DEFAULT_DESKTOP_VERSION);
  for (const version of DESKTOP_VERSIONS) {
    assert.equal(regressionOptions(['--layer', 'native', '--desktop-version', version]).desktopVersion, version);
    assert.equal(preparationOptions(['--desktop-version', version]).desktopVersion, version);
    assert.equal(desktopDownloadUrl(version), `https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-${version}-win-x64.exe`);
  }
  assert.equal(DESKTOP_URL, desktopDownloadUrl(DEFAULT_DESKTOP_VERSION));
  for (const version of ['latest', '0.2.2-alpha.3', "';process.exit(0);//"]) {
    assert.throws(() => desktopVersion(version), /桌面回归基线/);
    assert.throws(() => desktopDownloadUrl(version), /桌面回归基线/);
    assert.throws(() => regressionOptions(['--desktop-version', version]), /桌面回归基线/);
    assert.throws(() => preparationOptions(['--desktop-version', version]), /桌面回归基线/);
  }
});

test('回归与下载入口拒绝未知参数、缺值以及以另一个选项冒充值', () => {
  for (const parse of [regressionOptions, preparationOptions]) {
    assert.throws(() => parse(['--desktop-version']), /未知或缺值/);
    assert.throws(() => parse(['--desktop-version', '--report', 'x']), /未知或缺值/);
    assert.throws(() => parse(['--unknown', 'value']), /未知或缺值/);
  }
  assert.throws(() => regressionOptions(['--layer', 'unexpected']), /--layer/);
});

test('CI 双桌面矩阵对下载与执行传递同一基线，工件按版本区分', async () => {
  const workflow = await readFile(new URL('../.github/workflows/rc5-regression.yml', import.meta.url), 'utf8');
  for (const version of DESKTOP_VERSIONS) assert.ok(workflow.includes(`'${version}'`));
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /prepare-ci-dsh\.mjs --desktop-version \$\{\{ matrix\.desktop-version \}\}/);
  assert.match(workflow, /run-regression\.mjs --layer native --desktop-version \$\{\{ matrix\.desktop-version \}\}/);
  assert.match(workflow, /name: desktop-native-\$\{\{ matrix\.desktop-version \}\}-results/);
});
