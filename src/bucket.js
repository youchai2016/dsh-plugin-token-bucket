/**
 * Pure bucket model shared by the Host and the widget.
 *
 * Money moves as integer hundredths ("cents") so nothing here can drift, and every
 * function is a pure fold over samples: given the same sample stream, the Host and
 * any number of open windows derive exactly the same water level and totals.
 */
export const STORAGE_KEY = 'dsh-plugin-token-bucket:v1';
export const SAMPLE_HISTORY = 24;
export const DEFAULTS = Object.freeze({ x: null, y: null, scale: 1, hidden: false, amount: true });
export const POLL = Object.freeze({
  hotMs: 5000, warmMs: 20000, idleMs: 60000, hotWindowMs: 120000, maxBackoffMs: 600000,
});
// A rate of ¥2/min fills the tap. A rolling window keeps the reading honest: the
// balance only moves in whole cents, so a per-sample derivative would be pure noise.
export const RATE_WINDOW_MS = 180000;
export const RATE_MIN_SPAN_MS = 30000;
export const FLOW_FULL_CENTS_PER_MIN = 200;

export function cleanPreferences(value) {
  const source = value && typeof value === 'object' ? value : {};
  const finite = candidate => typeof candidate === 'number' && Number.isFinite(candidate);
  return {
    x: finite(source.x) ? source.x : null,
    y: finite(source.y) ? source.y : null,
    scale: finite(source.scale) ? Math.min(2, Math.max(0.6, source.scale)) : 1,
    hidden: source.hidden === true,
    amount: source.amount !== false,
  };
}

export function clampPosition(x, y, width, height, viewportWidth, viewportHeight, top = 56) {
  const margin = 12;
  const maxX = Math.max(margin, viewportWidth - width - margin);
  const maxY = Math.max(margin, viewportHeight - height - margin);
  return {
    x: Math.min(maxX, Math.max(margin, x)),
    y: Math.min(maxY, Math.max(Math.min(top, maxY), y)),
  };
}

/** "575.28" -> 57528. Anything unparseable is null, never NaN and never a guess. */
export function parseAmount(text) {
  if (typeof text === 'number') return Number.isFinite(text) ? Math.round(text * 100) : null;
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/^(-?)(\d+)(?:\.(\d{1,6}))?$/);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  if (!Number.isSafeInteger(whole)) return null;
  const fraction = Number((match[3] ?? '').padEnd(2, '0').slice(0, 2));
  return sign * (whole * 100 + fraction);
}

