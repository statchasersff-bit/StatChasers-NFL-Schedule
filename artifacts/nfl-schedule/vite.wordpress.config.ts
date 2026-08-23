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
 *   - `:root` in the emitted CSS is rewritten to `.sc-nfl-app` so design tokens stay inside the
 *     widget instead of landing on the document root next to the theme's own variables.
 */
function scopeRootSelector(scope: string): Plugin {
  return {
    name: 'sc-nfl-scope-root-selector',
    // Tailwind emits its final CSS from generateBundle as well, so this has to run after it.
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        let rewritten = 0;
        for (const file of Object.values(bundle)) {
          if (file.type !== 'asset' || !file.fileName.endsWith('.css')) continue;
          const css = typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString('utf8');
          // `:root` only ever appears as a whole selector in the emitted CSS; the lookahead keeps
          // the rewrite off `:root-something` and off any `:root` inside a string or url().
          file.source = css.replace(/:root(?![\w-])/g, scope);
          rewritten += 1;
        }
        if (rewritten === 0) {
          this.error('sc-nfl-scope-root-selector found no CSS asset to scope — the bundle would leak :root tokens.');
        }
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), scopeRootSelector('.sc-nfl-app')],
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
