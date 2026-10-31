import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnectionSettings, validateServerUrl } from '../src/connection-settings.mjs'

function fakeCredentials() {
  const records = new Map()
  let pending = Promise.resolve()
  let failCommit = false
  return {
    setFailCommit(value) { failCommit = value },
    async readRecord(key) { return structuredClone(records.get(key)) },
    modifyRecord(key, mutate) {
      const operation = pending.then(async () => {
        const result = await mutate(structuredClone(records.get(key)))
        if (failCommit) throw new Error('credential write failed')
        if (result !== undefined) records.set(key, structuredClone(result))
        return structuredClone(records.get(key))
      })
      pending = operation.catch(() => {})
      return operation
    },
    async deleteRecord(key) { records.delete(key) },
  }
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-connection-test-'))
  const configPath = join(directory, 'connection.json')
  const credentials = fakeCredentials()
  t.after(async () => {
    await unlink(configPath).catch((error) => { if (error.code !== 'ENOENT') throw error })
    await rmdir(directory)
  })
  return { directory, configPath, credentials, settings: createConnectionSettings({ configPath, credentials, ...options }) }
}

test('地址与凭据分别保存，设备标识稳定且公开读取不含 token', async (t) => {
  const deviceId = randomUUID()
  const { configPath, directory, settings } = await fixture(t, { deviceId })
  const token = 'T'.repeat(43)
  await settings.save({ url: 'wss://example.test/bridge', token })
  assert.deepEqual(await settings.read(), { url: 'wss://example.test/bridge', configured: true, status: 'ready' })
  assert.deepEqual(await settings.resolve(), { url: 'wss://example.test/bridge', token, deviceId })
  const disk = await readFile(configPath, 'utf8')
  assert.doesNotMatch(disk, new RegExp(token))
  assert.equal(JSON.parse(disk).deviceId, deviceId)
  assert.deepEqual(await readdir(directory), ['connection.json'])
  await settings.save({ url: 'wss://example.test/bridge' })
  assert.equal((await settings.resolve()).deviceId, deviceId)
  await settings.clearToken()
  assert.equal((await settings.read()).status, 'credential_missing')
})

test('远程地址要求 WSS，拒绝地址凭据、查询参数与不安全 WS', () => {
  assert.equal(validateServerUrl('ws://127.0.0.1:18944'), 'ws://127.0.0.1:18944/')
  assert.equal(validateServerUrl('ws://localhost:18944/bridge'), 'ws://localhost:18944/bridge')
  assert.equal(validateServerUrl('wss://example.test/bridge'), 'wss://example.test/bridge')
  for (const url of [
    'ws://example.test/bridge', 'http://localhost/', 'wss://user:pass@example.test/',
    'wss://example.test/?token=value', 'wss://example.test/#secret', 'wss://example.test/path with spaces',
  ]) assert.throws(() => validateServerUrl(url))
})

test('清除连接移除地址和专属凭据，重复清除安全且重新保存沿用设备身份', async t => {
  const deviceId = randomUUID()
  const { directory, credentials, settings } = await fixture(t, { deviceId })
  await credentials.modifyRecord('other-plugin/connection', () => ({ kind: 'grant', payload: { unrelated: true } }))
  await settings.save({ url: 'wss://example.test/', token: 'C'.repeat(43) })
  await settings.clear()
  assert.deepEqual(await settings.read(), { url: undefined, configured: false, status: 'missing' })
  assert.deepEqual(await readdir(directory), [])
  assert.equal(await credentials.readRecord('dsh-claude-bridge/connection'), undefined)
  assert.equal((await credentials.readRecord('other-plugin/connection')).payload.unrelated, true)
  await assert.rejects(settings.resolve(), { code: 'SETTINGS_MISSING' })
  await settings.clear()
  await settings.save({ url: 'wss://example.test/', token: 'D'.repeat(43) })
  assert.equal((await settings.resolve()).deviceId, deviceId)
})

test('地址与凭据不匹配时停止连接，失败保存不覆盖已有凭据', async (t) => {
  const { configPath, credentials, settings } = await fixture(t)
  const token = 'A'.repeat(43)
  await settings.save({ url: 'wss://first.test/', token })
  await assert.rejects(settings.save({ url: 'wss://second.test/' }), { code: 'TOKEN_REQUIRED' })
  assert.equal((await settings.resolve()).url, 'wss://first.test/')
  credentials.setFailCommit(true)
  await assert.rejects(settings.save({ url: 'wss://second.test/', token: 'B'.repeat(43) }))
  assert.equal((await settings.read()).status, 'credential_mismatch')
  await assert.rejects(settings.resolve(), { code: 'CREDENTIAL_MISMATCH' })
  assert.doesNotMatch(await readFile(configPath, 'utf8'), /A{43}|B{43}/)
})

test('禁止把凭据放进 URL，即使路径进行了编码', async (t) => {
  const { settings } = await fixture(t)
  const token = 'T'.repeat(43)
  await assert.rejects(settings.save({ url: `wss://example.test/${token}`, token }), { code: 'INVALID_URL' })
  await assert.rejects(settings.save({ url: `wss://example.test/${'%54'.repeat(43)}`, token }), { code: 'INVALID_URL' })
})

test('设备标识必须一致，未知配置字段不会被覆盖', async (t) => {
  const firstDevice = randomUUID()
  const { configPath, credentials, settings } = await fixture(t, { deviceId: firstDevice })
  await settings.save({ url: 'wss://example.test/', token: 'C'.repeat(43) })
  const other = createConnectionSettings({ configPath, credentials, deviceId: randomUUID() })
  assert.equal((await other.read()).status, 'device_id_mismatch')
  await assert.rejects(other.resolve(), { code: 'DEVICE_ID_MISMATCH' })
  await assert.rejects(other.save({ url: 'wss://example.test/' }), { code: 'DEVICE_ID_MISMATCH' })
  const original = JSON.parse(await readFile(configPath, 'utf8'))
  await writeFile(configPath, JSON.stringify({ ...original, unexpected: true }))
  await assert.rejects(settings.save({ url: 'wss://example.test/' }), { code: 'SETTINGS_INVALID' })
})
