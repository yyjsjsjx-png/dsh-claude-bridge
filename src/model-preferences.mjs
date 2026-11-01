/** Device-local visibility and remote model-selection preferences. */
const identifier = text => typeof text === 'string' && text.trim().length > 0 && text === text.trim() && text.length <= 256
  && !/[\x00-\x1f\x7f]/.test(text)

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

export function validateCreationSelection(value) {
  if (!value || value.provider !== 'claude-sdk-remote' || !identifier(value.model)
    || (value.reasoningEffort !== undefined && !identifier(value.reasoningEffort))) {
    throw Object.assign(new TypeError('上次模型选择无效，请重新选择。'), { code: 'MODEL_PREFERENCES_INVALID' })
  }
  return { provider: value.provider, model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) }
}

/** Null records an explicit model-default choice; absent models have no memory. */
export function readModelEffortPreferences(state, fallbackSelection) {
  const saved = state.modelEffortPreferences
  const rows = saved?.version === 1 && saved.byModel && typeof saved.byModel === 'object' && !Array.isArray(saved.byModel)
    ? Object.entries(saved.byModel).filter(([model, effort]) => identifier(model) && (effort === null || identifier(effort)))
    : []
  const result = Object.fromEntries(rows.slice(-1024))
  // Existing installations have one last creation selection, not a per-model map.
  const legacy = state.creationSelection ?? fallbackSelection
  if (legacy?.provider === 'claude-sdk-remote' && identifier(legacy.model)
    && !Object.hasOwn(result, legacy.model)
    && (legacy.reasoningEffort === undefined || identifier(legacy.reasoningEffort))) {
    return { ...result, [legacy.model]: legacy.reasoningEffort ?? null }
  }
  return result
}

/** An omitted effort on a different model restores memory; same-model omission selects default. */
export function applyModelEffortPreference(value, current, preferences, models) {
  const selection = validateCreationSelection(value)
  if (Object.hasOwn(value, 'reasoningEffort')
    || (current?.provider === selection.provider && current.model === selection.model)) return selection
  const remembered = Object.hasOwn(preferences, selection.model) ? preferences[selection.model] : null
  const model = models.find(item => item.value === selection.model)
  return typeof remembered === 'string' && model?.supportedEffortLevels?.includes(remembered)
    ? { ...selection, reasoningEffort: remembered } : selection
}
