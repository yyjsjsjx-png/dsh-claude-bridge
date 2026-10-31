import test from 'node:test'
import assert from 'node:assert/strict'
import { toMcpContent, toMcpToolDefinitions, toSdkPrompt } from '../src/dsh-content.mjs'

const id = `sha256:${'a'.repeat(64)}`
const bytes = Buffer.from('fake image')
const imageRef = { attachmentId: id, mediaType: 'image/png', bytes: bytes.length, width: 3, height: 2 }
const fileRef = { attachmentId: id, name: 'notes.txt', bytes: 123 }
const store = {
  async readImage(ref) { return { ref, data: bytes } },
  fileHostPath() { return 'C:\\store\\notes.txt' },
  imageHostPath() { return 'C:\\store\\image.png' },
}
const options = { attachments: store, mapHostPath: (hostPath) => `mapped:${hostPath}` }

test('raw rc5 JSON schemas are preserved or explicitly narrowed, and failures are per tool', () => {
  const result = toMcpToolDefinitions([
    { name: 'strict', description: 'strict tool', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false } },
    { name: 'read', description: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
    { name: 'default', description: 'tool', parameters: { type: 'object', properties: { x: { type: 'string', default: 'x' } } } },
    { name: 'bad_union', description: 'unsupported', parameters: { type: 'object', properties: { x: { type: 'string', enum: ['a', 'b'], const: 'a' } } } },
  ])
  assert.deepEqual(result.compatibility.map((entry) => entry.status), ['preserved', 'converted', 'converted', 'disabled'])
  assert.deepEqual(result.tools.map((tool) => tool.name), ['strict', 'read', 'default'])
  assert.deepEqual(result.tools[0].inputSchema.required, ['x'])
  assert.equal(result.tools[1].inputSchema.additionalProperties, false)
  assert.match(result.compatibility[1].reason, /禁止未声明参数/)
})

test('non-validating defaults and examples become descriptions without adding arguments', () => {
  const original = { type: 'object', additionalProperties: false, default: { mode: 'auto' }, properties: {
    mode: { type: 'string', default: 'auto', examples: ['auto', 'manual'], description: 'Mode' },
    nested: { type: 'object', additionalProperties: true, properties: {
      attempts: { type: 'integer', default: 1 },
    } },
    alternatives: { oneOf: [{ type: 'string', examples: ['x'] }, { type: 'boolean', default: false }] },
  } }
  const { tools, compatibility } = toMcpToolDefinitions([{ name: 'sample', description: 'run', parameters: original }])
  assert.equal(compatibility[0].status, 'converted')
  assert.match(compatibility[0].reason, /default\/examples.*未自动填入参数/)
  assert.match(tools[0].description, /默认值.*\{"mode":"auto"\}/)
  assert.match(tools[0].inputSchema.properties.mode.description, /Mode\n.*默认值.*"auto"/s)
  assert.match(tools[0].inputSchema.properties.mode.description, /示例.*\["auto","manual"\]/)
  assert.match(tools[0].inputSchema.properties.nested.properties.attempts.description, /默认值.*1/)
  assert.match(tools[0].inputSchema.properties.alternatives.oneOf[1].description, /默认值.*false/)
  const serialized = JSON.stringify(tools[0].inputSchema)
  assert.equal(/"(?:default|examples)"\s*:/.test(serialized), false)
  assert.equal(original.properties.mode.default, 'auto')
  assert.equal(tools[0].inputSchema.required, undefined)
})

test('invalid or oversized annotations disable only the affected tools', () => {
  const circular = {}
  circular.self = circular
  const result = toMcpToolDefinitions([
    { name: 'circular', description: 'bad', parameters: { type: 'object', properties: { x: { type: 'string', default: circular } } } },
    { name: 'lossy', description: 'bad', parameters: { type: 'object', properties: { x: { type: 'string', examples: [undefined] } } } },
    { name: 'oversized', description: 'bad', parameters: { type: 'object', properties: { x: { type: 'string', default: 'x'.repeat(17000) } } } },
    { name: 'good', description: 'ok', parameters: { type: 'object', properties: { x: { type: 'string', default: 'x' } } } },
  ])
  assert.deepEqual(result.compatibility.map((entry) => entry.status), ['disabled', 'disabled', 'disabled', 'converted'])
  assert.deepEqual(result.tools.map((tool) => tool.name), ['good'])
})

