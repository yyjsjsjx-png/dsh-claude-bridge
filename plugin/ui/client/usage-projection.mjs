/** Reuse the desktop's usage component with a remote-only numerical projection. */
export function createUsageProjectionBridge({ React, getClientTiming = () => undefined }) {
  return function installUsageProjection(ctx) {
    if (typeof ctx.slots.entries !== 'function' || typeof ctx.slots.subscribe !== 'function') return () => {};
    const wrappers = new Set();
    const emptyTiming = Object.freeze({ submissions: 0, samples: 0, totalMs: 0, unknown: 0, pending: 0 });
    const emptySnapshot = () => emptyTiming, emptySubscribe = () => () => {};
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
            const store = getClientTiming()?.getStore(props.clientTimingSessionId);
            const client = React.useSyncExternalStore(store?.subscribe ?? emptySubscribe,
              store?.getSnapshot ?? emptySnapshot, store?.getSnapshot ?? emptySnapshot);
            const stats = {
              turns: original?.turns ?? 0, steps: original?.steps ?? 0,
              llmMs: original?.llmMs ?? 0, toolMs: original?.toolMs ?? 0,
              ttftMs: client.totalMs, ttftSteps: client.samples,
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
            // rc.5 renders these two locale values only as <dt> children.
            // Keep all other translation calls and ordinary sessions native.
            const translate = (key, ...args) => key === 'stats.dialog.ttft'
              ? React.createElement('span', { title:
                `客户端提交至同请求首个有效模型输出被 ClientSession 接收处理的平均耗时，含本机准备、队列、网络及服务端等待；非空正文、思考和工具参数增量均算有效输出，排除开始帧、心跳、签名和工具名。不是像素绘制耗时。当前窗口提交 ${client.submissions} 次，有效 ${client.samples} 次，不可测 ${client.unknown} 次，待完成 ${client.pending} 次；旧历史不补造客户端样本，也不混入 SDK 数值。SDK 估算仍单独保留，${ttftSamples}/${count} 个响应有 SDK 样本。` }, '首 Token 平均（TTFT）')
              : key === 'stats.dialog.speed' ? React.createElement('span', { title:
                `将同一完整响应的输出 Token，与本机收到原始 SDK message_start 至最后有效内容帧的时长配对，汇总后计算接收速度；该本机观察窗口包含思考阶段和缓冲影响，不代表上游生成测速；${tpsSamples}/${count} 个响应有完整接收样本。` }, '接收速度（TPS）')
                : props.t(key, ...args);
            return React.createElement(NativeUsage, { ...props, useProjection: alias, t: translate });
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
              style: { display: 'inline-flex', alignItems: 'center' } }, content);
          }
          const component = id === 'activity' ? RemoteActivity : RemoteUsage;
          wrappers.add(component);
          // Reuse the native injection unchanged, adding only the pane identity
          // needed to read the same per-window receive-timing store.
          const inject = id !== 'activity' ? next.inject : function(sessionId, ...args) {
            return { ...next.inject?.call(this, sessionId, ...args), clientTimingSessionId: sessionId };
          };
          dispose = ctx.slots.register({ name: slot, ...next.options,
            priority: (next.options.priority ?? 0) - 1, locale: next.locale, inject }, component);
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
