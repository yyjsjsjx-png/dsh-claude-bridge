// DSH rc5 content and schema projection; no SDK is loaded on the DSH host.
const MAX_CONTENT_BYTES = 3 * 1024 * 1024
const MAX_BLOCKS = 64
const MAX_TOOLS = 80
const MAX_SCHEMA_DEPTH = 32
const MAX_SCHEMA_NODES = 5000
const MAX_ANNOTATION_BYTES = 16 * 1024
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])
const TYPES = new Set([...SCALAR_TYPES, 'object', 'array'])
const FORBIDDEN_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype'])

export class DshContentError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DshContentError'
    this.code = code
  }
}

function fail(code, message) { throw new DshContentError(code, message) }
function cancelled(signal) {
  if (signal?.aborted) fail('CANCELLED', '操作已取消')
}
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).every((key) => typeof key === 'string'
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && 'value' in Object.getOwnPropertyDescriptor(value, key))
}
function schemaError(reason) { throw new Error(reason) }
function keysOnly(object, allowed) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) schemaError(`不支持 schema 关键字 ${key}`)
  }
}
function validScalar(type, value) {
  if (type === 'null') return value === null
  if (type === 'number' || type === 'integer') {
    return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
      && (type !== 'integer' || Number.isSafeInteger(value))
  }
  return typeof value === type
}
// DSH accepts arbitrary lossless JSON in these non-validating annotations.
// Reject values JSON.stringify would silently change, rather than presenting a
// different default/example to the model.
function annotationJson(value) {
  const path = new Set()
  let count = 0
  function visit(item, depth) {
    if (depth > MAX_SCHEMA_DEPTH || ++count > MAX_SCHEMA_NODES) schemaError('schema 注解过深或过大')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return
    if (typeof item !== 'object' || path.has(item)) schemaError('schema 注解不是无损 JSON')
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) {
        schemaError('schema 注解数组不是无损 JSON')
      }
      path.add(item)
      try {
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i))
          if (!descriptor?.enumerable || !('value' in descriptor)) schemaError('schema 注解数组不是无损 JSON')
          visit(descriptor.value, depth + 1)
        }
      } finally { path.delete(item) }
      return
    }
    if (!isRecord(item)) schemaError('schema 注解对象不是无损 JSON')
    path.add(item)
    try { for (const entry of Object.values(item)) visit(entry, depth + 1) }
    finally { path.delete(item) }
  }
  visit(value, 0)
  const text = JSON.stringify(value)
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_ANNOTATION_BYTES) {
    schemaError('schema 注解超过可安全展示的大小')
  }
  return text
}
function schemaNode(value, state, depth, { author = false, property = false } = {}) {
  if (!isRecord(value) || depth > MAX_SCHEMA_DEPTH || ++state.count > MAX_SCHEMA_NODES || state.path.has(value)) {
    schemaError('schema 结构无效、嵌套过深或循环引用')
  }
  state.path.add(value)
  try {
    const annotations = new Set(['description', 'title', 'default', 'examples'])
    for (const name of ['description', 'title']) {
      if (Object.hasOwn(value, name) && typeof value[name] !== 'string') schemaError(`${name} 必须是文本`)
    }
    const result = {}
    for (const name of ['description', 'title']) if (Object.hasOwn(value, name)) result[name] = value[name]
    for (const name of ['default', 'examples']) {
      if (!Object.hasOwn(value, name)) continue
      const json = annotationJson(value[name])
      const note = name === 'default'
        ? `DSH schema 标注的默认值（仅供参考，实际行为以工具为准）：${json}`
        : `DSH schema 标注的示例（仅供参考，不是约束）：${json}`
      result.description = result.description ? `${result.description}\n${note}` : note
      state.annotations.add(name)
      // SDK tool() receives only the property shape; a root description is
      // therefore also carried in its tool-level description.
      if (depth === 0) state.rootNotes.push(note)
    }
    const hasType = Object.hasOwn(value, 'type')
    const hasOneOf = Object.hasOwn(value, 'oneOf')
    if (hasType && hasOneOf) schemaError('type 和 oneOf 不能同时出现')
    const propertyRequired = author && property && Object.hasOwn(value, 'required')
    if (propertyRequired && value.required !== true) schemaError('DSL 参数 required 只能为 true')
    const authorRequired = propertyRequired ? ['required'] : []
    if (hasOneOf) {
      keysOnly(value, new Set([...annotations, ...authorRequired, 'oneOf']))
      if (!Array.isArray(value.oneOf) || value.oneOf.length < 2) schemaError('oneOf 至少需要两个分支')
      result.oneOf = value.oneOf.map((branch) => schemaNode(branch, state, depth + 1, { author }))
      return result
    }
    if (!hasType) {
      if (author) schemaError('DSL 参数缺少 type 或 oneOf')
      keysOnly(value, annotations)
      return result
    }
    const type = value.type
    if (author && type === 'json') {
      keysOnly(value, new Set([...annotations, ...authorRequired, 'type']))
      return result
    }
    if (!TYPES.has(type)) schemaError('不支持此 schema 类型')
    result.type = type
    if (SCALAR_TYPES.has(type)) {
      keysOnly(value, new Set([...annotations, ...authorRequired, 'type', 'enum', 'const']))
      // Zod's JSON Schema importer ignores const when enum is also present.
      if (Object.hasOwn(value, 'enum') && Object.hasOwn(value, 'const')) {
        schemaError('SDK 无法同时保留 enum 与 const 约束')
      }
      if (Object.hasOwn(value, 'enum')) {
        if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.some((item) => !validScalar(type, item))) {
          schemaError('enum 的值无效或超出安全整数范围')
        }
        result.enum = [...value.enum]
      }
      if (Object.hasOwn(value, 'const')) {
        if (!validScalar(type, value.const)) schemaError('const 的值无效或超出安全整数范围')
        result.const = value.const
      }
      if (type === 'integer') state.safeIntegers = true
      return result
    }
    if (type === 'array') {
      keysOnly(value, new Set([...annotations, ...authorRequired, 'type', 'items']))
      if (Object.hasOwn(value, 'items')) result.items = schemaNode(value.items, state, depth + 1, { author })
      return result
    }
    keysOnly(value, new Set([...annotations, ...authorRequired, 'type', 'properties',
      ...(!author ? ['required'] : []), 'additionalProperties']))
    if (author && !Object.hasOwn(value, 'additionalProperties')) schemaError('DSL 对象须声明 additionalProperties')
    if (Object.hasOwn(value, 'additionalProperties')) {
      if (typeof value.additionalProperties !== 'boolean') schemaError('additionalProperties 必须是布尔值')
      result.additionalProperties = value.additionalProperties
    }
    if (Object.hasOwn(value, 'properties')) {
      const compiled = schemaProperties(value.properties, state, depth + 1, author)
      result.properties = compiled.properties
      if (author && compiled.required.length) result.required = compiled.required
    }
    if (!author && Object.hasOwn(value, 'required')) {
      if (!Array.isArray(value.required) || new Set(value.required).size !== value.required.length
        || value.required.some((key) => typeof key !== 'string' || !Object.hasOwn(result.properties ?? {}, key))) {
        schemaError('required 包含无效或未声明的参数')
      }
      result.required = [...value.required]
    }
    return result
  } finally {
    state.path.delete(value)
  }
}
function schemaProperties(value, state, depth, author) {
  if (!isRecord(value) || state.path.has(value)) schemaError('properties 必须是不含循环引用的对象')
  state.path.add(value)
  try {
    const properties = {}
    const required = []
    for (const [name, node] of Object.entries(value)) {
      if (FORBIDDEN_PROPERTIES.has(name)) schemaError('参数名称包含不安全的保留键')
      Object.defineProperty(properties, name, {
        value: schemaNode(node, state, depth, { author, property: author }), enumerable: true, writable: true, configurable: true,
      })
      if (author && node.required === true) required.push(name)
    }
    return { properties, required }
  } finally {
    state.path.delete(value)
  }
}
function toolSchema(parameters) {
  const state = { count: 0, path: new Set(), safeIntegers: false, annotations: new Set(), rootNotes: [] }
  if (!isRecord(parameters)) schemaError('参数 schema 不是对象')
  let schema
  let wasDsl = false
  if (typeof parameters.type === 'string') {
    schema = schemaNode(parameters, state, 0)
    if (schema.type !== 'object') schemaError('工具根 schema 必须是对象')
  } else {
    // {} is both a valid unconstrained raw JSON Schema and an empty author DSL.
    // Inferring an empty argument object here would silently narrow the former.
    if (Object.keys(parameters).length === 0) schemaError('空 schema 不能区分原始 JSON Schema 与作者 DSL')
    wasDsl = true
    const compiled = schemaProperties(parameters, state, 1, true)
    schema = { type: 'object', properties: compiled.properties }
    if (compiled.required.length) schema.required = compiled.required
  }
  const reasons = []
  if (!schema.properties) schema.properties = {}
  if (wasDsl) reasons.push('已将 DSH 作者 DSL 编译为 JSON Schema')
  if (schema.additionalProperties !== false) {
    schema.additionalProperties = false
    reasons.push('根对象改为禁止未声明参数')
  }
  if (state.safeIntegers) reasons.push('SDK 将整数限制为 JavaScript 安全整数')
  if (state.annotations.size) reasons.push(`已将 ${[...state.annotations].join('/')} 非验证注解转为说明，未自动填入参数`)
  return { schema, reasons, rootNotes: state.rootNotes }
}

