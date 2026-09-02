/**
 * Liveness.
 *
 * `/healthz` touches no database and no upstream on purpose: it answers "is this
 * process able to serve?" and nothing else. A health check that queried Actual
 * would make the container restart because Ghostfolio was restarting, which turns
 * one degraded panel into a crash loop. Readiness — "is the data fresh?" — is a
 * separate question, and it belongs in the API next to the staleness indicator.
 *
 * It is exempt from the rate limit, from CSRF and from authentication: a container
 * health check runs on a fixed schedule from the Docker bridge, where a 429 reads as
 * a dead process, a `Set-Cookie` on every probe is pure noise, and a 401 would
 * restart a perfectly healthy container.
 *
 * `GET /` used to live here, answering "the UI is not built yet". It now belongs to
 * `server/spa.ts`, which serves the shell when there is a bundle and keeps a version
 * of that same explainer for when there is not — one owner for the root path.
 */
import type { FastifyInstance } from 'fastify'
import { APP_VERSION } from '../version.ts'

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', { config: { rateLimit: false, csrf: false, auth: false } }, () => ({
    status: 'ok',
    version: APP_VERSION,
  }))
}
