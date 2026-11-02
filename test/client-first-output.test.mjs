import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { createClientFirstOutput } from '../plugin/ui/client/client-first-output.mjs'

// Execute the shipped rc.5 Session methods, without its gateway, user data or
// conversation renderer. Its request identity and live-event ordering are the
// integration boundary under test, not a second implementation of submission.
const source = await readFile(new URL('../plugin/session-client/client.js', import.meta.url), 'utf8')
const start = source.indexOf('var Session = class {')
const end = source.indexOf('/** Run one callback on the next animation frame', start)
assert.ok(start >= 0 && end > start)
const NativeSession = vm.runInNewContext(`${source.slice(start, end)}; Session`, {
  randomUUID, attachmentRefsIn: () => [], scheduleFrame: fn => fn(),
})

const box = (left = 10, top = 10, right = 110, bottom = 30) => ({ left, top, right, bottom })
function element(tag = 'div', attributes = {}, parent = null) {
  const value = { tag, attributes, parentElement: parent, children: [], isConnected: true,
    style: { display: 'block', visibility: 'visible', contentVisibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' },
    rect: box(), hasAttribute: name => Object.hasOwn(attributes, name), getBoundingClientRect() { return this.rect },
    contains(other) { for (let item = other; item; item = item.parentElement) if (item === this) return true; return false },
    closest(selector) {
      for (let item = this; item; item = item.parentElement) {
        if (selector.split(',').some(part => {
          const suffix = /^\[class\$="([^"]+)"\]$/.exec(part)
          if (suffix) return String(item.attributes.class ?? '').split(/\s+/).some(name => name.endsWith(suffix[1]))
          const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part)
          return attr ? item.hasAttribute(attr[1]) && (attr[2] === undefined || item.attributes[attr[1]] === attr[2]) : item.tag === part
        })) return item
      }
      return null
    },
  }
  parent?.children.push(value)
  return value
}
function text(parent, value = '合成可见输出') {
  const node = { parentElement: parent, textContent: value, rect: box() }
  parent.children.push(node)
  return node
}
function fixture() {
  let time = 100, nextFrame = 0, bridge = {}, retained = false
  const frames = new Map(), events = new Map(), saved = new Map(), scopeDisposers = []
  const doc = { hidden: false, defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: node => node.style },
    addEventListener: (name, fn) => events.set(name, fn), removeEventListener: name => events.delete(name),
    createRange() { let node; return { selectNodeContents: value => { node = value }, getClientRects: () => [node.rect] } },
    createTreeWalker(root) {
      const nodes = [], visit = item => { if (item.textContent !== undefined) nodes.push(item); else item.children.forEach(visit) }
      visit(root); let index = 0
      return { nextNode: () => nodes[index++] }
    },
  }
  const storeListeners = new Set()
  const face = { getSnapshot: () => bridge, subscribe(fn) { storeListeners.add(fn); return () => storeListeners.delete(fn) } }
  const scope = { effect(fn) { const dispose = fn(); scopeDisposers.push(dispose); return dispose } }
  const session = Object.assign(Object.create(NativeSession.prototype), {
    running: false, pendingSubmissions: [], submissionSettlements: new Map(),
    firstPromptPendingTurn: false, projections: { faceOf: () => face, seqOf: () => 100 },
    notifier: { markDirty() { time += 10 } }, eventSource: { append() {} }, actx: scope,
    installWindow() { retained = true },
  })
  const originals = Object.fromEntries(['beginSubmission', 'appendLive', 'installWindow', 'retireFailedSubmission'].map(key => [key, session[key]]))
  const tracker = createClientFirstOutput({ document: doc, now: () => time,
    requestFrame(fn) { frames.set(++nextFrame, fn); return nextFrame }, cancelFrame: id => frames.delete(id),
    storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
  })
  const observer = tracker.bind('synthetic/session', session, scope)
  let seq = 0
  const append = (type, data) => session.appendLive({ event: { type, data, seq: seq++ } })
  const submit = (mode = 'queue', turn = 1) => {
    const submission = session.beginSubmission({ mode, text: '合成输入', attachments: [] })
    append('turn/start', { turn })
    append('user/message', { source: { kind: 'user', rpcId: submission.requestId }, content: [] })
    return submission
  }
  const props = (turn = 1, blocks = [{ kind: 'text', text: '合成输出' }]) => ({ node: { data: { turn, step: 1, blocks } } })
  const root = element(); root.style.display = 'contents'
  const paragraph = element('p', {}, root), output = text(paragraph)
  return { tracker, observer, session, originals, scope, root, paragraph, output, props, append, submit, frames, saved, doc,
    tick(ms = 50) { time += ms; const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn(time)) },
    setTime(value) { time = value },
    hidden(value) { doc.hidden = value; events.get('visibilitychange')?.() },
    ordinary() { bridge = null; for (const fn of storeListeners) fn() },
    prune() { scopeDisposers.splice(0).forEach(fn => fn()) }, wasWindowInstalled: () => retained,
  }
}

