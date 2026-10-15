import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applySnapshot, clampPosition, cleanPreferences, FLOW_FULL_CENTS_PER_MIN, formatCents, formatCompactCents,
  freshState, parseAmount, persistedOf, POLL, RATE_WINDOW_MS, restoreState, viewOf,
} from '../src/bucket.js';
import { classifyHttp, parseBalancePayload, readBalance, BALANCE_URL } from '../src/balance.js';
import { apply, BalanceHub, KEY_REFS, name } from '../src/host-bridge.js';

const AT = 1_700_000_000_000;
const snapshot = (extra = {}) => ({
  type: 'snapshot', hostEpoch: 'e', seq: 1, at: AT, pollMs: 60000, status: 'ready', currency: 'CNY',
  totalCents: 57528, grantedCents: 17891, toppedUpCents: 39637, available: true, spentCents: 0, ...extra,
});
const ready = (state, extra) => applySnapshot(state, snapshot(extra), AT).state;
const wallet = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '575.28', granted_balance: '178.91', topped_up_balance: '396.37' }] };

test('amounts stay exact: parsing, formatting and compact rates', () => {
  assert.equal(parseAmount('575.28'), 57528);
  assert.equal(parseAmount('0.01'), 1);
  assert.equal(parseAmount('12'), 1200);
  assert.equal(parseAmount('1.239'), 123);
  assert.equal(parseAmount('-3.50'), -350);
  for (const bad of ['', 'abc', '1.2.3', null, undefined, {}, NaN]) assert.equal(parseAmount(bad), null);
  assert.equal(formatCents(57528), '¥575.28');
  assert.equal(formatCents(1), '¥0.01');
  assert.equal(formatCents(0), '¥0.00');
  assert.equal(formatCents(-250), '-¥2.50');
  assert.equal(formatCents(57528, 'USD'), '$575.28');
  assert.equal(formatCompactCents(12), '¥0.12');
  assert.equal(formatCompactCents(1250), '¥12.5');
  assert.equal(formatCompactCents(123456), '¥1.2k');
});

test('preferences and placement are bounded and tolerate junk', () => {
  assert.deepEqual(cleanPreferences(null), cleanPreferences({}));
  assert.equal(cleanPreferences({ scale: 9 }).scale, 2);
  assert.equal(cleanPreferences({ scale: 0 }).scale, 0.6);
  assert.equal(cleanPreferences({ scale: NaN }).scale, 1);
  assert.equal(cleanPreferences({ x: Infinity }).x, null);
  assert.equal(cleanPreferences({ hidden: 'yes' }).hidden, false);
  assert.equal(cleanPreferences({ amount: false }).amount, false);
  assert.deepEqual(clampPosition(-30, -40, 104, 156, 800, 600), { x: 12, y: 56 });
  assert.deepEqual(clampPosition(9999, 9999, 104, 156, 800, 600), { x: 684, y: 432 });
});

test('the first reading is a baseline, then cents in and out become level and rate', () => {
  const start = freshState(AT);
  const first = applySnapshot(start, snapshot(), AT);
  assert.equal(first.change, 'none', 'a baseline can never be mistaken for spending');
  assert.equal(first.state.capacityCents, 57528);
  assert.equal(viewOf(first.state, AT).level, 1);

  const spent = applySnapshot(first.state, snapshot({ seq: 2, at: AT + 60000, totalCents: 57524 }), AT + 60000);
  assert.equal(spent.change, 'spend');
  assert.equal(spent.state.spentCents, 4);
  assert.equal(spent.state.history.length, 1);
  const view = viewOf(spent.state, AT + 60000);
  assert.equal(view.spentText, '¥0.04');
  assert.equal(view.level, 57524 / 57528);
  assert.ok(view.rateCentsPerMin > 0);
  assert.ok(view.flow > 0 && view.flow <= 1);
  // One cent of spending is spread over the minimum window, so the reading is honest
  // about how little evidence there is: 4 cents over 30 s is 8 cents per minute.
  assert.equal(formatCents(Math.round(view.rateCentsPerMin)), '¥0.08');

  const refilled = applySnapshot(spent.state, snapshot({ seq: 3, at: AT + 120000, totalCents: 67524 }), AT + 120000);
  assert.equal(refilled.change, 'refill');
  assert.equal(refilled.state.refillCents, 10000);
  assert.equal(refilled.state.capacityCents, 67524, 'a top-up makes the bucket taller');
  assert.equal(viewOf(refilled.state, AT + 120000).level, 1);
});

