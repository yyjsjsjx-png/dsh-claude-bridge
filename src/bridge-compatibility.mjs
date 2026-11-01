/** Pure release negotiation; metadata absence remains compatible with legacy peers. */
const MAX_VERSION_LENGTH = 256;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseVersion(value) {
  if (typeof value !== 'string' || value.length > MAX_VERSION_LENGTH) return undefined;
  const match = SEMVER.exec(value);
  if (!match || match[0] !== value) return undefined;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^[0-9]+$/.test(part) && part.length > 1 && part[0] === '0')) return undefined;
  return { value, core: match.slice(1, 4), prerelease };
}

// Decimal strings avoid precision loss for valid identifiers above MAX_SAFE_INTEGER.
function compareNumeric(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    const order = compareNumeric(left.core[index], right.core[index]);
    if (order) return order;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length ? -1 : right.prerelease.length ? 1 : 0;
  }
  const count = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index++) {
    const a = left.prerelease[index], b = right.prerelease[index];
    if (a === b) continue;
    const aNumeric = /^[0-9]+$/.test(a), bNumeric = /^[0-9]+$/.test(b);
    if (aNumeric && bNumeric) return compareNumeric(a, b);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return Math.sign(left.prerelease.length - right.prerelease.length);
}

export function evaluateBridgeCompatibility(input = {}) {
  const invalidInput = input === null || typeof input !== 'object' || Array.isArray(input);
  const { clientVersion, serverVersion, minimumClientVersion } = invalidInput ? {} : input;
  const client = parseVersion(clientVersion);
  const server = parseVersion(serverVersion);
  const minimum = parseVersion(minimumClientVersion);
  const result = (status, message) => ({ status, clientVersion: client?.value, serverVersion: server?.value,
    minimumClientVersion: minimumClientVersion === null ? null : minimum?.value, message });
  if (invalidInput || (serverVersion !== undefined && !server)
    || (minimumClientVersion !== undefined && minimumClientVersion !== null && !minimum)) {
    return result('invalid', '服务器版本声明无效，暂不能确认兼容性。');
  }
  if (minimum && (!client || compareVersions(client, minimum) < 0)) {
    return result('update-required', `客户端至少需要 ${minimum.value}，请更新客户端后连接。`);
  }
  if (!server && !minimum) return result('legacy', '服务器未声明版本要求，按旧版兼容方式连接。');
  return result('compatible', '客户端满足服务器的版本要求。');
}

export function bridgeCompatibilityAllowed(info) {
  return info?.status === 'compatible' || info?.status === 'legacy';
}
