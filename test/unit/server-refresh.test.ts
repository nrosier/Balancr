/**
 * The refresh endpoints — the only place a request starts work instead of reading it.
 *
 * Every other route in this application answers out of SQLite, and the freshness block
 * on each response says how old that is. These two are the other half of that sentence:
 * the reader who can see `sync` failed two days ago gets a way to act on it. So the
 * tests are about the fences and the honesty of the answer, not about the pulling:
 *
 *  - **A second refresh is refused, and the refusal names what is running.** `409`
 *    rather than a queued `202`, because a `202` that sits behind four jobs has told
 *    the caller something untrue.
 *  - **A misspelt job name is a 400.** Accepted-and-ignored would put a spinner over
 *    figures nothing is recomputing.
 *  - **The response names the dependency expansion.** Asking for `portfolio` runs
 *    `networth` and `signals` too, and `accepted` vs `requested` is what lets the page
 *    say so instead of leaving whoever clicked to know the graph.
 *  - **`ai` is refused here and lives next door.** It is the one job that spends money,
 *    so it is owner-only and in the AI bucket — and the refusal says where it went,
 *    because "unknown job" would send the reader looking for a typo.
 *  - **The trail records who.** Nothing a refresh writes is judgement, but it is the
 *    only act with an effect outside this application, and the `jobs` table holds one
 *    row per job that every run overwrites.
 *
 * The registry is injected, so nothing here dials Actual or Ghostfolio. That is what
 * `buildApp`'s `jobs` option is for: the real `sync` would either hang on a network
 * timeout or assert against whatever the developer happens to have running.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../../src/db/index.ts'
import { auditLog, users } from '../../src/db/schema.ts'
import { AI_OFF_REASONS } from '../../src/domain/ai/availability.ts'
import { auditValues, loadAuditTrail, type AuditRow } from '../../src/domain/audit.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { REFRESHABLE, jobsInFlight, type Job } from '../../src/jobs/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import type { ErrorBody } from '../../src/server/errors.ts'
import { requireAiAvailable } from '../../src/server/routes/ai.ts'
import { requireJobsEnabled } from '../../src/server/routes/refresh.ts'
import type { Freshness, RefreshAccepted } from '../../src/server/routes/api/schemas.ts'
import { apiFixture } from '../helpers/api-fixture.ts'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string
let viewer: string
let ran: string[]
let open: () => void

function signIn(db: Db, role: 'owner' | 'viewer'): string {
  const row = db
    .insert(users)
    .values({
      oidcSub: `sub-${crypto.randomUUID()}`,
      email: `${role}@example.test`,
      displayName: role,
      locale: 'en',
      role,
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('inserting the user returned no row')
  return createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined })
    .token
}

/**
 * Every registered job, faked, recording that it ran.
 *
 * `gate` is a promise the test resolves, which is how a pipeline is made busy without
 * a timer: the jobs sit in the queue until `open()` is called, which is the state a
 * real refresh spends most of its life in.
 */
function fakes(gate: Promise<void>): Job[] {
  return REFRESHABLE.map((name) => ({
    name,
    schedule: { kind: 'interval', minutes: 60 } as const,
    run: async () => {
      ran.push(name)
      await gate
    },
  }))
}

/**
 * A POST that satisfies CSRF unless the test asks for it not to.
 *
 * `anonymous` still sends the CSRF pair. The hooks run in registration order — CSRF
 * before authentication, so that an anonymous flood is throttled and refused before it
 * costs a session lookup — which means a request missing both answers 403, and the 401
 * this endpoint owes an unauthenticated caller would never be reached.
 */
const post = (
  url: string,
  body?: object,
  options: { token?: string; csrf?: boolean; anonymous?: boolean } = {},
) => {
  const csrf = newCsrfToken()
  return app.inject({
    method: 'POST',
    url,
    ...(body === undefined ? {} : { payload: body }),
    cookies: {
      ...(options.anonymous === true ? {} : { [SESSION_COOKIE]: options.token ?? owner }),
      ...(options.csrf === false ? {} : { [CSRF_COOKIE]: csrf }),
    },
    headers: options.csrf === false ? {} : { [CSRF_HEADER]: csrf },
  })
}

const refreshTrail = (): AuditRow[] => loadAuditTrail(ctx.db, { action: 'jobs.refresh' })

const after = (row: AuditRow | undefined): Record<string, unknown> | null =>
  row === undefined ? null : auditValues(row).after