test('duplicates, replays and failures never double count or empty the bucket', () => {
  const base = ready(ready(freshState(AT), {}), { seq: 2, at: AT + 60000, totalCents: 57524 });
  const duplicate = applySnapshot(base, snapshot({ seq: 2, at: AT + 60000, totalCents: 57524 }), AT + 60000);
  assert.equal(duplicate.change, 'none');
  assert.equal(duplicate.state.spentCents, 4);
  const replay = applySnapshot(base, snapshot({ seq: 9, at: AT + 90000, totalCents: 50000 }), AT + 90000);
  assert.equal(replay.state.totalCents, 50000, 'a newer sequence is accepted');
  const failed = applySnapshot(replay.state, { type: 'snapshot', seq: 10, at: AT + 120000, pollMs: 60000, status: 'unreachable', spentCents: 4, detail: 'http 503' }, AT + 120000);
  assert.equal(failed.state.totalCents, 50000, 'a failed read keeps the last known level');
  const failedView = viewOf(failed.state, AT + 120000);
  assert.equal(failedView.status, 'unreachable');
  assert.equal(failedView.totalText, '¥500.00');
  assert.equal(failedView.flow, 0);
  assert.equal(applySnapshot(base, { nonsense: true }, AT).change, 'ignored');
});

test('staleness and the rolling rate window behave over time', () => {
  const state = ready(ready(freshState(AT), {}), { seq: 2, at: AT + 60000, totalCents: 57500 });
  assert.equal(viewOf(state, AT + 60000).stale, false);
  assert.equal(viewOf(state, AT + 600000).stale, true, 'a quiet balance read is reported as old');
  assert.equal(viewOf(state, AT + 600000).healthy, false);
  // Outside the window the burn rate drops back to zero instead of haunting the tap.
  const late = AT + 60000 + RATE_WINDOW_MS + 1000;
  assert.equal(viewOf(state, late).rateCentsPerMin, 0);
  assert.equal(viewOf(state, late).flow, 0);
  const capped = viewOf({ ...state, history: [{ at: AT + 60000, spent: 100000 }] }, AT + 60000);
  assert.equal(capped.flow, 1, 'an enormous burn pins the tap open without overflowing');
  assert.equal(FLOW_FULL_CENTS_PER_MIN, 200);
});

test('the persisted model survives a restart and ignores junk', () => {
  const state = ready(ready(freshState(AT), {}), { seq: 2, at: AT + 60000, totalCents: 57524 });
  const saved = JSON.parse(JSON.stringify(persistedOf(state)));
  const restored = restoreState(freshState(AT + 500000), saved, AT + 500000);
  assert.equal(restored.capacityCents, 57528);
  assert.equal(restored.spentCents, 4);
  assert.equal(restored.seq, 2);
  assert.equal(restored.history.length, 1);
  const junk = restoreState(freshState(AT), { capacityCents: 'x', spentCents: -5, history: [{ at: 'nope' }, null, { at: 1, spent: 2 }] }, AT);
  assert.equal(junk.capacityCents, 0);
  assert.equal(junk.spentCents, 0);
  assert.deepEqual(junk.history, [{ at: 1, spent: 2 }]);
});

test('the documented balance payload parses, including odd shapes', () => {
  const parsed = parseBalancePayload(JSON.stringify(wallet));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.wallet, { currency: 'CNY', totalCents: 57528, grantedCents: 17891, toppedUpCents: 39637, available: true });
  assert.equal(parseBalancePayload(JSON.stringify({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '9.99' }] })).wallet.available, false);
  assert.equal(parseBalancePayload(JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: '9.99' }] })).wallet.currency, 'USD');
  assert.equal(parseBalancePayload('{').ok, false);
  assert.equal(parseBalancePayload('{}').ok, false);
  assert.equal(parseBalancePayload(JSON.stringify({ balance_infos: [{ currency: 'CNY' }] })).ok, false);
});

