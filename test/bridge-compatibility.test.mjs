import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBridgeCompatibility, bridgeCompatibilityAllowed } from '../src/bridge-compatibility.mjs';

test('仅服务端升级不强制旧客户端更新，也不按主次版本差异拒绝', () => {
  for (const minimumClientVersion of [undefined, null]) {
    for (const clientVersion of ['0.2.2', '1.0.0', undefined]) {
      const info = evaluateBridgeCompatibility({ clientVersion, serverVersion: '50.20.3', minimumClientVersion });
      assert.equal(info.status, 'compatible');
      assert.equal(info.serverVersion, '50.20.3');
      assert.equal(bridgeCompatibilityAllowed(info), true);
    }
  }
});

test('最低客户端要求只阻止低版本或未知客户端，等于和更高版本可继续', () => {
  const check = clientVersion => evaluateBridgeCompatibility({ clientVersion,
    serverVersion: '0.3.0', minimumClientVersion: '0.2.3' });
  for (const client of ['0.2.2', undefined, '', 'unknown-client']) {
    const info = check(client);
    assert.equal(info.status, 'update-required');
    assert.match(info.message, /客户端至少需要 0\.2\.3/);
    assert.equal(bridgeCompatibilityAllowed(info), false);
  }
  for (const client of ['0.2.3', '0.2.4', '1.0.0']) assert.equal(check(client).status, 'compatible');
});

test('无版本老服务端和无版本老客户端按实际最低要求协商', () => {
  for (const value of [{}, { clientVersion: '0.2.2' }, { minimumClientVersion: null }]) {
    assert.equal(evaluateBridgeCompatibility(value).status, 'legacy');
  }
  assert.equal(evaluateBridgeCompatibility({ serverVersion: '0.2.3' }).status, 'compatible');
  assert.equal(evaluateBridgeCompatibility({ minimumClientVersion: '0.2.3' }).status, 'update-required');
  assert.equal(evaluateBridgeCompatibility({ clientVersion: '0.2.3', minimumClientVersion: '0.2.3' }).status, 'compatible');
});

test('SemVer 正确比较稳定版、rc、数字标识和先行标识长度', () => {
  const cases = [
    ['1.2.3-rc.1', '1.2.3', 'update-required'],
    ['1.2.3', '1.2.3-rc.99', 'compatible'],
    ['1.2.3-rc.2', '1.2.3-rc.10', 'update-required'],
    ['1.2.3-rc.10', '1.2.3-rc.2', 'compatible'],
    ['1.2.3-1', '1.2.3-alpha', 'update-required'],
    ['1.2.3-alpha', '1.2.3-1', 'compatible'],
    ['1.2.3-alpha', '1.2.3-alpha.1', 'update-required'],
    ['1.2.3-beta', '1.2.3-alpha.99', 'compatible'],
  ];
  for (const [clientVersion, minimumClientVersion, status] of cases) {
    assert.equal(evaluateBridgeCompatibility({ clientVersion, serverVersion: '9.0.0', minimumClientVersion }).status,
      status, `${clientVersion} / ${minimumClientVersion}`);
  }
});

test('构建信息不参与先后比较，超出安全整数的数字标识不丢精度', () => {
  const cases = [
    ['1.2.3+client.00', '1.2.3+server.42', 'compatible'],
    ['1.2.3-rc.2+client', '1.2.3-rc.2+server', 'compatible'],
    ['9007199254740992.0.0', '9007199254740993.0.0', 'update-required'],
    ['1.2.3-9007199254740992', '1.2.3-9007199254740993', 'update-required'],
  ];
  for (const [clientVersion, minimumClientVersion, status] of cases) {
    assert.equal(evaluateBridgeCompatibility({ clientVersion, serverVersion: '9.0.0', minimumClientVersion }).status, status);
  }
});

test('非法或过长的服务端声明拒绝协商，消息不回显任意输入', () => {
  const invalid = ['v1.2.3', '01.2.3', '1.02.3', '1.2', '1.2.3-rc.01', '1.2.3-', '1.2.3+a..b',
    '1.2.3\n', '1.2.3\r\n', '1.2.3 ', '1.2.3\nUNTRUSTED_DECLARATION',
    '1.2.3+' + 'a'.repeat(251), 123, {}, false];
  for (const declaration of invalid) {
    for (const fields of [{ serverVersion: declaration }, { serverVersion: '1.2.3', minimumClientVersion: declaration }]) {
      const info = evaluateBridgeCompatibility({ clientVersion: '1.2.3', ...fields });
      assert.equal(info.status, 'invalid');
      assert.equal(bridgeCompatibilityAllowed(info), false);
      assert.doesNotMatch(info.message, /UNTRUSTED|v1\.2\.3|rc\.01|a{10}/);
    }
  }
  assert.equal(evaluateBridgeCompatibility({ serverVersion: null }).status, 'invalid');
  for (const input of [null, [], 1]) assert.equal(evaluateBridgeCompatibility(input).status, 'invalid');
});

test('返回字段只保留通过校验的声明，允许状态仅为compatible或legacy', () => {
  const info = evaluateBridgeCompatibility({ clientVersion: 'untrusted-client', serverVersion: '1.2.3', minimumClientVersion: '1.2.3' });
  assert.deepEqual(info, { status: 'update-required', clientVersion: undefined, serverVersion: '1.2.3',
    minimumClientVersion: '1.2.3', message: '客户端至少需要 1.2.3，请更新客户端后连接。' });
  for (const status of ['invalid', 'update-required', 'unchecked', undefined]) {
    assert.equal(bridgeCompatibilityAllowed({ status }), false);
  }
  assert.equal(bridgeCompatibilityAllowed(null), false);
  assert.equal(bridgeCompatibilityAllowed({ status: 'legacy' }), true);
});
