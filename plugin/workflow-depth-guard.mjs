import { CLAUDE_PRESET } from './policy.mjs';

/**
 * rc.5 workflow starts children without maxDepth. Restrict its invocation at
 * the configured depth ceiling until the workflow engine forwards that cap.
 * Read both the cap and durable depth afresh for every call. Only the shipped
 * workflow tool in the remote preset is covered; regular DSH is untouched.
 */
export function createWorkflowDepthGuard({ subagents, delegationDepthOf }) {
  if (typeof subagents?.resolveMaxDepth !== 'function' || typeof delegationDepthOf !== 'function') {
    throw new TypeError('DSH 子代理深度服务不可用。');
  }
  return (exec) => {
    const agent = exec?.agent;
    if (exec?.name !== 'workflow' || agent?.session?.header?.agentPreset !== CLAUDE_PRESET) return;
    try {
      const limit = subagents.resolveMaxDepth();
      if (!Number.isSafeInteger(limit) || limit < 0) return '无法确认 DSH 子代理深度限制，已拒绝 workflow。';
      const depth = delegationDepthOf(agent);
      if (depth >= limit) {
        return `已达到 DSH 子代理深度上限（当前 ${depth}，上限 ${limit}）；此处不能执行 workflow。`;
      }
    } catch {
      return '无法确认 DSH 子代理深度，已拒绝 workflow。';
    }
  };
}