/** Lets the queued jobs finish, so the next test starts with an unclaimed pipeline. */
async function drain(): Promise<void> {
  open()
  for (let tick = 0; tick < 200 && jobsInFlight().length > 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (jobsInFlight().length > 0) throw new Error(`still running: ${jobsInFlight().join(', ')}`)
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(async () => {
  ctx = apiFixture()
  ran = []
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  app = await buildApp({ db: ctx.db, web: null, jobs: fakes(gate) })
  owner = signIn(ctx.db, 'owner')
  viewer = signIn(ctx.db, 'viewer')
})

afterEach(async () => {
  await drain()
  await app.close()
  ctx.sqlite.close()
})

describe('POST /api/refresh', () => {
  it('accepts the four data jobs when nothing is named', async () => {
    // A POST with no body at all is the useful default for a person with a terminal,
    // and it must mean the same four the freshness block reports on.
    const res = await post('/api/refresh')

    expect(res.statusCode).toBe(202)
    const body = res.json<RefreshAccepted>()
    expect(body.accepted).toEqual(['sync', 'portfolio', 'networth', 'signals'])
    expect(body.requested).toEqual(['sync', 'portfolio', 'networth', 'signals'])
    expect(Date.parse(body.startedAt)).not.toBeNaN()
  })

  it('names the jobs it added for a selective refresh', async () => {
    // The issue's own requirement: either run the dependents or say what is now
    // inconsistent. This runs them, and the two lists are how the page says so.
    const res = await post('/api/refresh', { jobs: ['portfolio'] })

    expect(res.statusCode).toBe(202)
    expect(res.json<RefreshAccepted>()).toMatchObject({
      accepted: ['portfolio', 'networth', 'signals'],
      requested: ['portfolio'],
    })
  })

  it('answers while the work is still outstanding', async () => {
    const res = await post('/api/refresh', { jobs: ['probe'] })

    // The gate is still shut, so nothing has finished — and the request is already
    // answered. Awaiting `downloadBudget` against an Actual instance with no timeout
    // guarantee would tie a user-facing request to it, which is what the 202 avoids.
    expect(res.statusCode).toBe(202)
    expect(jobsInFlight()).toContain('probe')
  })

  it('refuses a second refresh while one is running, naming what is busy', async () => {
    await post('/api/refresh', { jobs: ['sync'] })
    const res = await post('/api/refresh', { jobs: ['portfolio'] })

    expect(res.statusCode).toBe(409)
    const error = res.json<ErrorBody>().error
    expect(error.code).toBe('conflict')
    // The names, not just the status: a refresh button has one line to explain itself
    // in, and "sync is running" is the difference between waiting and filing a bug.
    expect(error.message).toContain('sync')
  })

  it('refuses an unknown job rather than quietly dropping it', async () => {
    const res = await post('/api/refresh', { jobs: ['portfolio', 'portfolios'] })

    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.code).toBe('bad_request')
    expect(ran).toEqual([])
    // And nothing was started, so the pipeline is still free.
    expect(jobsInFlight()).toEqual([])
  })

  it('refuses an empty list, which asks for nothing', async () => {
    // Distinct from an absent body, which asks for everything. A client that sent `[]`
    // meaning "all" would otherwise get a 202 and no work.
    const res = await post('/api/refresh', { jobs: [] })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a field it does not know', async () => {
    const res = await post('/api/refresh', { job: 'sync' })
    expect(res.statusCode).toBe(400)
  })

  it('sends the AI pass to its own endpoint rather than running it', async () => {
    const res = await post('/api/refresh', { jobs: ['sync', 'ai'] })

    expect(res.statusCode).toBe(403)
    // The message names where it went. "Unknown job: ai" would be a lie about a job
    // that exists and is one click away.
    expect(res.json<ErrorBody>().error.message).toContain('/api/ai/refresh')
    expect(ran).toEqual([])
  })

  it('lets a viewer refresh, because noticing stale figures is not a privilege', async () => {
    // The one write-side route that is not owner-only, and deliberately: a refresh
    // changes no judgement, and the person who sees the numbers look old is often
    // exactly the one who cannot change a threshold.
    const res = await post('/api/refresh', { jobs: ['probe'] }, { token: viewer })
    expect(res.statusCode).toBe(202)
  })

  it('refuses without a session', async () => {
    const res = await post('/api/refresh', { jobs: ['probe'] }, { anonymous: true })
    expect(res.statusCode).toBe(401)
    expect(jobsInFlight()).toEqual([])
  })

  it('refuses without a CSRF token', async () => {
    const res = await post('/api/refresh', { jobs: ['probe'] }, { csrf: false })
    expect(res.statusCode).toBe(403)
    expect(res.json<ErrorBody>().error.message).toContain('CSRF')
  })

  it('records one audit entry per job, marking the ones it added itself', async () => {
    await post('/api/refresh', { jobs: ['networth'] })

    const entries = refreshTrail()
    expect(entries.map((entry) => entry.entityRef).sort()).toEqual(['networth', 'signals'])

    const byRef = new Map(entries.map((entry) => [entry.entityRef, entry]))
    // Per job rather than one entry holding a list, so "when was `networth` last pulled
    // by hand" is answerable by `entityRef`.
    expect(after(byRef.get('networth'))).toEqual({ requested: true })
    expect(after(byRef.get('signals'))).toEqual({ requested: false })
    expect(byRef.get('networth')?.actorId).not.toBeNull()
  })

  it('writes nothing to the trail when it refuses', async () => {
    await post('/api/refresh', { jobs: ['nope'] })
    expect(ctx.db.select().from(auditLog).all()).toEqual([])
  })

  it('leaves the freshness block able to describe what it started', async () => {
    const started = await post('/api/refresh', { jobs: ['sync'] })
    const startedAt = Date.parse(started.json<RefreshAccepted>().startedAt)

    await drain()
    const res = await app.inject({
      method: 'GET',
      url: '/api/overview',
      cookies: { [SESSION_COOKIE]: owner },
    })
    const freshness = res.json<{ freshness: Freshness }>().freshness
    const sync = freshness.jobs.find((job) => job.name === 'sync')

    // The client's stop condition: this job has run since I asked, and is not running
    // now. Both halves have to be readable off this payload or the button spins for ever.
    expect(sync?.status).toBe('ok')
    expect(Date.parse(sync?.lastRunAt ?? '')).toBeGreaterThanOrEqual(startedAt)
  })
})

describe('POST /api/ai/refresh', () => {
  it('starts the AI pass for an owner', async () => {
    const res = await post('/api/ai/refresh')

    expect(res.statusCode).toBe(202)
    expect(res.json<RefreshAccepted>()).toMatchObject({ accepted: ['ai'], requested: ['ai'] })
  })

  it('does not pull the data jobs in with it', async () => {
    // `ai` has no dependents by design. Adding them would make the expensive button
    // also the slow one, and the pass reads what is stored rather than what is fresh.
    const res = await post('/api/ai/refresh')
    expect(res.json<RefreshAccepted>().accepted).toEqual(['ai'])
  })

  it('refuses a viewer', async () => {
    // Reading the dashboard is reading. Spending the month's allowance is not.
    const res = await post('/api/ai/refresh', undefined, { token: viewer })
    expect(res.statusCode).toBe(403)
    expect(ran).toEqual([])
  })

  it('refuses without a CSRF token', async () => {
    const res = await post('/api/ai/refresh', undefined, { csrf: false })
    expect(res.statusCode).toBe(403)
  })

  it('shares the one-at-a-time claim with the ordinary refresh', async () => {
    // Two doors, one pipeline. A refresh that could run alongside the AI pass would
    // have it read facts that were being replaced underneath it.
    await post('/api/refresh', { jobs: ['sync'] })
    const res = await post('/api/ai/refresh')
    expect(res.statusCode).toBe(409)
  })

  it('records the run against the actor', async () => {
    await post('/api/ai/refresh')
    const entries = refreshTrail()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.entityRef).toBe('ai')
    expect(entries[0]?.actorId).not.toBeNull()
    expect(after(entries[0])).toEqual({ requested: true })
  })

  it('passes force through to the job context, and defaults it to false (#160)', async () => {
    // `startRefresh`'s options reach `runJob` reach the context `aiJob.run` sees — this
    // is the one place that chain is observable from outside the job itself.
    await app.close()
    const seen: (boolean | undefined)[] = []
    const jobs: Job[] = REFRESHABLE.map((name) => ({
      name,
      schedule: { kind: 'interval', minutes: 60 } as const,
      run: async (jobCtx) => {
        if (name === 'ai') seen.push(jobCtx.force)
        ran.push(name)
      },
    }))
    app = await buildApp({ db: ctx.db, web: null, jobs })

    await post('/api/ai/refresh', { force: true })
    await drain()
    await post('/api/ai/refresh')
    await drain()

    expect(seen).toEqual([true, false])
  })
})

