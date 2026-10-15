/**
 * DSH Host half: read the API balance on an adaptive cadence and fan one sample
 * stream out to every open window. Read-only: it never writes a profile, never
 * touches the session log, and never exposes the credential.
 */
import { readBalance } from './balance.js';
import { POLL } from './bucket.js';

export const name = 'tokenBucket';
export const inject = ['credentials'];
// The reference DSH's Models page manages for chat; resolution is per call, never cached.
export const KEY_REFS = Object.freeze(['DEEPSEEK_API_KEY']);
export const QUEUE_LIMIT = 8;

export class BalanceHub {
  constructor({
    credentials, fetchImpl = globalThis.fetch, now = () => Date.now(),
    poll = POLL, keyRefs = KEY_REFS, epoch = globalThis.crypto?.randomUUID?.() ?? `tb-${Date.now()}`,
  } = {}) {
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.poll = { ...POLL, ...poll };
    this.keyRefs = keyRefs;
    this.hostEpoch = epoch;
    this.seq = 0;
    this.spentCents = 0;
    this.lastTotalCents = null;
    this.lastChangeAt = 0;
    this.snapshot = {
      type: 'snapshot', hostEpoch: epoch, seq: 0, at: now(), pollMs: this.poll.idleMs,
      status: 'unconfigured', spentCents: 0, detail: 'starting',
    };
    this.clients = new Set();
    this.timer = undefined;
    this.disposed = false;
    this.failures = 0;
    this.inFlight = false;
  }
  /** One resolution attempt across the known reference names. */
  async resolveKey() {
    const service = this.credentials;
    if (!service || typeof service.resolve !== 'function') return { status: 'unconfigured', detail: 'no credential service' };
    for (const ref of this.keyRefs) {
      try {
        const resolved = await service.resolve(ref);
        if (resolved && typeof resolved.value === 'string' && resolved.value.length > 0) return { key: resolved.value };
      } catch { /* A rejected reference is simply not the one we want. */ }
    }
    return { status: 'unconfigured', detail: 'no key' };
  }
  /** Delay before the next read: fast right after money moved, slow when nothing does. */
  nextDelay() {
    if (this.failures > 0) return Math.min(this.poll.maxBackoffMs, this.poll.hotMs * 2 ** Math.min(this.failures, 7));
    const since = this.now() - this.lastChangeAt;
    if (this.lastChangeAt > 0 && since < this.poll.hotWindowMs) return this.poll.hotMs;
    if (this.lastChangeAt > 0 && since < 10 * 60_000) return this.poll.warmMs;
    return this.poll.idleMs;
  }
  publish(partial) {
    if (this.disposed) return;
    const status = partial.status ?? 'unreachable';
    const at = this.now();
    // Account for the movement first: the cadence published with this sample must
    // already reflect it, or a spend would wait a whole idle cycle before being seen.
    if (status === 'ready' && Number.isSafeInteger(partial.totalCents)) {
      if (Number.isSafeInteger(this.lastTotalCents)) {
        const delta = partial.totalCents - this.lastTotalCents;
        if (delta < 0) this.spentCents += -delta;
        if (delta !== 0) this.lastChangeAt = at;
      }
      this.lastTotalCents = partial.totalCents;
    }
    this.seq += 1;
    const snapshot = {
      type: 'snapshot', hostEpoch: this.hostEpoch, seq: this.seq, at, pollMs: this.nextDelay(),
      status, spentCents: this.spentCents,
      ...(partial.detail === undefined ? {} : { detail: String(partial.detail).slice(0, 160) }),
    };
    if (status === 'ready') {
      snapshot.currency = partial.currency ?? 'CNY';
      snapshot.totalCents = partial.totalCents;
      snapshot.available = partial.available !== false;
      if (Number.isSafeInteger(partial.grantedCents)) snapshot.grantedCents = partial.grantedCents;
      if (Number.isSafeInteger(partial.toppedUpCents)) snapshot.toppedUpCents = partial.toppedUpCents;
    }
    this.snapshot = snapshot;
    for (const client of this.clients) client.push(snapshot);
    return snapshot;
  }
  async readOnce() {
    if (this.disposed || this.inFlight) return;
    this.inFlight = true;
    try {
      const resolved = await this.resolveKey();
      const result = resolved.key === undefined
        ? { status: resolved.status, detail: resolved.detail }
        : await readBalance({ fetchImpl: this.fetchImpl, key: resolved.key, timeoutMs: 8000 });
      if (result.status === 'ready') this.failures = 0;
      else if (result.status === 'unreachable' || result.status === 'invalid') this.failures += 1;
      else this.failures = 0;
      this.publish(result);
    } catch (error) {
      this.failures += 1;
      this.publish({ status: 'unreachable', detail: typeof error?.message === 'string' ? error.message.slice(0, 80) : 'error' });
    } finally {
      this.inFlight = false;
    }
  }
  schedule() {
    if (this.disposed || this.timer !== undefined) return;
    const delay = this.nextDelay();
    this.snapshot = { ...this.snapshot, pollMs: delay };
    this.timer = setTimeout(() => { this.timer = undefined; void this.readOnce().then(() => this.schedule()); }, delay);
  }
  watch(signal) {
    const hub = this;
    const queue = [];
    let resolveNext;
    let ended = this.disposed || signal?.aborted === true;
    const finish = () => {
      if (ended) return;
      ended = true;
      hub.clients.delete(client);
      signal?.removeEventListener('abort', finish);
      queue.length = 0;
      if (resolveNext) { const resolve = resolveNext; resolveNext = undefined; resolve({ done: true }); }
    };
    const client = {
      push(snapshot) {
        if (ended) return;
        if (resolveNext) { const resolve = resolveNext; resolveNext = undefined; resolve({ done: false, value: snapshot }); }
        else if (queue.length >= QUEUE_LIMIT) queue.shift();
        queue.push(snapshot);
      },
      next() {
        if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
        if (ended) return Promise.resolve({ done: true });
        if (resolveNext) return Promise.reject(new Error('Only one bucket iterator read may be pending'));
        return new Promise(resolve => { resolveNext = resolve; });
      },
      return() { finish(); return Promise.resolve({ done: true }); },
      [Symbol.asyncIterator]() { return this; },
      close: finish,
    };
    if (!ended) {
      this.clients.add(client);
      signal?.addEventListener('abort', finish, { once: true });
      client.push(this.snapshot);
      // The first reader fills the bucket immediately instead of waiting a full cycle.
      if (this.clients.size === 1 && this.timer === undefined) void this.readOnce().then(() => this.schedule());
    }
    return client;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
    for (const client of [...this.clients]) client.close();
  }
}

export function apply(ctx) {
  const hub = new BalanceHub({ credentials: ctx.get('credentials') });
  const service = { watch(signal) { return hub.watch(signal); } };
  // Public Cordis service plus the exact visible protocol binding; strict reflection
  // is contributed by the generated contract the client mounts.
  service.typertRemote = Object.freeze({ service, serviceKey: name, namespace: name });
  ctx.provide(name, service);
  ctx.effect(() => () => hub.dispose(), 'token-bucket.poller');
}
