// Generated from src/host-bridge.js. Uses the Host credential service and one read-only balance request.

// src/bucket.js
var DEFAULTS = Object.freeze({ x: null, y: null, scale: 1, hidden: false, amount: true });
var POLL = Object.freeze({
  hotMs: 5e3,
  warmMs: 2e4,
  idleMs: 6e4,
  hotWindowMs: 12e4,
  maxBackoffMs: 6e5
});
function parseAmount(text) {
  if (typeof text === "number") return Number.isFinite(text) ? Math.round(text * 100) : null;
  if (typeof text !== "string") return null;
  const match = text.trim().match(/^(-?)(\d+)(?:\.(\d{1,6}))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? -1 : 1;
  const whole = Number(match[2]);
  if (!Number.isSafeInteger(whole)) return null;
  const fraction = Number((match[3] ?? "").padEnd(2, "0").slice(0, 2));
  return sign * (whole * 100 + fraction);
}

// src/balance.js
var BALANCE_URL = "https://api.deepseek.com/user/balance";
var MAX_BODY_BYTES = 8192;
function classifyFailure(error) {
  const name2 = error?.name;
  if (name2 === "AbortError" || name2 === "TimeoutError") return { status: "unreachable", detail: "timeout" };
  return { status: "unreachable", detail: typeof error?.code === "string" ? error.code.slice(0, 40) : "network" };
}
function classifyHttp(status) {
  if (status === 401 || status === 403) return { status: "unauthorized", detail: `http ${status}` };
  return { status: "unreachable", detail: `http ${status}` };
}
function parseBalancePayload(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, detail: "not json" };
  }
  const infos = body?.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) return { ok: false, detail: "no wallet" };
  const wallet = infos.find((entry) => entry?.currency === "CNY") ?? infos[0];
  const total = parseAmount(wallet?.total_balance);
  if (total === null) return { ok: false, detail: "no total" };
  const granted = parseAmount(wallet?.granted_balance);
  const toppedUp = parseAmount(wallet?.topped_up_balance);
  return {
    ok: true,
    wallet: {
      currency: wallet?.currency === "USD" ? "USD" : "CNY",
      totalCents: total,
      // Older payloads may omit the split; the level still works from the total.
      grantedCents: granted === null ? null : granted,
      toppedUpCents: toppedUp === null ? null : toppedUp,
      available: body?.is_available !== false
    }
  };
}
async function readBalance({ fetchImpl, key, signal, timeoutMs = 8e3 }) {
  if (typeof key !== "string" || key.length === 0) return { status: "unconfigured", detail: "no key" };
  if (typeof fetchImpl !== "function") return { status: "unreachable", detail: "no fetch" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const stop = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forward);
  };
  const forward = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return { status: "unreachable", detail: "aborted" };
    }
    signal.addEventListener("abort", forward, { once: true });
  }
  try {
    const response = await fetchImpl(BALANCE_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) return classifyHttp(response.status);
    const text = (await response.text()).slice(0, MAX_BODY_BYTES);
    const parsed = parseBalancePayload(text);
    if (!parsed.ok) return { status: "invalid", detail: parsed.detail };
    return { status: "ready", ...parsed.wallet };
  } catch (error) {
    return classifyFailure(error);
  } finally {
    stop();
  }
}