describe('the guards that read configuration', () => {
  // Called directly rather than through a request: configuration is frozen at import,
  // so the switched-off branches have no other way to be reached. `jobsCheck` in
  // `routes/api/status.ts` takes its flag as an argument for the same reason.
  it('refuses a refresh on an instance that runs no jobs', () => {
    expect(() => requireJobsEnabled(false)).toThrow(
      expect.objectContaining({ statusCode: 403 }) as Error,
    )
    expect(() => requireJobsEnabled(true)).not.toThrow()
  })

  it('refuses the paid endpoints for each of the three ways the model can be off', () => {
    // Zero is not an exhausted allowance — that degrades to the cached answer one layer
    // down — it is a deployment that has switched the model off. Same for a missing key
    // and an explicit `AI_ENABLED=false`: all three are the operator's own settings, so
    // all three answer 409 rather than inviting a retry with 503.
    for (const reason of AI_OFF_REASONS) {
      expect(() => {
        requireAiAvailable({ enabled: false, reason })
      }).toThrow(expect.objectContaining({ statusCode: 409 }) as Error)
    }
    expect(() => {
      requireAiAvailable({ enabled: true, reason: null })
    }).not.toThrow()
  })

  it('names something different for each reason, so the message is worth reading', () => {
    // A guard that threw the same sentence three times would send whoever is holding
    // `curl` to the wrong variable two times out of three.
    const messages = AI_OFF_REASONS.map((reason) => {
      try {
        requireAiAvailable({ enabled: false, reason })
        return ''
      } catch (err) {
        return (err as Error).message
      }
    })
    expect(new Set(messages).size).toBe(AI_OFF_REASONS.length)
  })
})
