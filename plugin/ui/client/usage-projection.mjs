/** Reuse the desktop's usage component with a remote-only numerical projection. */
export function createUsageProjectionBridge({ React, createClientFirstOutput, createPortal,
  useAnchoredPosition, useDismissOnOutsidePointer }) {
  return function installUsageProjection(ctx) {
    if (typeof ctx.slots.entries !== 'function' || typeof ctx.slots.subscribe !== 'function') return () => {};
    const wrappers = new Set();
    const firstOutput = createClientFirstOutput?.();
    let closed = false;
    const duration = value => value == null || !Number.isFinite(value) ? '未知'
      : value < 1000 ? `${Math.round(value)} ms` : `${Math.round(value / 100) / 10} s`;
    function RemoteStats({ nativeProps, stats, measured, observer, NativeUsage }) {
      const mode = nativeProps.usePerformanceUsage?.(value => value);
      const empty = React.useMemo(() => ({ version: 1, submissions: 0, samples: 0, totalMs: 0 }), []);
      const client = React.useSyncExternalStore(observer?.subscribe ?? (() => () => {}),
        observer?.getSnapshot ?? (() => empty));
      const [open, setOpen] = React.useState(false);
      const rootRef = React.useRef(null), panelRef = React.useRef(null);
      const position = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 });
      useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef);
      React.useEffect(() => {
        if (!open) return;
        const close = event => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('keydown', close);
        return () => document.removeEventListener('keydown', close);
      }, [open]);
      if (mode === 'compact') return React.createElement(NativeUsage, nativeProps);
      if (!stats.steps && !client.submissions) return null;
      const count = measured?.responseCount ?? 0, sdkSamples = measured?.ttftSteps ?? 0;
      const speed = stats.decodeMs > 0 ? `${Math.round(stats.decodeTokens / stats.decodeMs * 10000) / 10} tok/s` : '未知';
      const counts = nativeProps.t('stats.counts', { turns: stats.turns, steps: stats.steps });
      const label = speed === '未知' ? counts : `${counts} · ${speed}`;
      const rows = [
        ['客户端首字显示（观察）', duration(client.samples ? client.totalMs / client.samples : null),
          `本窗口客户端提交前开始，原生正文或思考内容实际可见后观察；包括本机准备、网络和渲染等待，不是显示器物理 paint 精确时间。${client.samples}/${client.submissions} 次客户端提交有样本；排队、插话、后台或无法关联时不计，旧历史缺观察为未知。`],
        ['SDK 首有效输出（估算）', duration(sdkSamples ? measured.ttftMs / sdkSamples : null),
          `SDK 首帧时长，加上远端同机观察首帧到有效正文、思考或工具参数的间隔；含 SDK 缓冲和调度误差，非精确上游计时。${sdkSamples}/${count} 个响应有样本，与客户端提交的分母独立。`],
        [nativeProps.t('stats.dialog.llmTime'), duration(stats.llmMs)],
        [nativeProps.t('stats.dialog.toolTime'), duration(stats.toolMs)],
        ['接收速度（TPS）', speed,
          `同一完整响应输出 Token / 本机接收首帧至最后有效内容的时长，包含思考和缓冲影响；${measured?.tpsSamples ?? 0}/${count} 个响应有完整样本。`],
      ];
      return React.createElement('span', { ref: rootRef, 'data-composer-stat': 'activity', style: { display: 'inline-flex' } },
        React.createElement('button', { type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': open,
          'aria-label': String(label), onClick: () => setOpen(!open),
          style: { border: 0, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)',
            font: 'inherit', cursor: 'pointer', padding: '1px 4px', fontVariantNumeric: 'tabular-nums' } }, label),
        open && createPortal(React.createElement('div', { ref: panelRef, role: 'dialog',
          'aria-label': '远程会话耗时与速度',
          style: { position: 'fixed', zIndex: 1100, minWidth: 270, padding: 12, borderRadius: 12,
            background: 'var(--dsw-specific-menu, #fafafa)', color: 'var(--dsw-alias-label-secondary)',
            boxShadow: 'var(--dsw-elevation-prominent, 0 4px 20px #0002)',
            fontSize: 12, ...(position ?? { visibility: 'hidden', left: 0, top: 0 }) } },
          React.createElement('strong', null, '远程会话耗时与速度'),
          React.createElement('dl', { 'data-session-stats-details': true,
            style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 16px', marginBottom: 0 } },
          ...rows.flatMap(([name, value, title]) => [React.createElement('dt', { key: `${name}:label`, title }, name),
            React.createElement('dd', { key: `${name}:value`, title, style: { margin: 0, fontVariantNumeric: 'tabular-nums' } }, value)]))), document.body));
    }
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
            if (firstOutput && createPortal && useAnchoredPosition && useDismissOnOutsidePointer) {
              return React.createElement(RemoteStats, { nativeProps: { ...props, useProjection: alias },
                stats, measured, observer: props.clientFirstOutput, NativeUsage });
            }
            const ttftSamples = measured?.ttftSteps ?? 0, tpsSamples = measured?.tpsSamples ?? 0;
            const count = measured?.responseCount ?? 0;
            // rc.5 renders these two locale values only as <dt> children.
            // Keep all other translation calls and ordinary sessions native.
            const translate = (key, ...args) => key === 'stats.dialog.ttft'
              ? React.createElement('span', { title:
                `SDK 首帧时长，加上远端同机观察首帧到首个有效输出的间隔，再按样本取平均；非空正文、思考和工具参数 JSON 增量均算有效输出，排除开始帧、心跳、签名和工具名。此估算含 SDK 缓冲与调度误差，非精确上游计时；${ttftSamples}/${count} 个响应有计时样本，缺证据的响应不计入平均。` }, '首 Token 平均（TTFT）')
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
