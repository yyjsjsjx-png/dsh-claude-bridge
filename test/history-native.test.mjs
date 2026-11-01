import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import vm from 'node:vm'
import { resolveDshModule } from '../plugin/compat/resolve-dsh-module.mjs'
import { localHistory, restoreAssistant, assistantIdentity, knownToolResult, UNKNOWN_TOOL_TEXT } from '../src/history-sync.mjs'
import { nativeChat } from './fixtures/native-chat.mjs'
import { strictSession } from './fixtures/native-persistence.mjs'
import { HISTORY_TOOL_RESULT, appendHistoryRecord } from '../src/history-records.mjs'
import { repairBridgeHistories } from '../scripts/repair-history.mjs'
import { createClient } from '../plugin/ui/client/entry.mjs'

const available = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)
test('实际 rc5：闭合轮次补齐消息和真实工具结果，原生日志与显示历史可重新回放', { skip: !available }, async () => {
  const { Session, SESSION_FORMAT_VERSION, appendPluginRecord } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const helpers = { ...await import(resolveDshModule('@deepseek-ai/dsh-llm')), appendPluginRecord }
  const session = Session.create('native-recovery', undefined, { version: SESSION_FORMAT_VERSION,
    id: 'native-recovery', createdAt: 0, delegationDepth: 0, isSeeded: false, agentPreset: 'claude-sdk-remote' })
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: { provider: 'claude-sdk-remote', model: 'fixture' },
    tools: [{ name: 'local_command', description: '合成命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } }] }, reason: 'initial' })
  const content = [{ type: 'text', text: '已收到开头' }, { type: 'tool-call', id: 'call-fixture', name: 'local_command', arguments: '{"command":"synthetic"}' }]
  const message = helpers.createAssistantMessage({ content, source: { provider: 'claude-sdk-remote', model: 'fixture' } })
  session.append('assistant/message', { turn: 1, step: 1,
    message: { ...message, id: assistantIdentity('api-fixture', content) }, stream: [], interrupted: true }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId: 'call-fixture', name: 'local_command', arguments: '{"command":"synthetic"}' })
  session.append('tool/result', { turn: 1, step: 1, meta: { claudeBridgeOutcome: 'unknown' },
    message: helpers.createToolResultMessage({ callId: 'call-fixture', content: [{ type: 'text', text: UNKNOWN_TOOL_TEXT }], isError: true }) },
    { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const native = { apiId: 'api-fixture', content: [{ type: 'text', text: '已收到开头以及断线尾部' }, content[1]], model: 'fixture' }
  assert.equal(restoreAssistant(session, native, localHistory(session), helpers, 'fixture'), 1)
  const recovered = appendHistoryRecord(session, HISTORY_TOOL_RESULT, { turn: 1, step: 1,
    meta: { claudeBridgeRecovered: true }, callSeq: call.seq,
    message: helpers.createToolResultMessage({ callId: 'call-fixture', content: [{ type: 'text', text: '已查证的合成结果' }], isError: false }) }, helpers)
  assert.equal(knownToolResult(recovered), true)
  const events = Array.from({ length: session.seq }, (_, seq) => session.eventAt(seq))
  await strictSession(session)
  const restored = Session.create(session.id, events, session.header)
  assert.equal(restored.firstLiveSeq, session.seq)
  assert.equal(restored.eventAt(session.seq).type, 'session/end-seed')
  assert.equal(restoreAssistant(restored, native, localHistory(restored), helpers, 'fixture'), 0)
  assert.equal(localHistory(restored).results.get('call-fixture').data.message.isError, false)
  assert.ok(!restored.surface.nodes.includes(recovered.seq))
  const view = await nativeChat()
  const client = await historyClient()
  client.installTranscriptOrder(view.ctx)
  view.replace(events)
  assert.equal(view.order().find(node => node.kind === 'tool-call').data.root.isError, false)
})

test('实际原生分组：补齐旧思考后仍按思考、调用顺序、最终答复排列，旧错序记录重载即修复', { skip: !available }, async () => {
  const { Session, SESSION_FORMAT_VERSION, appendPluginRecord } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const helpers = { ...await import(resolveDshModule('@deepseek-ai/dsh-llm')), appendPluginRecord }
  const session = Session.create('history-order', undefined, { version: SESSION_FORMAT_VERSION,
    id: 'history-order', createdAt: 0, delegationDepth: 0, isSeeded: false, agentPreset: 'claude-sdk-remote' })
  const tools = ['a', 'b'].map(id => ({ type: 'tool-call', id, name: 'local_wait', arguments: '{}' }))
  const first = [{ type: 'text', text: '合成执行前说明' }, ...tools]
  const answer = [{ type: 'text', text: '合成最终答复' }]
  const append = (apiId, content, step) => session.append('assistant/message', { turn: 1, step, stream: [],
    message: { ...helpers.createAssistantMessage({ content, source: { provider: 'claude-sdk-remote', model: 'fixture' } }),
      id: assistantIdentity(apiId, content) } }, { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  append('api-first', first, 1)
  for (const block of tools) session.append('tool/call', { turn: 1, step: 1, callId: block.id, name: block.name, arguments: block.arguments })
  for (const block of tools.toReversed()) session.append('tool/result', { turn: 1, step: 1,
    message: helpers.createToolResultMessage({ callId: block.id, content: [{ type: 'text', text: '合成结果' }], isError: false }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 }); session.append('step/start', { turn: 1, step: 2 })
  append('api-final', answer, 2)
  session.append('step/end', { turn: 1, step: 2 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const record = { apiId: 'api-first', model: 'fixture', content: [{ type: 'reasoning', text: '合成早期分析' }, ...first] }
  const view = await nativeChat()
  view.replace(session.snapshotEvents())
  const order = () => Array.from(view.order().filter(node => ['assistant-step', 'tool-call'].includes(node.kind)), node =>
    node.kind === 'assistant-step' ? `assistant:${node.data.step}` : `tool:${node.data.root.callId}`)
  const expected = ['assistant:1', 'tool:a', 'tool:b', 'assistant:2']
  assert.deepEqual(order(), expected)
  assert.equal(restoreAssistant(session, record, localHistory(session), helpers), 1)
  view.append(session.eventAt(session.seq - 1))
  // An ignorable repair cannot corrupt or reorder the native journal on its own.
  assert.deepEqual(order(), expected)
  await strictSession(session)
  const client = await historyClient()
  const original = view.ctx.uiConversation.events.entries().find(item => item.kind === 'assistant-step').buildViewNode
  const dispose = client.installTranscriptOrder(view.ctx)
  view.assembler.rebuildRegistry()
  assert.deepEqual(order(), expected)
  const early = view.order().find(node => node.kind === 'assistant-step' && node.data.step === 1)
  assert.deepEqual(Array.from(early.data.blocks, block => block.kind), ['reasoning', 'text', 'tool-call', 'tool-call'])
  assert.equal(restoreAssistant(session, record, localHistory(session), helpers), 0)
  view.replace(session.snapshotEvents())
  assert.deepEqual(order(), expected)
  dispose()
  assert.equal(view.ctx.uiConversation.events.entries().find(item => item.kind === 'assistant-step').buildViewNode, original)
})

async function historyClient() {
  let entry
  vm.runInNewContext(await readFile(new URL('../plugin/ui/client.js', import.meta.url), 'utf8'),
    { window: { __ModuleLoader__: { load: value => { entry = value } } } })
  return entry.factory(name => name === 'zod' ? { z: {} } : {})
}

test('实际 rc5 展示：冷回放与实时追加的最终正文在折叠模式可见，工作过程仍可折叠', { skip: !available }, async () => {
  const { Session, SESSION_FORMAT_VERSION } = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const helpers = await import(resolveDshModule('@deepseek-ai/dsh-llm'))
  for (const reasoning of [false, true]) {
    const session = Session.create(`native-final-${reasoning}`, undefined, { version: SESSION_FORMAT_VERSION,
      id: `native-final-${reasoning}`, createdAt: 0, delegationDepth: 0, isSeeded: false, agentPreset: 'claude-sdk-remote' })
    const append = (step, content) => session.append('assistant/message', { turn: 1, step, stream: [],
      message: helpers.createAssistantMessage({ content, source: { provider: 'claude-sdk-remote', model: 'fixture' } }) },
    { surfaceOp: 'append' })
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
    append(1, [{ type: 'reasoning', text: '合成工作过程' },
      { type: 'tool-call', id: 'fixture-tool', name: 'local_command', arguments: '{}' }])
    const call = session.append('tool/call', { turn: 1, step: 1, callId: 'fixture-tool', name: 'local_command', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, message: helpers.createToolResultMessage({ callId: 'fixture-tool',
      content: [{ type: 'text', text: '合成工具结果' }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.append('step/end', { turn: 1, step: 1 }); session.append('step/start', { turn: 1, step: 2 })
    append(2, [...reasoning ? [{ type: 'reasoning', text: '合成最终分析' }] : [], { type: 'text', text: '合成最终正文' }])
    session.append('step/end', { turn: 1, step: 2 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    for (const lifecycle of ['cold', 'live']) {
      const view = await nativeChat()
      createClient({}).installTranscriptOrder(view.ctx)
      const events = session.snapshotEvents()
      if (lifecycle === 'cold') view.replace(events)
      else for (const event of events) view.append(event)
      const final = view.order().find(node => node.kind === 'assistant-step' && node.data.step === 2)
      const tool = view.order().find(node => node.kind === 'tool-call')
      for (const mode of ['compact', 'standard', 'detailed', 'verbose']) {
        const answer = view.seat(final, { mode, groupPart: 'response' })
        assert.equal(answer['data-turn-process-member'], undefined, `${lifecycle}/${mode}: final answer outside process`)
        assert.equal(answer['data-turn-process-hidden'], undefined, `${lifecycle}/${mode}: final answer visible`)
        assert.equal(answer.children.turnProcess?.hasContent, true, `${lifecycle}/${mode}: disclosure retains process`)
        const collapsed = view.seat(tool, { mode })
        assert.equal(collapsed['data-turn-process-hidden'], mode === 'verbose' ? undefined : true,
          `${lifecycle}/${mode}: work still follows native folding`)
        assert.equal(view.seat(tool, { mode, open: true })['data-turn-process-hidden'], undefined,
          `${lifecycle}/${mode}: work can be opened`)
        if (reasoning) assert.equal(view.seat(final, { mode, groupPart: 'reasoning' })['data-turn-process-hidden'],
          mode === 'verbose' ? undefined : true, `${lifecycle}/${mode}: reasoning stays in process`)
      }
    }
  }
})

test('原生离线迁移：旧损坏历史先备份、完整校验并原子写回，再次更新不改写', { skip: !available }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-bridge-migration-'))
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(directory.startsWith(join(tmpdir(), 'dsh-bridge-migration-')))
    await rm(directory, { recursive: true, force: true })
  })
  const native = await import(resolveDshModule('@deepseek-ai/dsh-session'))
  const helpers = await import(resolveDshModule('@deepseek-ai/dsh-llm'))
  const id = 'synthetic-history-migration'
  const session = native.Session.create(id, undefined, { version: 4, id, createdAt: 0,
    delegationDepth: 0, isSeeded: false, agentPreset: 'claude-sdk-remote' })
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 })
  session.append('step/end', { turn: 1, step: 1 }); session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const content = [{ type: 'text', text: '合成闭合后补齐' }]
  session.append('assistant/message', { turn: 1, step: 1, stream: [], message: {
    ...helpers.createAssistantMessage({ content, source: { provider: 'claude-sdk-remote', model: 'fixture' } }),
    id: assistantIdentity('old-api', content),
  } }, { surfaceOp: 'append' })
  await assert.rejects(() => strictSession(session), /open turn and step/)
  const require = createRequire(resolveDshModule('@deepseek-ai/dsh-session'))
  const path = join(directory, 'sessions', 'fixture-workspace', id, 'session.v4.jsonl.zstd')
  const physicalHeader = { type: 'session', ...session.header }
  const before = Buffer.concat([zstdCompressSync(Buffer.from(JSON.stringify(physicalHeader) + '\n')),
    zstdCompressSync(Buffer.from(session.snapshotEvents().map(event => JSON.stringify(event) + '\n').join('')))])
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, before)
  const backup = join(directory, 'backup')
  const report = await repairBridgeHistories({ home: directory, backup, require })
  assert.deepEqual(report, { checked: 1, repaired: 1, changedRecords: 1 })
  assert.deepEqual(await readFile(join(backup, 'histories', 'fixture-workspace', id, 'session.v4.jsonl.zstd')), before)
  const after = await readFile(path), first = zstdDecompressSync(after, { info: true })
  const events = zstdDecompressSync(after.subarray(first.engine.bytesWritten)).toString().trim().split('\n').map(JSON.parse)
  assert.equal(events.at(-1).ignorable, true)
  assert.deepEqual(events.at(-1).data.message.content, content)
  assert.deepEqual(await repairBridgeHistories({ home: directory, backup, require }), { checked: 1, repaired: 0, changedRecords: 0 })
  assert.deepEqual(await readFile(path), after)
  assert.equal((await readdir(dirname(path))).length, 1)
})
