import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BucketWidget } from '../src/widget.js';
import { MESSAGES, translate } from '../src/i18n.js';
import { STORAGE_KEY } from '../src/bucket.js';

const source = readFileSync(new URL('../src/widget.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/bucket.css', import.meta.url), 'utf8');
const AT = 1_700_000_000_000;

// Minimal DOM fixture exercises the real constructor and event handlers without a browser.
function fixture(t, language = 'en') {
  let document;
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag; this.attributes = {}; this.dataset = {}; this.children = [];
      this.hidden = false; this.value = ''; this.textContent = ''; this.checked = false;
      this.ownerDocument = document; this.listeners = new Map(); this.captures = new Set();
      this.style = { setProperty(key, value) { this[key] = value; } };
      this.offsetWidth = 268; this.offsetHeight = 380;
    }
    setAttribute(key, value) {
      this.attributes[key] = String(value);
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      if (key === 'hidden') this.hidden = true;
      if (['min', 'max', 'value'].includes(key)) this[key] = value;
    }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    toggleAttribute(key, force) { if (force) this.setAttribute(key, ''); else this.removeAttribute(key); }
    append(...nodes) { this.children.push(...nodes); }
    remove() {}
    replaceChildren() { this.children = []; }
    cloneNode() { return this; }
    focus() { document.activeElement = this; }
    setPointerCapture(id) { this.captures.add(id); }
    hasPointerCapture(id) { return this.captures.has(id); }
    releasePointerCapture(id) { this.captures.delete(id); }
    addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(callback); }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatch(type, details = {}) {
      const event = { detail: 0, preventDefault() {}, stopPropagation() {}, composedPath: () => [], ...details };
      for (const callback of this.listeners.get(type) || []) callback(event);
    }
    querySelectorAll(selector) {
      const matches = node => selector.startsWith('.') ? (node.attributes.class || '').split(' ').includes(selector.slice(1))
        : selector.startsWith('#') ? node.attributes.id === selector.slice(1)
        : selector.startsWith('[') ? Object.hasOwn(node.attributes, selector.slice(1, -1)) : node.tagName === selector;
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    set innerHTML(html) {
      this.content = new Element('fragment');
      for (const [, tag, attributes] of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
        const node = new Element(tag);
        for (const [, key, value] of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(key, value ?? '');
        this.content.append(node);
      }
    }
  }
  document = new Element('document');
  document.documentElement = new Element('html');
  document.createElement = tag => new Element(tag);
  document.hidden = false;
  const window = new Element('window');
  window.innerWidth = 900; window.innerHeight = 800;
  document.defaultView = window;
  const globals = { document, window, getComputedStyle: () => ({ getPropertyValue: () => '', paddingBottom: '0', paddingLeft: '0', paddingRight: '0', paddingTop: '0' }) };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
  const clock = { value: AT };
  const store = new Map();
  const storage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };
  const host = new Element(); host.ownerDocument = document;
  host.attachShadow = () => (host.shadowRoot = new Element('shadow'));
  const views = [];
  const widget = new BucketWidget(host, { language, css, storage, now: () => clock.value, onView: view => views.push(view) });
  widget.clock = clock;
  t.after(() => widget.dispose());
  return { widget, document, window, storage, store, clock, views };
}

const snapshot = (extra = {}) => ({
  type: 'snapshot', hostEpoch: 'e', seq: 1, at: AT, pollMs: 60000, status: 'ready', currency: 'CNY',
  totalCents: 57528, grantedCents: 17891, toppedUpCents: 39637, available: true, spentCents: 0, ...extra,
});

