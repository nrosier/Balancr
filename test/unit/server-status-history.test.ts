/**
 * `GET /api/status/history` — one job's past attempts, over HTTP.
 *
 * `server-status.test.ts` covers `/api/status` itself; this file is the endpoint
 * `status-history.ts` describes as split out from it on purpose, and it has had no
 * test of its own until now (#326) — including no check that a real run's
 * `stepsJson`, written by `runner.ts`'s own `makeStep`, actually survives
 * `jobHistorySchema.parse` on the way back out.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { users } from '../../src/db/schema.ts'
import { jobRuns as jobRunsTable } from '../../src/db/schema.ts'
import type { Db } from '../../src/db/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { SESSION_COOKIE } from '../../src/server/cookies.ts'
import { MAX_HISTORY_LIMIT } from '../../src/server/routes/api/status-history.ts'
import type { JobHistory } from '../../src/server/routes/api/schemas.ts'
import { apiFixture } from '../helpers/api-fixture.ts'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let session: string

function signIn(db: Db): string {
  const row = db
    .insert(users)
    .values({
      oidcSub: `sub-${crypto.randomUUID()}`,
      email: 'nick@example.test',
      displayName: 'Nick',
      locale: 'en',
      role: 'owner',
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('inserting the user returned no row')
  return createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined })
    .token
}

async function open(): Promise<void> {
  ctx = apiFixture()
  app = await buildApp({ db: ctx.db, web: null })
  session = signIn(ctx.db)
}

const history = (qs: string) =>
  app.inject({
    method: 'GET',
    url: `/api/status/history${qs}`,
    cookies: { [SESSION_COOKIE]: session },
  })

/** A `job_runs` row as `runJob` writes one, inserted directly so the test controls
 * the exact steps stored rather than depending on a job's own logic. */
function insertRun(
  db: Db,
  over: {
    jobName?: string
    status?: 'running' | 'ok' | 'error' | 'partial'
    startedAt: Date
    finishedAt?: Date | null
    durationMs?: number | null
    error?: string | null
    steps?: unknown[]
  },
): void {
  db.insert(jobRunsTable)
    .values({
      id: crypto.randomUUID(),
      jobName: over.jobName ?? 'sync',
      status: over.status ?? 'ok',
      startedAt: over.startedAt,
      finishedAt: over.finishedAt ?? over.startedAt,
      durationMs: over.durationMs ?? 100,
      error: over.error ?? null,
      stepsJson: JSON.stringify(over.steps ?? []),
    })
    .run()
}

beforeEach(async () => {
  await open()
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

describe('/api/status/history', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status/history?job=sync' })
    expect(res.statusCode).toBe(401)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unauthenticated')
  })

  it('refuses a job the registry does not know, same as "run now" would', async () => {
    const res = await history('?job=gremlins')
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('bad_request')
  })

  it('refuses a missing job name rather than guessing one', async () => {
    const res = await history('')
    expect(res.statusCode).toBe(400)
  })

  it('answers an empty shape for a job that has never run', async () => {
    const res = await history('?job=sync')
    expect(res.statusCode).toBe(200)
    expect(res.json<JobHistory>()).toEqual({ jobName: 'sync', runs: [] })
  })

  it('orders most-recent first and caps at the requested limit', async () => {
    insertRun(ctx.db, { startedAt: new Date('2026-08-01T00:00:00Z') })
    insertRun(ctx.db, { startedAt: new Date('2026-08-03T00:00:00Z') })
    insertRun(ctx.db, { startedAt: new Date('2026-08-02T00:00:00Z') })
    // A different job's rows must never leak into `sync`'s answer.
    insertRun(ctx.db, { jobName: 'backup', startedAt: new Date('2026-08-04T00:00:00Z') })

    const body = (await history('?job=sync&limit=2')).json<JobHistory>()
    expect(body.runs.map((run) => run.startedAt)).toEqual([
      '2026-08-03T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
    ])
  })

  it('refuses a limit outside 1..MAX_HISTORY_LIMIT rather than clamping it silently', async () => {
    expect((await history('?job=sync&limit=0')).statusCode).toBe(400)
    expect((await history(`?job=sync&limit=${MAX_HISTORY_LIMIT + 1}`)).statusCode).toBe(400)
  })

  it('round-trips a real run’s steps — including an ok step, which carries no error key', async () => {
    // The exact shape `runner.ts`'s `makeStep` writes for a step that succeeded: no
    // `error` property at all, not `error: null`. `jobHistorySchema` has to accept
    // that shape, because it is the only shape an all-ok run's `stepsJson` ever has.
    insertRun(ctx.db, {
      startedAt: new Date('2026-08-05T00:00:00Z'),
      finishedAt: new Date('2026-08-05T00:00:05Z'),
      durationMs: 5_000,
      steps: [
        { name: 'connect', status: 'ok', durationMs: 100 },
        { name: 'fetch', status: 'ok', durationMs: 900 },
      ],
    })

    const res = await history('?job=sync')
    expect(res.statusCode).toBe(200)
    const body = res.json<JobHistory>()
    expect(body.runs[0]?.steps.map((step) => step.name)).toEqual(['connect', 'fetch'])
  })

  it('quotes a step’s own error rather than the run’s', async () => {
    insertRun(ctx.db, {
      startedAt: new Date('2026-08-06T00:00:00Z'),
      status: 'partial',
      steps: [
        { name: 'connect', status: 'ok', durationMs: 50 },
        { name: 'fetch', status: 'error', durationMs: 200, error: 'ECONNREFUSED actual:5006' },
      ],
    })

    const body = (await history('?job=sync')).json<JobHistory>()
    expect(body.runs[0]?.status).toBe('partial')
    expect(body.runs[0]?.steps[1]?.error).toBe('ECONNREFUSED actual:5006')
    expect(body.runs[0]?.steps[0]?.error).toBeNull()
  })
})
