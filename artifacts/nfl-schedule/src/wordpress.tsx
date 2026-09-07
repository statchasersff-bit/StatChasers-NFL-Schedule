/**
 * WordPress bundle entry.
 *
 * Two problems this solves that the standalone build never has to:
 *
 * 1. **The theme's CSS wins.** Tailwind emits everything inside `@layer`, and unlayered CSS beats
 *    layered CSS no matter the specificity. A theme rule as ordinary as `.entry-content a { color }`
 *    therefore overrides every utility in this bundle. Rather than fight that with specificity
 *    against a theme we cannot see, the app renders inside a **shadow root**: theme CSS cannot
 *    cross that boundary, and neither can ours.
 *
 * 2. **The static table must stay put until we are ready.** The plugin has already rendered every
 *    game as plain HTML. This is progressive enhancement, not hydration — we mount a separate tree
 *    and only reveal it (via the `sc-nfl-ready` class App sets once data arrives) when it can
 *    actually show the schedule. If this script fails at any point, the static table simply stays.
 */
import { createRoot } from 'react-dom/client';
import { setBaseUrl } from '@workspace/api-client-react';

import App from './App';
import { getConfig } from './config';
import { PortalContainerContext } from './portal-container';
import { ErrorBoundary } from '@/components/error-boundary';

// Kept in the module graph so the build emits it; the split plugin then divides it into the
// document stylesheet and the shadow stylesheet. Nothing is auto-injected into the page.
import './wordpress.css';

// Read while this script is executing, which is the only time `document.currentScript` is set.
const selfSrc = document.currentScript instanceof HTMLScriptElement ? document.currentScript.src : '';

/**
 * Where the stylesheet lives when the page has not told us.
 *
 * `styleUrl` normally arrives in the inline config the plugin prints before this bundle. Caching
 * and optimisation plugins move, defer, combine and sometimes drop inline scripts — often only for
 * their mobile cache — and a missing config used to mean the app rendered with no stylesheet at
 * all: theme fonts, no layout, both responsive nav labels showing at once. The bundle knows its
 * own URL and the stylesheet is its sibling, so derive it rather than depending on the page.
 */
function fallbackStyleUrl(): string {
  const src =
    selfSrc ||
    Array.from(document.scripts)
      .map((script) => script.src)
      .find((value) => /sc-nfl-schedule\.js(\?|$)/.test(value)) ||
    '';
  return src ? src.replace(/\.js(\?|$)/, '.css$1') : '';
}

async function loadStyles(shadow: ShadowRoot, href: string) {
  // Fetched rather than inlined so the browser caches it separately from the JS, and injected
  // rather than <link>ed so we can await it — the static table is still on screen meanwhile, so
  // there is no flash of unstyled content either way.
  const response = await fetch(href);
  if (!response.ok) throw new Error(`stylesheet ${response.status}`);
  const css = await response.text();

  // A 200 is not proof we got the stylesheet: an error page, a challenge page or a stripped asset
  // all arrive as text. Every build of this stylesheet has :host rules — the shadow-split step in
  // the Vite config fails the build otherwise — so their absence means this is not our CSS.
  if (!css.includes(':host')) throw new Error('stylesheet did not look like the app stylesheet');

  const style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);
}

/**
 * The same stylesheet, as a <link> inside the shadow root.
 *
 * A fetch can fail where a stylesheet request still succeeds — a service worker, a CORS or COEP
 * rule, an offline cache that only answers navigations. This costs a second request only when the
 * first route has already failed.
 */
function linkStyles(shadow: ShadowRoot, href: string) {
  return new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => reject(new Error('stylesheet link failed')), { once: true });
    shadow.appendChild(link);
  });
}

/**
 * Hand the page back to the static table.
 *
 * `sc-nfl-js` is what hides it and `sc-nfl-booted` is what stops the page's inline script from
 * restoring it, so both have to go. Without this a bail after the class was set left the visitor
 * with an empty space where the schedule should be.
 */
function restoreStaticTable() {
  document.documentElement.classList.remove('sc-nfl-booted', 'sc-nfl-js');
}

async function boot() {
  const config = getConfig();
  const host = document.querySelector<HTMLElement>(config.mount);
  if (!host) return;

  // Tells the page's inline boot script that the bundle arrived, so it stops counting down to
  // restoring the static table. Set before any await: from here on this code owns the display.
  document.documentElement.classList.add('sc-nfl-booted');

  if (config.apiBase) setBaseUrl(config.apiBase);

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

  // Styles first, and no app without them. An unstyled app is worse than the static table it would
  // replace, so every path out of here either has the stylesheet or gives the table back.
  const styleUrl = config.styleUrl || fallbackStyleUrl();
  if (!styleUrl) {
    console.error('[sc-nfl] no stylesheet URL — leaving the static table in place');
    restoreStaticTable();
    return;
  }
  try {
    await loadStyles(shadow, styleUrl);
  } catch (error) {
    console.warn('[sc-nfl] fetching the stylesheet failed, trying a <link>', error);
    try {
      await linkStyles(shadow, styleUrl);
    } catch (linkError) {
      console.error('[sc-nfl] could not load the schedule stylesheet', linkError);
      restoreStaticTable();
      return;
    }
  }

  const container = document.createElement('div');
  container.className = 'sc-nfl-app';
  shadow.appendChild(container);

  createRoot(container, {
    onCaughtError: (error, errorInfo) => {
      console.error(error, errorInfo.componentStack);
    },
  }).render(
    // Radix portals default to document.body, which is outside this shadow root and therefore
    // outside the stylesheet we just injected. Keep them inside.
    <PortalContainerContext.Provider value={container}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </PortalContainerContext.Provider>,
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
} else {
  void boot();
}
