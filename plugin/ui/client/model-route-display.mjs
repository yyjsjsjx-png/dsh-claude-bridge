/** Show a selected-versus-actual model difference once, where it happened. */
export function createModelRouteDisplay({ React }) {
  const kind = 'claude-bridge-model-route';
  const record = 'plugin:claude-bridge/model-route';
  const projection = 'claudeBridgeModelRoute';
  const cards = ['mismatch', 'refusal-fallback', 'refusal-no-fallback', 'recovered'];
  const categories = { cyber: '网络安全', bio: '生物安全', frontier_llm: '前沿模型', reasoning_extraction: '思考内容提取', general_harms: '一般危害' };
  const secondary = 'var(--dsw-alias-text-secondary, #777)';
  const count = value => Number.isSafeInteger(value) && value >= 0;

  const modelLabel = value => {
    if (typeof value !== 'string' || !value) return '未知模型';
    const name = value.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
    const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/.exec(name);
    if (match) return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
    return /^(opus|sonnet|haiku)$/.test(name) ? `${name[0].toUpperCase()}${name.slice(1)}` : value;
  };
  const categoryLabel = value => typeof value === 'string' && value ? categories[value] ? `${categories[value]}，${value}` : value : null;

  const cardTitle = data => {
    if (data.kind === 'recovered') return `已恢复所选模型 ${modelLabel(data.actualModel)}`;
    if (data.kind === 'refusal-no-fallback') return `${modelLabel(data.originalModel)} 拒绝回答，未切换模型`;
    if (data.kind === 'mismatch') return `实际由 ${modelLabel(data.actualModel)} 回答，与所选 ${modelLabel(data.requestedModel)} 不同`;
    const category = categoryLabel(data.category);
    return `本轮改由 ${modelLabel(data.actualModel)} 回答 · ${modelLabel(data.originalModel)} 被安全机制拦截${category ? `（${category}）` : ''}`;
  };
  const cardLines = data => {
    const lines = [];
    if (data.kind === 'recovered') {
      lines.push(`此前由 ${modelLabel(data.previousModel)} 回答，现在已回到 ${modelLabel(data.actualModel)}。`);
      return lines;
    }
    lines.push(`你的选择：${modelLabel(data.requestedModel ?? data.originalModel)}`);
    if (data.actualModel) lines.push(`实际响应：${modelLabel(data.actualModel)}`);
    if (data.kind === 'mismatch') {
      lines.push('原因：SDK 未报告，这里不做猜测。');
    } else {
      const category = categoryLabel(data.category);
      lines.push(`原因：${modelLabel(data.originalModel)} 的安全机制拒绝了这次请求${category ? `（${category}）` : ''}，可能是误判。`);
      if (data.explanation) lines.push(`服务端说明：${data.explanation}`);
    }
    if (data.kind === 'refusal-fallback') {
      if (count(data.retractedResponseCount) && data.retractedResponseCount > 0) {
        lines.push(`已撤回 ${data.retractedResponseCount} 条回复：之前已显示的文字没有作为最终回答。`);
      }
      if (count(data.retractedToolCallCount) && data.retractedToolCallCount > 0) {
        lines.push(`被撤回的部分包含 ${data.retractedToolCallCount} 个工具调用：已执行的效果不会撤销，接手模型可能重新执行。`);
      } else if (count(data.retractedOtherCount) && data.retractedOtherCount > 0) {
        lines.push('被撤回的部分可能涉及工具结果：已执行的效果不会撤销，接手模型可能重新执行。');
      }
    }
    if (data.kind !== 'refusal-no-fallback') lines.push('你的模型选择没有改变；恢复时会再显示一张卡片。');
    return lines;
  };
  const fieldsOf = data => Object.fromEntries(['kind', 'runId', 'routeId', 'requestedModel', 'originalModel', 'actualModel',
    'previousModel', 'category', 'explanation', 'retractedResponseCount', 'retractedOtherCount', 'retractedToolCallCount']
    .filter(key => data[key] !== undefined).map(key => [key, data[key]]));
  const valid = event => event.type === record && event.ignorable === true && event.data?.version === 1
    && cards.includes(event.data.kind) && typeof event.data.routeId === 'string' && event.data.routeId.length > 0;

  function ModelRouteCard({ node }) {
    const data = node.data;
    return React.createElement('details', { style: { padding: '8px 0', color: secondary, fontSize: '13px' } },
      React.createElement('summary', { style: { cursor: 'pointer' } }, cardTitle(data)),
      React.createElement('div', { style: { padding: '8px 16px', whiteSpace: 'pre-wrap' } }, cardLines(data).join('\n')));
  }

  /** Quiet composer marker for as long as another model holds the session. */
  function ModelRouteMarker({ useProjection }) {
    const open = useProjection(projection)?.open;
    if (open == null) return null;
    const actual = modelLabel(open.actualModel);
    const selected = modelLabel(open.requestedModel ?? open.originalModel);
    return React.createElement('span', { role: 'status',
      title: `所选 ${selected}，最近一次实际由 ${actual} 回答。下一次请求仍按所选模型发出，恢复后此标记消失。`,
      style: { fontSize: '12px', color: secondary, whiteSpace: 'nowrap', flexShrink: 0 } }, `实际 ${actual}`);
  }

  function install(ctx) {
    const disposeEvent = ctx.uiConversation.events.register({
      kind, target: 'chat',
      match: event => valid(event) ? { id: event.data.routeId, role: 'start' } : null,
      start: (_context, match) => ({ seq: match.event.seq, ...fieldsOf(match.event.data) }),
      // The end-of-turn notice explains the card its takeover response opened.
      update: (context, match) => ({ ...context.state, ...fieldsOf(match.event.data) }),
      buildViewNode: context => context.state === undefined ? null : {
        key: context.key, kind, id: context.id, target: 'chat', anchorSeq: context.state.seq,
        location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
        visibility: 'visible', groupTree: 'turn', data: context.state,
      },
    });
    const disposeCard = ctx.slots.register({ name: 'conversation.chat.node', key: kind }, ModelRouteCard);
    return () => { disposeCard(); disposeEvent(); };
  }
  install.Marker = ModelRouteMarker;
  return install;
}
