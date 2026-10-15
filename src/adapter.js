import { BucketWidget } from './widget.js';
import { observeBalance } from './bridge-client.js';
import { normalizeLanguage } from './i18n.js';

/** Only this file knows DSH's client contract. No private DOM or API routes. */
export function readDshLanguage(locale) {
  try { return normalizeLanguage(locale?.getSnapshot?.().active); } catch { return 'en'; }
}

export function observeDshLanguage(locale, onLanguage) {
  let alive = true, previous;
  const publish = () => {
    if (!alive) return;
    const next = readDshLanguage(locale);
    if (next !== previous) { previous = next; onLanguage(next); }
  };
  const unsubscribe = locale?.subscribe?.(publish) || (() => {});
  publish();
  return () => { if (!alive) return; alive = false; unsubscribe(); };
}

export function createPlugin(require, css) {
  const React = require('react');
  const h = React.createElement;
  return {
    inject: ['slots', 'connection', 'locale', 'remote'],
    apply(ctx) {
      function Bucket() {
        const element = React.useRef(null);
        React.useEffect(() => {
          const instance = new BucketWidget(element.current, { css, language: readDshLanguage(ctx.locale) });
          let stopLanguage = () => {};
          try { stopLanguage = observeDshLanguage(ctx.locale, language => instance.setLanguage(language)); }
          catch { instance.setLanguage('en'); }
          let stopBalance = () => {};
          try { stopBalance = observeBalance(ctx, { onSnapshot: snapshot => instance.update(snapshot) }); }
          catch { /* The widget keeps its last known level and reports the silence. */ }
          return () => { stopBalance(); stopLanguage(); instance.dispose(); };
        }, []);
        return h('div', { ref: element, 'data-token-bucket': 'mounted' });
      }
      // One failing bucket must never take the shell overlay down with it.
      class Boundary extends React.Component {
        constructor(props) { super(props); this.state = { failed: false }; }
        static getDerivedStateFromError() { return { failed: true }; }
        render() { return this.state.failed ? null : this.props.children; }
      }
      const Root = () => h(Boundary, null, h(Bucket));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'token-bucket', order: 91,
      }, Root));
    },
  };
}
