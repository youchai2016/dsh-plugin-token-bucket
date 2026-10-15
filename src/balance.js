/**
 * Host-side balance read. The only outbound request this plugin ever makes.
 *
 * The API key is resolved through DSH's credential service on every poll and is
 * never stored, logged, echoed in an error, or attached to anything the client sees.
 */
import { parseAmount } from './bucket.js';

export const BALANCE_URL = 'https://api.deepseek.com/user/balance';
export const MAX_BODY_BYTES = 8192;

/** Classify a transport failure without leaking the request or the credential. */
export function classifyFailure(error) {
  const name = error?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return { status: 'unreachable', detail: 'timeout' };
  return { status: 'unreachable', detail: typeof error?.code === 'string' ? error.code.slice(0, 40) : 'network' };
}

export function classifyHttp(status) {
  if (status === 401 || status === 403) return { status: 'unauthorized', detail: `http ${status}` };
  return { status: 'unreachable', detail: `http ${status}` };
}

/** Parse the documented payload: { is_available, balance_infos: [{ currency, total_balance, ... }] }. */
export function parseBalancePayload(text) {
  let body;
  try { body = JSON.parse(text); } catch { return { ok: false, detail: 'not json' }; }
  const infos = body?.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) return { ok: false, detail: 'no wallet' };
  const wallet = infos.find(entry => entry?.currency === 'CNY') ?? infos[0];
  const total = parseAmount(wallet?.total_balance);
  if (total === null) return { ok: false, detail: 'no total' };
  const granted = parseAmount(wallet?.granted_balance);
  const toppedUp = parseAmount(wallet?.topped_up_balance);
  return {
    ok: true,
    wallet: {
      currency: wallet?.currency === 'USD' ? 'USD' : 'CNY',
      totalCents: total,
      // Older payloads may omit the split; the level still works from the total.
      grantedCents: granted === null ? null : granted,
      toppedUpCents: toppedUp === null ? null : toppedUp,
      available: body?.is_available !== false,
    },
  };
}

/**
 * One read. `key` must be non-empty; the caller decides how often to call and how to
 * back off. Returns a partial snapshot (never `seq`/`at`, which the poller owns).
 */
export async function readBalance({ fetchImpl, key, signal, timeoutMs = 8000 }) {
  if (typeof key !== 'string' || key.length === 0) return { status: 'unconfigured', detail: 'no key' };
  // A Host without fetch is reported as itself, never as a vague network failure.
  if (typeof fetchImpl !== 'function') return { status: 'unreachable', detail: 'no fetch' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const stop = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', forward); };
  const forward = () => controller.abort();
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); return { status: 'unreachable', detail: 'aborted' }; }
    signal.addEventListener('abort', forward, { once: true });
  }
  try {
    const response = await fetchImpl(BALANCE_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return classifyHttp(response.status);
    // Bound the read: a balance payload is a few hundred bytes.
    const text = (await response.text()).slice(0, MAX_BODY_BYTES);
    const parsed = parseBalancePayload(text);
    if (!parsed.ok) return { status: 'invalid', detail: parsed.detail };
    return { status: 'ready', ...parsed.wallet };
  } catch (error) {
    return classifyFailure(error);
  } finally {
    stop();
  }
}
