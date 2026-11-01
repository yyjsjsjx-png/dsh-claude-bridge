/** Context and quota views own presentation and React visibility effects. */
export function createMeterViews({ React, createPortal, useAnchoredPosition, useDismissOnOutsidePointer }) {
const CONTEXT_GROUPS = [
  { name: '系统与指令', color: 'var(--dsw-static-neutral-bluish-400, #aeb4bd)',
    ids: ['system_prompt', 'mcp_instructions', 'memory_files', 'custom_agents', 'skills'] },
  { name: '工具定义', color: 'rgb(167, 139, 250)',
    ids: ['system_tools', 'mcp_tools', 'system_tools_deferred', 'mcp_tools_deferred'] },
  { name: '对话消息', color: 'var(--dsw-static-blue-450, #4e8cff)', ids: ['messages'] },
];
const METER_CSS = `
.dsh-claude-meter { display:inline-flex; align-items:center; gap:8px; flex:none;
  color:var(--dsw-alias-label-tertiary, #858992); font-size:var(--dsh-content-font-size-secondary, 13px); }
.dsh-claude-meter-trigger { display:inline-flex; align-items:center; gap:6px; flex:none;
  padding:1px 8px; border:0; border-radius:var(--dsw-radius-sm, 6px); background:transparent;
  color:inherit; font:inherit; font-variant-numeric:tabular-nums; line-height:20px;
  white-space:nowrap; cursor:pointer; }
.dsh-claude-meter-trigger:hover, .dsh-claude-meter-trigger[aria-expanded="true"] {
  background:var(--dsw-alias-interactive-bg-hover, #f1f1f2); color:var(--dsw-alias-label-secondary, #666); }
.dsh-claude-meter-panel { position:fixed; z-index:1100; box-sizing:border-box;
  width:min(280px, calc(100vw - 24px)); padding:12px; border:0;
  border-radius:var(--dsw-radius-lg, 14px); background:var(--dsw-specific-menu, #fafafa);
  backdrop-filter:var(--dsw-menu-backdrop-filter); --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-prominent, 0 4px 20px #0002); font-family:inherit; font-size:12px; line-height:20px;
  color:var(--dsw-alias-label-secondary, #666); }
.dsh-claude-meter-head { display:flex; align-items:center; gap:6px; font-size:12px; line-height:20px; }
.dsh-claude-meter-head strong, .dsh-claude-meter-count { font-weight:500;
  font-variant-numeric:tabular-nums; color:var(--dsw-alias-label-primary, #222); }
.dsh-claude-meter-count { margin-left:auto; white-space:nowrap; }
.dsh-claude-meter-bar { display:flex; gap:1px; height:4px; border-radius:999px;
  margin:10px 0 12px; background:var(--dsw-alias-interactive-bg-hover, #eee); overflow:hidden; }
.dsh-claude-meter-segment { flex:none; min-width:2px; height:100%; border-radius:1px; }
.dsh-claude-meter-rows { margin:6px 0 0; font-size:12px; line-height:20px; }
.dsh-claude-meter-row { display:flex; justify-content:space-between; gap:12px; padding:2px 0; }
.dsh-claude-meter-row dd { margin:0; font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-primary, #222); }
.dsh-claude-meter-swatch { display:inline-block; width:8px; height:8px; margin-right:6px; border-radius:2px; }
.dsh-claude-quota-row { margin-top:12px; font-size:12px; line-height:20px; }
.dsh-claude-quota-line { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.dsh-claude-quota-reset { color:var(--dsw-alias-label-tertiary, #858992); font-size:11px; }
.dsh-claude-quota-bar { height:4px; margin:5px 0 3px; border-radius:999px;
  background:var(--dsw-alias-interactive-bg-hover, #eee); overflow:hidden; }
.dsh-claude-quota-refresh { border:0; border-radius:4px; background:transparent; color:inherit;
  font:inherit; cursor:pointer; margin-left:auto; padding:0 4px; }
.dsh-claude-quota-refresh:hover { background:var(--dsw-alias-interactive-bg-hover, #eee); }
`;
function compactTokens(value) {
  const scaled = number => String(Math.round(number * (number >= 100 ? 1 : 10)) / (number >= 100 ? 1 : 10));
  return value < 1000 ? String(value) : value < 1_000_000 ? `${scaled(value / 1000)}K` : `${scaled(value / 1_000_000)}M`;
}

  function SessionMeter({ useBridgeStatus, syncSession }) {
    const state = useBridgeStatus(value => value);
    React.useEffect(() => {
      if (state == null || !syncSession || ['running', 'compacting', 'stopping'].includes(state.phase)) return;
      let cancelled = false, timer, failures = 0, inFlight = false;
      const sync = async () => {
        clearTimeout(timer);
        if (cancelled || inFlight || document.hidden || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
        inFlight = true;
        let result;
        try { result = await syncSession(); } catch { result = { status: 'unavailable' }; }
        finally { inFlight = false; }
        if (!cancelled) {
          const retry = ['waiting', 'unavailable', 'active'].includes(result?.status);
          if (!retry) failures = 0;
          timer = setTimeout(sync, retry ? Math.min(30_000, 2000 * 2 ** Math.min(failures++, 4)) : 30_000);
        }
      };
      void sync();
      window.addEventListener('online', sync);
      document.addEventListener('visibilitychange', sync);
      return () => { cancelled = true; clearTimeout(timer); window.removeEventListener('online', sync);
        document.removeEventListener('visibilitychange', sync); };
    }, [syncSession, state == null, state?.phase, state?.connection]);
    const [open, setOpen] = React.useState(false);
    const rootRef = React.useRef(null);
    const panelRef = React.useRef(null);
    const position = useAnchoredPosition({ open: open && state != null,
      anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 });
    useDismissOnOutsidePointer(rootRef, open && state != null, setOpen, panelRef);
    React.useEffect(() => { setOpen(false); }, [state?.model]);
    React.useEffect(() => {
      if (!open) return;
      const dismiss = event => { if (event.key === 'Escape') setOpen(false); };
      document.addEventListener('keydown', dismiss);
      return () => document.removeEventListener('keydown', dismiss);
    }, [open]);
    if (state == null) return null;
    const snapshot = state.context;
    const known = snapshot?.status === 'known';
    const phases = { stopping: '正在停止…', stopped: '已停止', unknown: '状态待核实',
      failed: '运行失败', compacting: '正在压缩…' };
    const recovery = state.recovery;
    const recoveryText = { syncing: '同步记录…', waiting: '等待云端收尾…', unavailable: '同步待重试' }[recovery?.status]
      ?? (recovery?.status === 'ready' && recovery.interrupted ? '已恢复，可继续' : null);
    const reading = !known ? '未知' : snapshot.percentage > 0 && snapshot.percentage < 0.1 ? '<0.1%'
      : `≈${Math.round(snapshot.percentage * (snapshot.percentage < 1 ? 10 : 1)) / (snapshot.percentage < 1 ? 10 : 1)}%`;
    const percent = known ? Math.min(100, snapshot.percentage) : 0;
    // Group only SDK-provided used categories. Free space, reserves and
    // deferred definitions are not occupied context; absent rows stay absent.
    const rows = known ? CONTEXT_GROUPS.map(group => ({ ...group,
      tokens: snapshot.categories.filter(item => item.kind === 'used' && group.ids.includes(item.id))
        .reduce((sum, item) => sum + item.tokens, 0),
    })).filter(row => row.tokens > 0) : [];
    const categoryTotal = rows.reduce((sum, row) => sum + row.tokens, 0);
    const segments = rows.length ? rows.map(row => ({ ...row, width: percent * row.tokens / categoryTotal }))
      : [{ name: '已用', color: 'var(--dsw-static-blue-450, #4e8cff)', width: percent }];
    return React.createElement('span', { ref: rootRef, className: 'dsh-claude-meter' },
      React.createElement('style', null, METER_CSS),
      !recoveryText && phases[state.phase] && React.createElement('span', { role: 'status' }, phases[state.phase]),
      recoveryText && React.createElement('button', { type: 'button', className: 'dsh-claude-meter-trigger',
        'aria-label': '同步云端记录', title: recovery.status === 'ready'
          ? `已补齐 ${recovery.added} 条消息。${recovery.unresolvedTools ? `${recovery.unresolvedTools} 个工具结果仍待核实；继续对话时会告知 Claude。` : '可以直接在输入框继续对话。'}`
          : '自动同步原生 Claude 会话；点击可立即重试。', onClick: () => { void syncSession?.().catch(() => {}); } }, recoveryText),
      state.connection === 'reconnecting' && React.createElement('span', { role: 'status',
        title: '短暂断线，正在恢复原连接；不会重新发送整轮请求。' }, '连接恢复中…'),
      state.toolMayHaveExecuted && React.createElement('span', { role: 'status',
        title: '工具可能已执行，停止不代表撤销。' }, '工具结果待核实'),
      React.createElement('button', { type: 'button', className: 'dsh-claude-meter-trigger',
        'aria-label': `上下文已用 ${reading}`, 'aria-haspopup': 'dialog', 'aria-expanded': open,
        title: state.phase === 'running' ? 'SDK 上一轮近似快照，完成本轮后更新' : 'SDK 上下文近似值',
        onClick: () => setOpen(!open) },
        React.createElement('svg', { viewBox: '0 0 14 14', width: 14, height: 14, 'aria-hidden': true },
          React.createElement('circle', { cx: 7, cy: 7, r: 5.5, fill: 'none', strokeWidth: 2,
            stroke: 'var(--dsw-alias-border-l3, #ddd)' }),
          React.createElement('circle', { cx: 7, cy: 7, r: 5.5, fill: 'none', strokeWidth: 2,
            stroke: 'currentColor', strokeLinecap: 'round', transform: 'rotate(-90 7 7)',
            strokeDasharray: `${2 * Math.PI * 5.5 * percent / 100} ${2 * Math.PI * 5.5}` })),
        reading),
      open && createPortal(React.createElement('div', { ref: panelRef,
        className: 'dsh-claude-meter-panel', role: 'dialog', 'aria-label': '上下文已用',
        style: position ?? { visibility: 'hidden', left: 0, top: 0 } },
        React.createElement('div', { className: 'dsh-claude-meter-head' },
          React.createElement('span', null, '上下文已用'), React.createElement('strong', null, reading),
          known && React.createElement('span', { className: 'dsh-claude-meter-count' },
            `~${compactTokens(snapshot.totalTokens)} / ${compactTokens(snapshot.maxTokens)}`)),
        known ? React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'dsh-claude-meter-bar', role: 'meter',
            'aria-label': '上下文占用', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent },
            ...segments.filter(segment => segment.width > 0).map(segment => React.createElement('span', {
              key: segment.name, className: 'dsh-claude-meter-segment',
              style: { width: `${segment.width}%`, background: segment.color } }))),
          rows.length > 0 && React.createElement('dl', { className: 'dsh-claude-meter-rows' },
            ...rows.map(row => React.createElement('div', { key: row.name, className: 'dsh-claude-meter-row' },
              React.createElement('dt', null, React.createElement('span', { className: 'dsh-claude-meter-swatch',
                'aria-hidden': true, style: { background: row.color } }), row.name),
              React.createElement('dd', null, `~${compactTokens(row.tokens)}`)))))
          : React.createElement('p', { style: { margin: '8px 0 0' } }, '完成一轮对话后更新。')), document.body));
  }

  function QuotaMeter({ useBridgeStatus, useQuota, readQuota }) {
    const bridge = useBridgeStatus(value => value);
    const quota = useQuota(value => value);
    const remoteSession = bridge != null;
    const [open, setOpen] = React.useState(false);
    const [now, setNow] = React.useState(() => Date.now());
    const currentTime = Math.max(now, Date.now());
    const rootRef = React.useRef(null);
    const panelRef = React.useRef(null);
    const previousPhase = React.useRef(bridge?.phase);
    const position = useAnchoredPosition({ open: open && remoteSession,
      anchorRef: rootRef, panelRef, side: 'top', gap: 8, margin: 12 });
    useDismissOnOutsidePointer(rootRef, open && remoteSession, setOpen, panelRef);
    React.useEffect(() => {
      if (!remoteSession) { setOpen(false); return; }
      void readQuota('visible');
      const refresh = () => { if (!document.hidden) void readQuota('visible'); };
      const online = () => { if (!document.hidden) void readQuota('online'); };
      const offline = () => { void readQuota('offline'); };
      const poll = setInterval(() => { if (!document.hidden) void readQuota('poll'); }, 60_000);
      const clock = setInterval(() => setNow(Date.now()), 15_000);
      document.addEventListener('visibilitychange', refresh);
      window.addEventListener('online', online);
      window.addEventListener('offline', offline);
      return () => {
        clearInterval(poll); clearInterval(clock); document.removeEventListener('visibilitychange', refresh);
        window.removeEventListener('online', online); window.removeEventListener('offline', offline);
      };
    }, [remoteSession, readQuota]);
    React.useEffect(() => {
      const previous = previousPhase.current;
      previousPhase.current = bridge?.phase;
      if (!remoteSession || !['running', 'compacting', 'stopping'].includes(previous)
        || !['completed', 'stopped', 'failed', 'unknown'].includes(bridge.phase)) return;
      const timer = setTimeout(() => { if (!document.hidden) void readQuota('activity'); }, 3000);
      return () => clearTimeout(timer);
    }, [remoteSession, bridge?.phase, readQuota]);
    React.useEffect(() => {
      if (remoteSession && quota.status === 'available' && (quota.expiresAt <= now
        || quota.windows.some(row => row.resetsAt !== null && row.resetsAt <= now)) && !document.hidden) void readQuota('reset');
    }, [remoteSession, quota, now, readQuota]);
    React.useEffect(() => {
      if (!remoteSession || !quota.nextRefreshAt) return;
      const timer = setTimeout(() => { if (!document.hidden) void readQuota('queued'); },
        Math.max(1, quota.nextRefreshAt - Date.now()));
      return () => clearTimeout(timer);
    }, [remoteSession, quota.nextRefreshAt, readQuota]);
    React.useEffect(() => {
      if (!remoteSession || quota.status !== 'available') return;
      const expiry = Math.min(quota.expiresAt, ...quota.windows.flatMap(row => row.resetsAt === null ? [] : [row.resetsAt]));
      const delay = expiry - Date.now();
      if (delay <= 0) { if (!document.hidden) void readQuota('reset'); return; }
      const timer = setTimeout(() => { setNow(Date.now()); if (!document.hidden) void readQuota('reset'); }, delay + 1);
      return () => clearTimeout(timer);
    }, [remoteSession, quota, readQuota]);
    React.useEffect(() => {
      if (!open) return;
      const dismiss = event => { if (event.key === 'Escape') setOpen(false); };
      document.addEventListener('keydown', dismiss);
      return () => document.removeEventListener('keydown', dismiss);
    }, [open]);
    if (!remoteSession) return null;
    const versionBlocked = quota.paused === 'version';
    const clientUpdateRequired = quota.code === 'CLIENT_UPDATE_REQUIRED';
    const rows = !versionBlocked && quota.status === 'available' && quota.expiresAt > currentTime
      ? quota.windows.filter(row => row.resetsAt === null || row.resetsAt > currentTime) : [];
    const fiveHour = rows.find(row => row.id === 'five_hour');
    const weekly = rows.find(row => row.id === 'seven_day');
    const remaining = row => {
      const value = 100 - row.usedPercent;
      return value > 0 && value < 0.1 ? '<0.1%' : `${Math.round(value * 10) / 10}%`;
    };
    const staleFiveHour = quota.status === 'available' && quota.windows.some(row => row.id === 'five_hour');
    const reading = versionBlocked ? (clientUpdateRequired ? '客户端需更新' : '版本校验失败')
      : [fiveHour && `5h 剩余 ${remaining(fiveHour)}`, weekly && `周剩余 ${remaining(weekly)}`]
        .filter(Boolean).join(' · ') || (staleFiveHour ? '5h 待刷新' : '5h 额度未知');
    const resetTime = row => {
      if (row.resetsAt === null) return '';
      const minutes = Math.max(1, Math.ceil((row.resetsAt - currentTime) / 60_000));
      if (minutes < 60) return `${minutes} 分钟后重置`;
      if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后重置`;
      return `${new Date(row.resetsAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 重置`;
    };
    return React.createElement('span', { ref: rootRef, className: 'dsh-claude-meter' },
      React.createElement('style', null, METER_CSS),
      React.createElement('button', { type: 'button', className: 'dsh-claude-meter-trigger',
        'aria-label': `额度明细，${reading}`, 'aria-haspopup': 'dialog', 'aria-expanded': open,
        title: 'Claude 账号额度，来自 SDK', onClick: () => {
          setNow(Date.now()); setOpen(!open); if (!open) void readQuota('open');
        } },
        React.createElement('svg', { viewBox: '0 0 14 14', width: 14, height: 14, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
          React.createElement('circle', { cx: 7, cy: 7, r: 5.3 }),
          React.createElement('path', { d: 'M7 3.7V7l2.2 1.4', strokeLinecap: 'round', strokeLinejoin: 'round' })),
        reading),
      open && createPortal(React.createElement('div', { ref: panelRef, role: 'dialog', 'aria-label': '剩余额度',
        className: 'dsh-claude-meter-panel',
        style: { ...position ?? { visibility: 'hidden', left: 0, top: 0 }, maxHeight: 'min(420px, calc(100vh - 24px))', overflowY: 'auto' } },
        React.createElement('div', { className: 'dsh-claude-meter-head' },
          React.createElement('strong', null, '剩余额度'),
          React.createElement('button', { type: 'button', className: 'dsh-claude-quota-refresh',
            'aria-label': '刷新额度', title: '刷新额度', disabled: quota.refreshing || quota.paused === 'offline',
            onClick: () => { void readQuota('manual'); } }, quota.refreshing ? '…' : '↻')),
        ...rows.map(row => React.createElement('div', { key: row.id, className: 'dsh-claude-quota-row' },
          React.createElement('div', { className: 'dsh-claude-quota-line' },
            React.createElement('span', null, row.scope === 'model-weekly' ? `${row.name} · 周额度` : row.name),
            React.createElement('strong', { style: { fontWeight: 500, fontVariantNumeric: 'tabular-nums',
              color: 'var(--dsw-alias-label-primary, #222)' } }, remaining(row))),
          React.createElement('div', { className: 'dsh-claude-quota-bar', role: 'meter',
            'aria-label': `${row.name}剩余额度`, 'aria-valuemin': 0, 'aria-valuemax': 100,
            'aria-valuenow': 100 - row.usedPercent },
            React.createElement('div', { style: { height: '100%', width: `${100 - row.usedPercent}%`,
              borderRadius: 'inherit', background: 'var(--dsw-static-blue-450, #4e8cff)' } })),
          row.resetsAt !== null && React.createElement('div', { className: 'dsh-claude-quota-reset' }, resetTime(row)))),
        !rows.length && React.createElement('p', { style: { margin: '10px 0 0' } },
          quota.refreshing ? '正在读取额度…' : versionBlocked ? (clientUpdateRequired
            ? '当前客户端低于服务端版本要求，请更新后重试。' : '服务端版本要求无效，请核对版本声明后重试。')
            : quota.paused === 'auth' ? '请在服务器重新登录后刷新。'
            : quota.paused === 'unsupported' ? '当前服务器不支持额度查询。'
              : quota.paused === 'offline' ? '网络离线，恢复后自动刷新。' : '暂时无法获取有效额度。'),
        versionBlocked && quota.minimumClientVersion && React.createElement('p', null,
          `最低客户端版本：${quota.minimumClientVersion}`),
        versionBlocked && React.createElement('a', {
          href: 'https://github.com/yyjsjsjx-png/dsh-claude-bridge/blob/main/docs/updating.md',
          target: '_blank', rel: 'noopener noreferrer',
        }, '查看更新说明'),
        rows.length > 0 && React.createElement('div', { className: 'dsh-claude-quota-reset', style: { marginTop: 10 } },
          quota.refreshing ? '正在刷新…'
            : `${quota.paused === 'offline' ? '离线 · ' : quota.code ? '刷新失败 · ' : ''}更新于 ${new Date(quota.observedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`)), document.body));
  }

  return { SessionMeter, QuotaMeter };
}
