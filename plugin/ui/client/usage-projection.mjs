/** Reuse the desktop's usage component with a remote-only numerical projection. */
export function createUsageProjectionBridge({ React }) {
  return function installUsageProjection(ctx) {
    if (typeof ctx.slots.entries !== 'function' || typeof ctx.slots.subscribe !== 'function') return () => {};
    const wrappers = new Set();
    let closed = false;
    const mount = (slot, field, id) => {
      let native, dispose, reconciling = false;
      const reconcile = () => {
        if (closed || reconciling) return;
        // entries() is the complete candidate list, including the shadowed native entry.
        const next = ctx.slots.entries(slot).find(entry => entry.options[field] === id
          && entry.locale === 'chat' && !wrappers.has(entry.component));
        if (next === native) return;
        reconciling = true;
        try {
          native = next;
          dispose?.(); dispose = undefined;
          if (!next) return;
          const NativeUsage = next.component;
          function RemoteActivity(props) {
            const remote = props.useProjection('claudeBridge') != null;
            const measured = props.useProjection('claudeBridgeResponseStats');
            const original = props.useProjection('sessionStats');
            const stats = {
              turns: original?.turns ?? 0, steps: original?.steps ?? 0,
              llmMs: original?.llmMs ?? 0, toolMs: original?.toolMs ?? 0,
              ttftMs: measured?.ttftMs ?? 0, ttftSteps: measured?.ttftSteps ?? 0,
              decodeMs: measured?.decodeMs ?? 0, decodeTokens: measured?.decodeTokens ?? 0,
            };
            const alias = (key, selector, equal) => {
              // Always invoke the native hook; session switching keeps hook order stable.
              const value = props.useProjection(key, selector, equal);
              return !remote || key !== 'sessionStats' ? value
                : typeof selector === 'function' ? selector(stats) : stats;
            };
            if (!remote) return React.createElement(NativeUsage, props);
            const ttftSamples = measured?.ttftSteps ?? 0, tpsSamples = measured?.tpsSamples ?? 0;
            const count = measured?.responseCount ?? 0;
            const translate = (key, ...args) => key === 'stats.dialog.ttft'
              ? `首 Token 平均（TTFT，估算，${ttftSamples} 个样本）`
              : key === 'stats.dialog.speed' ? `接收速度（TPS，${tpsSamples} 个样本）` : props.t(key, ...args);
            const content = React.createElement(NativeUsage, { ...props, useProjection: alias, t: translate });
            const insufficient = !ttftSamples && !tpsSamples;
            return React.createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
              title: `TTFT：SDK 首帧时长，加上远端同机观察首帧到首个有效输出的间隔，再按样本取平均；非空正文、思考和工具参数 JSON 增量均算有效输出，排除开始帧、心跳、签名和工具名。此估算含 SDK 缓冲与调度误差，非精确上游计时；${ttftSamples}/${count} 个响应有样本。`
                + `TPS：将同一完整响应的输出 Token，与本机收到原始 SDK message_start 至最后有效内容帧的时长配对，汇总后计算接收速度；该本机观察窗口包含思考阶段和缓冲影响，不代表上游生成测速；${tpsSamples}/${count} 个响应有样本。` }, content,
            (insufficient || ttftSamples < count || tpsSamples < count) && React.createElement('span',
              { style: { fontSize: 11, opacity: 0.7 } }, insufficient ? '计时样本不足' : '部分计时'));
          }
          function RemoteUsage(props) {
            const remote = props.useProjection('claudeBridge') != null;
            const usage = props.useProjection('claudeBridgeUsage');
            if (id === 'turn-tail') {
              const turn = usage?.turns?.[props.node?.data?.turn];
              if (!remote || turn?.coverage !== 'complete') return React.createElement(NativeUsage, props);
              const { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = turn;
              return React.createElement(NativeUsage, { ...props, node: { ...props.node, data: { ...props.node.data,
                tokenUsage: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                  totalTokens: uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens } } } });
            }
            const alias = (key, ...args) => props.useProjection(remote && usage != null
              && key === 'tokenUsage' ? 'claudeBridgeUsage' : key, ...args);
            const content = React.createElement(NativeUsage, { ...props, useProjection: alias });
            if (!remote || usage?.coverage === 'complete' || usage &&
              usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === 0) return content;
            const incomplete = usage?.coverage === 'legacy' ? '旧记录用量不完整'
              : '当前为已报告用量；旧记录或运行中的用量可能尚未完整。';
            return React.createElement('span', { title: incomplete,
              style: { display: 'inline-flex', alignItems: 'center', gap: 4 } }, content,
            React.createElement('span', { style: { fontSize: 11, opacity: 0.7 } },
              usage?.coverage === 'legacy' ? '历史不完整' : '部分用量'));
          }
          const component = id === 'activity' ? RemoteActivity : RemoteUsage;
          wrappers.add(component);
          dispose = ctx.slots.register({ name: slot, ...next.options,
            priority: (next.options.priority ?? 0) - 1, locale: next.locale, inject: next.inject }, component);
        } finally { reconciling = false; }
    };
    const unsubscribe = ctx.slots.subscribe(slot, reconcile);
    reconcile();
    return () => { unsubscribe(); dispose?.(); };
    };
    const cleanup = [mount('conversation.composer.dock', 'id', 'usage'), mount('conversation.chat.node', 'key', 'turn-tail'),
      mount('conversation.composer.dock', 'id', 'activity')];
    return () => { closed = true; for (const dispose of cleanup) dispose(); wrappers.clear(); };
  };
}