test('author DSL is converted with requiredness and nested openness intact', () => {
  const result = toMcpToolDefinitions([{
    name: 'search', description: 'search', parameters: {
      query: { type: 'string', required: true },
      options: { type: 'object', additionalProperties: true, properties: { limit: { type: 'integer' } } },
      value: { type: 'json' },
      tags: { type: 'array', items: { type: 'string' } },
    },
  }])
  assert.equal(result.compatibility[0].status, 'converted')
  assert.deepEqual(result.tools[0].inputSchema.required, ['query'])
  assert.deepEqual(result.tools[0].inputSchema.properties.options.properties.limit, { type: 'integer' })
  assert.equal(result.tools[0].inputSchema.properties.options.additionalProperties, true)
  assert.deepEqual(result.tools[0].inputSchema.properties.value, {})
  assert.match(result.compatibility[0].reason, /安全整数/)
})

test('DSL invalid keywords or cyclic schemas disable only their own tool', () => {
  const cyclic = { type: 'array' }
  cyclic.items = cyclic
  const result = toMcpToolDefinitions([
    { name: 'bad', description: 'bad', parameters: { x: { type: 'string', pattern: 'a' } } },
    { name: 'cycle', description: 'cycle', parameters: { x: cyclic } },
    { name: 'empty', description: 'empty', parameters: {} },
    { name: 'good', description: 'good', parameters: { type: 'object', properties: {} } },
  ])
  assert.deepEqual(result.compatibility.map((entry) => entry.status), ['disabled', 'disabled', 'disabled', 'converted'])
  assert.deepEqual(result.tools.map((tool) => tool.name), ['good'])
})

test('user text, verified image and file handle retain order in SDK prompt', async () => {
  const result = await toSdkPrompt([{ role: 'user', content: [
    { type: 'text', text: '请查看' },
    { type: 'image', attachment: imageRef },
    { type: 'file', attachment: fileRef },
  ] }], options)
  assert.deepEqual(result[0], { type: 'text', text: '请查看' })
  assert.deepEqual(result[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } })
  assert.match(result[2].text, /本机 DSH 的 read 工具/)
  assert.ok(result[2].text.includes(JSON.stringify('mapped:C:\\store\\notes.txt')))
})

test('MCP tool results support text, verified images, files and offloaded handles', async () => {
  const result = await toMcpContent([
    { type: 'text', text: '结果' },
    { type: 'image', attachment: imageRef },
    { type: 'image', attachment: imageRef, offloaded: true },
    { type: 'file', attachment: fileRef },
  ], options)
  assert.deepEqual(result[1], { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') })
  assert.match(result[2].text, /未开放 read_image/)
  assert.match(result[2].text, /未提供图片内容/)
  assert.match(result[3].text, /notes\.txt/)
  assert.deepEqual(await toMcpContent([], options), [])
})

test('省略图片仅在工具可用时提示原生读图，不在转换层绕过权限重新加载', async () => {
  let reads = 0
  const content = await toSdkPrompt([{ type: 'image', attachment: imageRef, offloaded: true }], {
    ...options, imageInput: true, attachments: { ...store, async readImage() { reads++ } },
  })
  assert.match(content[0].text, /read_image 工具读取/)
  assert.match(content[0].text, /仍需通过本机权限与大小校验/)
  assert.equal(reads, 0)
})

test('attachments fail explicitly for unsupported input, limits, missing path and cancellation', async () => {
  let reads = 0
  const fake = { ...store, async readImage(ref) { reads++; return { ref, data: bytes } } }
  const errorCode = (code) => (error) => error.code === code
  await assert.rejects(toSdkPrompt([{ type: 'image', attachment: { ...imageRef, bytes: 3 * 1024 * 1024 } }], { attachments: fake }), errorCode('CONTENT_TOO_LARGE'))
  assert.equal(reads, 0)
  await assert.rejects(toMcpContent([{ type: 'file', attachment: fileRef }], { attachments: store }), errorCode('ATTACHMENT_PATH_UNAVAILABLE'))
  await assert.rejects(toSdkPrompt([{ type: 'image', attachment: { ...imageRef, mediaType: 'image/svg+xml' } }], options), errorCode('INVALID_ATTACHMENT'))
  await assert.rejects(toSdkPrompt([{ type: 'audio' }], options), errorCode('UNSUPPORTED_CONTENT'))
  await assert.rejects(toSdkPrompt([{ role: 'assistant', content: [{ type: 'text', text: 'history' }] }], options), errorCode('UNSUPPORTED_CONTENT'))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(toSdkPrompt([{ type: 'text', text: 'x' }], { ...options, signal: controller.signal }), errorCode('CANCELLED'))
})
