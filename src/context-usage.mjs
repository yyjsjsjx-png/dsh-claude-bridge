// SDK summary categories only; never transmit paths or arbitrary labels.
const CATEGORY_NAMES = Object.freeze({
  system_prompt: '系统提示', system_tools: '系统工具', mcp_tools: '本机工具',
  mcp_instructions: 'MCP 指令', mcp_tools_deferred: '待加载 MCP 工具',
  system_tools_deferred: '待加载系统工具', custom_agents: '代理定义',
  memory_files: '指令文件', skills: '技能', messages: '会话消息',
  autocompact_buffer: '自动压缩预留', compact_buffer: '压缩预留', free_space: '剩余空间',
})
const count = value => Number.isSafeInteger(value) && value >= 0

export function contextCategories(input) {
  const categories = []
  const seen = new Set()
  for (const item of Array.isArray(input) ? input.slice(0, 64) : []) {
    if (!Object.hasOwn(CATEGORY_NAMES, item?.id) || seen.has(item.id) || !count(item.tokens)
      || !['used', 'free', 'buffer', 'deferred'].includes(item.kind)) continue
    seen.add(item.id)
    categories.push({ id: item.id, name: CATEGORY_NAMES[item.id], tokens: item.tokens, kind: item.kind })
  }
  return categories
}

/** Neither cumulative usage nor the DSH transcript is an input. */
export function contextSnapshot(summary, observedAt = Date.now()) {
  if (summary?.source !== 'sdk-summary-approximate' || !count(summary.totalTokens)
    || !count(summary.maxTokens) || summary.maxTokens === 0) return { status: 'unknown' }
  return { status: 'known', source: 'sdk-summary-approximate',
    totalTokens: summary.totalTokens, maxTokens: summary.maxTokens,
    ...(count(summary.rawMaxTokens) && summary.rawMaxTokens > 0 ? { rawMaxTokens: summary.rawMaxTokens } : {}),
    percentage: summary.totalTokens / summary.maxTokens * 100, observedAt,
    categories: contextCategories(summary.categories) }
}
