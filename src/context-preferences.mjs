/** Validate the optional TTL override used by the Claude Code subprocess. */
export function validatePromptCacheTtl(value) {
  if (value !== undefined && value !== '5m' && value !== '1h') {
    throw Object.assign(new Error('缓存有效期须选择跟随 Claude Code、5 分钟或 1 小时。'),
      { code: 'INVALID_PROMPT_CACHE_TTL' })
  }
  return value
}

/** Validate device-wide defaults for native SDK context behavior. */
export function validateContextPreferences(value = { autoCompactWindowTokens: null }, { allowCacheTtl = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'autoCompactWindowTokens' && !(allowCacheTtl && key === 'promptCacheTtl'))
    || !Object.hasOwn(value, 'autoCompactWindowTokens')
    || (value.autoCompactWindowTokens !== null && (!Number.isSafeInteger(value.autoCompactWindowTokens)
      || value.autoCompactWindowTokens < 100_000 || value.autoCompactWindowTokens > 1_000_000))) {
    throw Object.assign(new Error('自动压缩窗口须为 100,000–1,000,000 之间的整数，或选择跟随模型默认。'),
      { code: 'INVALID_CONTEXT_PREFERENCES' })
  }
  const promptCacheTtl = validatePromptCacheTtl(value.promptCacheTtl)
  return { autoCompactWindowTokens: value.autoCompactWindowTokens,
    ...(promptCacheTtl === undefined ? {} : { promptCacheTtl }) }
}
