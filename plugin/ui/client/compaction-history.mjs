/** Render confirmed SDK boundaries as durable, display-only conversation markers. */
export function createCompactionHistory({ React, MarkdownText, summaryRules }) {
  const kind = 'claude-bridge-compaction';
  const record = 'plugin:claude-bridge/compaction';
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const uuid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
  const markdownLabels = { code: { copyLabel: '复制', copiedLabel: '已复制',
    toolbarLabels: { codeLabel: '代码', wrapLabel: '换行', unwrapLabel: '取消换行' } }, footnotes: '脚注' };
  const unavailable = { SUMMARY_MISSING: '本次压缩没有返回摘要正文。', SUMMARY_EMPTY: '本次压缩返回的摘要正文为空。',
    SUMMARY_TOO_LARGE: '摘要超过 1 MiB 显示上限，未截断或展示。', SUMMARY_UNPAIRED: '摘要未能与本次压缩边界可靠对应。',
    SUMMARY_UNAVAILABLE: '原生摘要读取失败或暂不可用。', SUMMARY_CONFLICT: '同一压缩边界的摘要记录冲突，未展示正文。' };
  const dataOf = event => {
    const progress = event.data;
    // Older clients persisted the last boundary repeatedly during sampling.
    // preTokens is boundary evidence; a bare status:null is insufficient.
    if (event.type === 'plugin:claude-bridge/progress' && event.ignorable === true
      && progress?.version === 1 && typeof progress.runId === 'string'
      && progress.compaction?.status === 'completed' && count(progress.compaction.preTokens)
      && count(progress.compaction.completedAt)) {
      return { version: 1, runId: progress.runId, ...progress.compaction };
    }
    return event.type === record ? event.data : undefined;
  };
  const valid = event => {
    const data = dataOf(event);
    return event.ignorable === true && data?.version === 1 && typeof data.runId === 'string'
      && ['auto', 'manual', 'unknown'].includes(data.trigger) && count(data.completedAt)
      && ['preTokens', 'postTokens', 'durationMs'].every(key => data[key] === undefined || count(data[key]));
  };
  function CompactionMarker({ node, useProjection }) {
    const data = node.data;
    const state = typeof useProjection === 'function' ? useProjection('claudeBridgeCompactionSummaries') : undefined;
    const summary = summaryRules?.lookup(state, data);
    const [expanded, setExpanded] = typeof React.useState === 'function' ? React.useState(false) : [false, () => {}];
    const title = data.trigger === 'auto' ? '自动压缩已完成'
      : data.trigger === 'manual' ? '手动压缩已完成' : '上下文压缩已完成';
    const label = data.recovered ? `${title} · 历史补录` : title;
    const details = [];
    if (count(data.preTokens)) details.push(`压缩前 ${data.preTokens.toLocaleString()} tokens`);
    if (count(data.postTokens)) details.push(`压缩后 ${data.postTokens.toLocaleString()} tokens`);
    if (count(data.durationMs)) details.push(`耗时 ${(data.durationMs / 1000).toFixed(1)} 秒`);
    const message = summary?.status === 'unavailable' ? unavailable[summary.code] ?? unavailable.SUMMARY_UNAVAILABLE
      : state ? data.boundaryUuid ? '原生压缩摘要尚未送达。' : '旧记录尚未找到可可靠对应的原生摘要。'
        : 'Claude 原生压缩已完成。当前接口未提供压缩摘要正文。';
    return React.createElement('details', { onToggle: event => setExpanded(event.currentTarget.open), style: { padding: '8px 0',
      color: 'var(--dsw-alias-text-secondary, #777)', fontSize: '13px' } },
    React.createElement('summary', { style: { cursor: 'pointer' } }, label),
    React.createElement('div', { style: { padding: '8px 16px', whiteSpace: 'pre-wrap' } },
      details.length ? `${details.join(' · ')}\n` : '', summary?.status === 'available'
        ? expanded ? MarkdownText ? React.createElement(MarkdownText, { text: summary.text, labels: markdownLabels })
          : React.createElement('pre', null, summary.text) : null : message));
  }
  return function installCompactionHistory(ctx) {
    const disposeEvent = ctx.uiConversation.events.register({
      kind, target: 'chat',
      match: event => valid(event) ? { id: `${dataOf(event).runId}:${dataOf(event).completedAt}`, role: 'start' } : null,
      start: (_context, match) => ({ trigger: dataOf(match.event).trigger,
        runId: dataOf(match.event).runId, completedAt: dataOf(match.event).completedAt,
        ...(dataOf(match.event).recovered === true ? { recovered: true } : {}),
        seq: count(dataOf(match.event).anchorSeq) ? dataOf(match.event).anchorSeq : match.event.seq,
        ...(uuid(dataOf(match.event).boundaryUuid) ? { boundaryUuid: dataOf(match.event).boundaryUuid } : {}),
        ...Object.fromEntries(['preTokens', 'postTokens', 'durationMs']
          .filter(key => count(dataOf(match.event)[key])).map(key => [key, dataOf(match.event)[key]])) }),
      update: (context, match) => {
        const boundaryUuid = dataOf(match.event)?.boundaryUuid;
        if (!uuid(boundaryUuid)) return context.state;
        if (context.state.boundaryUuid && context.state.boundaryUuid !== boundaryUuid) return { ...context.state, boundaryConflict: true };
        return { ...context.state, boundaryUuid };
      },
      buildViewNode: context => context.state === undefined ? null : {
        key: context.key, kind, id: context.id, target: 'chat', anchorSeq: context.state.seq,
        location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
        visibility: 'visible', groupTree: 'turn', data: context.state,
      },
    });
    const disposeSlot = ctx.slots.register({ name: 'conversation.chat.node', key: kind }, CompactionMarker);
    return () => { disposeSlot(); disposeEvent(); };
  };
}
