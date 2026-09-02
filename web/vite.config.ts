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
