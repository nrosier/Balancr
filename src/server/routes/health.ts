/**
 * Liveness and the unbuilt root.
 *
 * `/healthz` touches no database and no upstream on purpose: it answers "is this
 * process able to serve?" and nothing else. A health check that queried Actual
 * would make the container restart because Ghostfolio was restarting, which turns
 * one degraded panel into a crash loop. Readiness — "is the data fresh?" — is a
 * separate question, and it belongs in the API next to the staleness indicator.
 *
 * Both routes are exempt from the rate limit, from CSRF and from authentication: a
 * container health check runs on a fixed schedule from the Docker bridge, where a
 * 429 reads as a dead process, a `Set-Cookie` on every probe is pure noise, and a
 * 401 would restart a perfectly healthy container.
 */
import type { FastifyInstance } from 'fastify'
import { APP_VERSION } from '../version.ts'

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', { config: { rateLimit: false, csrf: false, auth: false } }, () => ({
    status: 'ok',
    version: APP_VERSION,
  }))

  // The SPA takes this path in 0.6.0. Until then it says so, because a bare
  // Fastify `Route GET:/ not found` on the root of a fresh deployment reads as a
  // broken container rather than as an unfinished one.
  app.get('/', { config: { rateLimit: false, csrf: false, auth: false } }, () => ({
    name: 'balancr',
    version: APP_VERSION,
    ui: 'not built yet — the web interface arrives in 0.6.0',
    health: '/healthz',
  }))
}
