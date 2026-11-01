/** Controllers use the same external-store contract as native DSH hooks. */
export function createStore(initial) {
  let snapshot = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next) { snapshot = next; for (const listener of listeners) listener(); },
  };
}

export function textError(error) {
  return error instanceof Error ? error.message : String(error || '操作失败');
}
