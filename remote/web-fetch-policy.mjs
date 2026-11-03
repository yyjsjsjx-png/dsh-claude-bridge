import { lookup } from 'node:dns/promises'
import { BlockList } from 'node:net'

const nonPublicV4 = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) nonPublicV4.addSubnet(network, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const nonPublicV6 = new BlockList()
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  nonPublicV6.addSubnet(network, prefix, 'ipv6')
}

// Reject a known non-public answer. Claude Code owns the actual connection
// and its redirect checks; this lookup cannot pin DNS for that connection.
export async function hasPublicWebAddresses(url, { resolve = lookup, timeoutMs = 3000 } = {}) {
  let timer
  try {
    const records = await Promise.race([
      resolve(new URL(url).hostname, { all: true }),
      new Promise(resolve => { timer = setTimeout(() => resolve([]), timeoutMs) }),
    ])
    return records.length > 0 && records.every(({ address, family }) => family === 4
      ? !nonPublicV4.check(address, 'ipv4')
      : family === 6 && globalV6.check(address, 'ipv6') && !nonPublicV6.check(address, 'ipv6'))
  } catch { return false } finally { clearTimeout(timer) }
}
