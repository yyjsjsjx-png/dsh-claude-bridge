import test from 'node:test'
import assert from 'node:assert/strict'
import { SdkProjection } from '../src/sdk-projection.mjs'

// Run in the installed DSH Electron executable with ELECTRON_RUN_AS_NODE=1.
// The ordinary Node test suite skips these cases if its ASAR reader is absent.
const available = Boolean(process.versions.electron && process.env.DSH_CLAUDE_BRIDGE_RESOURCES)

async function fixture() {
  const helpers = await import('../plugin/compat/runtime.mjs')
  const records = []
  const frames = []
  const agent = {
    id: 'projection-test',
    session: { append(type, data, intent) { records.push({ type, data, intent }); return { seq: records.length } } },
    dispatch: { emit(type, value) { frames.push({ type, ...value }) } },
  }
  const projection = new SdkProjection({ agent, helpers, turn: 1, step: 1, model: 'haiku', async onUsage() {} })
  return { records, frames, projection }
}

test('实际 rc5 helper：整轮停止保留已收到文本，冻结后续流和完整消息', { skip: !available }, async () => {
  const { records, frames, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
    content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text: '停止前文本' } } })
  projection.interrupt()
  const count = frames.length
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
    delta: { type: 'text_delta', text: '晚到文字' } } })
  await projection.accept({ type: 'assistant', message: { id: 'late', content: [{ type: 'text', text: '停止后的说明' }] } })
  let reports = 0
  let started = 0
  projection.onUsage = async () => { reports++ }
  projection.onStarted = async () => { started++ }
  await projection.accept({ type: 'system', subtype: 'init' })
  await projection.accept({ type: 'result', usage: { input_tokens: 1, output_tokens: 2 } })
  assert.equal(frames.length, count)
  assert.equal(records.length, 1)
  assert.equal(records[0].data.interrupted, true)
  assert.deepEqual(records[0].data.message.content, [{ type: 'text', text: '停止前文本' }])
  assert.equal(reports, 1)
  assert.equal(started, 1)
})

test('实际 rc5 helper：流式 thinking 作为 reasoning 展示并持久记录', { skip: !available }, async () => {
  const { records, frames, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'thinking-test' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
    content_block: { type: 'thinking', thinking: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
    delta: { type: 'thinking_delta', thinking: '分析样本' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 1,
    content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 1,
    delta: { type: 'text_delta', text: '最终答复' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
  await projection.accept({ type: 'assistant', message: { id: 'thinking-test', content: [
    { type: 'thinking', thinking: '分析样本' }, { type: 'text', text: '最终答复' },
  ] } })
  await projection.accept({ type: 'result', subtype: 'success' })
  const blocks = records.filter(record => record.type === 'assistant/message').flatMap(record => record.data.message.content)
  assert.deepEqual(blocks, [{ type: 'reasoning', text: '分析样本' }, { type: 'text', text: '最终答复' }])
  assert.equal(frames.some(frame => frame.frame.type === 'chunk'
    && frame.frame.chunk.type === 'reasoning-delta' && frame.frame.chunk.text === '分析样本'), true)
})

test('实际 rc5 helper：partial 流省略 thinking 时保留完整消息中的 thinking', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'message_start', message: { id: 'thinking-partial' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 1,
    content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 1,
    delta: { type: 'text_delta', text: '最终答复' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
  await projection.accept({ type: 'assistant', message: { id: 'thinking-partial', content: [
    { type: 'thinking', thinking: '分析样本' }, { type: 'text', text: '最终答复' },
  ] } })
  await projection.accept({ type: 'result', subtype: 'success' })
  const blocks = records.filter(record => record.type === 'assistant/message').flatMap(record => record.data.message.content)
  assert.equal(blocks.filter(block => block.type === 'reasoning' && block.text === '分析样本').length, 1)
  assert.equal(blocks.filter(block => block.type === 'text' && block.text === '最终答复').length, 1)
  assert.deepEqual(blocks.map(block => block.type), ['reasoning', 'text'])
})

test('实际 rc5 helper：多个 SDK 响应分别记录步骤和真实流式用量', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  let nextStep = 0
  projection.onModelStart = async () => ++nextStep
  for (const [id, text, tokens] of [['first', '先检查', 4], ['second', '已完成', 6]]) {
    await projection.accept({ type: 'stream_event', event: { type: 'message_start', message: { id,
      usage: { input_tokens: 3, cache_read_input_tokens: 5 } } } })
    await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0,
      content_block: { type: 'text', text: '' } } })
    await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text } } })
    await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    await projection.accept({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: tokens } } })
    await projection.accept({ type: 'assistant', message: { id, model: 'model-a', content: [{ type: 'text', text }] } })
  }
  await projection.accept({ type: 'result', usage: { input_tokens: 100, output_tokens: 100 } })
  const messages = records.filter(record => record.type === 'assistant/message')
  assert.deepEqual(messages.map(record => record.data.step), [1, 2])
  // Aggregate result usage must not be added to the last per-response count.
  assert.equal(messages[1].data.usage.outputTokens, 6)
  assert.equal(messages[1].data.usage.cacheReadTokens, 5)
})

