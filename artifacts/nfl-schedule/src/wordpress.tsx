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

async function loadStyles(shadow: ShadowRoot, href: string) {
  // Fetched rather than inlined so the browser caches it separately from the JS, and injected
  // rather than <link>ed so we can await it — the static table is still on screen meanwhile, so
  // there is no flash of unstyled content either way.
  const style = document.createElement('style');
  try {
    const response = await fetch(href);
    if (!response.ok) throw new Error(`stylesheet ${response.status}`);
    style.textContent = await response.text();
  } catch (error) {
    // Without styles the app would render as unstyled markup on top of a perfectly good static
    // table. Leave the static table alone instead.
    console.error('[sc-nfl] could not load the schedule stylesheet', error);
    throw error;
  }
  shadow.appendChild(style);
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

  if (config.styleUrl) {
    try {
      await loadStyles(shadow, config.styleUrl);
    } catch {
      return; // static table stands
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
