import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

/**
 * Build for the WordPress plugin.
 *
 * Differs from the standalone config in three ways:
 *   - Fixed, unhashed output names, so the plugin can enqueue them by path and cache-bust with
 *     its own version constant.
 *   - IIFE output with inlined dynamic imports: one <script> tag, no module graph for WordPress
 *     to worry about and no crossorigin/MIME surprises on shared hosts.
 *   - The CSS is split for shadow-root rendering: document-scoped at-rules are hoisted into a
 *     separate stylesheet, and `:root` becomes `:host`. See splitShadowStyles below.
 */
/**
 * Splits the compiled CSS into the two places it has to live once the app renders in a shadow root.
 *
 * A shadow root is a style boundary in both directions, but a few at-rules are document-scoped and
 * are simply ignored inside one:
 *   - `@font-face` / the Google Fonts `@import` — fonts resolve against the document,
 *   - `@property` — custom-property registrations are global; without them Tailwind v4 utilities
 *     that lean on registered initial values (notably `--tw-border-style: solid`) stop working and
 *     every border silently disappears.
 *
 * Those go to a document stylesheet the plugin enqueues normally. Everything else goes to a shadow
 * stylesheet, with `:root` rewritten to `:host` — inside a shadow tree `:root` matches nothing, so
 * the design tokens would otherwise never apply.
 */
function splitShadowStyles(): Plugin {
  return {
    name: 'sc-nfl-split-shadow-styles',
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        let handled = 0;
        for (const [key, file] of Object.entries(bundle)) {
          if (file.type !== 'asset' || !file.fileName.endsWith('.css')) continue;
          const css = typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString('utf8');

          const documentRules: string[] = [];
          let shadowCss = css;

          // Font imports must be reachable from the document.
          // Minified output has no space after the at-rule name: @import"https://...";
          shadowCss = shadowCss.replace(/@import\s*(?:url\()?\s*["'][^"')]+["']\s*\)?[^;]*;/g, (match) => {
            documentRules.push(match);
            return '';
          });

          // @property blocks have no nested braces, so a non-greedy match is exact here.
          shadowCss = shadowCss.replace(/@property\s+--[\w-]+\s*\{[^}]*\}/g, (match) => {
            documentRules.push(match);
            return '';
          });

          shadowCss = shadowCss.replace(/:root(?![\w-])/g, ':host');

          if (!/:host/.test(shadowCss)) {
            this.error('sc-nfl-split-shadow-styles: no :host rules after rewriting — tokens would not apply in the shadow root.');
          }
          if (!documentRules.some((rule) => rule.startsWith('@property'))) {
            this.error('sc-nfl-split-shadow-styles: no @property rules hoisted — border utilities would break in the shadow root.');
          }
          if (!documentRules.some((rule) => rule.startsWith('@import'))) {
            this.error('sc-nfl-split-shadow-styles: the font @import was not hoisted — @font-face is ignored inside a shadow root, so the app would render in a fallback font.');
          }
          if (/@import|@property/.test(shadowCss)) {
            this.error('sc-nfl-split-shadow-styles: document-scoped at-rules remain in the shadow stylesheet.');
          }

          file.source = shadowCss;
          this.emitFile({
            type: 'asset',
            fileName: 'sc-nfl-schedule.document.css',
            source: documentRules.join('\n') + '\n',
          });
          handled += 1;
          void key;
        }
        if (handled === 0) {
          this.error('sc-nfl-split-shadow-styles found no CSS asset to process.');
        }
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), splitShadowStyles()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(import.meta.dirname, '..', '..', 'attached_assets'),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/wordpress'),
    emptyOutDir: true,
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(import.meta.dirname, 'src/wordpress.tsx'),
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'sc-nfl-schedule.js',
        assetFileNames: (asset) =>
          asset.names?.[0]?.endsWith('.css') ? 'sc-nfl-schedule.css' : 'assets/[name][extname]',
      },
    },
  },
});