test('实际 rc5 helper：一次流式文本和最终用量只提交一条 assistant 消息', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await projection.accept({ type: 'assistant', message: { model: 'model-a', content: [{ type: 'text', text: '你好' }] } })
  await projection.accept({ type: 'result', subtype: 'success', usage: {
    input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4,
  } })
  const messages = records.filter((record) => record.type === 'assistant/message')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].data.message.content[0].text, '你好')
  assert.deepEqual(messages[0].data.usage, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })
})

test('实际 rc5 helper：SDK tool_use 投影为可关联的 assistant tool-call', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  await projection.accept({ type: 'assistant', message: { model: 'model-a', content: [
    { type: 'tool_use', id: 'toolu_test', name: 'mcp__dsh__local_smoke', input: { command: 'pwd' } },
  ] } })
  const message = records.find((record) => record.type === 'assistant/message')?.data.message
  const call = message?.content.find((block) => block.type === 'tool-call')
  assert.equal(call?.id, 'toolu_test')
  assert.equal(call?.name, 'local_smoke')
  assert.deepEqual(JSON.parse(call.arguments), { command: 'pwd' })
  assert.deepEqual(projection.committedToolCalls.get('toolu_test'), { name: 'local_smoke', arguments: call.arguments })
})

test('实际 rc5 helper：流式文本与工具参数共同形成有序 assistant 块', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '检查中' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 1,
    content_block: { type: 'tool_use', id: 'toolu_stream', name: 'mcp__dsh__local_smoke', input: {} } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
  await projection.accept({ type: 'assistant', message: { model: 'model-a', content: [
    { type: 'text', text: '检查中' },
    { type: 'tool_use', id: 'toolu_stream', name: 'mcp__dsh__local_smoke', input: { command: 'pwd' } },
  ] } })
  const message = records.find((record) => record.type === 'assistant/message')?.data.message
  assert.deepEqual(message?.content.map((block) => block.type), ['text', 'tool-call'])
  assert.equal(message.content[1].id, 'toolu_stream')
  assert.equal(message.content[1].name, 'local_smoke')
  assert.deepEqual(JSON.parse(message.content[1].arguments), { command: 'pwd' })
})

test('实际 rc5 helper：相同 SDK message ID 的已流式输出片段不重复提交', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '检查中' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 1,
    content_block: { type: 'tool_use', id: 'toolu_same', name: 'mcp__dsh__local_smoke', input: {} } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } })
  await projection.accept({ type: 'assistant', message: { id: 'msg_same', model: 'model-a', content: [{ type: 'text', text: '检查中' }] } })
  await projection.accept({ type: 'assistant', message: { id: 'msg_same', model: 'model-a', content: [
    { type: 'tool_use', id: 'toolu_same', name: 'mcp__dsh__local_smoke', input: {} },
  ] } })
  const blocks = records.filter((record) => record.type === 'assistant/message').flatMap((record) => record.data.message.content)
  assert.equal(blocks.filter((block) => block.type === 'tool-call' && block.id === 'toolu_same').length, 1)
  assert.equal(blocks.filter((block) => block.type === 'text' && block.text === '检查中').length, 1)
})

test('实际 rc5 helper：相同 SDK message ID 的不同工具块均保留', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  for (const id of ['toolu_one', 'toolu_two']) {
    await projection.accept({ type: 'assistant', message: { id: 'msg_same', model: 'model-a', content: [
      { type: 'tool_use', id, name: 'mcp__dsh__local_smoke', input: {} },
    ] } })
  }
  const blocks = records.filter((record) => record.type === 'assistant/message').flatMap((record) => record.data.message.content)
  assert.deepEqual(blocks.filter((block) => block.type === 'tool-call').map((block) => block.id), ['toolu_one', 'toolu_two'])
})

test('实际 rc5 helper：部分流只有文本时仍补全完整消息里的工具块', { skip: !available }, async () => {
  const { records, projection } = await fixture()
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '检查中' } } })
  await projection.accept({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
  await projection.accept({ type: 'assistant', message: { id: 'msg_partial', model: 'model-a', content: [
    { type: 'text', text: '检查中' },
    { type: 'tool_use', id: 'toolu_unstreamed', name: 'mcp__dsh__local_smoke', input: {} },
  ] } })
  const blocks = records.filter((record) => record.type === 'assistant/message').flatMap((record) => record.data.message.content)
  assert.equal(blocks.filter((block) => block.type === 'text' && block.text === '检查中').length, 1)
  assert.equal(blocks.filter((block) => block.type === 'tool-call' && block.id === 'toolu_unstreamed').length, 1)
})