/** Build a per-tool compatibility report without letting one unsupported tool block others. */
export function toMcpToolDefinitions(input) {
  if (!Array.isArray(input)) fail('INVALID_TOOLS', '工具目录必须是数组')
  const tools = []
  const compatibility = []
  const seen = new Set()
  for (const entry of input) {
    const name = typeof entry?.name === 'string' ? entry.name : ''
    try {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || seen.has(name)) schemaError('工具名称无效或重复')
      seen.add(name)
      if (typeof entry.description !== 'string' || !entry.description.trim()
        || Buffer.byteLength(entry.description, 'utf8') > 32768) schemaError('工具说明无效')
      if (tools.length >= MAX_TOOLS) schemaError('超过远程工具数量限制')
      const { schema, reasons, rootNotes } = toolSchema(entry.parameters)
      const description = [entry.description, ...rootNotes].join('\n')
      if (Buffer.byteLength(description, 'utf8') > 32768) schemaError('转换后的工具说明超过大小限制')
      tools.push({ name, description, inputSchema: schema })
      compatibility.push({ name, status: reasons.length ? 'converted' : 'preserved', reason: reasons.join('；') })
    } catch (error) {
      compatibility.push({ name, status: 'disabled', reason: error instanceof Error ? error.message : 'schema 不受支持' })
    }
  }
  return { tools, compatibility }
}

