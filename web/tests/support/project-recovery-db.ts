// This test double exposes request success and transaction completion separately.
// It serializes transactions and publishes writes only at the commit boundary.
export function projectRecoveryDatabase() {
  const state: any = { stored: undefined, opened: [], closed: 0, paused: false, abortNext: false, errorNext: null, pending: [], current: null, requestSuccess: 0 };
  const start = () => {
    if (state.current || !state.pending.length) return;
    const tx = state.current = state.pending.shift();
    setImmediate(() => {
      if (state.errorNext) { tx.error = state.errorNext; state.errorNext = null; tx.onerror?.(); tx.abort(); return; }
      while (tx.ops.length && !tx.aborted) {
        const op = tx.ops.shift();
        if (op.kind === 'get') { op.request.result = structuredClone(state.stored); op.request.onsuccess?.(); }
        else { tx.proposed = structuredClone(op.value); state.requestSuccess++; op.request.onsuccess?.(); }
      }
      if (!tx.aborted && !state.paused) state.complete();
    });
  };
  state.complete = () => {
    const tx = state.current; if (!tx) return;
    if (state.abortNext) { state.abortNext = false; tx.abort(); return; }
    if (tx.proposed !== undefined) state.stored = tx.proposed;
    state.current = null; tx.oncomplete?.(); start();
  };
  const db = { createObjectStore() {}, close() { state.closed++; }, transaction(_store: string, mode: string) {
    const tx: any = { ops: [], aborted: false, error: null, objectStore() { return {
      get() { const request: any = {}; tx.ops.push({ kind: 'get', request }); return request; },
      put(value: any) { const request: any = {}; tx.ops.push({ kind: 'put', value, request }); return request; }
    }; }, abort() { if (tx.aborted) return; tx.aborted = true; state.current = null; setImmediate(() => { tx.onabort?.(); start(); }); }, mode };
    state.pending.push(tx); start(); return tx;
  } };
  const factory = { open(name: string, version: number) { state.opened.push([name, version]); const request: any = { result: db }; setImmediate(() => { request.onupgradeneeded?.(); request.onsuccess?.(); }); return request; } } as unknown as IDBFactory;
  return { state, factory };
}
