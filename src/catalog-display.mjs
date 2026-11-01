import { createHash } from 'node:crypto'

/** The persisted key is opaque; connection addresses and grants are never saved here. */
export function catalogConnectionIdentity(connection) {
  return createHash('sha256').update(JSON.stringify(connection)).digest('hex')
}

/** Keep only bounded directory metadata, never arbitrary RPC/account fields. */
export function catalogDisplayModels(input) {
  if (!Array.isArray(input) || input.length > 256) throw new TypeError('模型展示目录无效')
  const seen = new Set()
  const text = (value, limit) => {
    if (typeof value !== 'string' || !value.trim() || value.length > limit) {
      throw new TypeError('模型展示目录字段无效')
    }
    return value
  }
  return input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('模型展示目录条目无效')
    const value = text(item.value, 256)
    if (seen.has(value)) throw new TypeError('模型展示目录包含重复条目')
    seen.add(value)
    const model = { value, displayName: text(item.displayName, 512) }
    for (const [key, limit] of [['description', 2048], ['resolvedModel', 256]]) {
      if (item[key] !== undefined) model[key] = text(item[key], limit)
    }
    for (const [key, limit] of [['inputModalities', 16], ['supportedEffortLevels', 64]]) {
      if (item[key] === undefined) continue
      if (!Array.isArray(item[key]) || item[key].length > limit || new Set(item[key]).size !== item[key].length) {
        throw new TypeError('模型展示目录能力无效')
      }
      model[key] = item[key].map(value => text(value, 64))
    }
    return model
  })
}

export function readDisplayCatalog(record, identity) {
  if (!identity || !record || record.version !== 1 || record.identity !== identity
    || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0) return undefined
  try { return { models: catalogDisplayModels(record.models), updatedAt: record.updatedAt } }
  catch { return undefined }
}
