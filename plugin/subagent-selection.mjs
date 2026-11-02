import { CLAUDE_PROVIDER } from './policy.mjs';

export const MODEL_DEFAULT_EFFORT = 'model-default';

/** Validate and translate the supplied catalog. The remote tool owns applying
 * device visibility and Session policy; no default effort is inferred here. */
export function subagentModels(catalog) {
  const rows = Array.isArray(catalog) ? catalog : catalog?.status === 'ok' ? catalog.models : undefined;
  if (!Array.isArray(rows) || !rows.length) throw new Error('远程子任务模型目录尚未就绪。');
  const seen = new Set(['account-default']);
  return rows.map(row => {
    if (!row || typeof row.value !== 'string' || !row.value || seen.has(row.value)
      || typeof row.displayName !== 'string' || !row.displayName) throw new Error('远程子任务模型目录无效。');
    seen.add(row.value);
    const efforts = row.supportedEffortLevels;
    if (efforts !== undefined && (!Array.isArray(efforts)
      || efforts.some(id => typeof id !== 'string' || !id || id === MODEL_DEFAULT_EFFORT)
      || new Set(efforts).size !== efforts.length)) throw new Error('远程子任务推理强度目录无效。');
    return { provider: CLAUDE_PROVIDER, id: row.value, name: row.displayName,
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
      ...(efforts?.length ? { reasoning: { efforts: efforts.map(id => ({ id, name: id })) } } : {}) };
  });
}

export function assertRemoteSubagentRoute(options) {
  if (options.provider !== CLAUDE_PROVIDER) {
    throw Object.assign(new Error('远程子任务只能使用同一 Claude 账号的模型。'), { code: 'SUBAGENT_ENGINE_MISMATCH' });
  }
}

/** An own undefined overwrites the parent's effort in rc5's native child merge,
 * including when the explicitly selected model is the same as the parent. */
export function withModelDefault(options) {
  if (options?.reasoningEffort !== MODEL_DEFAULT_EFFORT) return options;
  return { ...options, reasoningEffort: undefined };
}