test('the bucket draws level, the granted share, the tap and the readout', t => {
  const { widget: w, views } = fixture(t);
  assert.equal(w.bucket.dataset.status, 'unconfigured');
  assert.equal(w.amount.textContent, '—', 'no money is shown before a real reading');

  w.update(snapshot());
  assert.equal(w.bucket.dataset.status, 'ready');
  assert.equal(w.bucket.dataset.level, 'high');
  assert.equal(w.bucket.dataset.flow, 'idle');
  assert.equal(w.bucket.style['--level'], '1');
  assert.equal(w.bucket.style['--bonus-share'], String(17891 / 57528));
  assert.equal(w.amount.textContent, '¥575.28');
  assert.equal(w.vTotal.textContent, '¥575.28');
  assert.equal(w.vGranted.textContent, '¥178.91');
  assert.equal(w.vTopped.textContent, '¥396.37');
  assert.equal(w.vCapacity.textContent, '¥575.28');
  assert.match(w.button.getAttribute('aria-label'), /¥575\.28/);
  assert.equal(views.at(-1).levelPct, 100);

  // A spend both splashes and opens the tap.
  w.clock.value = AT + 60000;
  w.update(snapshot({ seq: 2, at: AT + 60000, totalCents: 57524 }));
  assert.equal(w.bucket.dataset.delta, 'spend');
  assert.equal(w.delta.textContent, '-¥0.04');
  assert.equal(w.bucket.dataset.splash, 'true');
  assert.equal(w.vSpent.textContent, '¥0.04');
  assert.ok(Number(w.bucket.style['--flow']) > 0, 'the tap opens while money is moving');
  assert.equal(w.bucket.dataset.flow === 'idle', false);

  // A top-up is celebrated rather than drawn as a spend.
  w.clock.value = AT + 120000;
  w.update(snapshot({ seq: 3, at: AT + 120000, totalCents: 67524 }));
  assert.equal(w.bucket.dataset.delta, 'refill');
  assert.equal(w.delta.textContent, '+¥100.00', 'a top-up announces what was added, not the new total');
  assert.equal(w.vRefill.textContent, '¥100.00');
  assert.equal(w.bucket.style['--level'], '1', 'a taller bucket is still full');
});

test('a failed read keeps the water level and says so', t => {
  const { widget: w } = fixture(t);
  w.update(snapshot());
  w.clock.value = AT + 300000;
  w.update({ type: 'snapshot', hostEpoch: 'e', seq: 2, at: AT + 300000, pollMs: 60000, status: 'unreachable', spentCents: 0, detail: 'http 503' });
  assert.equal(w.bucket.dataset.status, 'unreachable');
  assert.equal(w.amount.textContent, '¥575.28', 'the last real balance is not thrown away');
  assert.equal(w.bucket.style['--flow'], '0.000', 'and the tap is shut');
  assert.equal(w.vTotal.textContent, '¥575.28');
  // An old but *successful* reading is reported as stale rather than live.
  w.clock.value = AT + 600000;
  w.update(snapshot({ seq: 3, at: AT + 60000 }));
  w.render();
  assert.equal(w.bucket.dataset.status, 'stale', 'an old reading is reported as old, not as live');
});

test('the low-water states change colour and start wobbling', t => {
  const { widget: w } = fixture(t);
  // The bucket is as tall as the highest balance ever seen, so establish that first.
  w.update(snapshot());
  w.update(snapshot({ seq: 2, at: AT + 1000, totalCents: 15000, grantedCents: 0, toppedUpCents: 15000 }));
  assert.equal(w.bucket.dataset.level, 'mid');
  w.update(snapshot({ seq: 3, at: AT + 2000, totalCents: 5000, grantedCents: 0, toppedUpCents: 5000 }));
  assert.equal(w.bucket.dataset.level, 'low');
  assert.match(css, /data-level=low\] \.stage\{animation:wobble/);
});