function validRef(ref, image) {
  if (!isRecord(ref) || typeof ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId)
    || !Number.isSafeInteger(ref.bytes) || ref.bytes < (image ? 1 : 0)
    || (image && (!MEDIA_TYPES.has(ref.mediaType) || !Number.isSafeInteger(ref.width) || ref.width < 1
      || !Number.isSafeInteger(ref.height) || ref.height < 1))
    || (!image && typeof ref.name !== 'string')) {
    fail('INVALID_ATTACHMENT', '附件引用无效或图片格式不受支持')
  }
}
function attachmentPath(ref, options, image = false) {
  const method = image ? 'imageHostPath' : 'fileHostPath'
  if (typeof options.attachments?.[method] !== 'function' || typeof options.mapHostPath !== 'function') {
    fail('ATTACHMENT_PATH_UNAVAILABLE', '附件缺少本机工具可读取的路径映射')
  }
  try {
    const hostPath = options.attachments[method](ref)
    const mappedPath = typeof hostPath === 'string' ? options.mapHostPath(hostPath) : undefined
    if (typeof mappedPath !== 'string' || !mappedPath.trim() || /[\r\n\0]/.test(mappedPath)) {
      fail('ATTACHMENT_PATH_UNAVAILABLE', '附件缺少本机工具可读取的路径映射')
    }
    return mappedPath
  } catch (error) {
    if (error instanceof DshContentError) throw error
    fail('ATTACHMENT_PATH_UNAVAILABLE', '附件路径映射失败')
  }
}
function fileText(ref, options) {
  validRef(ref, false)
  const path = attachmentPath(ref, options)
  const digest = ref.attachmentId.slice(7, 15)
  return `[文件 ${JSON.stringify(ref.name)}（${ref.bytes} 字节，sha256:${digest}）：本机只读副本位于 ${JSON.stringify(path)}。需要内容时请使用本机 DSH 的 read 工具读取该路径；修改前先复制到可写位置。此路径仅属于本机工具环境。]`
}
function offloadedText(ref, options) {
  validRef(ref, true)
  const path = attachmentPath(ref, options, true)
  const name = ref.name === undefined ? ref.attachmentId : `${JSON.stringify(ref.name)} (${ref.attachmentId})`
  const recovery = options.imageInput === true
    ? '此处未提供图片内容；需要视觉信息时请通过本机 DSH 的 read_image 工具读取该路径，仍需通过本机权限与大小校验。'
    : '当前型号未开放 read_image，此处未提供图片内容；需要视觉信息时请提示用户重新附加图片。'
  return `[图片 ${name} 已按 DSH 上下文策略省略；本机只读副本位于 ${JSON.stringify(path)}（${ref.width}x${ref.height}，${ref.mediaType}）。${recovery}]`
}
async function imageData(ref, options) {
  validRef(ref, true)
  if (Math.ceil(ref.bytes / 3) * 4 > MAX_CONTENT_BYTES) fail('CONTENT_TOO_LARGE', '图片超过当前传输大小限制')
  if (typeof options.attachments?.readImage !== 'function') fail('ATTACHMENT_UNAVAILABLE', 'DSH 图片读取服务不可用')
  cancelled(options.signal)
  let stored
  try { stored = await options.attachments.readImage(ref, options.signal) } catch {
    cancelled(options.signal)
    fail('ATTACHMENT_READ_FAILED', '读取或校验图片附件失败')
  }
  cancelled(options.signal)
  if (!(stored?.data instanceof Uint8Array) || stored.data.byteLength !== ref.bytes
    || stored.ref?.attachmentId !== ref.attachmentId || stored.ref?.mediaType !== ref.mediaType
    || stored.ref?.bytes !== ref.bytes) fail('ATTACHMENT_READ_FAILED', '图片附件与记录不一致')
  return Buffer.from(stored.data.buffer, stored.data.byteOffset, stored.data.byteLength).toString('base64')
}
async function projectContent(content, options, target) {
  if (!Array.isArray(content) || (target === 'sdk' && content.length === 0) || content.length > MAX_BLOCKS) {
    fail('INVALID_CONTENT', '内容为空或超过块数量限制')
  }
  const blocks = []
  for (const block of content) {
    cancelled(options.signal)
    if (!isRecord(block)) fail('INVALID_CONTENT', '内容块无效')
    if (block.type === 'text') {
      if (typeof block.text !== 'string') fail('INVALID_CONTENT', '文本内容无效')
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'file') {
      blocks.push({ type: 'text', text: fileText(block.attachment, options) })
    } else if (block.type === 'image' && block.offloaded === true) {
      blocks.push({ type: 'text', text: offloadedText(block.attachment, options) })
    } else if (block.type === 'image') {
      const data = await imageData(block.attachment, options)
      blocks.push(target === 'sdk'
        ? { type: 'image', source: { type: 'base64', media_type: block.attachment.mediaType, data } }
        : { type: 'image', mimeType: block.attachment.mediaType, data })
    } else {
      fail('UNSUPPORTED_CONTENT', '存在不支持的消息或附件类型')
    }
    if (Buffer.byteLength(JSON.stringify(blocks), 'utf8') > MAX_CONTENT_BYTES) {
      fail('CONTENT_TOO_LARGE', '消息或附件超过当前传输大小限制')
    }
  }
  return blocks
}

/** Project only this turn's user messages; Claude SDK owns historical context. */
export async function toSdkPrompt(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) fail('INVALID_CONTENT', '本轮消息为空')
  let content
  if (messages.every((item) => isRecord(item) && typeof item.type === 'string')) content = messages
  else {
    content = []
    for (const message of messages) {
      if (!isRecord(message) || message.role !== 'user' || !Array.isArray(message.content)) {
        fail('UNSUPPORTED_CONTENT', '只能发送本轮用户消息；SDK 会话历史由远端管理')
      }
      content.push(...message.content)
    }
  }
  return projectContent(content, options, 'sdk')
}

/** Convert DSH tool-result blocks to model-visible MCP content. */
export async function toMcpContent(content, options = {}) {
  return projectContent(content, options, 'mcp')
}
