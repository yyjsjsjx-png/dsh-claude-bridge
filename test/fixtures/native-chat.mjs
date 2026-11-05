import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

// Exercise the installed renderer's pure registries, assembler, view and
// grouping code. No DOM, user session, authentication or model is involved.
export async function nativeChat() {
  const base = join(process.env.DSH_CLAUDE_BRIDGE_RESOURCES, 'app.asar/dsh/node_modules/@deepseek-ai')
  const [conversation, chat] = await Promise.all(['dsh-client-ui-conversation', 'dsh-client-ui-chat']
    .map(name => readFile(join(base, name, 'lib/client.js'), 'utf8')))
  const between = (source, first, last) => {
    const start = source.indexOf(`//#region ${first}`)
    const end = source.indexOf(`//#region ${last}`, start)
    assert.ok(start >= 0 && end > start, `installed renderer region: ${first}`)
    return source.slice(start, end)
  }
  const region = (source, name) => {
    const start = source.indexOf(`//#region ${name}`), end = source.indexOf('//#endregion', start)
    assert.ok(start >= 0 && end > start, `installed renderer region: ${name}`)
    return source.slice(start, end)
  }
  const functionRegion = name => {
    const start = chat.lastIndexOf('//#region ', chat.indexOf(`function ${name}(`))
    const end = chat.indexOf('//#endregion', start)
    assert.ok(start >= 0 && end > start)
    return chat.slice(start, end)
  }
  const source = [
    between(conversation, 'lib/types/client/contract/conversation.js', '../../util/crypto/lib/index.js'),
    region(conversation, 'lib/types/client/conversation/view-registry.js'),
    region(conversation, 'lib/types/client/conversation/group-registry.js'),
    region(chat, 'lib/types/client/contract/group-tree.js'),
    region(chat, 'lib/types/client/contract/snapshot.js'),
    region(chat, 'lib/types/client/contract/turn-process.js'),
    region(chat, 'lib/types/client/contract/assistant-content.js'),
    functionRegion('assistantText'),
    region(chat, 'lib/types/client/reasoning-text.js'),
    region(chat, '../../util/values/lib/index.js'),
    between(chat, 'lib/types/client/conversation-nodes/common.js', '../../core/session/lib/types/surface.js'),
    region(chat, '../../core/session/lib/types/surface.js'),
    region(chat, 'lib/types/client/conversation-nodes/tool.js'),
    region(chat, 'lib/types/client/conversation-nodes/turn-process.js'),
    region(chat, '../../llm/llm/lib/types/assistant-stream.js'),
    region(chat, '../../llm/token-meter/lib/types/turn-usage.js'),
    region(chat, 'lib/types/client/conversation-nodes/turn-tail.js'),
    region(chat, 'lib/types/client/conversation-nodes/process-activity.js'),
    region(chat, 'lib/types/client/conversation-nodes/process-groups.js'),
    region(chat, 'lib/types/client/conversation-nodes/turn-process-presentation.js'),
    region(chat, 'lib/types/client/stores.js'),
    region(chat, 'lib/types/client/chat/ChatNodeSeat.js'),
    region(chat, 'lib/types/client/presentation-policy.js'),
    `({ ConversationNodeAssembler, ConversationEventRegistry, ConversationViewRegistry, ConversationGroupRegistry,
      registerAssistantConversationNode, registerToolConversationNode, registerTurnProcess,
      registerTurnTailConversationNode, registerChatConversationView, processGroupDefinition,
      derivePresentation, ChatNodeSeat, presentationPolicyFor })`,
  ].join('\n')
  const store = {
    notifySubscribers(listeners) { for (const fn of listeners) fn() },
    createSnapshotStore(value) {
      return { getSnapshot: () => value, set(next) { value = next }, subscribe() { return () => {} } }
    },
  }
  const native = vm.runInNewContext(source, { _deepseek_ai_cordis: { Service: { tracker: Symbol() } },
    _deepseek_ai_dsh_client_store: store, brandString: value => value, Intl, TextEncoder, console,
    react: { memo: fn => fn, useCallback: fn => fn, useMemo: fn => fn(), useEffect() {},
      useState: initialize => [typeof initialize === 'function' ? initialize() : initialize] },
    react_jsx_runtime: { jsx: (type, props) => ({ type, props }) },
    ChatView_module_css_default: { flowItem: 'native-flow-item' },
    _deepseek_ai_dsh_client_ui_primitives: {},
  })
  const disposers = []
  const ctx = { effect(action) { const dispose = action() ?? (() => {}); disposers.push(dispose); return dispose } }
  ctx.uiConversation = { events: new native.ConversationEventRegistry(ctx), views: new native.ConversationViewRegistry(ctx) }
  ctx.uiConversation.groups = new native.ConversationGroupRegistry(ctx, ctx.uiConversation.views)
  native.registerAssistantConversationNode(ctx)
  native.registerToolConversationNode(ctx)
  native.registerTurnProcess(ctx)
  native.registerTurnTailConversationNode(ctx)
  native.registerChatConversationView(ctx)
  ctx.uiConversation.groups.register(native.processGroupDefinition)
  const assembler = new native.ConversationNodeAssembler(ctx.uiConversation.events, ctx.uiConversation.views, ctx.uiConversation.groups)
  assembler.activateTarget('chat')
  return { ctx, assembler,
    supportsFoldedReplies: native.presentationPolicyFor('standard').foldedReplies !== undefined,
    supportsProcessEvidence: ctx.uiConversation.events.entries().some(item => item.kind === 'process-evidence'),
    order() {
      assembler.flush()
      const snapshot = assembler.snapshot('chat')
      return snapshot.order.map(key => snapshot.nodes.get(key))
    },
    seat(node, { mode = 'standard', groupPart, open = false, foldedReplies } = {}) {
      assembler.flush()
      const snapshot = assembler.snapshot('chat')
      const turnOf = item => ['step', 'turn'].includes(item?.location.kind) ? item.location.turn.turn : undefined
      const turn = turnOf(node)
      const process = turn === undefined ? undefined : native.derivePresentation(turn, {
        getTurn: number => snapshot.order.filter(key => turnOf(snapshot.nodes.get(key)) === number),
      }, snapshot.nodes)
      return native.ChatNodeSeat({ nodeKey: node.key, groupPart,
        useChatNode: () => node, useChatNodeProcess: () => process,
        usePresentation: select => select(native.presentationPolicyFor(mode, 'completion', foldedReplies)),
        useStore: select => select({ turnProcesses: process === undefined ? [] : [
          { turn, answerStep: process.spec.answerStep ?? 0, collapsed: !open },
        ] }),
        useChatNodeBottom: () => false, deferCollapse: false,
        useGroupAction: () => ({ current: null }), actions: { setTurnProcessOpen() {} },
        renderSlot: (_name, owner) => owner, t: () => '',
      }).props
    },
    replace(events) { assembler.replaceWindow(events.map(event => ({ type: 'durable', event })), false); assembler.flush() },
    append(event) { assembler.append({ type: 'durable', event }); assembler.flush() },
  }
}