test('ordinary settings, drag, keyboard and hide/restore still work', t => {
  const { widget: w, document, store } = fixture(t);
  w.button.dispatch('contextmenu');
  assert.equal(w.panel.hidden, false);

  const origin = { ...w.position };
  w.button.dispatch('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.equal(w.position.x, origin.x - 20);
  const dragged = { ...w.position };
  w.button.dispatch('pointerdown', { button: 0, isPrimary: true, pointerId: 1, clientX: 100, clientY: 100 });
  w.button.dispatch('pointermove', { pointerId: 1, clientX: 80, clientY: 70 });
  assert.equal(w.bucket.dataset.dragging, 'true');
  assert.equal(w.position.x, dragged.x - 20);
  assert.equal(w.position.y, dragged.y - 30);
  w.button.dispatch('pointerup', { pointerId: 1 });
  assert.equal(w.drag, null);
  assert.equal(w.button.hasPointerCapture(1), false);

  w.range.value = '140'; w.range.dispatch('input');
  assert.equal(w.preferences.scale, 1.4);
  assert.equal(w.range.style['--range-progress'], `${(140 - 70) / (180 - 70) * 100}%`);
  w.amountSwitch.checked = false; w.amountSwitch.dispatch('change');
  assert.equal(w.preferences.amount, false);
  assert.equal(w.bucket.dataset.amount, 'false');
  assert.equal(JSON.parse(store.get(STORAGE_KEY)).amount, false);

  w.preferences.x = 100; w.preferences.y = 100;
  w.root.querySelector('.reset').dispatch('click');
  assert.equal(w.preferences.x, null);

  w.root.querySelector('.hide').dispatch('click');
  assert.equal(w.bucket.hidden, true); assert.equal(w.restore.hidden, false);
  assert.equal(document.activeElement, w.restore);
  w.restore.dispatch('click');
  assert.equal(w.bucket.hidden, false); assert.equal(document.activeElement, w.button);

  w.openPanel();
  w.root.dispatch('keydown', { key: 'Escape' });
  assert.equal(w.panel.hidden, true);
  w.openPanel();
  document.dispatch('pointerdown', { composedPath: () => [] });
  assert.equal(w.panel.hidden, true);
});

test('the model survives a restart, and disposal is clean and idempotent', t => {
  const { widget: w, storage, clock } = fixture(t);
  w.update(snapshot());
  clock.value = AT + 60000;
  w.update(snapshot({ seq: 2, at: AT + 60000, totalCents: 57500 }));
  assert.ok(storage.getItem(`${STORAGE_KEY}:model`), 'spending is persisted immediately');
  const saved = JSON.parse(storage.getItem(`${STORAGE_KEY}:model`));
  assert.equal(saved.capacityCents, 57528);
  assert.equal(saved.spentCents, 28);

  let cleanups = 0;
  w.cleanups.push(() => cleanups++);
  w.dispose(); w.dispose();
  assert.equal(cleanups, 1);
  assert.equal(w.root.children.length, 0);
  assert.equal(w.button.listeners.get('click').size, 0);
});

test('the shipped widget is inert: no fetches, no dynamic HTML, no diagnostics', t => {
  const { widget: w } = fixture(t);
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|document\.write|eval\(|diagnostic|telemetry|clipboard/i);
  // The only innerHTML write is the static template, never assembled from data.
  assert.equal((source.match(/innerHTML\s*=/g) ?? []).length, 1);
  assert.doesNotMatch(css, /url\(["']?https?:/i, 'the stylesheet must not fetch anything');
  assert.deepEqual(w.root.querySelectorAll('button').map(node => node.getAttribute('class')),
    ['bucket-button', 'close', 'action reset', 'action hide', 'restore']);
  assert.deepEqual(w.root.querySelectorAll('input').map(node => node.getAttribute('id')),
    ['bucket-size', 'bucket-amount']);
  assert.equal(w.button.getAttribute('aria-label').length > 0, true);
});

test('both dictionaries stay consistent, with matching placeholders', () => {
  assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.zh).sort());
  for (const language of ['en', 'zh']) {
    for (const [key, value] of Object.entries(MESSAGES[language])) {
      assert.ok(value.trim(), key);
      assert.equal(translate(language, key), value);
      assert.deepEqual((value.match(/\{\w+\}/g) ?? []).sort(), (MESSAGES.en[key].match(/\{\w+\}/g) ?? []).sort());
    }
  }
  assert.equal(translate('zh', 'value.perMin', { amount: '¥1.20' }), '每分钟 ¥1.20');
  assert.equal(translate('en', 'missing.key'), 'missing.key');
});
