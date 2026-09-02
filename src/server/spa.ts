/**
 * Serving the built single-page application.
 *
 * Three decisions worth stating, because each one has a wrong version that looks
 * fine until it isn't:
 *
 *  1. **The plugin is registered with `serve: false`.** `@fastify/static`'s own
 *     wildcard route is convenient and unusable here: it has no way to attach a
 *     `config` block, so every file it served would arrive at the authentication
 *     `preHandler` with no opt-out and be answered with a 401 — including the
 *     JavaScript that draws the sign-in screen. Registering it purely for the
 *     `reply.sendFile` decoration and writing the two routes by hand keeps
 *     deny-by-default intact and makes the exemptions visible where the route is.
 *  2. **The wildcard parameter is handed to `sendFile` untouched.** Not
 *     `join(ASSETS, name)` — `@fastify/send` refuses a path containing a `..`
 *     segment relative to its root (`UP_PATH_REGEXP`), and `join` would normalise
 *     that segment away *before* the guard ever saw it. Passing the raw parameter is
 *     what makes the traversal check work; "tidying" it up is what breaks it.
 *  3. **Unknown paths get `index.html`, but only when they look like a person
 *     typing an address.** A client-side router means `/budget` is a real URL that
 *     the server has no route for, so a deep link or a refresh has to be answered
 *     with the shell. That rule cannot be unconditional: `/api/spelling-mistake`
 *     must stay a JSON 404 or a fetch fails on `JSON.parse` instead of on the
 *     status, a monitoring check on a renamed endpoint would read as healthy, and a
 *     missing `/assets/*` file would arrive at the browser as HTML labelled
 *     JavaScript. So the fallback is limited to GET/HEAD requests that accept
 *     `text/html` and are not under a prefix this server owns.
 *
 * When there is no build on disk — `npm start` without `npm run build`, which is
 * every server test — none of this is registered and the root path answers a short
 * JSON explainer instead. That is the same courtesy the old `GET /` gave: a bare
 * `Route GET:/ not found` on a fresh deployment reads as a broken container.
 */
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { logger } from '../logger.ts'
import { APP_VERSION } from './version.ts'

const log = logger.child({ module: 'server.spa' })

/** The document Vite emits, and the only file served from the root of the bundle. */
const INDEX = 'index.html'

/** Vite's hashed output directory, relative to the bundle root. */
const ASSETS = 'assets'

/**
 * A year, in milliseconds, for the hashed files.
 *
 * Safe precisely because the names are content-hashed: a changed file is a changed
 * URL, so nothing has to expire. `immutable` additionally tells the browser not to
 * revalidate on a reload, which is the difference between a warm reload costing one
 * request and costing one per chunk.
 */
const ASSET_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Prefixes that must never be answered with the shell.
 *
 * `startsWith`, so `/healthz-old` is included too — that is the safe direction: it
 * gets a JSON 404 rather than a page.
 */
const SERVER_PREFIXES = ['/api/', '/auth/', `/${ASSETS}/`, '/bootstrap', '/healthz'] as const

/**
 * Where the built bundle is, or null if it was never built.
 *
 * Two candidates because this file runs from two places. Compiled, it is
 * `dist/server/spa.js` and the bundle is its sibling `dist/web/`; under `tsx` it is
 * `src/server/spa.ts` and the bundle is `dist/web/` at the repository root. Probing
 * for `index.html` rather than branching on `NODE_ENV` means the answer comes from
 * what is actually on disk.
 */
export function webRoot(): string | null {
  for (const candidate of ['../web/', '../../dist/web/']) {
    if (existsSync(new URL(`${candidate}${INDEX}`, import.meta.url))) {
      return fileURLToPath(new URL(candidate, import.meta.url))
    }
  }
  return null
}

/** True for a request that should be answered with the shell rather than a 404. */
function wantsShell(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const accept = request.headers.accept
  // A `fetch` with no `Accept` at all is a script, not a person; only an explicit
  // willingness to render HTML earns the shell.
  if (accept === undefined || !accept.includes('text/html')) return false
  const path = request.url.split('?')[0] ?? '/'
  return !SERVER_PREFIXES.some((prefix) => path.startsWith(prefix))
}

/**
 * Sends the shell, uncached.
 *
 * `no-store` because `index.html` is the one file whose name never changes while its
 * contents do: it names the hashed bundle, so a cached copy after a release points
 * at files that have been deleted, and the application fails to start with nothing
 * on screen to say why. It is roughly a kilobyte; the request is free.
 */
function sendShell(root: string): (request: FastifyRequest, reply: FastifyReply) => FastifyReply {
  return (_request, reply) =>
    reply
      .header('cache-control', 'no-store')
      // Without this, `@fastify/send` sets `public, max-age=0` and overwrites the
      // header above — it applies its own set wholesale after the handler runs.
      .sendFile(INDEX, root, { cacheControl: false })
}

/**
 * The not-found handler to install when a build exists: the shell for navigations,
 * and the ordinary JSON envelope for everything else.
 *
 * Composed rather than registered separately because Fastify allows exactly one
 * not-found handler per prefix and throws on the second.
 */
export function spaNotFoundHandler(
  root: string,
  fallback: (request: FastifyRequest, reply: FastifyReply) => void,
): (request: FastifyRequest, reply: FastifyReply) => void {
  const shell = sendShell(root)
  return (request, reply) => {
    if (wantsShell(request)) {
      shell(request, reply)
      return
    }
    fallback(request, reply)
  }
}

/**
 * Registers the bundle's routes, or the explainer when there is no bundle.
 *
 * Everything here is `auth: false`: the sign-in screen *is* the bundle, so requiring
 * a session to fetch it would leave a signed-out visitor with a blank page. It is the
 * one deliberate hole in deny-by-default, and it exposes exactly what a public
 * deployment's HTML and JavaScript already are — no data, no configuration beyond
 * what `/bootstrap` serves anyway.
 */
export async function registerSpa(app: FastifyInstance, root: string | null): Promise<void> {
  if (root === null) {
    log.warn('no web bundle found; serving the API only (run `npm run build`)')
    app.get('/', { config: { rateLimit: false, csrf: false, auth: false } }, () => ({
      name: 'balancr',
      version: APP_VERSION,
      ui: 'not built — run `npm run build`',
      health: '/healthz',
    }))
    return
  }

  // `serve: false` gives us `reply.sendFile` and nothing else; see the file header.
  // `fastify-plugin` wrapping means the decoration lands on this instance rather
  // than on a throwaway child context.
  await app.register(fastifyStatic, { root, serve: false })

  // Joining our own two constants, which is not the thing point 2 in the header
  // warns about — that is about the request parameter below, and it stays raw.
  const assetsDir = join(root, ASSETS)

  app.get<{ Params: { '*': string } }>(
    `/${ASSETS}/*`,
    {
      // Exempt from the rate limit because one cold page load is a dozen requests
      // through this route — fonts, chunks, the icon — and a 429 on a chunk is a
      // white screen. They are static files off local disk; there is nothing here
      // to protect that a per-minute counter would protect.
      config: { rateLimit: false, csrf: false, auth: false },
    },
    (request, reply) =>
      reply.sendFile(request.params['*'], assetsDir, {
        maxAge: ASSET_MAX_AGE_MS,
        immutable: true,
      }),
  )

  const shell = sendShell(root)
  app.get('/', { config: { csrf: false, auth: false } }, shell)

  log.debug({ root }, 'serving the web bundle')
}
