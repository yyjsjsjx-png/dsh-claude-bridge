/** Visibility preferences only; hidden models remain resolvable for history. */
export function defaultVisibleIds(models) {
  return models.filter(model => {
    // Match the user's requested family/version against official metadata.
    // Recommended/account defaults are aliases, not extra named model rows.
    if (/default/i.test(`${model.value} ${model.displayName}`)) return false
    const label = `${model.displayName} ${model.value}`
    const family = label.match(/(?:^|[^a-z])(opus|haiku|sonnet)(?=[^a-z]|$)/i)?.[1]
    if (!family) return false
    return /(?:^|[^0-9])5[.\-_]5(?:[^0-9]|$)/.test(model.displayName)
      || new RegExp(`(?:^|[-_])${family}[-_]5[-_]5(?:$|[-_\\[])`, 'i').test(model.resolvedModel ?? model.value)
  }).map(model => model.value)
}

export function validateVisibleIds(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'enabledIds') || !Array.isArray(value.enabledIds)
    || value.enabledIds.length > 1024
    || value.enabledIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 256 || /[\x00-\x1f\x7f]/.test(id))
    || new Set(value.enabledIds).size !== value.enabledIds.length) {
    throw Object.assign(new TypeError('模型显示设置无效，请重新选择。'), { code: 'MODEL_PREFERENCES_INVALID' })
  }
  return [...value.enabledIds]
}
