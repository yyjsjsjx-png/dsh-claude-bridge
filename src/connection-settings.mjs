import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

const DEFAULT_KEY = 'dsh-claude-bridge/connection'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/
const DEVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class ConnectionSettingsError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ConnectionSettingsError'
    this.code = code
  }
}

/** Accept WSS URLs and loopback-only WS URLs without credentials or query strings. */
export function validateServerUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new ConnectionSettingsError('INVALID_URL', '服务器地址无效')
  }
  const input = value.trim()
  if (/[\s?#]/u.test(input)) throw new ConnectionSettingsError('INVALID_URL', '服务器地址不能包含空格、查询参数或片段')
  let url
  try { url = new URL(input) } catch { throw new ConnectionSettingsError('INVALID_URL', '服务器地址无效') }
  if (url.username || url.password || !url.hostname || url.search || url.hash) {
    throw new ConnectionSettingsError('INVALID_URL', '服务器地址不能包含凭据、查询参数或片段')
  }
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new ConnectionSettingsError('INSECURE_URL', '远程服务器必须使用 wss')
  }
  return url.href
}

export function validateConnectionToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new ConnectionSettingsError('INVALID_TOKEN', '连接凭据格式无效')
  }
  return token
}

/** Check decoded path forms too, so URL encoding cannot conceal a token. */
export function urlContainsToken(url, token) {
  let candidate = url
  for (let index = 0; index < 3; index++) {
    if (candidate.includes(token)) return true
    let decoded
    try { decoded = decodeURIComponent(candidate) } catch { break }
    if (decoded === candidate) break
    candidate = decoded
  }
  return false
}

export function validateDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw new ConnectionSettingsError('INVALID_DEVICE_ID', '设备标识无效')
  }
  return deviceId.toLowerCase()
}

function readPayload(record) {
  if (!record || record.kind !== 'grant' || !record.payload || typeof record.payload !== 'object'
    || record.payload.version !== 1 || typeof record.payload.url !== 'string'
    || typeof record.payload.token !== 'string') return undefined
  try {
    return { url: validateServerUrl(record.payload.url), token: validateConnectionToken(record.payload.token) }
  } catch {
    return undefined
  }
}

async function readConfig(configPath) {
  let text
  try { text = await readFile(configPath, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new ConnectionSettingsError('SETTINGS_READ_FAILED', '连接设置无法读取')
  }
  let value
  try { value = JSON.parse(text) } catch { throw new ConnectionSettingsError('SETTINGS_INVALID', '连接设置格式无效') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || typeof value.url !== 'string'
    || Object.keys(value).some((key) => !['version', 'url', 'deviceId'].includes(key))) {
    throw new ConnectionSettingsError('SETTINGS_INVALID', '连接设置格式无效')
  }
  return { version: 1, url: validateServerUrl(value.url),
    ...(value.deviceId === undefined ? {} : { deviceId: validateDeviceId(value.deviceId) }) }
}

async function writeConfig(configPath, url, deviceId) {
  const dir = dirname(configPath)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temporary = join(dir, `.${basename(configPath)}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify({ version: 1, url, deviceId })}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, configPath)
  } catch {
    if (handle) await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw new ConnectionSettingsError('SETTINGS_WRITE_FAILED', '连接设置无法保存')
  }
}

/**
 * Use rc5 `ctx.credentials` record operations. The JSON file stores only the
 * address; the credential record binds that address to its token. A mismatched
 * pair is rejected, including after a partially failed save.
 */
export function createConnectionSettings({ configPath, credentials, credentialKey = DEFAULT_KEY, deviceId: requestedDeviceId }) {
  if (typeof configPath !== 'string' || !isAbsolute(configPath)) {
    throw new TypeError('configPath 必须是绝对路径')
  }
  if (!credentials || typeof credentials.readRecord !== 'function'
    || typeof credentials.modifyRecord !== 'function' || typeof credentials.deleteRecord !== 'function') {
    throw new TypeError('需要 DSH 凭据记录接口')
  }
  if (typeof credentialKey !== 'string' || !/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(credentialKey)) {
    throw new TypeError('凭据记录标识无效')
  }
  const deviceId = requestedDeviceId === undefined ? undefined : validateDeviceId(requestedDeviceId)

  async function read() {
    const config = await readConfig(configPath)
    if (!config) return { url: undefined, configured: false, status: 'missing' }
    if (deviceId && config.deviceId && config.deviceId !== deviceId) {
      return { url: config.url, configured: false, status: 'device_id_mismatch' }
    }
    const record = readPayload(await credentials.readRecord(credentialKey))
    if (!record) return { url: config.url, configured: false, status: 'credential_missing' }
    if (record.url !== config.url) return { url: config.url, configured: false, status: 'credential_mismatch' }
    if (!config.deviceId) return { url: config.url, configured: false, status: 'device_id_missing' }
    return { url: config.url, configured: true, status: 'ready' }
  }

  async function save({ url: rawUrl, token } = {}) {
    const url = validateServerUrl(rawUrl)
    // Refuse an address that embeds the newly supplied credential in its path.
    if (token !== undefined && urlContainsToken(url, validateConnectionToken(token))) {
      throw new ConnectionSettingsError('INVALID_URL', '服务器地址不能包含连接凭据')
    }
    // Do not overwrite a file that is not our own valid settings document.
    await readConfig(configPath)
    await credentials.modifyRecord(credentialKey, async (current) => {
      const previous = readPayload(current)
      const selected = token === undefined
        ? (previous?.url === url ? previous.token : undefined)
        : validateConnectionToken(token)
      if (!selected) throw new ConnectionSettingsError('TOKEN_REQUIRED', '更换服务器地址时需要对应的连接凭据')
      if (urlContainsToken(url, selected)) throw new ConnectionSettingsError('INVALID_URL', '服务器地址不能包含连接凭据')
      const existing = await readConfig(configPath)
      if (deviceId && existing?.deviceId && existing.deviceId !== deviceId) {
        throw new ConnectionSettingsError('DEVICE_ID_MISMATCH', '连接设置与本机设备标识不一致')
      }
      const selectedDeviceId = deviceId ?? existing?.deviceId ?? randomUUID()
      await writeConfig(configPath, url, selectedDeviceId)
      return { kind: 'grant', payload: { version: 1, url, token: selected } }
    })
    return { url, configured: true, status: 'ready' }
  }

  async function resolve() {
    const config = await readConfig(configPath)
    if (!config) throw new ConnectionSettingsError('SETTINGS_MISSING', '尚未配置服务器地址')
    if (!config.deviceId) throw new ConnectionSettingsError('DEVICE_ID_MISSING', '设备标识尚未创建')
    if (deviceId && config.deviceId !== deviceId) {
      throw new ConnectionSettingsError('DEVICE_ID_MISMATCH', '连接设置与本机设备标识不一致')
    }
    const record = readPayload(await credentials.readRecord(credentialKey))
    if (!record) throw new ConnectionSettingsError('TOKEN_MISSING', '尚未配置连接凭据')
    if (record.url !== config.url) throw new ConnectionSettingsError('CREDENTIAL_MISMATCH', '连接凭据与服务器地址不匹配')
    if (urlContainsToken(config.url, record.token)) throw new ConnectionSettingsError('INVALID_URL', '服务器地址不能包含连接凭据')
    return { url: config.url, token: record.token, deviceId: config.deviceId }
  }

  async function clearToken() {
    await credentials.deleteRecord(credentialKey)
  }

  return { read, save, resolve, clearToken }
}
