import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BridgeBackend } from '../src/backend.mjs'
import { catalogConnectionIdentity, catalogDisplayModels, readDisplayCatalog } from '../src/catalog-display.mjs'
import { createClaudeCatalogAdapter } from '../plugin/catalog-adapter.mjs'

const provider = 'claude-sdk-remote'
const models = [{ value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-5-5',
  inputModalities: ['text', 'image'], supportedEffortLevels: ['low', 'high'] }]
const Adapter = createClaudeCatalogAdapter(class {})

async function fixture(t, request, config = {}, directory) {
  directory ??= await mkdtemp(join(tmpdir(), 'dsh-catalog-display-'))
  const backend = new BridgeBackend({}, { stateDirectory: directory, ...config }, {
    helpers: {}, createTransport: async () => ({ peer: { async request(method, params) {
      if (method === 'initialize') return { protocolVersion: 1, authenticated: true }
      return request(method, params)
    } }, async close() {} }),
  })
  await backend.state.ready
  t.after(async () => {
    await backend.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return { backend, directory }
}

test('展示缓存仅保存目录白名单，连接身份与凭据变化隔离且不保存明文', () => {
  const grant = { transport: 'wss', url: 'wss://synthetic.invalid/bridge', token: 'synthetic-grant', deviceId: 'device' }
  const identity = catalogConnectionIdentity(grant)
  assert.notEqual(identity, catalogConnectionIdentity({ ...grant, token: 'another-grant' }))
  assert.notEqual(identity, catalogConnectionIdentity({ ...grant, url: 'wss://other.invalid/' }))
  const record = { version: 1, identity, updatedAt: 123,
    models: catalogDisplayModels([{ ...models[0], account: 'not-metadata', token: grant.token }]) }
  const serialized = JSON.stringify(record)
  for (const value of [grant.url, grant.token, 'not-metadata']) assert.equal(serialized.includes(value), false)
  assert.deepEqual(readDisplayCatalog(record, identity).models, models)
  assert.equal(readDisplayCatalog(record, 'different-identity'), undefined)
  assert.equal(readDisplayCatalog({ ...record, models: [{ value: 'broken' }] }, identity), undefined)
})

test('重启立即读取本机展示目录，执行目录时钟不恢复且 prepareCall 仍等待真实目录', async t => {
  const first = await fixture(t, async () => ({ status: 'ok', models }))
  await first.backend.catalog()
  const persisted = JSON.parse(await readFile(join(first.directory, 'state.json'), 'utf8'))
  assert.deepEqual(persisted.displayCatalog.models, models)
  let release, started
  const waiting = new Promise(resolve => { started = resolve })
  const restored = await fixture(t, async method => {
    assert.equal(method, 'catalog'); started()
    return new Promise(resolve => { release = resolve })
  }, {}, first.directory)
  const adapter = new Adapter(restored.backend)
  assert.equal(restored.backend.catalogCache, undefined)
  assert.deepEqual((await adapter.listModels(provider)).map(model => model.id), ['haiku'])
  await waiting
  assert.deepEqual((await adapter.resolveModel(provider, 'haiku')).reasoning.efforts.map(item => item.id), ['low', 'high'])
  let prepared = false
  const prepare = adapter.prepareCall(provider, 'haiku').finally(() => { prepared = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(prepared, false)
  release({ status: 'ok', models: [] })
  await assert.rejects(prepare, /不在当前账号/)
  await restored.backend.displayCatalogRefreshPending
})

test('无缓存时全局模型列表和已选远程模型不等网络，历史行不猜测能力', async t => {
  let release, started
  const waiting = new Promise(resolve => { started = resolve })
  const f = await fixture(t, async () => { started(); return new Promise(resolve => { release = resolve }) })
  const session = { header: { agentPreset: provider }, requestHeader: () => ({ config: { provider, model: 'old-model' } }) }
  const adapter = new Adapter(f.backend, { sessions: { list: () => [session] },
    sessionProjections: { stateOf: () => undefined } })
  // Mirrors the native Promise.all providers -> listModels -> resolveModelInfo path.
  const catalog = await Promise.all([Promise.resolve([{ provider: 'ordinary', id: 'local', name: 'Local' }]),
    adapter.listModels(provider).then(rows => Promise.all(rows.map(row => adapter.resolveModel(provider, row.id))))])
  await waiting
  assert.equal(catalog[0][0].id, 'local')
  assert.deepEqual(Object.keys(catalog[1][0]).sort(), ['description', 'id', 'name', 'provider'])
  assert.equal((await adapter.resolveModel(provider, 'another-saved-selection')).id, 'another-saved-selection')
  release({ status: 'ok', models })
  await f.backend.displayCatalogRefreshPending
})

test('后台失败隔离并退避，手动刷新恢复状态且未变化目录不触发 replace 循环', async t => {
  let catalogs = 0, fail = true, notifications = 0
  const f = await fixture(t, async method => {
    if (method === 'authStatus') return { loggedIn: true }
    catalogs++
    if (fail) throw Object.assign(new Error('synthetic failure'), { code: 'REMOTE_OFFLINE' })
    return { status: 'ok', models }
  })
  const adapter = new Adapter(f.backend)
  f.backend.onDisplayCatalogChanged = () => { notifications++; void adapter.listModels(provider) }
  await adapter.listModels(provider)
  await f.backend.displayCatalogRefreshPending
  assert.deepEqual(f.backend.displayCatalogStatus, { status: 'failed', code: 'REMOTE_OFFLINE' })
  await Promise.all(Array.from({ length: 8 }, () => adapter.listModels(provider)))
  assert.equal(catalogs, 1)
  const retryAfter = f.backend.displayCatalogRefreshAfter
  assert.ok(retryAfter > Date.now())
  fail = false
  await f.backend.catalog({ refresh: true })
  assert.deepEqual(f.backend.displayCatalogStatus, { status: 'ready' })
  assert.equal(f.backend.displayCatalogRefreshAfter, retryAfter)
  assert.equal(catalogs, 2); assert.equal(notifications, 1)
  f.backend.catalogCache.time = Date.now() - 31_000
  f.backend.displayCatalogRefreshAfter = 0
  await adapter.listModels(provider)
  await f.backend.displayCatalogRefreshPending
  assert.equal(catalogs, 3); assert.equal(notifications, 1)
})

test('连接身份不符不展示旧目录，清除后迟到的目录不能回写缓存', async t => {
  let release, started, waiting
  const f = await fixture(t, async () => ({ status: 'ok', models }), { remoteWorkerPath: '/synthetic/one' })
  await f.backend.catalog()
  const other = await fixture(t, async () => { throw new Error('不得连接') },
    { remoteWorkerPath: '/synthetic/two' }, f.directory)
  assert.deepEqual((await other.backend.displayCatalog()).models, [])
  f.backend.catalogCache = undefined
  waiting = new Promise(resolve => { started = resolve })
  f.backend.connection.peer.request = async () => { started(); return new Promise(resolve => { release = resolve }) }
  const request = f.backend.catalog()
  await waiting
  const rejected = assert.rejects(request, { code: 'CONNECTION_CHANGED' })
  f.backend.connectionSettings = { async clear() { return { configured: false, status: 'missing' } } }
  await f.backend.clearConnection()
  release({ status: 'ok', models })
  await rejected
  assert.equal(f.backend.state.value.displayCatalog, undefined)
  assert.equal(JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8')).displayCatalog, undefined)
})

test('已排队的旧缓存写入遇到换连接时重新检查版本，不会在清除后恢复', async t => {
  const f = await fixture(t, async () => ({ status: 'ok', models }))
  let release, queued
  const gate = new Promise(resolve => { release = resolve })
  const writing = new Promise(resolve => { queued = resolve })
  const update = f.backend.state.update.bind(f.backend.state)
  f.backend.state.queue = gate
  f.backend.state.update = action => { queued(); return update(action) }
  const request = f.backend.catalog()
  await writing
  const rejected = assert.rejects(request, { code: 'CONNECTION_CHANGED' })
  f.backend.connectionSettings = { async clear() { return { configured: false, status: 'missing' } } }
  const clearing = f.backend.clearConnection()
  release()
  await clearing; await rejected
  assert.equal(f.backend.state.value.displayCatalog, undefined)
})

test('显式刷新不会被正在后台进行的普通目录查询吞掉', async t => {
  let release, started, catalogs = 0, auth = 0
  const waiting = new Promise(resolve => { started = resolve })
  const f = await fixture(t, async method => {
    if (method === 'authStatus') { auth++; return { loggedIn: true } }
    catalogs++
    if (catalogs === 1) { started(); return new Promise(resolve => { release = resolve }) }
    return { status: 'ok', models }
  })
  f.backend.refreshDisplayCatalog()
  await waiting
  const explicit = f.backend.catalog({ refresh: true })
  release({ status: 'ok', models })
  await explicit
  await f.backend.displayCatalogRefreshPending
  assert.equal(catalogs, 2); assert.equal(auth, 1)
})

test('账号默认的展示可立即返回，实际 prepareCall 仍检查实时目录', async () => {
  let catalogs = 0
  const adapter = new Adapter({ async catalog() { catalogs++; throw new Error('synthetic offline') } })
  assert.equal((await adapter.resolveModel(provider, 'account-default')).id, 'account-default')
  assert.equal(catalogs, 0)
  await assert.rejects(adapter.prepareCall(provider, 'account-default'), /synthetic offline/)
  assert.equal(catalogs, 1)
})
