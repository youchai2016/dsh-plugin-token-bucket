import * as BucketBridgeContract from '../lib/remote.js';

// Shared only for overlapping mounts of this widget; never duplicate a Remote method.
const bucketRemoteMounts = new WeakMap();
function acquireBucketRemote(ctx, remote) {
  // Cordis returns a fresh traced service wrapper on each get; root Context is stable.
  const owner = ctx.root ?? remote;
  let entry = bucketRemoteMounts.get(owner);
  if (!entry || entry.closed || entry.failed) {
    const previous = entry?.closing;
    entry = { refs: 0, closed: false, failed: false };
    // $mount installs LOCAL descriptors only; it does not check Host readiness.
    entry.ready = Promise.resolve(previous).catch(() => {}).then(() => remote.$mount(BucketBridgeContract.TYPERT_REMOTE)).catch(() => {
      entry.failed = true;
      throw new Error('Local bucket mount failed');
    });
    entry.ready.catch(() => {});
    bucketRemoteMounts.set(owner, entry);
  }
  entry.refs += 1;
  let released = false;
  return {
    ready: entry.ready,
    get failed() { return entry.failed; },
    release() {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs !== 0) return;
      entry.closing = Promise.resolve(entry.closing).then(() => entry.ready).then(async unmount => {
        if (entry.refs !== 0 || entry.closed) return;
        entry.closed = true;
        await unmount();
      }).catch(() => {}).finally(() => {
        if ((entry.closed || entry.failed) && bucketRemoteMounts.get(owner) === entry) bucketRemoteMounts.delete(owner);
      });
    },
  };
}

// A mounted namespace is a separate Cordis capability: inject it in a child AFTER
// mounting, because requiring it in the mount owner would prevent that owner loading.
function acquireBucketNamespace(ctx, abort) {
  return new Promise((resolve, reject) => {
    let fiber, disposed = false, closing;
    const dispose = () => {
      if (disposed) return closing;
      disposed = true;
      abort.signal.removeEventListener('abort', cancelled);
      closing = Promise.resolve(fiber?.dispose());
      return closing;
    };
    const cancelled = () => {
      reject(new Error('Bucket namespace unavailable'));
      Promise.resolve(dispose()).catch(() => {});
    };
    if (abort.signal.aborted) { cancelled(); return; }
    abort.signal.addEventListener('abort', cancelled, { once: true });
    try {
      fiber = ctx.inject(['remote.tokenBucket'], scope => {
        if (disposed || abort.signal.aborted) return;
        scope.effect(() => () => abort.abort(), 'token-bucket.namespace');
        resolve({ service: scope.remote.tokenBucket, dispose });
      });
      if (disposed) Promise.resolve(fiber.dispose()).catch(() => {});
      Promise.resolve(fiber).catch(error => { reject(error); Promise.resolve(dispose()).catch(() => {}); });
    } catch (error) {
      reject(error);
      Promise.resolve(dispose()).catch(() => {});
    }
  });
}

/**
 * Follow live balance snapshots. Returns synchronous, idempotent cleanup.
 * onSnapshot(validatedSnapshot) is called for every frame; onHealth(boolean) reports
 * this stream only. Frames are schema validated, so a malformed Host answer is dropped.
 */
export function observeBalance(ctx, { onSnapshot, onHealth } = {}) {
  let disposed = false;
  let generationKey;
  let revision = 0;
  let run;
  let retry;
  let retryDelay = 1000;
  let health;
  const subscriptions = [];
  const call = (fn, value) => { if (!disposed) { try { fn?.(value); } catch { /* UI callbacks cannot poison transport. */ } } };
  const setHealth = value => { if (health !== value) { health = value; call(onHealth, value); } };
  const remote = ctx.remote;
  if (!remote || typeof remote.$mount !== 'function') {
    setHealth(false);
    return () => { disposed = true; };
  }
  let lease = acquireBucketRemote(ctx, remote);
  const connected = () => ctx.connection?.state?.getSnapshot?.() === 'connected';
  const retire = () => {
    revision += 1;
    if (retry !== undefined) { clearTimeout(retry); retry = undefined; }
    if (run) {
      const old = run; run = undefined;
      old.abort.abort();
      try { Promise.resolve(old.handle?.dispose?.()).catch(() => {}); } catch { /* already withdrawn */ }
    }
  };
  const start = () => {
    if (disposed || !connected()) return;
    retire();
    const token = revision;
    const current = { abort: new AbortController(), handle: undefined };
    run = current;
    setHealth(false);
    const active = () => !disposed && token === revision && connected();
    void (async () => {
      try {
        if (lease.failed) {
          lease.release();
          lease = acquireBucketRemote(ctx, remote);
        }
        await lease.ready;
        if (!active()) return;
        const waiting = setTimeout(() => current.abort.abort(), 3000);
        try { current.scope = await acquireBucketNamespace(ctx, current.abort); }
        finally { clearTimeout(waiting); }
        if (!active() || current.abort.signal.aborted) return;
        current.handle = current.scope.service.watch(current.abort.signal);
        setHealth(true);
        retryDelay = 1000;
        for await (const value of current.handle) {
          if (!active()) return;
          call(onSnapshot, BucketBridgeContract.BUCKET_SNAPSHOT_SCHEMA.parse(value));
        }
      } catch { /* Fail closed and retry without forwarding errors or raw frames. */ }
      finally {
        current.abort.abort();
        try { await current.handle?.dispose?.(); } catch { /* already closed */ }
        try { await current.scope?.dispose(); } catch { /* already withdrawn */ }
        if (active()) {
          run = undefined;
          setHealth(false);
          retry = setTimeout(() => { retry = undefined; start(); }, retryDelay);
          retryDelay = Math.min(10000, retryDelay * 2);
        }
      }
    })();
  };
  const reconcile = () => {
    if (disposed) return;
    const key = connected() ? (ctx.connection?.generation?.getSnapshot?.() ?? true) : null;
    if (key === generationKey) return;
    generationKey = key;
    retryDelay = 1000;
    retire();
    setHealth(false);
    if (key !== null) start();
  };
  for (const store of [ctx.connection?.state, ctx.connection?.generation]) {
    if (typeof store?.subscribe === 'function') subscriptions.push(store.subscribe(reconcile));
  }
  reconcile();
  return () => {
    if (disposed) return;
    disposed = true;
    retire();
    for (const unsubscribe of subscriptions) unsubscribe();
    lease.release();
  };
}