test('原生提交起点包含本机准备，连续流式提交不重排双帧，每用户提交只计一次', () => {
  const f = fixture()
  const result = f.submit()
  assert.equal(typeof result.abandon, 'function')
  const seat = f.observer.observe(f.props(), f.root)
  assert.equal(f.frames.size, 1)
  seat.update(f.props())
  f.tick(100)
  assert.equal(f.frames.size, 1)
  seat.update(f.props(1, [{ kind: 'text', text: '持续流式更新' }]))
  f.tick(100)
  // Native beginSubmission and acceptance each markDirty (+10), before RAF.
  assert.deepEqual(f.observer.getSnapshot(), { version: 1, submissions: 1, samples: 1, totalMs: 220 })
  seat.update(f.props()); f.tick(); f.tick()
  f.observer.observe({ node: { data: { turn: 1, step: 2, blocks: [{ kind: 'text', text: '工具后的第二步' }] } } }, f.root)
  f.tick(); f.tick()
  assert.equal(f.observer.getSnapshot().samples, 1)
  const saved = JSON.parse([...f.saved.values()][0])
  assert.deepEqual(Object.keys(saved).sort(), ['samples', 'submissions', 'totalMs', 'version'])
  assert.equal(JSON.stringify(saved).includes(result.requestId), false)
  f.tracker.dispose()
})

test('只认新live turn与精确rpcId，不把历史回放或其它请求配给当前提交', () => {
  const f = fixture()
  const request = f.session.beginSubmission({ mode: 'queue', text: '合成', attachments: [] })
  f.append('user/message', { source: { kind: 'user', rpcId: request.requestId }, content: [] })
  let seat = f.observer.observe(f.props(), f.root); f.tick(); f.tick()
  assert.equal(f.observer.getSnapshot().samples, 0)
  f.append('turn/start', { turn: 1 })
  f.append('user/message', { source: { kind: 'user', rpcId: 'other' }, content: [] })
  seat.update(f.props()); f.tick(); f.tick()
  assert.equal(f.observer.getSnapshot().samples, 0)
  f.append('user/message', { source: { kind: 'user', rpcId: request.requestId }, content: [] })
  seat.update(f.props(2)); f.tick(); f.tick()
  assert.equal(f.observer.getSnapshot().samples, 0)
  seat.update(f.props()); f.tick(); f.tick()
  assert.equal(f.observer.getSnapshot().samples, 1)
  f.append('turn/end', {})
  const second = f.session.beginSubmission({ mode: 'queue', text: '合成', attachments: [] })
  f.session.installWindow()
  assert.equal(f.wasWindowInstalled(), true)
  f.append('turn/start', { turn: 2 })
  f.append('user/message', { source: { kind: 'user', rpcId: second.requestId }, content: [] })
  seat = f.observer.observe(f.props(2), f.root); f.tick(); f.tick()
  assert.equal(f.observer.getSnapshot().samples, 1)
  seat.cancel(); f.tracker.dispose()
})

