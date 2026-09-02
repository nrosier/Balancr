import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Two projects, because the two halves of this repository need different globals.
 *
 * The server tests need Node and must not have a `document`; the frontend tests need
 * a DOM and must not have `process.env` full of secrets. Running both under one
 * environment means either the server tests pass against a jsdom `fetch` that behaves
 * differently from Node's, or the component tests cannot render at all.
 *
 * `test.projects` rather than `test.workspace`: the latter was removed in Vitest 4.
 */
const web = fileURLToPath(new URL('web/', import.meta.url))

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['./test/setup.ts'],
        },
      },
      {
        // The React plugin, so `.tsx` transforms the same way it does in the real
        // build. Without it the JSX transform depends on which tsconfig esbuild
        // happens to find, which is the kind of difference that shows up as one
        // component rendering `undefined`.
        plugins: [react()],
        // Rooted at `web/` so relative imports and `import.meta.glob` resolve exactly
        // as they do under `vite build`.
        root: web,
        test: {
          name: 'web',
          include: ['test/**/*.test.tsx', 'test/**/*.test.ts'],
          environment: 'jsdom',
          setupFiles: ['./test/setup.ts'],
        },
      },
    ],
  },
})
