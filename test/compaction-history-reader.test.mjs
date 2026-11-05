import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, appendFile, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { createCompactionHistoryReader } from '../remote/compaction-history.mjs'
import { createCompactionTranscriptProjection } from '../remote/compaction-transcript.mjs'
import { MAX_COMPACTION_SUMMARY_BYTES } from '../src/compaction-summary.mjs'

const deviceId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const row = (type, uuid, values = {}) => ({ type, uuid, sessionId, ...values })
const boundary = (uuid, values = {}) => row('system', uuid, { subtype: 'compact_boundary',
  timestamp: '2026-11-06T00:00:00.000Z', compactMetadata: { trigger: 'auto', preTokens: 900, postTokens: 100, durationMs: 23 }, ...values })
const summary = (uuid, parentUuid, text = '合成原生摘要\n原样保留。', values = {}) => row('user', uuid,
  { parentUuid, isCompactSummary: true, message: { role: 'user', content: text }, ...values })
const assistant = (uuid, id) => row('assistant', uuid, { message: { id,
  get content() { assert.fail('不能读取普通助手正文') } } })

async function fixture(t) {
  const parent = await realpath(tmpdir()), directory = await mkdtemp(join(parent, 'bridge-compact-read-'))
  t.after(async () => { assert.equal(dirname(directory), parent); assert.ok(directory.startsWith(join(parent, 'bridge-compact-read-'))); await rm(directory, { recursive: true, force: true }) })
  const root = join(directory, 'sessions'), configDir = join(directory, 'config')
  const cwd = join(root, 'devices', deviceId, sessionId)
  const metadata = { version: 2, engine: 'claude-sdk', sessionId, deviceId,
    dshSessionId: 'dsh-owned', projectPath: 'D:\\fixture' }
  await mkdir(join(root, '_owners'), { recursive: true }); await mkdir(cwd, { recursive: true })
  await writeFile(join(root, '_owners', sessionId + '.json'), JSON.stringify(metadata))
  await writeFile(join(cwd, 'bridge-session.json'), JSON.stringify(metadata))
  const projectDirectory = join(configDir, 'projects', (await realpath(cwd)).replace(/[^a-zA-Z0-9-]/g, '-'))
  await mkdir(projectDirectory, { recursive: true })
  const transcript = join(projectDirectory, sessionId + '.jsonl')
  let auth = 0, releases = 0, lock, failRelease = false
  const options = { sessionRoot: root, configDir, authorizedDeviceId: deviceId, activeSessions: new Set(),
    requireAuth: async () => { auth++ }, acquireLock: async () => {
      lock = { held: true, async release() { releases++; if (failRelease) throw new Error('synthetic release'); lock = null } }
      return lock
    } }
  const params = { deviceId, sessionId, dshSessionId: metadata.dshSessionId, projectPath: metadata.projectPath }
  return { options, params, transcript, root, cwd, projectDirectory, configDir, directory,
    read: createCompactionHistoryReader(options), write: rows => writeFile(transcript, rows.map(value => JSON.stringify(value)).join('\n') + '\n'),
    get auth() { return auth }, get releases() { return releases },
    loseLock() { lock.held = false }, failRelease() { failRelease = true } }
}

test('只按真实边界UUID链关联原生摘要，邻近API标识可定位且普通正文不读取', () => {
  const p = createCompactionTranscriptProjection(sessionId)
  p.accept(assistant('a1', 'msg-before'))
  p.accept({ type: 'user', uuid: 'ordinary', sessionId,
    get message() { assert.fail('不能读取普通用户正文') } })
  p.accept(boundary('b1'))
  p.accept(summary('s1', 'b1'))
  p.accept(summary('orphan', 'unmatched', '不应串到相邻边界'))
  p.accept(assistant('a2', 'msg-after'))
  const [record] = p.records()
  assert.deepEqual(record, { boundaryUuid: 'b1', trigger: 'auto', preTokens: 900, postTokens: 100,
    durationMs: 23, completedAt: Date.parse('2026-11-06T00:00:00.000Z'), beforeApiId: 'msg-before', afterApiId: 'msg-after',
    summary: { status: 'available', text: '合成原生摘要\n原样保留。' } })
})

test('旧无hook摘要、正文缺失、空白、过大、冲突与子代理严格区分', () => {
  const p = createCompactionTranscriptProjection(sessionId)
  for (let i = 0; i < 6; i++) p.accept(boundary('b' + i))
  p.accept(summary('s1', 'b1', [{ type: 'text', text: '一' }, { type: 'text', text: '\n二' }], { isMeta: true }))
  p.accept(summary('s2', 'b2', '  '))
  p.accept(summary('s3', 'b3', 'a'.repeat(MAX_COMPACTION_SUMMARY_BYTES + 1)))
  p.accept(summary('s4', 'b4', '原始'))
  p.accept(summary('s4-other', 'b4', '冲突'))
  p.accept(summary('s5', 'b5', '子代理', { isSidechain: true }))
  assert.deepEqual(p.records().map(value => value.summary.status === 'available' ? value.summary.text : value.summary.code),
    ['SUMMARY_MISSING', '一\n二', 'SUMMARY_EMPTY', 'SUMMARY_TOO_LARGE', 'SUMMARY_CONFLICT', 'SUMMARY_MISSING'])
  assert.throws(() => p.accept(boundary('foreign', { sessionId: deviceId })), { code: 'COMPACTION_TRANSCRIPT_INVALID' })
  assert.throws(() => p.accept(boundary(undefined)), { code: 'COMPACTION_TRANSCRIPT_INVALID' })
})

