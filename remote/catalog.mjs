import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { sdkErrorDetail } from './errors.mjs'
import { MODEL_CATALOG_CACHE_MS, isModelCatalogAuthFailure } from '../src/catalog-cache-policy.mjs'

export class CatalogError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CatalogError'
    this.code = code
  }
}

function modelString(value, field, maximum = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new CatalogError('CATALOG_INVALID', `模型目录的 ${field} 无效`)
  }
  return value
}

function sanitizeModels(input) {
  if (!Array.isArray(input) || input.length > 256) throw new CatalogError('CATALOG_INVALID', '模型目录格式无效')
  const ids = new Set()
  return input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new CatalogError('CATALOG_INVALID', '模型目录条目格式无效')
    }
    const value = modelString(item.value, 'value', 256)
    if (ids.has(value)) throw new CatalogError('CATALOG_INVALID', '模型目录包含重复标识')
    ids.add(value)
    const model = { value, displayName: modelString(item.displayName, 'displayName', 512) }
    if (item.description !== undefined) model.description = modelString(item.description, 'description')
    if (item.resolvedModel !== undefined) model.resolvedModel = modelString(item.resolvedModel, 'resolvedModel', 256)
    if (item.inputModalities !== undefined) {
      if (!Array.isArray(item.inputModalities) || item.inputModalities.length === 0 || item.inputModalities.length > 16
        || item.inputModalities.some(value => typeof value !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(value))
        || new Set(item.inputModalities).size !== item.inputModalities.length) {
        throw new CatalogError('CATALOG_INVALID', '模型输入类型目录无效')
      }
      model.inputModalities = [...item.inputModalities]
    }
    for (const key of ['supportsEffort', 'supportsAdaptiveThinking', 'supportsFastMode', 'supportsAutoMode']) {
      if (item[key] !== undefined) {
        if (typeof item[key] !== 'boolean') throw new CatalogError('CATALOG_INVALID', '模型能力字段无效')
        model[key] = item[key]
      }
    }
    if (item.supportedEffortLevels !== undefined) {
      if (!Array.isArray(item.supportedEffortLevels)
        || item.supportedEffortLevels.some((level) => typeof level !== 'string' || !level.trim()
          || level.length > 64 || /[\x00-\x1f\x7f]/.test(level))
        || new Set(item.supportedEffortLevels).size !== item.supportedEffortLevels.length) {
        throw new CatalogError('CATALOG_INVALID', '模型推理档位无效')
      }
      model.supportedEffortLevels = [...item.supportedEffortLevels]
    }
    return model
  })
}

/** Read model capabilities from the CLI initialize handshake without sending a prompt. */
export function createCatalogReader({ sdk, sessionRoot, cliPath, childEnv, now = () => Date.now(), cacheMs = MODEL_CATALOG_CACHE_MS }) {
  let cached
  let pending
  let generation = 0
  const cancelled = () => new CatalogError('CANCELLED', '模型目录查询已取消')
  const clear = () => { cached = pending = undefined; generation++ }
  function remember(input) {
    // A normal SDK Query already returns these capabilities at initialization.
    // Missing/invalid optional metadata must not change that Query's result.
    try {
      const models = sanitizeModels(input)
      generation++; pending = undefined
      cached = { time: now(), models }
      return true
    } catch { return false }
  }

  async function read({ signal, refresh = false } = {}) {
    if (signal?.aborted) throw cancelled()
    if (!refresh && cached && now() - cached.time < cacheMs) return structuredClone(cached.models)
    // Explicit refresh keeps its own query and cancellation. Ordinary cold reads
    // share only the bounded handshake, never one caller's abort signal.
    if (refresh) return structuredClone(await queryModels({ signal }))
    if (!pending) {
      const current = queryModels()
      pending = current
      current.finally(() => { if (pending === current) pending = undefined }).catch(() => {})
    }
    if (!signal) return structuredClone(await pending)
    let onAbort
    try {
      const abort = new Promise((_, reject) => {
        onAbort = () => reject(cancelled())
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      return structuredClone(await Promise.race([pending, abort]))
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  async function queryModels({ signal } = {}) {
    const currentGeneration = ++generation
    const cwd = join(sessionRoot, '_catalog')
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    const controller = new AbortController()
    const cancel = () => controller.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) controller.abort()
    let timer
    let query
    try {
      async function* noPrompt() {
        if (!controller.signal.aborted) {
          await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }))
        }
      }
      query = sdk.query({
        prompt: noPrompt(),
        options: {
          cwd,
          pathToClaudeCodeExecutable: cliPath,
          env: childEnv,
          settingSources: [],
          strictMcpConfig: true,
          tools: [],
          persistSession: false,
          abortController: controller,
        },
      })
      if (typeof query?.initializationResult !== 'function' || typeof query?.close !== 'function') {
        throw new CatalogError('CATALOG_UNAVAILABLE', 'SDK 未提供初始化接口')
      }
      const aborted = new Promise((_, reject) => {
        const onAbort = () => reject(new CatalogError(signal?.aborted ? 'CANCELLED' : 'CATALOG_TIMEOUT', signal?.aborted ? '模型目录查询已取消' : '模型目录查询超时'))
        if (controller.signal.aborted) onAbort()
        else controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      timer = setTimeout(() => controller.abort(), 15_000)
      timer.unref?.()
      const init = await Promise.race([query.initializationResult(), aborted])
      const models = sanitizeModels(init?.models)
      // A slower older cold read must not overwrite an explicit refresh.
      if (currentGeneration === generation) cached = { time: now(), models }
      return models
    } catch (error) {
      const detail = sdkErrorDetail(error)
      const problem = error instanceof CatalogError ? error
        : new CatalogError(detail?.code ?? 'CATALOG_UNAVAILABLE', detail?.message ?? '无法取得账号可用模型目录')
      if (currentGeneration === generation && isModelCatalogAuthFailure(problem.code)) clear()
      throw problem
    } finally {
      clearTimeout(timer)
      controller.abort()
      signal?.removeEventListener('abort', cancel)
      try { query?.close() } catch { /* The catalog process is already closing. */ }
    }
  }

  return { read, clear, remember }
}

/** Reject an unknown model or unsupported explicit effort instead of falling back. */
export function validateModelSelection(models, model, effort) {
  const modelName = model ?? 'default'
  const info = models.find((entry) => entry.value === modelName)
  if (!info) throw new CatalogError(model === undefined ? 'DEFAULT_MODEL_CAPABILITIES_UNKNOWN' : 'MODEL_UNAVAILABLE', '模型不在当前账号可用目录中')
  if (modelName === 'default' && (!info.resolvedModel || info.resolvedModel === 'default')) {
    throw new CatalogError('DEFAULT_MODEL_UNRESOLVED', '当前账号默认模型无法确定，请先选择明确的模型')
  }
  if (effort !== undefined && (!Array.isArray(info.supportedEffortLevels) || !info.supportedEffortLevels.includes(effort))) {
    throw new CatalogError('EFFORT_UNSUPPORTED', '当前模型不支持所选推理档位')
  }
  return info
}
