/** Render confirmed SDK boundaries as durable, display-only conversation markers. */
export function createCompactionHistory({ React }) {
  const kind = 'claude-bridge-compaction';
  const record = 'plugin:claude-bridge/compaction';
  const count = value => Number.isSafeInteger(value) && value >= 0;
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
  function CompactionMarker({ node }) {
    const data = node.data;
    const label = data.trigger === 'auto' ? '自动压缩已完成'
      : data.trigger === 'manual' ? '手动压缩已完成' : '上下文压缩已完成';
    const details = [];
    if (count(data.preTokens)) details.push(`压缩前 ${data.preTokens.toLocaleString()} tokens`);
    if (count(data.postTokens)) details.push(`压缩后 ${data.postTokens.toLocaleString()} tokens`);
    if (count(data.durationMs)) details.push(`耗时 ${(data.durationMs / 1000).toFixed(1)} 秒`);
    return React.createElement('details', { style: { padding: '8px 0',
      color: 'var(--dsw-alias-text-secondary, #777)', fontSize: '13px' } },
    React.createElement('summary', { style: { cursor: 'pointer' } }, label),
    React.createElement('div', { style: { padding: '8px 16px', whiteSpace: 'pre-wrap' } },
      details.length ? `${details.join(' · ')}\n` : '',
      'Claude 原生压缩已完成。当前接口未提供压缩摘要正文。'));
  }
  return function installCompactionHistory(ctx) {
    const disposeEvent = ctx.uiConversation.events.register({
      kind, target: 'chat',
      match: event => valid(event) ? { id: `${dataOf(event).runId}:${dataOf(event).completedAt}`, role: 'start' } : null,
      start: (_context, match) => ({ trigger: dataOf(match.event).trigger, seq: match.event.seq,
        ...Object.fromEntries(['preTokens', 'postTokens', 'durationMs']
          .filter(key => count(dataOf(match.event)[key])).map(key => [key, dataOf(match.event)[key]])) }),
      update: context => context.state,
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