test('one read never leaks the key and classifies every failure', async () => {
  const key = 'sk-test-secret-value';
  const ok = await readBalance({ key, fetchImpl: async (url, init) => {
    assert.equal(url, BALANCE_URL);
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    return { ok: true, status: 200, async text() { return JSON.stringify(wallet); } };
  } });
  assert.equal(ok.status, 'ready');
  assert.equal(ok.totalCents, 57528);
  assert.equal(JSON.stringify(ok).includes(key), false, 'the credential must never travel outward');

  const unauthorized = await readBalance({ key, fetchImpl: async () => ({ ok: false, status: 401, async text() { return 'no'; } }) });
  assert.equal(unauthorized.status, 'unauthorized');
  const server = await readBalance({ key, fetchImpl: async () => ({ ok: false, status: 503, async text() { return 'down'; } }) });
  assert.equal(server.status, 'unreachable');
  const thrown = await readBalance({ key, fetchImpl: async () => { const error = new Error(`boom ${key}`); error.code = 'ECONNRESET'; throw error; } });
  assert.equal(thrown.status, 'unreachable');
  assert.equal(JSON.stringify(thrown).includes(key), false, 'a transport error must not be echoed either');
  const missing = await readBalance({ key: '', fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(missing.status, 'unconfigured');
  assert.deepEqual(classifyHttp(403), { status: 'unauthorized', detail: 'http 403' });
});

test('the host poller resolves the credential per read, fans out and backs off', async t => {
  const calls = [];
  const credentials = { async resolve(ref) { calls.push(ref); return { value: 'sk-live', source: 'store' }; } };
  const hub = new BalanceHub({ credentials, now: () => AT, epoch: 'test',
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return JSON.stringify(wallet); } }) });
  // A failed assertion must still stop the poller, or the process never exits.
  t.after(() => hub.dispose());
  // Arm the poller so watch() does not race this test with a read of its own.
  hub.timer = setTimeout(() => {}, 3_600_000);
  const reader = hub.watch(new AbortController().signal);
  assert.equal((await reader.next()).value.status, 'unconfigured', 'the first frame is the current state, not a lie');
  await hub.readOnce();
  const first = (await reader.next()).value;
  assert.equal(first.status, 'ready');
  assert.equal(first.totalCents, 57528);
  assert.equal(first.seq > 0, true);
  assert.deepEqual(calls, [KEY_REFS[0]]);
  assert.equal(JSON.stringify(first).includes('sk-live'), false);

  const second = hub.watch(new AbortController().signal);
  assert.equal((await second.next()).value.seq, first.seq, 'a new reader starts from the current state');
  await hub.readOnce();
  assert.equal((await reader.next()).value.seq, first.seq + 1, 'both readers share one poller');
  assert.equal((await second.next()).value.seq, first.seq + 1);

  // A spend moves the host's own running total and opens the hot cadence.
  hub.fetchImpl = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ ...wallet, balance_infos: [{ ...wallet.balance_infos[0], total_balance: '575.20' }] }); } });
  await hub.readOnce();
  const spent = (await reader.next()).value;
  assert.equal(spent.spentCents, 8);
  assert.equal(spent.pollMs, POLL.hotMs, 'money moved, so look again soon');

  // Failures back off instead of hammering the endpoint, and never invent a level.
  hub.fetchImpl = async () => { throw new Error('offline'); };
  await hub.readOnce();
  const failed = (await reader.next()).value;
  assert.equal(failed.status, 'unreachable');
  assert.equal(failed.totalCents, undefined, 'a failed read publishes no wallet at all');
  assert.ok(hub.nextDelay() >= POLL.hotMs * 2);
  assert.equal(hub.failures, 1);
  hub.dispose();
  assert.deepEqual(await reader.next(), { done: true });
  assert.deepEqual(await second.next(), { done: true });
});

test('a missing credential service is a state, not a crash', async t => {
  for (const credentials of [undefined, { async resolve() { return undefined; } }, { async resolve() { throw new Error('no'); } }]) {
    const hub = new BalanceHub({ credentials, now: () => AT, epoch: 'x' });
    t.after(() => hub.dispose());
    await hub.readOnce();
    assert.equal(hub.snapshot.status, 'unconfigured');
    assert.equal(hub.spentCents, 0);
    hub.dispose();
  }
  const hub = new BalanceHub({ credentials: undefined, now: () => AT, epoch: 'y' });
  assert.equal(hub.nextDelay(), POLL.idleMs, 'nothing has moved yet, so poll slowly');
  hub.dispose();
});

test('the host entry exposes one read-only service and owns its cleanup', () => {
  let service; let cleanup; let effectLabel;
  const listeners = [];
  apply({
    get: key => (key === 'credentials' ? { async resolve() { return undefined; } } : undefined),
    provide: (key, value) => { assert.equal(key, name); service = value; },
    on: (...args) => listeners.push(args),
    effect: (factory, label) => { effectLabel = label; cleanup = factory(); },
  });
  assert.equal(name, 'tokenBucket');
  assert.deepEqual(Object.keys(service).sort(), ['typertRemote', 'watch']);
  assert.equal(service.typertRemote.namespace, 'tokenBucket');
  assert.equal(service.typertRemote.serviceKey, 'tokenBucket');
  assert.equal(service.typertRemote.service, service);
  assert.equal(effectLabel, 'token-bucket.poller');
  assert.deepEqual(listeners, [], 'the bucket watches no session events at all');
  assert.equal(typeof cleanup, 'function');
  cleanup();
});
