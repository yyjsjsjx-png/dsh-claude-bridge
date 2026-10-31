// Explicit catalog declarations take precedence over this dated fallback.
// Official model reference checked 2026-10-31:
// https://platform.claude.com/docs/en/models/overview
// These four named models accept images; unknown models/aliases stay unknown.
const VISION_MODELS = new Set([
  'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5',
])

/** Resolve image support without deriving it from a display name or family. */
export function imageCapability(model) {
  if (Array.isArray(model?.inputModalities) && model.inputModalities.length
    && model.inputModalities.every(value => typeof value === 'string' && value.length > 0)) {
    const supported = model.inputModalities.includes('image')
    return { supported, source: 'catalog', reason: supported
      ? '官方目录声明支持图片输入。' : '官方目录声明的输入类型不包含图片。' }
  }
  const identity = model?.resolvedModel ?? model?.value
  // The SDK may append a context-size selector to an otherwise exact model ID.
  const canonical = typeof identity === 'string' ? identity.replace(/\[(?:1m|200k)\]$/, '') : undefined
  if (VISION_MODELS.has(canonical)) {
    return { supported: true, source: 'official-reference', reason: '官方型号资料已确认支持图片输入（2026-10-31）。' }
  }
  return { supported: undefined, source: 'unknown', reason: '该型号的图片能力尚未确认；请使用已确认支持视觉的明确型号。' }
}
