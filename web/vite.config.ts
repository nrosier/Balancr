import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The browser build.
 *
 * Two settings here are load-bearing rather than preference, and both come from the
 * Content-Security-Policy in `src/server/security.ts`, which permits no external
 * origin and contains no `'unsafe-inline'`:
 *
 *  - `assetsInlineLimit: 0` — Vite inlines small assets as `data:` URIs by default,
 *    and `font-src 'self'` refuses a `data:` font. Every asset stays a real
 *    same-origin file.
 *  - `modulePreload.polyfill: false` — the polyfill is a script Vite injects for us;
 *    not injecting it is one less thing that has to be allowed.
 *
 * `root` is set explicitly because Vite resolves it from the working directory, not
 * from the config file, and this config is invoked from the repository root.
 *
 * Nothing here configures the code splitting (#435) — the split is expressed where it
 * belongs, as `import()` in `routes.ts` and `charts/Chart.tsx`, and Rolldown derives the
 * chunks from that. A `manualChunks` table would be a second, silent opinion about which
 * module goes where, and it goes stale the first time an import moves.
 */
const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Everything the SPA does not serve itself is the server's, in dev as in production. */
const API_PREFIXES = ['/api', '/auth', '/bootstrap', '/healthz']
const DEV_SERVER = 'http://127.0.0.1:3000'

export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    // Alongside the compiled server, so `dist/` is the whole deployable and the
    // Dockerfile copies one directory.
    outDir: '../dist/web',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    modulePreload: { polyfill: false },
    // Raised from 500 kB for exactly one chunk: ECharts, at around 640 kB even with
    // only the five series types this application draws registered (see
    // `charts/echarts.ts`). It is no longer in the entry and no longer on the critical
    // path — `charts/Chart.tsx` imports it dynamically — so the default warning's
    // advice ("consider dynamic import to code-split") is advice already taken, and
    // leaving it firing would train everyone to ignore the one warning that would
    // matter if a *page* chunk ever grew to this size. Every other chunk is under
    // 100 kB, so the new limit still has room to catch that.
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    strictPort: true,
    // `web/src/shared.ts` imports the formatters from `src/i18n/`, which is outside
    // this root; without this the dev server refuses to serve them.
    fs: { allow: [repoRoot] },
    proxy: Object.fromEntries(
      API_PREFIXES.map((prefix) => [prefix, { target: DEV_SERVER, changeOrigin: false }]),
    ),
  },
})
