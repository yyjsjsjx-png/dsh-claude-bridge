/** Observe the native Session receive boundary; no renderer, history replay or
 * content is retained. Each locally observed submission owns its own sample. */
export function createClientReceiveTiming({ now = () => performance.now(), document: doc = globalThis.document,
  report = () => {}, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id),
  maximumMs = 30 * 60 * 1000 } = {}) {
  const stores = new Map(), bindings = new Map(), createdRemote = new Set();
  let closed = false, uninstallManager;
  const safe = fn => { try { return fn(); } catch {} };
  const nonempty = value => typeof value === 'string' && value.length > 0;
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 160;
  function getStore(sessionId) {
    let store = stores.get(sessionId);
    if (!store) {
      let snapshot = { submissions: 0, samples: 0, totalMs: 0, unknown: 0, pending: 0, reasonCounts: {} };
      const listeners = new Set();
      store = { getSnapshot: () => snapshot,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        update(change) {
          snapshot = change(snapshot);
          for (const listener of listeners) safe(listener);
        } };
      stores.set(sessionId, store);
    }
    return store;
  }
  function emit(sessionId, sample, metric, durationMs, reason) {
    const condition = ['queued', 'steering'].includes(sample.condition) ? sample.condition
      : sample.background || doc?.hidden ? 'background' : 'foreground';
    const row = { version: 1, sessionId, requestId: sample.requestId, metric,
      quality: reason ? 'unknown' : 'precise', condition,
      source: 'client-session-receive', clock: 'client-monotonic',
      ...(reason ? { reason } : { durationMs }) };
    safe(() => Promise.resolve(report(row)).catch(() => {}));
  }
  function bind(sessionId, session, scope = session?.actx) {
    if (closed || !validId(sessionId) || !session) return;
    const previous = bindings.get(sessionId);
    if (previous?.session === session && previous.scope === scope) return previous;
    previous?.dispose('SESSION_DISPOSED');
    const store = getStore(sessionId), methods = new Map(), samples = new Map();
    const face = session.projections?.faceOf?.('claudeBridge');
    const selection = session.projections?.faceOf?.('modelSelection');
    let disposed = false, serial = 0, position, attempt, arrival;
    const remote = () => {
      const model = selection?.getSnapshot?.();
      return face?.getSnapshot?.() != null || createdRemote.has(sessionId)
        || session.header?.agentPreset === 'claude-sdk-remote'
        || (model?.pending ?? model?.lastUsed)?.provider === 'claude-sdk-remote';
    };
    const finish = (sample, at, reason) => {
      if (sample.done) return;
      const elapsed = at - sample.started;
      if (!reason && (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > maximumMs)) reason = 'TIMING_UNAVAILABLE';
      const durationMs = reason ? undefined : Math.round(elapsed);
      sample.done = true;
      store.update(value => ({ ...value, pending: value.pending - 1,
        ...(reason ? { unknown: value.unknown + 1,
          reasonCounts: { ...value.reasonCounts, [reason]: (value.reasonCounts[reason] ?? 0) + 1 } }
          : { samples: value.samples + 1, totalMs: value.totalMs + durationMs }) }));
      emit(sessionId, sample, 'first-output', durationMs, reason);
    };
    const remove = (sample, reason, at = now()) => {
      finish(sample, at, reason);
      clearTimer(sample.timer);
      samples.delete(sample.requestId);
    };
    const reset = reason => {
      for (const sample of samples.values()) remove(sample, reason);
      position = attempt = undefined;
    };
    const updatePosition = event => {
      if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) position = { turn: event.data.turn };
      if (event?.type === 'step/start' && Number.isSafeInteger(event.data?.turn) && Number.isSafeInteger(event.data?.step)) {
        position = { turn: event.data.turn, step: event.data.step, serial };
      }
      if (event?.type === 'turn/end' && position?.turn === event.data?.turn) position = undefined;
    };
    const output = (data, at, stream = false) => {
      if (!Number.isSafeInteger(data?.turn) || !Number.isSafeInteger(data?.step)) return;
      for (const sample of samples.values()) {
        if (sample.done || sample.turn !== data.turn || sample.step > data.step) continue;
        // A steering submission must not adopt a still-streaming old attempt.
        if (stream && (attempt?.id !== data.attemptId || attempt.serial <= sample.boundSerial)) continue;
        if (!stream && attempt?.turn === data.turn && attempt.step === data.step && attempt.serial <= sample.boundSerial) continue;
        if (!stream && !sample.freshStep
          && data.step === sample.step && !(attempt?.turn === data.turn && attempt.step === data.step
            && attempt.serial > sample.boundSerial)) continue;
        finish(sample, at);
      }
    };
    const fullOutput = (event, at) => {
      if (event?.type !== 'assistant/message') return;
      const content = event.data?.message?.content;
      if (!Array.isArray(content) || content.length === 1 && content[0]?.type === 'text'
        && content[0].text === 'No response requested.') return;
      if (content.some(block => ['text', 'reasoning'].includes(block.type) && nonempty(block.text)
        || block.type === 'tool-call' && nonempty(block.arguments))) output(event.data, at);
    };
    const live = (event, at) => {
      updatePosition(event);
      if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
        const sample = samples.get(event.data.source.rpcId);
        if (sample && !sample.done) {
          if (!position || !Number.isSafeInteger(position.step)) finish(sample, at, 'REQUEST_UNCORRELATED');
          else {
            sample.turn = position.turn; sample.step = position.step; sample.boundSerial = serial;
            sample.freshStep = position.serial > sample.submittedSerial;
          }
        }
      }
      fullOutput(event, at);
      if (event?.type === 'turn/end') {
        for (const sample of samples.values()) if (sample.turn === event.data?.turn) remove(sample, 'TURN_ENDED_WITHOUT_OUTPUT', at);
      }
    };
    const wrap = (name, make) => {
      const original = session[name];
      if (typeof original !== 'function') return;
      const wrapped = make(original);
      session[name] = wrapped;
      methods.set(name, { original, wrapped });
    };
    const uninstall = reason => {
      reset(reason);
      for (const [name, { original, wrapped }] of methods) if (session[name] === wrapped) session[name] = original;
      methods.clear();
    };
    const reconcile = () => {
      if (disposed) return;
      if (!remote()) { uninstall('REMOTE_SESSION_CHANGED'); return; }
      if (methods.size || typeof session.beginSubmission !== 'function') return;
      const capable = ['acceptEventChange', 'publishAssistantEntry', 'installWindow', 'retireFailedSubmission', 'dispose']
        .every(name => typeof session[name] === 'function');
      wrap('beginSubmission', original => function(input, ...args) {
        const started = now(), background = !!doc?.hidden, running = this.running;
        const result = original.call(this, input, ...args);
        safe(() => {
          if (disposed || !remote() || !validId(result?.requestId) || samples.has(result.requestId)) return;
          const sample = { requestId: result.requestId, started, background, submittedSerial: serial,
            condition: running ? input?.mode === 'steer' ? 'steering' : 'queued' : 'foreground' };
          samples.set(sample.requestId, sample);
          store.update(value => ({ ...value, submissions: value.submissions + 1, pending: value.pending + 1 }));
          emit(sessionId, sample, 'submission', 0);
          sample.timer = setTimer(() => safe(() => remove(sample, 'TIMING_TIMEOUT')), maximumMs);
          sample.timer?.unref?.();
          if (!capable || !Number.isFinite(started)) finish(sample, started, 'TIMING_UNAVAILABLE');
        });
        return result;
      });
      if (!capable) return;
      wrap('acceptEventChange', original => function(change, ...args) {
        const parent = arrival, current = { at: now(), type: change?.type, rebaseline: false };
        arrival = current; serial++;
        try {
          const result = original.call(this, change, ...args);
          safe(() => {
            if (current.rebaseline) return;
            if (change?.type === 'append') live(change.entry?.event, current.at);
            if (change?.type === 'assistant-stream' && change.frame?.type === 'start'
              && this.assistantStream?.activeAttempt?.attemptId === change.frame.attemptId) {
              attempt = { id: change.frame.attemptId, turn: change.frame.turn, step: change.frame.step, serial };
            }
          });
          return result;
        } finally { arrival = parent; }
      });
      wrap('publishAssistantEntry', original => function(result, ...args) {
        const returned = original.call(this, result, ...args);
        safe(() => {
          if (!arrival) return;
          if (result?.type === 'rebaseline') { arrival.rebaseline = true; reset('STREAM_REBASELINE'); return; }
          if (arrival.type !== 'assistant-stream' || result?.type !== 'transient') return;
          const event = result.entry?.event, chunk = event?.data?.chunk;
          if (event?.type === 'assistant/live-chunk' && (['text-delta', 'reasoning-delta'].includes(chunk?.type)
            && nonempty(chunk.text) || chunk?.type === 'tool-call-delta'
              && (nonempty(chunk.argumentsDelta) || nonempty(chunk.id) && nonempty(chunk.name)))) {
            output(event.data, arrival.at, true);
          }
        });
        return returned;
      });
      wrap('installWindow', original => function(entries, ...args) {
        safe(() => reset('HISTORY_REPLACED'));
        const result = original.call(this, entries, ...args);
        safe(() => {
          for (const entry of entries) updatePosition(entry.event);
          const active = this.assistantStream?.activeAttempt;
          if (active) attempt = { id: active.attemptId, turn: active.turn, step: active.step, serial };
        });
        return result;
      });
      wrap('retireFailedSubmission', original => function(requestId, ...args) {
        const settlement = this.submissionSettlements?.get(requestId);
        const result = original.call(this, requestId, ...args);
        safe(() => {
          const sample = samples.get(requestId);
          if (sample && settlement?.admitted === undefined) remove(sample, 'SUBMISSION_FAILED');
        });
        return result;
      });
      wrap('resync', original => function(...args) {
        if (this.openState !== 'cold') safe(() => reset('HISTORY_REPLACED'));
        return original.apply(this, args);
      });
      wrap('dispose', original => function(...args) {
        safe(() => record.dispose('SESSION_DISPOSED'));
        return original.apply(this, args);
      });
    };
    const record = { session, scope, reconcile,
      background() { for (const sample of samples.values()) sample.background = true; },
      dispose(reason = 'OBSERVER_DISPOSED') {
        if (disposed) return;
        disposed = true;
        for (const unsubscribe of subscriptions) unsubscribe?.();
        uninstall(reason);
        if (bindings.get(sessionId) === record) bindings.delete(sessionId);
      } };
    const subscriptions = [...new Set([face, selection])].map(source => source?.subscribe?.(() => safe(reconcile)));
    bindings.set(sessionId, record);
    scope?.effect?.(() => () => record.dispose('SESSION_DISPOSED'), 'claude-bridge:client-receive-timing');
    safe(reconcile);
    return record;
  }
  function install(sessions) {
    if (closed || uninstallManager || typeof sessions?.materializeScope !== 'function') return () => {};
    const original = sessions.materializeScope;
    const wrapped = function(id, ...args) {
      const record = original.call(this, id, ...args);
      safe(() => bind(id, record?.session ?? record?.binding?.session, record?.ctx));
      return record;
    };
    sessions.materializeScope = wrapped;
    // rc.5's client Session/list has no header/preset. Its successful create
    // argument is the earliest authoritative engine fact, before openSession.
    const originalCreate = sessions.create;
    const wrappedCreate = typeof originalCreate === 'function' ? async function(options, ...args) {
      const id = await originalCreate.call(this, options, ...args);
      safe(() => {
        const preset = options?.agentPreset;
        if (validId(id) && (preset === 'claude-sdk-remote'
          || typeof preset === 'string' && preset.startsWith('claude-sdk-remote+model-v1:'))) {
          createdRemote.add(id);
          bindings.get(id)?.reconcile();
        }
      });
      return id;
    } : undefined;
    if (wrappedCreate) sessions.create = wrappedCreate;
    uninstallManager = () => {
      if (sessions.materializeScope === wrapped) sessions.materializeScope = original;
      if (wrappedCreate && sessions.create === wrappedCreate) sessions.create = originalCreate;
    };
    if (sessions.scopes instanceof Map) for (const [id, record] of sessions.scopes) {
      safe(() => bind(id, record.session ?? record.binding?.session, record.ctx));
    }
    return dispose;
  }
  const hidden = () => {
    if (doc?.hidden) for (const record of bindings.values()) record.background?.();
  };
  doc?.addEventListener?.('visibilitychange', hidden);
  function dispose() {
    if (closed) return;
    closed = true; uninstallManager?.();
    doc?.removeEventListener?.('visibilitychange', hidden);
    for (const record of bindings.values()) record.dispose();
    bindings.clear(); createdRemote.clear();
  }
  return { bind, install, dispose, getStore,
    getSnapshot: sessionId => getStore(sessionId).getSnapshot(),
    subscribe: (sessionId, listener) => getStore(sessionId).subscribe(listener) };
}
