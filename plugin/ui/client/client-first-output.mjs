/** Device-local observation: one submitted user message, one visible output.
 * No conversation bodies, request ids or SDK timing records are persisted. */
export function createClientFirstOutput(options = {}) {
  const doc = options.document ?? globalThis.document;
  const now = options.now ?? (() => globalThis.performance.now());
  const frame = options.requestFrame ?? (callback => globalThis.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? (id => globalThis.cancelAnimationFrame(id));
  const canFrame = typeof options.requestFrame === 'function' || typeof globalThis.requestAnimationFrame === 'function';
  let storage = options.storage;
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
  const maximumMs = 30 * 60 * 1000;
  const bindings = new Map();
  let closed = false;

  // A positive Range alone is insufficient: scroll clipping and folded native
  // work details can leave descendant layout boxes outside the visible region.
  function visibleText(node, root) {
    const element = node.parentElement;
    if (!element || !root.contains(element) || !node.textContent?.trim()) return false;
    if (element.closest('[hidden],[aria-hidden="true"],[data-turn-process-hidden],[data-turn-process-inline]')) return false;
    const view = doc.defaultView;
    const width = view?.innerWidth ?? doc.documentElement?.clientWidth;
    const height = view?.innerHeight ?? doc.documentElement?.clientHeight;
    if (!(width > 0 && height > 0)) return false;
    const clips = [];
    for (let current = element; current; current = current.parentElement) {
      const style = view.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
      if (/(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
        clips.push({ rect: current.getBoundingClientRect(), x: style.overflowX !== 'visible', y: style.overflowY !== 'visible' });
      }
    }
    const range = doc.createRange();
    range.selectNodeContents(node);
    return [...range.getClientRects()].some(rect => {
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      let right = Math.min(width, rect.right), bottom = Math.min(height, rect.bottom);
      for (const clip of clips) {
        if (clip.x) { left = Math.max(left, clip.rect.left); right = Math.min(right, clip.rect.right); }
        if (clip.y) { top = Math.max(top, clip.rect.top); bottom = Math.min(bottom, clip.rect.bottom); }
      }
      return right > left && bottom > top;
    });
  }

  function visibleOutput(root, props) {
    if (!root?.isConnected || !doc?.createTreeWalker || doc.hidden) return false;
    const blocks = props.node?.data?.blocks ?? [];
    const text = props.groupPart !== 'reasoning' && blocks.some(block => block.kind === 'text' && block.text?.trim());
    const inlineHidden = props.turnProcess?.foldable && !props.turnProcess.open
      && props.turnProcess.spec?.answerStep === props.node.data.step && props.turnProcess.spec.inlineReasoning;
    const reasoning = props.groupPart !== 'response' && !inlineHidden
      && blocks.some(block => block.kind === 'reasoning' && block.text?.trim());
    if (!text && !reasoning) return false;
    const walker = doc.createTreeWalker(root, 4); // SHOW_TEXT, not labels or tool metadata.
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      const thought = element?.closest('[data-variant="think"]');
      let content = false;
      if (thought && reasoning) {
        // rc.5's expanded reasoning body and its real collapsed text preview;
        // the standalone “thinking” label is deliberately outside both seats.
        content = thought.hasAttribute('data-expanded') && !!element.closest('[class$="_thinkBody"]')
          || thought.hasAttribute('data-preview') && !!element.closest('[class$="_summaryText"]');
      } else if (!thought && text) {
        content = !!element?.closest('p,li,pre,code,blockquote,h1,h2,h3,h4,h5,h6,td,th')
          && !element.closest('button,svg,[role="button"],[class$="_stopped"]');
      }
      if (content && visibleText(node, root)) return true;
    }
    return false;
  }

  function bind(sessionId, session, scope = session?.actx) {
    if (!session || typeof sessionId !== 'string' || closed) return undefined;
    const previous = bindings.get(sessionId);
    if (previous?.session === session && previous?.scope === scope) return previous.handle;
    previous?.dispose();
    const key = `dsh-claude-bridge:first-output:v1:${encodeURIComponent(sessionId)}`;
    let snapshot = { version: 1, submissions: 0, samples: 0, totalMs: 0 };
    try {
      const saved = JSON.parse(storage?.getItem(key) ?? 'null');
      if (saved?.version === 1 && ['submissions', 'samples', 'totalMs'].every(name => Number.isSafeInteger(saved[name]) && saved[name] >= 0)
        && saved.submissions <= 1_000_000 && saved.samples <= saved.submissions && saved.totalMs <= saved.samples * maximumMs) {
        snapshot = { version: 1, submissions: saved.submissions, samples: saved.samples, totalMs: saved.totalMs };
      }
    } catch {}
    const listeners = new Set(), methods = new Map(), frames = new Set(), outstanding = new Set();
    let pending, turn, serial = 0, disposed = false;
    const face = session.projections?.faceOf?.('claudeBridge');
    const remote = () => face?.getSnapshot?.() != null;
    const publish = next => {
      snapshot = next;
      try { storage?.setItem(key, JSON.stringify(snapshot)); } catch {}
      for (const listener of listeners) { try { listener(); } catch {} }
    };
    const invalidate = () => { pending = undefined; outstanding.clear(); turn = undefined; };
    const wrap = (name, make) => {
      const original = session[name];
      if (typeof original !== 'function') return false;
      const wrapped = make(original);
      session[name] = wrapped;
      methods.set(name, { original, wrapped });
      return true;
    };
    const uninstall = () => {
      invalidate();
      for (const [name, { original, wrapped }] of methods) if (session[name] === wrapped) session[name] = original;
      methods.clear();
    };
    const reconcile = () => {
      if (disposed || !remote()) { uninstall(); return; }
      if (methods.size) return;
      if (['beginSubmission', 'appendLive', 'installWindow', 'retireFailedSubmission'].some(name => typeof session[name] !== 'function')) return;
      wrap('beginSubmission', original => function(...args) {
        const started = now(), eligible = !session.running && args[0]?.mode !== 'steer'
          && !doc?.hidden && outstanding.size === 0;
        const result = original.apply(this, args);
        if (!remote() || disposed || typeof result?.requestId !== 'string') return result;
        pending = undefined;
        outstanding.add(result.requestId);
        if (snapshot.submissions < 1_000_000) {
          publish({ ...snapshot, submissions: snapshot.submissions + 1 });
          if (eligible) pending = { requestId: result.requestId, started, serial, turn: undefined };
        }
        return result;
      });
      wrap('appendLive', original => function(entry, ...args) {
        const result = original.call(this, entry, ...args);
        serial++;
        const event = entry?.event;
        if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) turn = { number: event.data.turn, serial };
        if (event?.type === 'user/message' && pending && turn && turn.serial > pending.serial
          && event.data?.source?.kind === 'user' && event.data.source.rpcId === pending.requestId) pending.turn = turn.number;
        if (event?.type === 'turn/end') outstanding.clear();
        return result;
      });
      wrap('installWindow', original => function(...args) { invalidate(); return original.apply(this, args); });
      wrap('retireFailedSubmission', original => function(requestId, ...args) {
        outstanding.delete(requestId);
        if (pending?.requestId === requestId) pending = undefined;
        return original.call(this, requestId, ...args);
      });
    };
    const handle = {
      getSnapshot: () => snapshot,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      observe(props, root) {
        let latest = props, first, second, canceled = false;
        const update = next => {
          latest = next;
          const sample = pending;
          if (canceled || disposed || first !== undefined || second !== undefined
            || !sample || !Number.isSafeInteger(sample.turn) || !remote()
            || sample.turn !== latest.node?.data?.turn || !doc?.createTreeWalker || !doc?.createRange
            || !doc?.defaultView?.getComputedStyle || doc.hidden || !canFrame) return;
          first = frame(() => {
            frames.delete(first); first = undefined;
            if (canceled || disposed || pending !== sample || doc.hidden) return;
            second = frame(() => {
              frames.delete(second); second = undefined;
              if (canceled || disposed || pending !== sample || doc.hidden || latest.node?.data?.turn !== sample.turn) return;
              const elapsed = now() - sample.started;
              if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > maximumMs) { pending = undefined; return; }
              if (!visibleOutput(root, latest)) return;
              pending = undefined;
              outstanding.delete(sample.requestId);
              publish({ ...snapshot, samples: snapshot.samples + 1, totalMs: snapshot.totalMs + Math.round(elapsed) });
            });
            frames.add(second);
          });
          frames.add(first);
        };
        update(props);
        return { update, cancel() {
          canceled = true;
          for (const id of [first, second]) if (id !== undefined) { cancelFrame(id); frames.delete(id); }
        } };
      },
    };
    const unsubscribe = face?.subscribe?.(reconcile);
    const dispose = () => {
      if (disposed) return;
      disposed = true; unsubscribe?.(); uninstall();
      for (const id of frames) cancelFrame(id);
      frames.clear(); listeners.clear();
      if (bindings.get(sessionId) === record) bindings.delete(sessionId);
    };
    const record = { session, scope, handle, dispose, invalidate };
    bindings.set(sessionId, record);
    // ClientSessions owns this exact generation. Pruning it must release both
    // instance delegates and our Map entry, without extending native retention.
    scope?.effect?.(() => dispose, 'claude-bridge:first-output');
    reconcile();
    return handle;
  }
  const hidden = () => { if (doc.hidden) for (const binding of bindings.values()) binding.invalidate(); };
  doc?.addEventListener?.('visibilitychange', hidden);
  return { bind, dispose() {
    closed = true;
    doc?.removeEventListener?.('visibilitychange', hidden);
    for (const binding of bindings.values()) binding.dispose();
    bindings.clear();
  } };
}
