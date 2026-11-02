/** Reuse the desktop's usage component with a remote-only numerical projection. */
export function createUsageProjectionBridge({ React, createClientFirstOutput }) {
  return function installUsageProjection(ctx) {
    if (typeof ctx.slots.entries !== 'function' || typeof ctx.slots.subscribe !== 'function') return () => {};
    const wrappers = new Set();
    const firstOutput = createClientFirstOutput?.();
    const clientTimingAvailable = Boolean(firstOutput && typeof React.useSyncExternalStore === 'function');
    const emptyClientTiming = { submissions: 0, samples: 0, totalMs: 0 };
    const emptyClientSource = { getSnapshot: () => emptyClientTiming, subscribe: () => () => {} };
    let closed = false;
    const duration = value => value == null || !Number.isFinite(value) ? '未知'
      : value < 1000 ? `${Math.round(value)} ms` : `${Math.round(value / 100) / 10} s`;
    function ObservedAssistant({ nativeProps, NativeAssistant }) {
      const root = React.useRef(null), seat = React.useRef(null);
      React.useLayoutEffect(() => {
        const observed = nativeProps.clientFirstOutput?.observe(nativeProps, root.current);
        seat.current = observed;
        return () => { observed?.cancel(); if (seat.current === observed) seat.current = null; };
      }, [nativeProps.clientFirstOutput, nativeProps.node?.data?.turn]);
      // Stream commits refresh the candidate without canceling its two frames:
      // a token every frame must not postpone the first sample until completion.
      React.useLayoutEffect(() => { seat.current?.update(nativeProps); });
      return React.createElement('div', { ref: root, style: { display: 'contents' } },
        React.createElement(NativeAssistant, nativeProps));
    }
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
            const observer = props.clientFirstOutput ?? emptyClientSource;
            // Capability is fixed for this installation, so ordinary/remote
            // switching retains the same hook order. NativeUsage owns all UI.
            const client = clientTimingAvailable
              ? React.useSyncExternalStore(observer.subscribe, observer.getSnapshot) : emptyClientTiming;
            const useClient = client.samples > 0;
            const stats = {
              turns: original?.turns ?? 0, steps: original?.steps ?? 0,
              llmMs: original?.llmMs ?? 0, toolMs: original?.toolMs ?? 0,
              ttftMs: useClient ? client.totalMs : measured?.ttftMs ?? 0,
              ttftSteps: useClient ? client.samples : measured?.ttftSteps ?? 0,
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
            const sdkMean = duration(ttftSamples ? measured.ttftMs / ttftSamples : null);
            const ttftSource = useClient ? '当前显示客户端首字显示（观察）：从本窗口提交前至原生正文或思考内容实际可见后的双帧观察，包括本机准备、网络和渲染等待，不是显示器物理 paint 精确时间。'
              : '客户端观察不可用或暂无样本，当前显示 SDK 首有效输出（估算）；没有用 SDK 记录补造客户端样本。';
            // rc.5 renders these two locale values only as <dt> children.
            // Keep all other translation calls and ordinary sessions native.
            const translate = (key, ...args) => key === 'stats.dialog.ttft'
              ? React.createElement('span', { title:
                `${ttftSource} 客户端 ${client.samples}/${client.submissions} 次提交有样本，排队、插话、后台、旧历史或无法关联时不计。独立 SDK 首有效输出均值：${sdkMean}，${ttftSamples}/${count} 个响应有计时样本。SDK 首帧时长加上远端同机首帧到有效正文、思考或工具参数的间隔，包含缓冲与调度误差，非精确上游计时。两套分母独立，不相加、不混合平均；均无证据时为未知，按原生行为不显示 TTFT 行。` }, props.t(key, ...args))
              : key === 'stats.dialog.speed' ? React.createElement('span', { title:
                `将同一完整响应的输出 Token，与本机收到原始 SDK message_start 至最后有效内容帧的时长配对，汇总后计算接收速度；该本机观察窗口包含思考阶段和缓冲影响，不代表上游生成测速；${tpsSamples}/${count} 个响应有完整接收样本。` }, '接收速度（TPS）')
                : props.t(key, ...args);
            return React.createElement(NativeUsage, { ...props, useProjection: alias, t: translate });
          }
          function RemoteAssistant(props) {
            const remote = props.useProjection('claudeBridge') != null;
            return remote && firstOutput ? React.createElement(ObservedAssistant, { nativeProps: props, NativeAssistant: NativeUsage })
              : React.createElement(NativeUsage, props);
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
          const component = id === 'activity' ? RemoteActivity : id === 'assistant-step' ? RemoteAssistant : RemoteUsage;
          wrappers.add(component);
          const inject = firstOutput && ['activity', 'assistant-step'].includes(id) ? (...args) => {
            const original = typeof next.inject === 'function' ? next.inject(...args) : {};
            const sessionId = args[0];
            const binding = ctx.sessions?.binding?.(sessionId);
            const observer = firstOutput.bind(sessionId, binding?.session, binding?.ctx);
            return observer ? { ...original, clientFirstOutput: observer } : original;
          } : next.inject;
          dispose = ctx.slots.register({ name: slot, ...next.options,
            priority: (next.options.priority ?? 0) - 1, locale: next.locale, inject }, component);
        } finally { reconciling = false; }
    };
    const unsubscribe = ctx.slots.subscribe(slot, reconcile);
    reconcile();
    return () => { unsubscribe(); dispose?.(); };
    };
    const cleanup = [mount('conversation.composer.dock', 'id', 'usage'), mount('conversation.chat.node', 'key', 'turn-tail'),
      mount('conversation.composer.dock', 'id', 'activity'), mount('conversation.chat.node', 'key', 'assistant-step')];
    return () => { closed = true; for (const dispose of cleanup) dispose(); firstOutput?.dispose(); wrappers.clear(); };
  };
}
