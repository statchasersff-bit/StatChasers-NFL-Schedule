/**
 * Runtime configuration.
 *
 * The standalone build runs at the origin root and talks to the Express API. The WordPress
 * bundle is handed these values by `wp_localize_script`, so the same code can live under
 * /nfl/nfl-schedule/ and read from the plugin's REST route.
 */
export type ScheduleConfig = {
  /** Prepended to every relative API path. Empty string means same-origin as served. */
  apiBase: string;
  /** Page path the app owns. History updates stay inside it. Always starts and ends with "/". */
  basePath: string;
  season: number;
  /** CSS selector the app mounts into. */
  mount: string;
  /** Stylesheet injected into the shadow root. Empty in the standalone build, which uses <link>. */
  styleUrl: string;
};

const DEFAULTS: ScheduleConfig = {
  apiBase: '',
  // Standalone builds serve the app from the same path their assets are based at.
  basePath: import.meta.env.BASE_URL || '/',
  season: 2026,
  mount: '#root',
  styleUrl: '',
};

declare global {
  interface Window {
    SC_NFL_SCHEDULE?: Partial<ScheduleConfig>;
  }
}

function normalizeBasePath(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULTS.basePath;
  const withLeading = value.startsWith('/') ? value : `/${value}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/**
 * The router base, but only when the browser is actually inside it.
 *
 * wouter renders nothing at all when the current path falls outside its base, so a basePath that
 * disagrees with the real URL — a preview at /?page_id=123, a page moved without updating the
 * permalink — would blank the app rather than degrade. Falling back to no base keeps it rendering.
 */
export function routerBase(): string {
  const { basePath } = getConfig();
  const trimmed = basePath.replace(/\/$/, '');
  if (!trimmed) return '';
  if (typeof window === 'undefined') return trimmed;
  const path = window.location.pathname;
  return path === trimmed || path.startsWith(`${trimmed}/`) ? trimmed : '';
}

let resolved: ScheduleConfig | null = null;

export function getConfig(): ScheduleConfig {
  if (resolved) return resolved;
  const injected = typeof window === 'undefined' ? undefined : window.SC_NFL_SCHEDULE;
  const season = Number(injected?.season);
  resolved = {
    apiBase: typeof injected?.apiBase === 'string' ? injected.apiBase.replace(/\/+$/, '') : DEFAULTS.apiBase,
    basePath: normalizeBasePath(injected?.basePath),
    season: Number.isInteger(season) && season > 2000 ? season : DEFAULTS.season,
    mount: typeof injected?.mount === 'string' && injected.mount ? injected.mount : DEFAULTS.mount,
    styleUrl: typeof injected?.styleUrl === 'string' ? injected.styleUrl : DEFAULTS.styleUrl,
  };
  return resolved;
}
