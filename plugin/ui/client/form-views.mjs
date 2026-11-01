/** Forms retain local input state; async actions arrive through props. */
export function createFormViews({ React }) {
const SETTINGS_CSS = `
.dcb-page { display:flex; flex-direction:column; gap:16px; max-width:760px; padding:4px 0 24px;
  color:var(--dsw-alias-label-primary, #222); font-size:13px; line-height:1.6; }
.dcb-header { display:flex; flex-direction:column; gap:10px; }
.dcb-title { margin:0; font-size:18px; font-weight:600; line-height:1.4; }
.dcb-subtitle { margin:0; color:var(--dsw-alias-label-secondary, #666); }
.dcb-chips { display:flex; flex-wrap:wrap; gap:8px; }
.dcb-chip { display:inline-flex; align-items:center; gap:6px; height:26px; padding:0 10px;
  border:.5px solid var(--dsw-alias-border-l3, #ddd); border-radius:999px;
  background:var(--dsw-alias-bg-layer-1, #fafafa); font-size:12px; color:var(--dsw-alias-label-secondary, #666); }
.dcb-dot { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-label-tertiary, #999); flex:none; }
.dcb-chip[data-tone="ok"] .dcb-dot { background:var(--dsw-alias-state-success-primary, #2e9e5b); }
.dcb-chip[data-tone="warn"] .dcb-dot { background:var(--dsw-alias-state-warn-primary, #d99a1e); }
.dcb-chip[data-tone="error"] .dcb-dot { background:var(--dsw-alias-state-error-primary, #d64545); }
.dcb-card { padding:16px 18px; border:.5px solid var(--dsw-alias-border-l2, #e5e5e5);
  border-radius:var(--dsw-radius-lg, 14px); background:var(--dsw-alias-bg-layer-1, #fff); }
.dcb-card-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:4px; }
.dcb-card-title { margin:0; font-size:14px; font-weight:600; }
.dcb-card-meta { color:var(--dsw-alias-label-tertiary, #888); font-size:12px; }
.dcb-card-desc { margin:0 0 8px; color:var(--dsw-alias-label-secondary, #666); font-size:12px; }
.dcb-field { display:flex; flex-direction:column; gap:6px; padding:10px 0; }
.dcb-label { font-size:13px; font-weight:500; }
.dcb-input { box-sizing:border-box; width:100%; height:34px; padding:0 12px;
  border:.5px solid var(--dsw-alias-border-l4, #ccc); border-radius:var(--dsw-radius-md, 10px);
  background:var(--dsw-alias-bg-layer-3, #fff); font:inherit; font-size:13px; color:inherit; }
.dcb-input:focus-visible { outline:none; border-color:var(--dsw-alias-state-business-primary, #4e8cff); }
.dcb-input:disabled { color:var(--dsw-alias-label-tertiary, #999); }
.dcb-input::placeholder { color:var(--dsw-alias-label-dimmed, #aaa); }
.dcb-hint { margin:0; font-size:12px; color:var(--dsw-alias-label-tertiary, #888); }
.dcb-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:6px; }
.dcb-spacer { flex:1; }
.dcb-btn { box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; gap:4px;
  height:30px; padding:0 12px; border:.5px solid var(--dsw-alias-border-l3, #ddd);
  border-radius:var(--dsw-radius-md, 10px); background:transparent; color:inherit;
  font:inherit; font-size:13px; line-height:20px; cursor:pointer; white-space:nowrap; }
.dcb-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover, #f1f1f2); }
.dcb-btn:disabled { cursor:not-allowed; opacity:.45; }
.dcb-btn:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary, #4e8cff); outline-offset:1px; }
.dcb-btn[data-variant="primary"] { border-color:transparent; background:var(--dsw-alias-button-primary-fill, #222);
  color:var(--dsw-alias-label-primary-foreground, #fff); }
.dcb-btn[data-variant="primary"]:hover:not(:disabled) { background:var(--dsw-alias-button-primary-hover, #000); }
.dcb-btn[data-variant="ghost"] { border-color:transparent; }
.dcb-btn[data-variant="danger"] { border-color:transparent; color:var(--dsw-alias-state-error-primary, #d64545); }
.dcb-btn[data-variant="danger"]:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover-danger, #fdecec); }
.dcb-notice { margin:10px 0 0; padding:8px 12px; border-radius:var(--dsw-radius-md, 10px);
  background:var(--dsw-alias-bg-layer-2, #f5f5f5); color:var(--dsw-alias-label-secondary, #555); font-size:12px; }
.dcb-notice[data-tone="error"] { background:var(--dsw-alias-interactive-bg-hover-danger, #fdecec);
  color:var(--dsw-alias-state-error-primary, #c43c3c); }
.dcb-models { display:flex; flex-direction:column; margin:4px -8px 10px; max-height:360px; overflow-y:auto; }
.dcb-model { display:flex; align-items:center; gap:10px; padding:7px 8px; border-radius:var(--dsw-radius-sm, 6px); cursor:pointer; }
.dcb-model:hover { background:var(--dsw-alias-interactive-bg-hover, #f1f1f2); }
.dcb-model input { margin:0; accent-color:var(--dsw-alias-brand-primary, #4e6bfe); }
.dcb-model-name { font-weight:500; }
.dcb-model-id { margin-left:auto; color:var(--dsw-alias-label-tertiary, #888); font-size:12px;
  font-family:var(--ds-font-family-code, ui-monospace, monospace); }
.dcb-stats { display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:8px; margin-top:6px; }
.dcb-stat { display:flex; flex-direction:column; gap:2px; padding:10px 12px; border-radius:var(--dsw-radius-md, 10px);
  background:var(--dsw-alias-bg-layer-2, #f5f5f5); }
.dcb-stat-label { color:var(--dsw-alias-label-tertiary, #888); font-size:12px; }
.dcb-stat-value { font-size:15px; font-weight:600; font-variant-numeric:tabular-nums; }
.dcb-details summary { cursor:pointer; font-size:14px; font-weight:600; list-style-position:inside; }
.dcb-details ul { margin:8px 0; padding-left:20px; color:var(--dsw-alias-label-secondary, #555); font-size:12px; }
.dcb-details p { margin:8px 0 0; color:var(--dsw-alias-label-secondary, #555); font-size:12px; word-break:break-all; }
.dcb-dialog-mask { position:fixed; inset:0; z-index:10000; display:grid; place-items:center;
  background:var(--dsw-alias-bg-mask-1, rgba(0,0,0,.35)); }
.dcb-dialog { box-sizing:border-box; width:min(460px, 92vw); padding:20px 22px;
  border-radius:var(--dsw-radius-panel, 16px); background:var(--dsw-alias-bg-base, #fff);
  color:var(--dsw-alias-label-primary, #222); box-shadow:var(--dsw-elevation-panel, 0 8px 36px #0003);
  font-size:13px; line-height:1.6; }
.dcb-dialog .dcb-title { font-size:16px; margin-bottom:6px; }
.dcb-select { box-sizing:border-box; width:100%; height:34px; padding:0 10px;
  border:.5px solid var(--dsw-alias-border-l4, #ccc); border-radius:var(--dsw-radius-md, 10px);
  background:var(--dsw-alias-bg-layer-3, #fff); color:inherit; font:inherit; font-size:13px; }
.dcb-select:focus-visible { outline:none; border-color:var(--dsw-alias-state-business-primary, #4e8cff); }
.dcb-dialog .dcb-actions { justify-content:flex-end; margin-top:14px; }
`;

  function MenuItem({ sessionId, useMenuOpenState, show }) {
    const [, setOpen] = useMenuOpenState();
    return React.createElement('button', { type: 'button', role: 'menuitem',
      onClick: () => { setOpen(false); void show(sessionId); },
      style: { display: 'block', width: '100%', padding: '7px 12px',
        textAlign: 'left', background: 'transparent', border: 0, cursor: 'pointer' } },
    '新建远程会话');
  }

  function HeroButton({ show }) {
    return React.createElement('button', { type: 'button', onClick: () => { void show(); },
      style: { padding: '5px 10px', border: '.5px solid var(--dsw-alias-border-l3, #ddd)',
        borderRadius: 'var(--dsw-radius-md, 10px)', background: 'transparent', color: 'inherit',
        font: 'inherit', cursor: 'pointer' } },
    '新建远程会话');
  }

  function Picker({ useDialog, dismiss, chooseModel, chooseEffort, submit }) {
    const state = useDialog(value => value);
    if (!state.open) return null;
    const model = state.models.find(item => item.id === state.model);
    const efforts = model?.reasoning?.efforts ?? [];
    return React.createElement('div', { role: 'presentation', className: 'dcb-dialog-mask',
      onKeyDown: event => { if (event.key === 'Escape' && !state.busy) dismiss(); } },
    React.createElement('style', null, SETTINGS_CSS),
    React.createElement('div', { role: 'dialog', 'aria-modal': true, 'aria-label': '新建远程会话', className: 'dcb-dialog' },
    React.createElement('h2', { className: 'dcb-title' }, '新建远程会话'),
    React.createElement('p', { className: 'dcb-hint' }, '模型与推理强度来自服务器账号实际返回的目录。'),
    React.createElement('label', { className: 'dcb-field' },
      React.createElement('span', { className: 'dcb-label' }, '模型'),
      React.createElement('select', { className: 'dcb-select', value: state.model, disabled: state.loading || state.busy,
        onChange: event => chooseModel(event.target.value) },
      React.createElement('option', { value: '' }, state.loading ? '正在读取模型…' : '请选择模型'),
      ...state.models.map(item => React.createElement('option', { key: item.id, value: item.id }, item.name)))),
    efforts.length > 0 && React.createElement('label', { className: 'dcb-field' },
      React.createElement('span', { className: 'dcb-label' }, '推理强度'),
      React.createElement('select', { className: 'dcb-select', value: state.effort, disabled: state.busy,
        onChange: event => chooseEffort(event.target.value) },
      React.createElement('option', { value: '' }, '模型默认'),
      ...efforts.map(item => React.createElement('option', { key: item.id, value: item.id }, item.name)))),
    state.error && React.createElement('p', { role: 'alert', className: 'dcb-notice', 'data-tone': 'error' }, state.error),
    React.createElement('div', { className: 'dcb-actions' },
      React.createElement('button', { type: 'button', className: 'dcb-btn', 'data-variant': 'ghost',
        disabled: state.busy, onClick: dismiss }, '取消'),
      React.createElement('button', { type: 'button', className: 'dcb-btn', 'data-variant': 'primary',
        disabled: state.busy || state.loading || !state.model,
        onClick: () => { void submit(); } }, state.busy ? '正在创建…' : '创建'))));
  }

  function Settings({ useSettings, editUrl, save, clear, refresh, refreshStatus, loadModels, toggleVisibleModel, saveModels,
    editContextMode, editContextWindow, saveContext }) {
    const state = useSettings(value => value);
    const [token, setToken] = React.useState('');
    React.useEffect(() => { if (state.configured) void loadModels(); }, [state.configured, loadModels]);
    React.useEffect(() => {
      const page = typeof document === 'undefined' ? undefined : document;
      const refreshVisible = () => {
        if (page?.hidden || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
        void refreshStatus();
      };
      refreshVisible();
      const timer = window.setInterval?.(refreshVisible, 5000);
      page?.addEventListener?.('visibilitychange', refreshVisible);
      window.addEventListener?.('focus', refreshVisible);
      window.addEventListener?.('online', refreshVisible);
      return () => {
        if (timer !== undefined) window.clearInterval(timer);
        page?.removeEventListener?.('visibilitychange', refreshVisible);
        window.removeEventListener?.('focus', refreshVisible);
        window.removeEventListener?.('online', refreshVisible);
      };
    }, [refreshStatus]);
    const authentication = state.authentication === 'logged-in' ? '已登录'
      : state.authentication === 'login-required' ? '需在服务器完成登录' : '未验证';
    const statuses = { preserved: '原样支持', converted: '已转换', disabled: '已关闭' };
    const displayNumber = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
    const usage = state.usageSummary;
    const submit = () => {
      const value = { url: state.url, ...(token ? { token } : {}) };
      setToken('');
      void save(value);
    };
    const h = React.createElement;
    const chip = (label, value, tone) => h('span', { className: 'dcb-chip', 'data-tone': tone },
      h('span', { className: 'dcb-dot', 'aria-hidden': true }), `${label}：${value}`);
    const stat = (label, value) => h('div', { className: 'dcb-stat' },
      h('span', { className: 'dcb-stat-label' }, label), h('span', { className: 'dcb-stat-value' }, value));
    const selectedCount = state.modelsLoaded
      ? state.models.filter(model => state.selectedModelIds.includes(model.value)).length : 0;
    const authTone = state.authentication === 'logged-in' ? 'ok' : state.authentication === 'login-required' ? 'error' : 'warn';
    return h('section', { className: 'dcb-page' },
      h('style', null, SETTINGS_CSS),
      h('header', { className: 'dcb-header' },
        h('h2', { className: 'dcb-title' }, '远程会话'),
        h('p', { className: 'dcb-subtitle' }, '连接你自己的服务器；官方 Claude Code 与 Agent SDK 在服务器上运行，本机保留界面、文件、命令和审批。'),
        h('div', { className: 'dcb-chips', role: 'status', 'aria-label': '连接状态' },
          chip('配置', state.configured ? '已配置' : '未配置', state.configured ? 'ok' : 'warn'),
          chip('连接', state.connected ? '已连接' : '未连接', state.connected ? 'ok' : state.configured ? 'error' : 'warn'),
          chip('官方登录（最近验证）', authentication, authTone))),
      h('div', { className: 'dcb-card' },
        h('div', { className: 'dcb-card-head' }, h('h3', { className: 'dcb-card-title' }, '服务器连接')),
        h('label', { className: 'dcb-field' }, h('span', { className: 'dcb-label' }, '服务器地址'), h('input', {
          className: 'dcb-input', type: 'url', autoComplete: 'url', placeholder: 'wss://你的域名/', value: state.url,
          disabled: state.busy, onChange: event => editUrl(event.target.value),
        }), h('span', { className: 'dcb-hint' }, '公网使用可信证书的 wss://；SSH 转发时填 ws://127.0.0.1:端口/。')),
        h('label', { className: 'dcb-field' }, h('span', { className: 'dcb-label' }, '桥接口令'), h('input', {
          className: 'dcb-input', type: 'password', autoComplete: 'new-password', value: token, disabled: state.busy,
          placeholder: state.configured ? '已保存；留空则保留原口令' : '输入服务器上生成的桥接口令',
          onChange: event => setToken(event.target.value),
        }), h('span', { className: 'dcb-hint' }, '口令等同于你账号的使用权，只用于本人设备，不要分享给他人。')),
        h('div', { className: 'dcb-actions' },
          h('button', { type: 'button', className: 'dcb-btn', 'data-variant': 'primary', disabled: state.busy, onClick: submit }, '保存'),
          h('button', { type: 'button', className: 'dcb-btn', disabled: state.busy || !state.configured,
            onClick: () => { void refresh(); } }, '测试连接并刷新模型'),
          h('button', { type: 'button', className: 'dcb-btn', 'data-variant': 'ghost', disabled: state.busy,
            onClick: () => { void refreshStatus(); } }, '刷新状态'),
          h('span', { className: 'dcb-spacer' }),
          h('button', { type: 'button', className: 'dcb-btn', 'data-variant': 'danger', disabled: state.busy || state.activeRuns > 0,
            title: '仅移除本机地址和桥接口令；会话记录与服务器登录保留。',
            onClick: () => { setToken(''); void clear(); } }, '清除已保存连接')),
        state.message && h('p', { role: 'status', className: 'dcb-notice' }, state.message),
        (state.error || state.statusError) && h('p', { role: 'alert', className: 'dcb-notice', 'data-tone': 'error' }, state.error || state.statusError)),
      h('div', { className: 'dcb-card' },
        h('div', { className: 'dcb-card-head' }, h('h3', { className: 'dcb-card-title' }, '显示的模型'),
          state.modelsLoaded && state.models.length > 0
            && h('span', { className: 'dcb-card-meta' }, `已选 ${selectedCount} / ${state.models.length}`)),
        h('p', { className: 'dcb-card-desc' }, '选择模型列表中显示的模型；隐藏不会停止已有会话，正在使用的模型会暂时保留在原生列表中。'),
        !state.configured && h('p', { className: 'dcb-hint' }, '请先保存连接设置，再读取账号模型。'),
        state.modelsLoading && h('p', { className: 'dcb-hint' }, '正在读取模型…'),
        state.modelError && h('p', { role: 'alert', className: 'dcb-notice', 'data-tone': 'error' }, state.modelError),
        state.modelsLoaded && h('div', null,
          h('div', { className: 'dcb-models' },
            ...state.models.map(model => h('label', { key: model.value, className: 'dcb-model' },
              h('input', { type: 'checkbox', checked: state.selectedModelIds.includes(model.value),
                disabled: state.busy || state.modelsLoading, onChange: () => toggleVisibleModel(model.value) }),
              h('span', { className: 'dcb-model-name' }, model.displayName),
              model.resolvedModel && model.resolvedModel !== model.displayName
                ? h('span', { className: 'dcb-model-id' }, model.resolvedModel) : null))),
          state.models.length === 0 && h('p', { className: 'dcb-hint' }, '账号当前没有返回可用模型。'),
          h('div', { className: 'dcb-actions' },
            h('button', { type: 'button', className: 'dcb-btn', 'data-variant': 'primary', disabled: state.busy || state.modelsLoading,
              onClick: () => { void saveModels(); } }, '保存模型显示设置'))),
        state.configured && !state.modelsLoading && !state.modelsLoaded
          && h('div', { className: 'dcb-actions' }, h('button', { type: 'button', className: 'dcb-btn', disabled: state.busy,
            onClick: () => { void loadModels(); } }, '读取模型列表'))),
      h('div', { className: 'dcb-card' },
        h('div', { className: 'dcb-card-head' }, h('h3', { className: 'dcb-card-title' }, '上下文与自动压缩'),
          h('span', { className: 'dcb-card-meta' }, '本设备全部远程会话')),
        h('p', { className: 'dcb-card-desc' }, '设置各模型共用的自动压缩窗口，由服务器上的 Claude 原生压缩。保存后从下一轮起生效，当前运行继续使用原设置。'),
        h('label', { className: 'dcb-field' }, h('span', { className: 'dcb-label' }, '自动压缩方式'),
          h('select', { className: 'dcb-input', value: state.contextMode, disabled: state.busy,
            onChange: event => editContextMode(event.target.value) },
          h('option', { value: 'default' }, '跟随模型默认'), h('option', { value: 'custom' }, '自定义压缩窗口'))),
        state.contextMode === 'custom' && h('label', { className: 'dcb-field' },
          h('span', { className: 'dcb-label' }, '自动压缩窗口（tokens）'),
          h('input', { className: 'dcb-input', type: 'number', inputMode: 'numeric', min: 100000, max: 1000000, step: 1000,
            value: state.contextWindow, disabled: state.busy, onChange: event => editContextWindow(event.target.value) }),
          h('span', { className: 'dcb-hint' }, '支持 100,000–1,000,000 tokens，例如 200,000。实际窗口不超过模型自身上限；底栏百分比仍按 SDK 返回的模型上下文统计。')),
        state.autoCompactWindowSupported === false && h('p', { className: 'dcb-notice' }, '当前服务器需要更新后才能使用自定义窗口；跟随模型默认仍可用。'),
        h('div', { className: 'dcb-actions' }, h('button', { type: 'button', className: 'dcb-btn', 'data-variant': 'primary',
          disabled: state.busy || !state.contextDirty || (state.contextMode === 'custom' && state.autoCompactWindowSupported === false),
          onClick: () => { void saveContext(); } }, '保存上下文设置')),
        state.contextMessage && h('p', { role: 'status', className: 'dcb-notice' }, state.contextMessage),
        state.contextError && h('p', { role: 'alert', className: 'dcb-notice', 'data-tone': 'error' }, state.contextError)),
      h('div', { className: 'dcb-card' },
        h('div', { className: 'dcb-card-head' }, h('h3', { className: 'dcb-card-title' }, '本设备用量'),
          h('span', { className: 'dcb-card-meta' }, '本设备统计，不是账单')),
        state.activeRuns > 0 && h('p', { role: 'status', className: 'dcb-notice' }, `正在执行 ${displayNumber(state.activeRuns)} 轮，用量在运行结束后计入。`),
        usage === null ? h('p', { className: 'dcb-hint' }, '暂无统计。')
          : usage.runs === 0 ? h('p', { className: 'dcb-hint' }, '暂无已结算的用量记录。')
            : h('div', { className: 'dcb-stats' },
              stat('会话', displayNumber(usage.sessions)), stat('运行', displayNumber(usage.runs)),
              stat('输入 tokens', displayNumber(usage.inputTokens)), stat('输出 tokens', displayNumber(usage.outputTokens)),
              stat('缓存读取', displayNumber(usage.cacheReadTokens)), stat('缓存写入', displayNumber(usage.cacheWriteTokens)),
              stat('SDK 估算', Number.isFinite(usage.estimatedCostUsd) ? `$${usage.estimatedCostUsd.toFixed(4)}` : '—'))),
      ['basic', 'degraded', 'unavailable'].includes(state.remotePreset?.mode) && h('div', {
        role: state.remotePreset.mode === 'unavailable' ? 'alert' : 'status', className: 'dcb-notice',
      }, state.remotePreset.mode === 'unavailable' ? '远程会话插件不可用。'
        : state.remotePreset.mode === 'basic' ? '远程会话已回退到基础预设。' : '远程会话的部分可选能力已关闭。',
      ' 请展开“兼容性与诊断”查看原因。'),
      state.remoteCapabilities?.status === 'unavailable' && h('p', { role: 'alert', className: 'dcb-notice' },
        `远程会话插件不可用：${state.remoteCapabilities.reason}`),
      h('details', { className: 'dcb-card dcb-details' },
        h('summary', null, '兼容性与诊断'),
        state.desktopCompatibility && h('p', null,
          `DSH ${state.desktopCompatibility.version}；已验证支持：${(state.desktopCompatibility.verifiedVersions ?? []).join('、')}`),
        state.desktopCompatibility && !state.desktopCompatibility.verifiedVersions?.includes(state.desktopCompatibility.version)
          && h('p', { role: 'status', className: 'dcb-notice' }, '此桌面版本尚未完成回归验证，建议继续使用已验证版本。'),
        state.remotePreset && h('p', { role: state.remotePreset.mode === 'unavailable' ? 'alert' : 'status' },
          `远程预设：${({ unchecked: '尚未检查', full: '完整', degraded: '部分能力已关闭', basic: '基础', unavailable: '插件不可用' })[state.remotePreset.mode] ?? '未知'}`),
        ...(state.remotePreset?.reasons ?? []).map((reason, index) => h('p', { key: `preset-reason-${index}` }, reason)),
        state.remoteCapabilities && h('p', { role: state.remoteCapabilities.status === 'unavailable' ? 'alert' : 'status' },
          `基础 shell（${state.remoteCapabilities.shell}）：${state.remoteCapabilities.reason}`),
        state.disabledFeatures.length > 0 && React.createElement('ul', null, ...state.disabledFeatures.map((item, index) =>
          React.createElement('li', { key: `disabled-${item.name}-${index}` }, `${item.name}：已关闭（${item.reason}）`))),
        state.convertedFeatures.length > 0 && React.createElement('ul', null, ...state.convertedFeatures.map((item, index) =>
          React.createElement('li', { key: `converted-${item.name}-${index}` }, `${item.name}：已转换（${item.reason}）`))),
        React.createElement('p', null, '工具报告来自本次启动后最近一次运行，仅供排查。'),
        state.compatibility.length === 0 ? React.createElement('p', null, '本次启动尚未取得工具兼容报告。')
          : React.createElement('ul', null, ...state.compatibility.map((item, index) =>
            React.createElement('li', { key: `${item.name}-${index}` },
              `${item.name}：${statuses[item.status] ?? '未知'}${item.reason ? `（${item.reason}）` : ''}`))),
        React.createElement('p', null, `诊断记录：${state.diagnosticsPath || '尚未确定'}`)));
  }

  return { MenuItem, HeroButton, Picker, Settings };
}
