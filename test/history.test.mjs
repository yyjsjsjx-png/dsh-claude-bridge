import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createHistoryReader, createRunStore } from '../remote/history.mjs'

const deviceId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
async function fixture(t) {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'dsh-history-'))
  t.after(async () => { assert.equal(dirname(root), parent); assert.ok(root.startsWith(join(parent, 'dsh-history-'))); await rm(root, { recursive: true, force: true }) })
  const cwd = join(root, 'devices', deviceId, sessionId)
  const metadata = { version: 2, engine: 'claude-sdk', deviceId, sessionId, dshSessionId: 'dsh-history', projectPath: 'D:\\fixture' }
  await mkdir(join(root, '_owners'), { recursive: true }); await mkdir(cwd, { recursive: true })
  await writeFile(join(root, '_owners', `${sessionId}.json`), JSON.stringify(metadata))
  await writeFile(join(cwd, 'bridge-session.json'), JSON.stringify(metadata))
  let items = [], locked = false, authenticated = 0, reads = 0, info
  const options = { sessionRoot: root, authorizedDeviceId: deviceId, activeSessions: new Set(),
    requireAuth: async () => { authenticated++ },
    acquireLock: async () => { assert.equal(locked, false); locked = true; return { held: true, async release() { locked = false } } },
    sdk: { query() { throw new Error('历史同步不能推理') }, async getSessionInfo() { return info },
      async getSessionMessages(_id, { offset, limit }) { reads++; return items.slice(offset, offset + limit) } } }
  const params = { deviceId, sessionId, dshSessionId: metadata.dshSessionId, projectPath: metadata.projectPath }
  return { root, cwd, options, params, history: createHistoryReader(options), setItems(value) { items = value },
    get locked() { return locked }, get reads() { return reads }, get authenticated() { return authenticated } }
}

test('历史接口只读原生记录，归属先校验，不复制用户输入或压缩摘要', async t => {
  const f = await fixture(t)
  f.setItems([
    { type: 'user', uuid: 'prompt-1', session_id: sessionId, message: { content: 'PRIVATE_USER_TEXT' } },
    { type: 'assistant', uuid: 'answer-1', session_id: sessionId, parent_tool_use_id: null,
      message: { id: 'msg-1', model: 'fixture', content: [{ type: 'text', text: '合成输出' }] } },
    { type: 'user', uuid: 'result-1', session_id: sessionId, message: { content: [
      { type: 'tool_result', tool_use_id: 'call-1', content: '合成工具结果' }] } },
    { type: 'assistant', uuid: 'child-1', session_id: sessionId, parent_agent_id: 'child', message: { content: [] } },
  ])
  const reply = await f.history(f.params)
  assert.equal(reply.status, 'ok'); assert.equal(reply.nextOffset, 4); assert.equal(reply.done, true)
  assert.equal(reply.records.filter(item => item.type === 'assistant').length, 1)
  assert.equal(reply.records.find(item => item.type === 'tool-result').content[0].text, '合成工具结果')
  assert.equal(JSON.stringify(reply).includes('PRIVATE_USER_TEXT'), false)
  assert.equal(f.locked, false); assert.equal(f.authenticated, 1)
  const reads = f.reads
  const denied = await f.history({ ...f.params, deviceId: '33333333-3333-4333-8333-333333333333' })
  assert.equal(denied.code, 'DEVICE_MISMATCH'); assert.equal(f.reads, reads)
})

test('历史游标失配要求重读，活动会话等待，缺少原生证据不猜测重建', async t => {
  const f = await fixture(t)
  assert.equal((await f.history(f.params)).code, 'NATIVE_CONTEXT_UNCONFIRMED')
  f.setItems([{ type: 'user', uuid: 'anchor', session_id: sessionId, message: { content: [] } }])
  assert.equal((await f.history({ ...f.params, offset: 1, afterUuid: 'old-anchor' })).status, 'cursor-reset')
  assert.equal((await f.history({ ...f.params, offset: 1, afterUuid: 'anchor' })).status, 'ok')
  f.options.activeSessions.add(sessionId)
  assert.equal((await f.history(f.params)).status, 'busy')
})

test('合成停轮占位不进入历史展示，过滤后原生分页游标仍完整推进', async t => {
  const f = await fixture(t)
  const item = (uuid, model, text) => ({ type: 'assistant', uuid, session_id: sessionId,
    message: { id: uuid, model, content: [{ type: 'text', text }] } })
  f.setItems([item('placeholder', '<synthetic>', 'No response requested.'),
    item('normal', 'fixture', 'No response requested.'), item('error', '<synthetic>', 'Other error')])
  const reply = await f.history(f.params)
  assert.deepEqual(reply.records.map(record => record.apiId), ['normal', 'error'])
  assert.equal(reply.nextOffset, 3)
  assert.equal(reply.lastUuid, 'error')
  assert.equal((await f.history({ ...f.params, offset: 3, afterUuid: 'error' })).status, 'ok')
})

test('运行回执持久保存名称及参数哈希，终态和读取释放失败均可辨认', async t => {
  const f = await fixture(t), store = createRunStore()
  await store.begin(f.cwd, 'run-1', 'query')
  await store.receipt(f.cwd, 'run-1', 'call-1', 'local_command', { command: 'PRIVATE_COMMAND' })
  await store.finish(f.cwd, 'run-1', { status: 'completed' })
  const data = await readFile(join(f.cwd, 'bridge-runs.json'), 'utf8')
  assert.equal(data.includes('PRIVATE_COMMAND'), false)
  assert.equal(JSON.parse(data).runs['run-1'].status, 'completed')
  f.setItems([{ type: 'user', uuid: 'anchor', session_id: sessionId, message: { content: [] } }])
  const reader = createHistoryReader({ ...f.options, acquireLock: async () => ({ held: true, async release() { throw new Error('release failed') } }) })
  assert.equal((await reader(f.params)).code, 'LOCK_RELEASE_FAILED')
})