// src/host-bridge.js
var name = "tokenBucket";
var inject = ["credentials"];
var KEY_REFS = Object.freeze(["DEEPSEEK_API_KEY"]);
var QUEUE_LIMIT = 8;
var BalanceHub = class {
  constructor({
    credentials,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    poll = POLL,
    keyRefs = KEY_REFS,
    epoch = globalThis.crypto?.randomUUID?.() ?? `tb-${Date.now()}`
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
      type: "snapshot",
      hostEpoch: epoch,
      seq: 0,
      at: now(),
      pollMs: this.poll.idleMs,
      status: "unconfigured",
      spentCents: 0,
      detail: "starting"
    };
    this.clients = /* @__PURE__ */ new Set();
    this.timer = void 0;
    this.disposed = false;
    this.failures = 0;
    this.inFlight = false;
  }
  /** One resolution attempt across the known reference names. */
  async resolveKey() {
    const service = this.credentials;
    if (!service || typeof service.resolve !== "function") return { status: "unconfigured", detail: "no credential service" };
    for (const ref of this.keyRefs) {
      try {
        const resolved = await service.resolve(ref);
        if (resolved && typeof resolved.value === "string" && resolved.value.length > 0) return { key: resolved.value };
      } catch {
      }
    }
    return { status: "unconfigured", detail: "no key" };
  }
  /** Delay before the next read: fast right after money moved, slow when nothing does. */
  nextDelay() {
    if (this.failures > 0) return Math.min(this.poll.maxBackoffMs, this.poll.hotMs * 2 ** Math.min(this.failures, 7));
    const since = this.now() - this.lastChangeAt;
    if (this.lastChangeAt > 0 && since < this.poll.hotWindowMs) return this.poll.hotMs;
    if (this.lastChangeAt > 0 && since < 10 * 6e4) return this.poll.warmMs;
    return this.poll.idleMs;
  }
  publish(partial) {
    if (this.disposed) return;
    const status = partial.status ?? "unreachable";
    const at = this.now();
    if (status === "ready" && Number.isSafeInteger(partial.totalCents)) {
      if (Number.isSafeInteger(this.lastTotalCents)) {
        const delta = partial.totalCents - this.lastTotalCents;
        if (delta < 0) this.spentCents += -delta;
        if (delta !== 0) this.lastChangeAt = at;
      }
      this.lastTotalCents = partial.totalCents;
    }
    this.seq += 1;
    const snapshot = {
      type: "snapshot",
      hostEpoch: this.hostEpoch,
      seq: this.seq,
      at,
      pollMs: this.nextDelay(),
      status,
      spentCents: this.spentCents,
      ...partial.detail === void 0 ? {} : { detail: String(partial.detail).slice(0, 160) }
    };
    if (status === "ready") {
      snapshot.currency = partial.currency ?? "CNY";
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
      const result = resolved.key === void 0 ? { status: resolved.status, detail: resolved.detail } : await readBalance({ fetchImpl: this.fetchImpl, key: resolved.key, timeoutMs: 8e3 });
      if (result.status === "ready") this.failures = 0;
      else if (result.status === "unreachable" || result.status === "invalid") this.failures += 1;
      else this.failures = 0;
      this.publish(result);
    } catch (error) {
      this.failures += 1;
      this.publish({ status: "unreachable", detail: typeof error?.message === "string" ? error.message.slice(0, 80) : "error" });
    } finally {
      this.inFlight = false;
    }
  }
  schedule() {
    if (this.disposed || this.timer !== void 0) return;
    const delay = this.nextDelay();
    this.snapshot = { ...this.snapshot, pollMs: delay };
    this.timer = setTimeout(() => {
      this.timer = void 0;
      void this.readOnce().then(() => this.schedule());
    }, delay);
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
      signal?.removeEventListener("abort", finish);
      queue.length = 0;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = void 0;
        resolve({ done: true });
      }
    };
    const client = {
      push(snapshot) {
        if (ended) return;
        if (resolveNext) {
          const resolve = resolveNext;
          resolveNext = void 0;
          resolve({ done: false, value: snapshot });
        } else if (queue.length >= QUEUE_LIMIT) queue.shift();
        queue.push(snapshot);
      },
      next() {
        if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
        if (ended) return Promise.resolve({ done: true });
        if (resolveNext) return Promise.reject(new Error("Only one bucket iterator read may be pending"));
        return new Promise((resolve) => {
          resolveNext = resolve;
        });
      },
      return() {
        finish();
        return Promise.resolve({ done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      close: finish
    };
    if (!ended) {
      this.clients.add(client);
      signal?.addEventListener("abort", finish, { once: true });
      client.push(this.snapshot);
      if (this.clients.size === 1 && this.timer === void 0) void this.readOnce().then(() => this.schedule());
    }
    return client;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== void 0) {
      clearTimeout(this.timer);
      this.timer = void 0;
    }
    for (const client of [...this.clients]) client.close();
  }
};
function apply(ctx) {
  const hub = new BalanceHub({ credentials: ctx.get("credentials") });
  const service = { watch(signal) {
    return hub.watch(signal);
  } };
  service.typertRemote = Object.freeze({ service, serviceKey: name, namespace: name });
  ctx.provide(name, service);
  ctx.effect(() => () => hub.dispose(), "token-bucket.poller");
}
export {
  BalanceHub,
  KEY_REFS,
  QUEUE_LIMIT,
  apply,
  inject,
  name
};
