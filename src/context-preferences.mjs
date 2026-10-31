/** Device-wide defaults for native SDK compaction; never changes model capacity. */
export function validateContextPreferences(value = { autoCompactWindowTokens: null }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'autoCompactWindowTokens')
    || !Object.hasOwn(value, 'autoCompactWindowTokens')
    || (value.autoCompactWindowTokens !== null && (!Number.isSafeInteger(value.autoCompactWindowTokens)
      || value.autoCompactWindowTokens < 100_000 || value.autoCompactWindowTokens > 1_000_000))) {
    throw Object.assign(new Error('自动压缩窗口须为 100,000–1,000,000 之间的整数，或选择跟随模型默认。'),
      { code: 'INVALID_CONTEXT_PREFERENCES' })
  }
  return { autoCompactWindowTokens: value.autoCompactWindowTokens }
}
