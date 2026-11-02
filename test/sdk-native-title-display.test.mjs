import test from 'node:test'
import assert from 'node:assert/strict'
import { installRemoteNativeTitles } from '../plugin/remote-native-titles.mjs'

function fixture(normalize = value => value.replace(/\s+/g, ' ').trim()) {
  const sessions = new Map(), records = [], codes = []
  const service = { config: { maxTitleBytes: 80 },
    get: session => session.title, onUserMessage() {}, onRequestHeader() {}, refresh() {},
    async ensureFallback(session) { session.title ??= { title: 'fallback', source: { kind: 'fallback' } }; return session.title },
  }
  const ctx = { sessionTitle: service, sessions: { get: id => sessions.get(id) },
    sessionProjections: { stateOf: () => ({ first: { seq: 1 } }) } }
  const create = (id, preset = 'claude-sdk-remote') => {
    const session = { id, header: { agentPreset: preset }, append(type, data) {
      records.push({ type, data }); this.title = data
    } }
    sessions.set(id, session); return session
  }
  const titles = installRemoteNativeTitles(ctx, { normalizeSessionTitle: normalize, report: code => codes.push(code) })
  return { service, create, titles, records, codes }
}

test('只同步远程SDK标题，原生provider记录不假称模型；缺失、重复、手动标题与坏值不覆盖', () => {
  const f = fixture(), remote = f.create('remote'), ordinary = f.create('ordinary', 'standard')
  assert.equal(f.titles.sync(remote, undefined), false)
  assert.equal(f.titles.sync(ordinary, 'SDK title'), false)
  assert.equal(f.titles.sync(remote, 'SDK title'), true)
  assert.deepEqual(remote.title.source, { kind: 'provider', provider: 'claude-bridge-sdk-title' })
  assert.deepEqual(remote.title.messageSeqs, [1])
  assert.equal(f.titles.sync(remote, 'SDK title'), false)
  remote.title = { title: 'manual', source: { kind: 'user' } }
  assert.equal(f.titles.sync(remote, 'new SDK title'), false)
  assert.equal(remote.title.title, 'manual')
  assert.equal(f.titles.sync(remote, ''), false)
  assert.equal(f.titles.sync(remote, 'x'.repeat(4097)), false)
  assert.equal(f.records.length, 1)
  f.titles.dispose()
  assert.equal(f.titles.sync(f.create('late'), 'SDK title'), false)
})

test('同步前再次检查手动命名；事件写入失败只报告诊断', () => {
  let session
  const f = fixture(value => { session.title = { title: 'new manual', source: { kind: 'user' } }; return value })
  session = f.create('race')
  assert.equal(f.titles.sync(session, 'SDK title'), false)
  assert.equal(session.title.title, 'new manual')
  const failed = fixture(), broken = failed.create('broken')
  broken.append = () => { throw new Error('synthetic append failure') }
  assert.equal(failed.titles.sync(broken, 'SDK title'), false)
  assert.deepEqual(failed.codes, ['SDK_TITLE_SYNC_FAILED'])
})

test('SDK 标题与 fallback 同名仍确认来源一次，同名手动标题始终保留', () => {
  const f = fixture(), session = f.create('same-title')
  session.title = { title: '你好', source: { kind: 'fallback' } }
  assert.equal(f.titles.sync(session, '你好'), true)
  assert.deepEqual(session.title.source, { kind: 'provider', provider: 'claude-bridge-sdk-title' })
  assert.equal(f.titles.sync(session, '你好'), false)
  assert.equal(f.records.length, 1)
  session.title = { title: '你好', source: { kind: 'provider', provider: 'other-provider' } }
  assert.equal(f.titles.sync(session, '你好'), true)
  assert.equal(f.records.length, 2)
  session.title = { title: '你好', source: { kind: 'user' } }
  assert.equal(f.titles.sync(session, '你好'), false)
  assert.deepEqual(session.title.source, { kind: 'user' })
  assert.equal(f.records.length, 2)
})

test('ordinary方法保留this及参数；远程refresh仅fallback且不解锁，卸载仅恢复自己安装的方法', async () => {
  const f = fixture(), owner = {}, marker = {}, ordinary = f.create('ordinary', 'standard'), remote = f.create('remote')
  f.titles.dispose()
  const original = function(...args) { assert.equal(this, owner); assert.deepEqual(args, [ordinary, marker]); return marker }
  f.service.onUserMessage = original; f.service.onRequestHeader = original; f.service.refresh = original
  const mainArgs = [{ sessionId: ordinary.id }, marker]
  const mainOriginal = function(...args) { assert.equal(this, owner); assert.deepEqual(args, mainArgs); return marker }
  f.service.onMainRequest = mainOriginal
  const install = () => installRemoteNativeTitles({ sessionTitle: f.service, sessions: { get: id => id === remote.id ? remote : ordinary } },
    { normalizeSessionTitle: value => value })
  let titles = install()
  for (const name of ['onUserMessage', 'onRequestHeader', 'refresh']) assert.equal(f.service[name].call(owner, ordinary, marker), marker)
  assert.equal(f.service.onMainRequest.apply(owner, mainArgs), marker)
  remote.title = { title: 'manual', source: { kind: 'user' } }
  assert.equal((await f.service.refresh(remote)).title, 'manual')
  titles.dispose()
  for (const name of ['onUserMessage', 'onRequestHeader', 'refresh']) assert.equal(f.service[name], original)
  assert.equal(f.service.onMainRequest, mainOriginal)
  titles = install()
  const later = () => {}
  f.service.onUserMessage = later; f.service.onRequestHeader = later; f.service.refresh = later
  f.service.onMainRequest = later
  titles.dispose()
  for (const name of ['onUserMessage', 'onRequestHeader', 'refresh']) assert.equal(f.service[name], later)
  assert.equal(f.service.onMainRequest, later)
})
