/**
 * The write half of the freshness block.
 *
 * Every read in `routes/api/` says how old its figures are and which job last failed,
 * and until now that was the end of the sentence: the reader could see that `sync`
 * errored two days ago and could do nothing but wait for the schedule. This route is
 * the answer to it, and it is deliberately the smallest possible one — it starts jobs
 * and reports which, and everything about progress is read back through the same
 * `freshness` block that raised the question.
 *
 * It sits outside `routes/api/` for the reason that directory's own header gives: one
 * rule, that a request there never reaches an upstream and every route is a GET, is
 * worth more as a property a test can check over a directory than as a convention
 * with two exceptions in it. This is the third file on the writing side, next to
 * `settings.ts` and `ai.ts`.
 *
 * Four fences, none of which is about the payload:
 *
 *  - **Authenticated, but not owner-only.** Every other write in this application
 *    changes judgement — a threshold, a prompt, which account is the truth — and a
 *    viewer must not touch those. A refresh changes no judgement at all: it recomputes
 *    what is already derivable and pulls what the upstreams already hold. And the
 *    person who notices the numbers look old is very often exactly the one who cannot
 *    change a threshold, which is the argument the status panel makes for showing
 *    itself to a viewer. `ai` is the exception and lives in `ai.ts`, owner-only,
 *    because that one spends money.
 *  - **CSRF, like every other non-GET.** By the global hook, not by anything here.
 *  - **Its own rate-limit bucket.** See `REFRESH_RATE_LIMIT`: the resource being
 *    protected is not this process but somebody else's Actual instance.
 *  - **Audit-logged with the actor**, one entry per job actually started. See
 *    `'jobs.refresh'`.
 *
 * `202`, never `200`: the work has been accepted and has certainly not been done. A
 * `200` with a list of job names would read as "these ran".
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { recordAudit } from '../../domain/audit.ts'
import {
  DEFAULT_REFRESH,
  REFRESHABLE,
  startRefresh,
  type Job,
  type Refreshable,
  type RefreshStarted,
} from '../../jobs/index.ts'
import { requireUser } from '../auth/guard.ts'
import { conflict, forbidden } from '../errors.ts'
import { refreshRateLimit } from '../rate-limit.ts'
import { parseBody } from '../validate.ts'
import { refreshAcceptedSchema, type RefreshAccepted } from './api/schemas.ts'

/**
 * The body, or its absence.
 *
 * `jobs` omitted means `DEFAULT_REFRESH` — the four the freshness block reports on —
 * which is what makes `POST /api/refresh` with nothing at all the useful default for
 * a person with a terminal. An unknown name is a 400 naming the field rather than a
 * silently shorter list of accepted jobs: a client that misspelt `portfolio` and got
 * `202` back would show a spinner over figures nothing was recomputing.
 *
 * `ai` *is* in the enum, and is then refused by name below with a message that says
 * where it lives. Leaving it out would answer "unknown job: ai", which is a lie about
 * a job that exists and is one click away — and the reader of that 400 would go
 * looking for a typo rather than for the other endpoint.
 */
const refreshRequest = z.strictObject({
  jobs: z.array(z.enum([...REFRESHABLE])).min(1).optional(),
})

/**
 * A busy pipeline, in the terms the caller can act on.
 *
 * `409` because the request was right and the moment was wrong — the same request a
 * minute later succeeds, which is exactly what that status means and what makes a
 * client retry rather than give up. The names are in the message because a refresh
 * button has one line to explain itself in, and "`sync` is running" is the difference
 * between waiting and filing a bug.
 */
export function busyError(busy: readonly string[]): Error {
  return conflict(`A job is already running (${busy.join(', ')}). Try again when it has finished.`)
}

/**
 * Whether this instance may run a job at all.
 *
 * `JOBS_ENABLED=false` is a supported state and means something specific: this process
 * schedules nothing, because something else does. A refresh here would be a second
 * process pulling the same Actual `dataDir` — the one thing the whole single-owner
 * design exists to prevent — so it is refused rather than quietly allowed on the
 * grounds that a person asked. `403` and not `409`: waiting will not change it.
 *
 * The UI never shows the control on such an instance; the freshness block already
 * says `jobsEnabled: false` and prints its own note. This is the fence behind that.
 *
 * The flag is an argument rather than a read of `config` here, for the reason
 * `jobsCheck` in `routes/api/status.ts` gives: configuration is frozen at import, so
 * a branch that reads it directly can only be tested by mocking the process.
 */
export function requireJobsEnabled(enabled: boolean): void {
  if (!enabled) {
    throw forbidden('Scheduled jobs are switched off on this instance, so nothing can be run here.')
  }
}

/**
 * One entry per job that was started, and the flag that says why.
 *
 * `requested: false` marks a job that was added because it reads what a named one
 * writes. Recorded per job rather than as one entry with a list, so the trail can be
 * read by `entityRef` — "when was `portfolio` last pulled by hand" is a question about
 * one job, and an entry holding four names does not answer it.
 */
export function auditRefresh(db: Db, actorId: string, started: RefreshStarted): void {
  for (const name of started.accepted) {
    recordAudit(db, {
      action: 'jobs.refresh',
      entity: 'jobs',
      entityRef: name,
      actorId,
      after: { requested: started.requested.includes(name) },
      at: started.startedAt,
    })
  }
}

export function registerRefreshRoutes(
  app: FastifyInstance,
  db: Db,
  registry: readonly Job[],
): void {
  app.post(
    '/api/refresh',
    { ...refreshRateLimit() },
    (request: FastifyRequest, reply: FastifyReply): RefreshAccepted => {
      const user = requireUser(request)
      requireJobsEnabled(config.JOBS_ENABLED)

      // `?? {}` because a POST with no body at all is the documented way to say "all
      // of them", and Fastify hands that to a handler as `undefined` — which a strict
      // object schema rejects as loudly as it rejects a misspelt field.
      const body = parseBody(refreshRequest, request.body ?? {})
      const asked: readonly Refreshable[] = body.jobs ?? DEFAULT_REFRESH

      if (asked.includes('ai')) {
        // Not "unknown job". It exists, it is one click away, and it is somewhere else
        // precisely because it is the only one that costs money — see `ai.ts`.
        throw forbidden('The AI pass is not part of a refresh. POST /api/ai/refresh runs it.')
      }

      const outcome = startRefresh(db, registry, asked)
      if ('busy' in outcome) throw busyError(outcome.busy)

      auditRefresh(db, user.id, outcome)

      reply.code(202)
      return refreshAcceptedSchema.parse({
        accepted: outcome.accepted,
        requested: outcome.requested,
        startedAt: outcome.startedAt.toISOString(),
      })
    },
  )
}