test('后台、插话、排队、重叠提交和取消均不猜测首字样本', () => {
  for (const mode of ['hidden', 'steer', 'running', 'overlap', 'cancel']) {
    const f = fixture()
    if (mode === 'hidden') f.hidden(true)
    if (mode === 'running') f.session.running = true
    const submission = f.submit(mode === 'steer' ? 'steer' : 'queue')
    if (mode === 'hidden') f.hidden(false)
    if (mode === 'overlap') f.submit('queue', 2)
    if (mode === 'cancel') f.session.retireFailedSubmission(submission.requestId)
    f.observer.observe(f.props(mode === 'overlap' ? 2 : 1), f.root); f.tick(); f.tick()
    assert.equal(f.observer.getSnapshot().samples, 0, mode)
    f.tracker.dispose()
  }
  const f = fixture(); f.submit()
  f.observer.observe(f.props(), f.root); f.tick(); f.hidden(true); f.hidden(false); f.tick()
  assert.equal(f.observer.getSnapshot().samples, 0)
  f.tracker.dispose()
})

test('Range必须实际可见；思考label、折叠正文和视口外文字不能抢样本', () => {
  for (const mode of ['hidden', 'offscreen', 'clipped', 'label', 'inline']) {
    const f = fixture(); f.submit()
    let props = f.props()
    if (mode === 'hidden') f.paragraph.attributes.hidden = ''
    if (mode === 'offscreen') f.output.rect = box(10, 700, 110, 720)
    if (mode === 'clipped') { f.root.style.overflowY = 'hidden'; f.root.rect = box(0, 100, 500, 200) }
    if (mode === 'label') { f.paragraph.tag = 'span'; f.paragraph.attributes['data-variant'] = 'think'; props = f.props(1, [{ kind: 'reasoning', text: '合成思考' }]) }
    if (mode === 'inline') f.root.attributes['data-turn-process-inline'] = ''
    f.observer.observe(props, f.root); f.tick(); f.tick()
    assert.equal(f.observer.getSnapshot().samples, 0, mode)
    f.tracker.dispose()
  }
  for (const mode of ['expanded', 'preview']) {
    const f = fixture(); f.submit()
    f.paragraph.tag = 'div'
    f.root.attributes['data-variant'] = 'think'; f.root.attributes[`data-${mode}`] = ''
    f.paragraph.attributes.class = mode === 'expanded' ? 'native_thinkBody' : 'native_summaryText'
    f.observer.observe(f.props(1, [{ kind: 'reasoning', text: '合成思考' }]), f.root); f.tick(); f.tick()
    assert.equal(f.observer.getSnapshot().samples, 1, mode)
    f.tracker.dispose()
  }
})

test('按真实scope释放委托，旧scope不能删掉同id的新绑定；普通会话保持原生方法', () => {
  const f = fixture(), old = f.observer
  f.prune()
  for (const [name, original] of Object.entries(f.originals)) assert.equal(f.session[name], original)
  const secondScope = { effect: () => {} }
  const next = f.tracker.bind('synthetic/session', f.session, secondScope)
  assert.notEqual(next, old)
  assert.equal(f.tracker.bind('synthetic/session', f.session, secondScope), next)
  f.ordinary()
  for (const [name, original] of Object.entries(f.originals)) assert.equal(f.session[name], original)
  f.tracker.dispose()
})

test('同turn的两个会话不串样本，缺少DOM能力保持未知', () => {
  const a = fixture(), b = fixture(); a.submit(); b.submit()
  a.observer.observe(a.props(), a.root); a.tick(); a.tick()
  assert.equal(a.observer.getSnapshot().samples, 1)
  assert.equal(b.observer.getSnapshot().samples, 0)
  a.tracker.dispose(); b.tracker.dispose()
  const f = fixture()
  delete f.doc.createRange
  f.submit(); f.observer.observe(f.props(), f.root)
  assert.equal(f.frames.size, 0)
  assert.equal(f.observer.getSnapshot().samples, 0)
  f.tracker.dispose()
})