export function formatCents(cents, currency = 'CNY') {
  const symbol = currency === 'USD' ? '$' : '¥';
  const value = Number.isFinite(cents) ? cents : 0;
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(Math.round(value));
  return `${sign}${symbol}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/** Compact money for a rate or a small total: 0.12 / 12.5 / 1.2k. */
export function formatCompactCents(cents, currency = 'CNY') {
  const symbol = currency === 'USD' ? '$' : '¥';
  const value = Math.abs(Number.isFinite(cents) ? cents : 0) / 100;
  if (value < 10) return `${symbol}${value.toFixed(2)}`;
  if (value < 1000) return `${symbol}${value.toFixed(1)}`;
  return `${symbol}${(value / 1000).toFixed(1)}k`;
}

export function freshState(now = Date.now()) {
  return {
    seq: -1, at: now, status: 'unconfigured', currency: 'CNY',
    totalCents: null, grantedCents: null, toppedUpCents: null, available: undefined,
    capacityCents: 0, spentCents: 0, refillCents: 0,
    lastSpendAt: 0, history: [], pollMs: POLL.idleMs, detail: undefined,
  };
}

/** The persisted half of the model: only what must survive a restart. */
export function persistedOf(state) {
  return {
    capacityCents: state.capacityCents, spentCents: state.spentCents,
    refillCents: state.refillCents, seq: state.seq, history: state.history.slice(-SAMPLE_HISTORY),
  };
}

export function restoreState(base, saved, now = Date.now()) {
  const source = saved && typeof saved === 'object' ? saved : {};
  const integer = (value, fallback = 0) => (Number.isSafeInteger(value) ? value : fallback);
  return {
    ...base,
    at: now,
    capacityCents: Math.max(0, integer(source.capacityCents)),
    spentCents: Math.max(0, integer(source.spentCents)),
    refillCents: Math.max(0, integer(source.refillCents)),
    seq: integer(source.seq, -1),
    history: Array.isArray(source.history)
      ? source.history.filter(entry => entry && Number.isSafeInteger(entry.at) && Number.isSafeInteger(entry.spent)).slice(-SAMPLE_HISTORY)
      : [],
  };
}

/**
 * Fold one Host snapshot into the model. Returns the next state plus what kind of
 * change it was, so the widget can splash a spend or celebrate a refill.
 * Out-of-order and duplicate samples are ignored rather than double counted.
 */
export function applySnapshot(state, snapshot, now = Date.now()) {
  if (!snapshot || snapshot.type !== 'snapshot') return { state, change: 'ignored' };
  const at = snapshot.at ?? now;
  const next = {
    ...state, at, seq: snapshot.seq, status: snapshot.status,
    pollMs: snapshot.pollMs ?? state.pollMs, detail: snapshot.detail,
  };
  if (Number.isSafeInteger(snapshot.spentCents)) next.spentCents = Math.max(state.spentCents, snapshot.spentCents);
  if (snapshot.status !== 'ready') {
    // A failed read keeps the last known water level; it never empties the bucket.
    return { state: next, change: 'none' };
  }
  next.currency = snapshot.currency ?? state.currency;
  next.totalCents = snapshot.totalCents ?? null;
  next.grantedCents = snapshot.grantedCents ?? null;
  next.toppedUpCents = snapshot.toppedUpCents ?? null;
  next.available = snapshot.available;
  if (next.totalCents === null) return { state: next, change: 'none' };
  next.capacityCents = Math.max(state.capacityCents, next.totalCents);
  // The first ready sample is a baseline: it can never be mistaken for spending.
  if (!Number.isSafeInteger(snapshot.seq) || snapshot.seq <= state.seq || state.totalCents === null) {
    return { state: next, change: 'none' };
  }
  const delta = next.totalCents - state.totalCents;
  if (delta < 0) {
    const spent = -delta;
    next.spentCents = state.spentCents + spent;
    next.lastSpendAt = at;
    next.history = [...state.history, { at, spent }].slice(-SAMPLE_HISTORY);
    return { state: next, change: 'spend' };
  }
  if (delta > 0) {
    next.refillCents = state.refillCents + delta;
    next.lastSpendAt = at;
    return { state: next, change: 'refill' };
  }
  return { state: next, change: 'none' };
}

/** Everything the widget draws, derived - never stored twice. */
export function viewOf(state, now = Date.now()) {
  const total = state.totalCents;
  const at = state.at ?? now;
  const capacity = Math.max(state.capacityCents, total ?? 0);
  const ratio = value => (capacity > 0 && Number.isFinite(value) ? Math.min(1, Math.max(0, value / capacity)) : 0);
  const ageMs = Math.max(0, now - at);
  const stale = state.status === 'ready' && ageMs > Math.max(3 * state.pollMs, 20000);
  // The window slides with the clock, so the tap closes on its own once a burst is old.
  const recent = state.history.filter(entry => now - entry.at <= RATE_WINDOW_MS);
  const windowSpent = recent.reduce((sum, entry) => sum + entry.spent, 0);
  const windowMinutes = Math.max(now - (recent[0]?.at ?? now), RATE_MIN_SPAN_MS) / 60000;
  const rateCentsPerMin = windowSpent > 0 ? windowSpent / windowMinutes : 0;
  const flow = state.status === 'ready' && rateCentsPerMin > 0
    ? Math.min(1, Math.sqrt(rateCentsPerMin / FLOW_FULL_CENTS_PER_MIN))
    : 0;
  const level = ratio(total);
  return {
    status: state.status,
    currency: state.currency,
    totalCents: total,
    grantedCents: state.grantedCents,
    toppedUpCents: state.toppedUpCents,
    amountText: total === null ? null : formatCents(total, state.currency),
    totalText: total === null ? '' : formatCents(total, state.currency),
    grantedText: state.grantedCents === null ? '' : formatCents(state.grantedCents, state.currency),
    toppedUpText: state.toppedUpCents === null ? '' : formatCents(state.toppedUpCents, state.currency),
    spentText: formatCents(state.spentCents, state.currency),
    refillText: formatCents(state.refillCents, state.currency),
    capacityText: formatCents(capacity, state.currency),
    rateCentsPerMin,
    rateText: formatCompactCents(rateCentsPerMin, state.currency),
    levelPct: Math.round(level * 100),
    level,
    grantedLevel: ratio(state.grantedCents),
    toppedUpLevel: ratio(state.toppedUpCents),
    flow,
    stale,
    ageMs,
    healthy: state.status === 'ready' && !stale,
    history: state.history,
  };
}