test('摘要记录重放幂等，同UUID内容改变不接受，摘要不按位置/时间猜配', () => {
  const p = createCompactionTranscriptProjection(sessionId)
  p.accept(boundary('b')); p.accept(boundary('b'))
  p.accept(summary('s', 'unmatched')); p.accept(summary('s', 'unmatched'))
  assert.equal(p.records().length, 1)
  assert.equal(p.records()[0].summary.status, 'unavailable')
  assert.throws(() => p.accept(summary('s', 'b')), { code: 'COMPACTION_TRANSCRIPT_INVALID' })
})

test('归属/认证/活动/锁边界先于原生读取，文件与元数据只读', async t => {
  const f = await fixture(t)
  await f.write([boundary('b'), summary('s', 'b')])
  const original = await readFile(f.transcript)
  assert.equal((await f.read({ ...f.params, projectPath: 'wrong' })).code, 'SESSION_BINDING_MISMATCH')
  assert.equal((await f.read({ ...f.params, deviceId: sessionId })).code, 'DEVICE_MISMATCH')
  assert.equal((await f.read({ ...f.params, dshSessionId: 'other' })).code, 'SESSION_BINDING_MISMATCH')
  f.options.activeSessions.add(sessionId)
  assert.equal((await f.read(f.params)).status, 'busy')
  f.options.activeSessions.clear()
  const reply = await f.read(f.params)
  assert.equal(reply.status, 'ok'); assert.equal(reply.records[0].summary.text, '合成原生摘要\n原样保留。')
  assert.equal(reply.done, true); assert.equal(f.auth, 4); assert.equal(f.releases, 2)
  assert.deepEqual(await readFile(f.transcript), original)
})

test('原生指纹分页、完成后同指纹不重读正文、变化要求重读且不漏旧压缩', async t => {
  const f = await fixture(t)
  const rows = []
  for (let i = 0; i < 5; i++) rows.push(boundary('b' + i), summary('s' + i, 'b' + i, 'summary ' + i))
  await f.write(rows)
  const all = []
  let reply, cursor
  do {
    reply = await f.read({ ...f.params, ...(cursor ? { cursor } : {}) })
    assert.equal(reply.status, 'ok')
    all.push(...reply.records); cursor = reply.nextCursor
  } while (!reply.done)
  assert.deepEqual(all.map(value => value.boundaryUuid), ['b0', 'b1', 'b2', 'b3', 'b4'])
  const same = await f.read({ ...f.params, cursor })
  assert.equal(same.done, true); assert.deepEqual(same.records, [])
  await appendFile(f.transcript, JSON.stringify(boundary('b5')) + '\n')
  assert.equal((await f.read({ ...f.params, cursor })).status, 'cursor-reset')
  assert.equal((await f.read(f.params)).records.length, 2)
})

test('请求限制、取消、损坏/半行原生记录和锁丢失不返回部分正文', async t => {
  const f = await fixture(t)
  assert.equal((await f.read({ ...f.params, path: 'arbitrary' })).code, 'INVALID_REQUEST')
  assert.equal((await f.read({ ...f.params, cursor: { fingerprint: 'no', offset: 0, done: false } })).code, 'INVALID_REQUEST')
  assert.equal((await f.read(f.params)).code, 'COMPACTION_TRANSCRIPT_MISSING')
  await writeFile(f.transcript, JSON.stringify(boundary('b')))
  assert.equal((await f.read(f.params)).code, 'COMPACTION_TRANSCRIPT_INCOMPLETE')
  await writeFile(f.transcript, '{invalid}\n')
  assert.equal((await f.read(f.params)).code, 'COMPACTION_TRANSCRIPT_INVALID')
  const abort = new AbortController(); abort.abort()
  assert.equal((await f.read(f.params, { signal: abort.signal })).code, 'CANCELLED')
  await f.write([boundary('b'), summary('s', 'b')])
  const reader = createCompactionHistoryReader({ ...f.options, acquireLock: async () => ({ held: false, async release() {} }) })
  assert.equal((await reader(f.params)).code, 'SESSION_LOCK_LOST')
  f.failRelease()
  assert.equal((await f.read(f.params)).code, 'LOCK_RELEASE_FAILED')
})

test('拒绝指向其他会话/目录的转向，配置根本身可规范化', async t => {
  const f = await fixture(t)
  const foreign = join(f.directory, 'foreign.jsonl')
  await writeFile(foreign, JSON.stringify(boundary('foreign')) + '\n')
  await symlink(foreign, f.transcript)
  assert.equal((await f.read(f.params)).code, 'COMPACTION_TRANSCRIPT_UNSAFE')
})

test('UTF-8与JSON转义均受限，大正文整条分页或明确不可用而不截断', async t => {
  const f = await fixture(t)
  const text = '\n'.repeat(800_000)
  await f.write([boundary('b1'), summary('s1', 'b1', text + 'end'),
    boundary('b2'), summary('s2', 'b2', text + 'end')])
  const first = await f.read(f.params)
  assert.equal(first.records.length, 1)
  assert.equal(first.records[0].summary.text, text + 'end')
  assert.equal(first.done, false)
  const second = await f.read({ ...f.params, cursor: first.nextCursor })
  assert.equal(second.records[0].summary.text, text + 'end')
  assert.equal(second.done, true)
  await f.write([boundary('b3'), summary('s3', 'b3', '\u0000'.repeat(700_000))])
  const escaped = await f.read(f.params)
  assert.equal(escaped.records[0].summary.code, 'SUMMARY_TOO_LARGE')
  assert.equal(escaped.done, true)
})
