import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageProjectionBridge } from '../plugin/ui/client/usage-projection.mjs'

test('复用原生用量与轮末组件，仅远程映射数值，卸载和原生热更恢复正确', () => {
  const slots = new Map(), listeners = new Map()
  const emit = name => { for (const callback of listeners.get(name) ?? []) callback() }
  const register = (options, component) => {
    const entry = { options, component, locale: options.locale, inject: options.inject }
    const list = slots.get(options.name) ?? []
    slots.set(options.name, [...list, entry]); emit(options.name)
    return () => { slots.set(options.name, slots.get(options.name).filter(value => value !== entry)); emit(options.name) }
  }
  const ctx = { slots: { entries: name => slots.get(name) ?? [], register,
    subscribe(name, callback) {
      const list = listeners.get(name) ?? new Set(); list.add(callback); listeners.set(name, list)
      return () => list.delete(callback)
    } } }
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) }
  const dispose = createUsageProjectionBridge({ React })(ctx)
  const inject = () => ({ hooks: { performanceUsage: 'preserved' } })
  const nativeUsage = () => {}, nativeTail = () => {}
  let removeNative = register({ name: 'conversation.composer.dock', id: 'usage', order: 1, locale: 'chat', inject }, nativeUsage)
  register({ name: 'conversation.chat.node', key: 'turn-tail', locale: 'chat', inject,
    children: { 'conversation.chat.turnTail': { kind: 'list', scope: 'session' } } }, nativeTail)
  const winner = (name, field, id) => ctx.slots.entries(name).filter(e => e.options[field] === id)
    .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))[0]
  const original = { uncachedInputTokens: 10, outputTokens: 20 }
  const turn = { uncachedInputTokens: 330, outputTokens: 120075, cacheReadTokens: 31324396, cacheWriteTokens: 364916, coverage: 'complete' }
  const remoteUsage = { ...turn, turns: { 5: turn } }
  let remote = true
  const props = { useProjection(key) {
    if (key === 'claudeBridge') return remote ? {} : null
    if (key === 'claudeBridgeUsage') return remote ? remoteUsage : null
    return original
  }, node: { data: { turn: 5, tokenUsage: original }, anchorSeq: 10 } }
  let entry = winner('conversation.composer.dock', 'id', 'usage')
  assert.equal(entry.inject, inject)
  assert.equal(entry.locale, 'chat')
  const view = entry.component(props)
  assert.equal(view.type, nativeUsage)
  assert.equal(view.props.useProjection('tokenUsage'), remoteUsage)
  assert.equal(view.props.useProjection('sessionStats'), original)
  remoteUsage.coverage = 'partial'
  const partial = entry.component(props)
  assert.equal(partial.type, 'span')
  assert.match(partial.props.title, /已报告用量.*可能尚未完整/)
  assert.equal(partial.children.length, 1)
  assert.equal(partial.children[0].type, nativeUsage)
  assert.equal(partial.children[0].props.useProjection('tokenUsage'), remoteUsage)
  remoteUsage.coverage = 'legacy'
  const legacy = entry.component(props)
  assert.match(legacy.props.title, /旧记录用量不完整/)
  assert.equal(legacy.children.length, 1)
  remoteUsage.coverage = 'complete'
  const tail = winner('conversation.chat.node', 'key', 'turn-tail')
  const tailView = tail.component(props)
  assert.equal(tailView.type, nativeTail)
  assert.equal(tailView.props.node.data.tokenUsage.totalTokens, 31809717)
  assert.equal(props.node.data.tokenUsage, original)
  assert.deepEqual(tail.options.children, { 'conversation.chat.turnTail': { kind: 'list', scope: 'session' } })
  remote = false
  assert.equal(entry.component(props).props.useProjection('tokenUsage'), original)
  assert.equal(tail.component(props).props.node, props.node)
  removeNative()
  assert.equal(ctx.slots.entries('conversation.composer.dock').length, 0)
  const replacement = () => {}
  removeNative = register({ name: 'conversation.composer.dock', id: 'usage', locale: 'chat', inject }, replacement)
  entry = winner('conversation.composer.dock', 'id', 'usage')
  assert.equal(entry.component(props).type, replacement)
  dispose()
  assert.equal(winner('conversation.composer.dock', 'id', 'usage').component, replacement)
  assert.ok([...listeners.values()].every(list => list.size === 0))
  removeNative()
})

test('原生TTFT逐模型响应汇总，4用户提交9模型步骤不缩为4个样本，SDK不混入', () => {
  const Native=()=>{},entries=[],hooks=new Map(),inject=()=>({native:true});
  entries.push({options:{id:'activity'},component:Native,locale:'chat',inject});
  const ctx={slots:{entries:key=>key==='conversation.composer.dock'?entries:[],
    subscribe(key,fn){hooks.set(key,fn);return()=>hooks.delete(key)},register(options,component){
      const entry={options,component,inject:options.inject,locale:options.locale};entries.push(entry);hooks.get(options.name)?.();
      return()=>{entries.splice(entries.indexOf(entry),1);hooks.get(options.name)?.()};
    }}};
  const React={createElement:(type,props,...children)=>({type,props,children})};
  const dispose=createUsageProjectionBridge({React})(ctx),wrapper=entries.find(row=>row.component!==Native);
  assert.equal(wrapper.inject,inject);
  const native={turns:4,steps:9,llmMs:54100,toolMs:23200};let remote=true;
  let cycles={ttftMs:18000,ttftSamples:9,responseCount:9,ttftUnknown:0,durationMs:54000,durationSamples:9};
  const sdk={ttftMs:45000,ttftSteps:9,responseCount:9,decodeTokens:1200,decodeMs:6000,tpsSamples:9};
  const props={t:key=>key,useProjection(key,selector){const value=key==='claudeBridge'?remote?{}:null
    :key==='claudeBridgeModelStats'?cycles:key==='claudeBridgeResponseStats'?sdk:native;
    return typeof selector==='function'?selector(value):value;}};
  let view=wrapper.component(props);assert.equal(view.type,Native);assert.deepEqual(view.children,[]);
  assert.deepEqual(view.props.useProjection('sessionStats'),{...native,ttftMs:18000,ttftSteps:9,decodeTokens:1200,decodeMs:6000});
  assert.equal(view.props.useProjection('sessionStats',row=>row.ttftMs/row.ttftSteps),2000);
  const label=view.props.t('stats.dialog.ttft');assert.equal(label.children[0],'首 Token 平均（TTFT）');
  assert.match(label.props.title,/每个模型请求.*最后一个工具结果.*9\/9/);
  assert.match(label.props.title,/合法工具调用开始.*不混入 SDK/);
  cycles={ttftMs:6000,ttftSamples:3,responseCount:9,ttftUnknown:6};view=wrapper.component(props);
  assert.equal(view.props.useProjection('sessionStats').ttftSteps,3);
  assert.match(view.props.t('stats.dialog.ttft').props.title,/3\/9/);
  cycles=null;view=wrapper.component(props);assert.equal(view.props.useProjection('sessionStats').ttftMs,0);
  assert.equal(view.props.useProjection('sessionStats').ttftSteps,0);
  assert.equal(view.props.useProjection('sessionStats').decodeTokens,1200);
  remote=false;assert.equal(wrapper.component(props).props,props);dispose();assert.equal(entries.length,1);
});
