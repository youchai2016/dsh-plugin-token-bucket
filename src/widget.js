import {
  applySnapshot, cleanPreferences, clampPosition, DEFAULTS, formatCents, freshState, persistedOf, restoreState, STORAGE_KEY, viewOf,
} from './bucket.js';
import { normalizeLanguage, translate } from './i18n.js';

const MODEL_KEY = `${STORAGE_KEY}:model`;

/** Framework-independent bucket UI, shared by the real plugin and the offline preview. */
export class BucketWidget {
  constructor(host, { css, storage, language = 'en', now = () => Date.now(), onView = () => {} } = {}) {
    this.host = host;
    this.language = normalizeLanguage(language);
    this.originalLang = host.getAttribute('lang');
    this.now = now;
    this.onView = onView;
    this.cleanups = [];
    this.disposed = false;
    this.effects = new Map();
    this.storage = storage;
    if (storage === undefined) { try { this.storage = window.localStorage; } catch { this.storage = null; } }
    this.preferences = cleanPreferences(this.read(STORAGE_KEY));
    this.state = restoreState(freshState(now()), this.read(MODEL_KEY), now());
    this.persistedAt = 0;
    this.root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    this.root.replaceChildren();
    const sheet = document.createElement('style');
    sheet.textContent = css;
    this.root.append(sheet);
    // Static markup only: no dynamic HTML, no inline handlers, no remote assets.
    const template = document.createElement('template');
    template.innerHTML = `
      <div class="bucket" data-status="unconfigured" data-level="none" data-flow="idle" data-amount="true">
        <button type="button" class="bucket-button" aria-label="Balance bucket">
          <span class="stage">
            <span class="pail">
              <span class="water"><span class="layer base"></span><span class="layer bonus"></span><span class="foam"><span></span><span></span><span></span></span><span class="surf"></span></span>
            </span>
            <svg class="outline" viewBox="0 0 74 92" aria-hidden="true" focusable="false">
              <path class="glass" d="M8 10 L15 86 L59 86 L66 10 Z"/>
              <path d="M6.5 10 H67.5"/><path d="M14 86 H60"/>
              <path d="M12.5 10 L19 86"/><path d="M61.5 10 L55 86"/>
              <path class="rib" d="M11 38 H63"/><path class="rib" d="M12.6 62 H61.4"/>
              <path d="M14 9 C14 -3 60 -3 60 9"/>
            </svg>
            <span class="stream"></span>
            <span class="drops" aria-hidden="true"><span></span><span></span><span></span></span>
            <span class="splash" aria-hidden="true"></span>
            <span class="delta" aria-hidden="true"></span>
          </span>
          <output class="amount"></output>
        </button>
        <section class="panel" role="dialog" data-i18n-aria="panel.aria" hidden>
          <div class="panel-head"><strong data-i18n="panel.title"></strong><button class="close" type="button" data-i18n-aria="panel.close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
          <p class="subtitle" data-i18n="panel.subtitle"></p>
          <div class="setting"><label for="bucket-size"><span data-i18n="setting.size"></span> <output class="size-value"></output></label><input id="bucket-size" type="range" min="70" max="180" step="5" /></div>
          <div class="setting"><label for="bucket-amount" data-i18n="setting.amount"></label><input id="bucket-amount" type="checkbox" role="switch" /></div>
          <dl class="readout">
            <dt data-i18n="label.level"></dt><dd class="v-level"></dd>
            <dt data-i18n="label.total"></dt><dd class="v-total"></dd>
            <dt data-i18n="label.granted"></dt><dd class="v-granted"></dd>
            <dt data-i18n="label.toppedUp"></dt><dd class="v-topped"></dd>
            <dt data-i18n="label.spent"></dt><dd class="v-spent"></dd>
            <dt data-i18n="label.refill"></dt><dd class="v-refill"></dd>
            <dt data-i18n="label.rate"></dt><dd class="v-rate"></dd>
            <dt data-i18n="label.capacity"></dt><dd class="v-capacity"></dd>
            <dt data-i18n="label.updated"></dt><dd class="v-updated"></dd>
          </dl>
          <div class="panel-actions"><button class="action reset" type="button" data-i18n="action.reset"></button><button class="action hide" type="button" data-i18n="action.hide"></button></div>
        </section>
        <button class="restore" type="button" hidden data-i18n-aria="action.restoreAria" data-i18n="action.restore"></button>
      </div>`;
    this.root.append(template.content.cloneNode(true));
    this.bucket = this.root.querySelector('.bucket');
    this.button = this.root.querySelector('.bucket-button');
    this.pail = this.root.querySelector('.pail');
    this.stream = this.root.querySelector('.stream');
    this.amount = this.root.querySelector('.amount');
    this.delta = this.root.querySelector('.delta');
    this.panel = this.root.querySelector('.panel');
    this.restore = this.root.querySelector('.restore');
    this.range = this.root.querySelector('#bucket-size');
    this.amountSwitch = this.root.querySelector('#bucket-amount');
    for (const key of ['level', 'total', 'granted', 'topped', 'spent', 'refill', 'rate', 'capacity', 'updated']) {
      this[`v${key[0].toUpperCase()}${key.slice(1)}`] = this.root.querySelector(`.v-${key}`);
    }
    this.listen(this.button, 'pointerdown', event => this.pointerDown(event));
    this.listen(this.button, 'pointermove', event => this.pointerMove(event));
    this.listen(this.button, 'pointerup', event => this.pointerEnd(event));
    this.listen(this.button, 'pointercancel', event => this.pointerEnd(event, true));
    this.listen(this.button, 'lostpointercapture', () => { this.drag = null; delete this.bucket.dataset.dragging; });
    this.listen(this.button, 'click', event => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      if (event.detail === 0) this.openPanel();
    });
    this.listen(this.button, 'contextmenu', event => { event.preventDefault(); this.openPanel(); });
    this.listen(this.button, 'keydown', event => {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (!directions[event.key]) return;
      event.preventDefault();
      const [dx, dy] = directions[event.key];
      const step = event.shiftKey ? 20 : 5;
      this.preferences.x = this.position.x + dx * step;
      this.preferences.y = this.position.y + dy * step;
      this.reposition(); this.save();
    });
    this.listen(this.root.querySelector('.close'), 'click', () => this.closePanel());
    this.listen(this.root, 'keydown', event => {
      if (event.key !== 'Escape' || this.panel.hidden) return;
      event.preventDefault(); event.stopPropagation(); this.closePanel();
    });
    this.listen(document, 'pointerdown', event => {
      if (!this.panel.hidden && !event.composedPath().includes(host)) this.closePanel(false);
    });
    this.listen(this.range, 'input', () => {
      this.preferences.scale = Number(this.range.value) / 100; this.applyPreferences(); this.save();
    });
    this.listen(this.amountSwitch, 'change', () => {
      this.preferences.amount = this.amountSwitch.checked; this.applyPreferences(); this.save();
    });
    this.listen(this.root.querySelector('.reset'), 'click', () => {
      this.preferences.x = null; this.preferences.y = null; this.reposition(); this.save();
    });
    this.listen(this.root.querySelector('.hide'), 'click', () => {
      this.preferences.hidden = true; this.closePanel(false); this.applyPreferences(); this.save(); this.restore.focus();
    });
    this.listen(this.restore, 'click', () => {
      this.preferences.hidden = false; this.applyPreferences(); this.save(); this.button.focus();
    });
    this.listen(window, 'resize', () => this.reposition());
    this.listen(document, 'visibilitychange', () => { this.visibility(); this.render(); });
    this.interval = setInterval(() => { if (!document.hidden) this.render(); }, 1000);
    this.cleanups.push(() => clearInterval(this.interval));
    this.applyPreferences(); this.setLanguage(this.language);
  }
  read(key) { try { return JSON.parse(this.storage?.getItem(key) || 'null'); } catch { return null; } }
  listen(target, event, callback, options) {
    target.addEventListener(event, callback, options);
    this.cleanups.push(() => target.removeEventListener(event, callback, options));
  }
  save() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.preferences)); } catch { /* storage denial is not fatal */ }
  }
  saveModel(force = false) {
    const now = this.now();
    if (!force && now - this.persistedAt < 3000) { this.modelDirty = true; return; }
    this.persistedAt = now; this.modelDirty = false;
    try { this.storage?.setItem(MODEL_KEY, JSON.stringify(persistedOf(this.state))); } catch { /* optional */ }
  }
  visibility() { this.host.dataset.paused = String(document.hidden || this.preferences.hidden); }
  setLanguage(language) {
    if (this.disposed) return;
    this.language = normalizeLanguage(language);
    this.host.setAttribute('lang', this.language);
    for (const element of this.root.querySelectorAll('[data-i18n]')) element.textContent = translate(this.language, element.dataset.i18n);
    for (const element of this.root.querySelectorAll('[data-i18n-aria]')) element.setAttribute('aria-label', translate(this.language, element.dataset.i18nAria));
    this.render();
    if (!this.panel.hidden) this.positionPanel();
  }
  applyPreferences() {
    this.range.value = String(Math.round(this.preferences.scale * 100));
    this.root.querySelector('.size-value').textContent = `${this.range.value}%`;
    this.range.style.setProperty('--range-progress', `${(Number(this.range.value) - Number(this.range.min)) / (Number(this.range.max) - Number(this.range.min)) * 100}%`);
    this.amountSwitch.checked = this.preferences.amount;
    this.bucket.dataset.amount = String(this.preferences.amount);
    this.bucket.hidden = this.preferences.hidden; this.restore.hidden = !this.preferences.hidden;
    if (this.preferences.hidden) this.closePanel(false);
    this.visibility(); this.reposition();
  }
  reposition() {
    const size = 104 * this.preferences.scale;
    this.bucket.style.width = `${size}px`; this.bucket.style.height = `${size * 1.5}px`;
    const top = Math.max(56, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance')) || 0);
    this.position = clampPosition(
      this.preferences.x ?? window.innerWidth - size - 28,
      this.preferences.y ?? window.innerHeight - size * 1.5 - 24,
      size, size * 1.5, window.innerWidth, window.innerHeight, top);
    this.bucket.style.left = `${this.position.x}px`; this.bucket.style.top = `${this.position.y}px`;
    if (!this.panel.hidden) this.positionPanel();
  }
  positionPanel() {
    const size = 104 * this.preferences.scale;
    const width = this.panel.offsetWidth || Math.min(268, window.innerWidth - 24);
    const height = this.panel.offsetHeight || 380;
    const position = clampPosition(this.position.x + size / 2 - width / 2, this.position.y - height - 12,
      width, height, window.innerWidth, window.innerHeight);
    this.panel.style.left = `${position.x}px`; this.panel.style.top = `${position.y}px`;
  }
  openPanel() { this.panel.hidden = false; this.positionPanel(); this.root.querySelector('.close').focus(); }
  closePanel(focus = true) { this.panel.hidden = true; if (focus) this.button.focus(); }
  pointerDown(event) {
    if (event.button !== 0 || !event.isPrimary) return;
    this.suppressClick = false;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: this.position.x, originY: this.position.y, moved: false };
    this.button.setPointerCapture(event.pointerId);
  }
  pointerMove(event) {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y;
    if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
    if (!this.drag.moved) return;
    this.bucket.dataset.dragging = 'true';
    this.preferences.x = this.drag.originX + dx; this.preferences.y = this.drag.originY + dy;
    this.reposition();
  }
  pointerEnd(event, cancelled = false) {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    this.suppressClick = this.drag.moved || cancelled;
    if (this.drag.moved) { this.preferences.x = this.position.x; this.preferences.y = this.position.y; this.save(); }
    this.drag = null; delete this.bucket.dataset.dragging;
    if (this.button.hasPointerCapture(event.pointerId)) this.button.releasePointerCapture(event.pointerId);
  }
  /** Play a one-shot animation keyed by its data attribute, restarting it if it is already on. */
  flash(name, value, ms) {
    const previous = this.effects.get(name);
    if (previous !== undefined) clearTimeout(previous);
    this.bucket.dataset[name] = value;
    this.effects.set(name, setTimeout(() => {
      this.effects.delete(name);
      if (!this.disposed) delete this.bucket.dataset[name];
    }, ms));
  }
  update(snapshot) {
    if (this.disposed) return;
    const previousTotal = this.state.totalCents;
    const { state, change } = applySnapshot(this.state, snapshot, this.now());
    this.state = state;
    if (change === 'spend') {
      this.delta.textContent = `-${this.lastSpendText(state)}`;
      this.flash('delta', 'spend', 1400);
      this.flash('splash', 'true', 900);
      this.saveModel(true);
    } else if (change === 'refill') {
      // Announce what was added, not the new total: a top-up is about the difference.
      const added = Number.isSafeInteger(previousTotal) && Number.isSafeInteger(state.totalCents)
        ? state.totalCents - previousTotal : 0;
      this.delta.textContent = `+${formatCents(added, state.currency)}`;
      this.flash('delta', 'refill', 1800);
      this.saveModel(true);
    } else if (snapshot && snapshot.status === 'ready') this.saveModel();
    this.render();
  }
  lastSpendText(state) {
    const entry = state.history.at(-1);
    return viewOf({ ...state, spentCents: entry?.spent ?? 0, refillCents: 0 }, this.now()).spentText;
  }
  render() {
    if (this.disposed) return;
    const now = this.now();
    const view = viewOf(this.state, now);
    const status = view.status === 'ready' ? (view.stale ? 'stale' : 'ready') : view.status;
    this.bucket.dataset.status = status;
    const level = view.totalCents === null ? 'none' : view.level >= 0.3 ? 'high' : view.level >= 0.1 ? 'mid' : 'low';
    this.bucket.dataset.level = level;
    this.bucket.dataset.flow = view.flow === 0 ? 'idle' : view.flow < 0.25 ? 'drip' : 'pour';
    // Set on the root: the pail, the spout, the falling stream and the splash all
    // inherit these, so the water and the tap can never disagree.
    this.bucket.style.setProperty('--level', String(view.level));
    this.bucket.style.setProperty('--bonus-share', String(view.level > 0
      ? Math.min(1, Math.max(0, view.grantedLevel / view.level)) : 0));
    this.bucket.style.setProperty('--flow', view.flow.toFixed(3));
    this.amount.textContent = view.totalText === '' ? '—' : view.totalText;
    this.vLevel.textContent = `${view.levelPct}% · ${translate(this.language, 'label.level')}`;
    this.vTotal.textContent = view.totalText || '—';
    this.vGranted.textContent = view.grantedText || '—';
    this.vTopped.textContent = view.toppedUpText || '—';
    this.vSpent.textContent = view.spentText;
    this.vRefill.textContent = view.refillText;
    this.vRate.textContent = view.rateCentsPerMin > 0
      ? translate(this.language, 'value.perMin', { amount: view.rateText }) : translate(this.language, `flow.${view.flow > 0 ? 'drip' : 'idle'}`);
    this.vCapacity.textContent = view.capacityText;
    const seconds = Math.round(view.ageMs / 1000);
    this.vUpdated.textContent = seconds < 90
      ? translate(this.language, 'value.secondsAgo', { count: seconds })
      : translate(this.language, 'value.minutesAgo', { count: Math.round(seconds / 60) });
    const statusText = translate(this.language, view.stale ? 'state.stale' : `state.${view.status}`);
    this.button.setAttribute('aria-label', view.totalCents === null
      ? translate(this.language, 'bucket.ariaNoBalance', { status: statusText })
      : translate(this.language, 'bucket.aria', { status: statusText, balance: view.totalText, level: view.levelPct }));
    this.onView(view);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.effects.values()) clearTimeout(timer);
    this.effects.clear();
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    this.root.replaceChildren();
    delete this.host.dataset.paused;
    if (this.originalLang === null) this.host.removeAttribute('lang');
    else this.host.setAttribute('lang', this.originalLang);
  }
}
