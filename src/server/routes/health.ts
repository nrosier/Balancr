/**
 * Liveness, and the terse half of readiness.
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
 * `/readyz` is the second question — should traffic be routed here — and carries the
 * same three exemptions for the same three reasons. Two things about it are decisions
 * rather than details, and both are argued in `routes/api/status.ts`:
 *
 *  - **A broken upstream does not make it 503.** Readiness turns on Balancr's own
 *    database and nothing else. Ghostfolio being down is reported in the body and
 *    leaves the instance in rotation, because the budget pages are served from SQLite
 *    and are still right — withdrawing the container would replace a stale panel with
 *    a site that does not answer.
 *  - **It says less than the signed-in version.** Names and statuses, no messages: the
 *    text carries internal hostnames and upstream paths, and this endpoint answers
 *    anyone who can reach the port. `/api/status` is the same computation for someone
 *    with a session.
 *
 * It reads the database — one `select 1` and two small tables the jobs write — and no
 * upstream, so it stays a local question. That is what makes it safe to poll.
 *
 * `GET /` used to live here, answering "the UI is not built yet". It now belongs to
 * `server/spa.ts`, which serves the shell when there is a bundle and keeps a version
 * of that same explainer for when there is not — one owner for the root path.
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Db } from '../../db/index.ts'
import { buildStatus, terse } from './api/status.ts'
import { APP_VERSION } from '../version.ts'

export function registerHealthRoutes(app: FastifyInstance, db: Db): void {
  app.get('/healthz', { config: { rateLimit: false, csrf: false, auth: false } }, () => ({
    status: 'ok',
    version: APP_VERSION,
  }))

  app.get(
    '/readyz',
    { config: { rateLimit: false, csrf: false, auth: false } },
    (_request, reply: FastifyReply) => {
      const status = terse(buildStatus(db))
      // 503 only when this instance cannot serve. `degraded` is a 200: the orchestrator
      // is being told about an upstream, not asked to take the container away.
      return reply.code(status.ready ? 200 : 503).send(status)
    },
  )
}
