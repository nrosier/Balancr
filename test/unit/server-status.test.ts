/**
 * Readiness, on both sides of the session boundary.
 *
 * There are two endpoints answering one question, and the split is the thing to test:
 *
 *  - **`/readyz` is for the orchestrator.** No session, names and verdicts only, and a
 *    status code Docker and Traefik act on.
 *  - **`/api/status` is for the person.** Session required, and it quotes what upstreams
 *    actually said — which is exactly why it needs one. A probe error reads
 *    `connect ECONNREFUSED 172.19.0.4:3333`, and a sync failure carries the Actual
 *    host and port. Those are a map of a private network, handed to whoever curls a
 *    URL. `terse()` builds the unauthenticated payload by projection rather than by
 *    deleting fields, so the assertions below are about a rule, not a habit.
 *
 * And one decision worth a test of its own: **an upstream that broke does not make this
 * container unready.** Every budget page is served from Balancr's own SQLite and is
 * still correct; withdrawing the container would replace a stale portfolio panel with a
 * site that does not answer at all. Only a database that cannot be read flips readiness,
 * because at that point there is nothing left to serve.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { users } from '../../src/db/schema.ts'
import type { Db } from '../../src/db/index.ts'
import { saveProbe } from '../../src/jobs/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { SESSION_COOKIE } from '../../src/server/cookies.ts'
import { ghostfolioCheck, jobsCheck } from '../../src/server/routes/api/status.ts'
import type { Status } from '../../src/server/routes/api/schemas.ts'
import type { JobRow } from '../../src/jobs/index.ts'
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

async function open(options: Parameters<typeof apiFixture>[0] = {}): Promise<void> {
  ctx = apiFixture(options)
  app = await buildApp({ db: ctx.db, web: null })
  session = signIn(ctx.db)
}

const readyz = () => app.inject({ method: 'GET', url: '/readyz' })

const status = () =>
  app.inject({ method: 'GET', url: '/api/status', cookies: { [SESSION_COOKIE]: session } })

/** One check out of the four, by name. */
const check = (body: Status, name: string): Status['checks'][number] => {
  const found = body.checks.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`no ${name} check in the response`)
  return found
}

beforeEach(async () => {
  await open()
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

describe('/readyz', () => {
  it('answers without a session, because a container probe has none', async () => {
    const res = await readyz()
    expect(res.statusCode).toBe(200)
    expect(res.json<{ ready: boolean }>().ready).toBe(true)
  })

  it('sets no cookie, like the liveness probe', async () => {
    expect((await readyz()).headers['set-cookie']).toBeUndefined()
  })

  it('names the checks and their verdicts, and nothing else about them', async () => {
    const body = (await readyz()).json<Record<string, unknown>>()

    expect(Object.keys(body).sort()).toEqual(['at', 'checks', 'degraded', 'ready', 'version'])
    const checks = body['checks'] as Record<string, unknown>[]
    expect(checks.map((entry) => entry['name'])).toEqual([
      'database',
      'actual',
      'ghostfolio',
      'jobs',
    ])
    // Not `reason`: `shapeMismatch` names a Ghostfolio contract to anyone who asks.
    for (const entry of checks) expect(Object.keys(entry).sort()).toEqual(['name', 'status'])
  })

  it('says nothing a signed-in reader would be told', async () => {
    await app.close()
    ctx.sqlite.close()
    await open({ jobsFailed: true })
    saveProbe(
      ctx.db,
      'ghostfolio',
      'unreachable',
      {
        checks: [
          {
            path: '/api/v1/health',
            status: 'unreachable',
            detail: 'failed',
            error: 'connect ECONNREFUSED 172.19.0.4:3333',
          },
        ],
        warnings: [],
      },
      new Date(),
    )

    const terse = await readyz()
    const detailed = await status()

    // Still 200: see the header. A broken upstream is degraded, not unready.
    expect(terse.statusCode).toBe(200)
    expect(terse.json<{ degraded: boolean }>().degraded).toBe(true)

    expect(terse.payload).not.toContain('172.19.0.4')
    expect(terse.payload).not.toContain('actual:5006')
    expect(terse.payload).not.toContain('/api/v1/health')
    // The same two facts are in the signed-in answer, so the assertions above are
    // about who may read them rather than about whether they are recorded at all.
    expect(detailed.payload).toContain('172.19.0.4')
    expect(detailed.payload).toContain('actual:5006')
  })

  it('turns 503 only when the database cannot be read', async () => {
    // The volume that did not mount, in the only form a test can produce it. Every
    // other failure on this page leaves something correct to serve; this one does not.
    ctx.sqlite.close()

    const res = await readyz()
    expect(res.statusCode).toBe(503)
    const body = res.json<{ ready: boolean; checks: { name: string; status: string }[] }>()
    expect(body.ready).toBe(false)
    expect(body.checks.map((entry) => entry.status)).toEqual([
      'failed',
      'unknown',
      'unknown',
      'unknown',
    ])
  })
})

describe('/api/status', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' })
    expect(res.statusCode).toBe(401)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('unauthenticated')
  })

  it('reports a healthy instance as ready and not degraded', async () => {
    saveProbe(ctx.db, 'ghostfolio', 'ok', { checks: [], warnings: [] }, new Date())

    const body = (await status()).json<Status>()
    expect(body.ready).toBe(true)
    expect(body.degraded).toBe(false)
    expect(body.checks.map((entry) => entry.status)).toEqual(['ok', 'ok', 'ok', 'ok'])
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('calls a fresh deployment unknown rather than healthy', async () => {
    // The failure this prevents is the worst answer this endpoint could give: claiming
    // an upstream is fine because no probe has ever contradicted it.
    await app.close()
    ctx.sqlite.close()
    await open({ empty: true })

    const body = (await status()).json<Status>()
    expect(body.ready).toBe(true)
    expect(check(body, 'ghostfolio')).toEqual({
      name: 'ghostfolio',
      status: 'unknown',
      reason: 'neverRun',
    })
    expect(check(body, 'actual').reason).toBe('neverRun')
    expect(check(body, 'jobs').reason).toBe('neverRun')
    expect(body.probes).toEqual([])
  })

  it('carries each job’s two timestamps and its schedule', async () => {
    const body = (await status()).json<Status>()
    const sync = body.jobs.find((job) => job.name === 'sync')

    expect(sync?.lastRunAt).not.toBeNull()
    expect(sync?.lastSuccessAt).not.toBeNull()
    // From the registry rather than the row, so a job that has never run still says
    // when it will.
    expect(sync?.schedule).toMatch(/\d/)
  })

  it('separates a failing job from a stale one', async () => {
    await app.close()
    ctx.sqlite.close()
    await open({ jobsFailed: true })

    const body = (await status()).json<Status>()
    const sync = body.jobs.find((job) => job.name === 'sync')
    expect(sync?.status).toBe('error')
    expect(sync?.lastRunAt).not.toBeNull()
    // The point of two columns: it ran, it did not succeed.
    expect(sync?.lastSuccessAt).toBeNull()
    expect(sync?.error).toContain('ECONNREFUSED')

    expect(check(body, 'actual')).toEqual({ name: 'actual', status: 'failed', reason: 'jobFailed' })
    expect(body.degraded).toBe(true)
    expect(body.ready).toBe(true)
  })

  it('passes the probe’s per-path detail through', async () => {
    saveProbe(
      ctx.db,
      'ghostfolio',
      'shape-mismatch',
      {
        checks: [
          { path: '/api/v1/health', status: 'ok', detail: 'reachable' },
          {
            path: '/api/v1/portfolio/holdings',
            status: 'shape-mismatch',
            detail: 'unparseable',
            error: 'holdings.0.valueInBaseCurrency: expected number',
          },
        ],
        warnings: ['no currency on 2 holdings'],
      },
      new Date('2026-09-03T02:00:00.000Z'),
    )

    const body = (await status()).json<Status>()
    const probe = body.probes[0]
    expect(probe?.source).toBe('ghostfolio')
    expect(probe?.detailAvailable).toBe(true)
    expect(probe?.checkedAt).toBe('2026-09-03T02:00:00.000Z')
    expect(probe?.checks.find((entry) => entry.status !== 'ok')?.path).toBe(
      '/api/v1/portfolio/holdings',
    )
    expect(probe?.warnings).toEqual(['no currency on 2 holdings'])

    // A contract change, not an outage: failed, so it does not read as something that
    // will pass on its own.
    expect(check(body, 'ghostfolio')).toEqual({
      name: 'ghostfolio',
      status: 'failed',
      reason: 'shapeMismatch',
    })
  })

  it('keeps the verdict when the stored report cannot be read', async () => {
    saveProbe(ctx.db, 'ghostfolio', 'unreachable', { checks: [], warnings: [] }, new Date())
    ctx.db.$client.prepare(`update upstream_probes set report_json = '{"nope":1}'`).run()

    const body = (await status()).json<Status>()
    expect(body.probes[0]?.detailAvailable).toBe(false)
    expect(body.probes[0]?.status).toBe('unreachable')
    // Degraded, because unreachable resolves itself and the pages are still right.
    expect(check(body, 'ghostfolio').status).toBe('degraded')
  })
})

describe('the two verdicts that depend on more than a row', () => {
  const row = (over: Partial<JobRow> = {}): JobRow => ({
    name: 'sync',
    status: 'ok',
    lastRunAt: new Date(),
    lastSuccessAt: new Date(),
    nextRunAt: null,
    lastDurationMs: 120,
    error: null,
    ...over,
  })

  it('reports jobs switched off as a state, never as a failure', () => {
    // `JOBS_ENABLED=false` is supported — a second instance, or a copy of the database
    // being read. It is why everything else looks old, and saying "failed" would send
    // someone looking for a fault that is a setting.
    expect(jobsCheck([row()], false)).toEqual({ status: 'unknown', reason: 'jobsOff' })
    expect(jobsCheck([], true)).toEqual({ status: 'unknown', reason: 'neverRun' })
    expect(jobsCheck([row(), row({ name: 'ai', status: 'error' })], true)).toEqual({
      status: 'degraded',
      reason: 'jobFailed',
    })
    expect(jobsCheck([row()], true)).toEqual({ status: 'ok', reason: null })
  })

  it('separates a Ghostfolio that is down from one that changed', () => {
    const at = new Date()
    const probe = (status: 'ok' | 'unreachable' | 'shape-mismatch') => ({
      source: 'ghostfolio' as const,
      status,
      checkedAt: at,
      report: null,
    })

    expect(ghostfolioCheck(undefined)).toEqual({ status: 'unknown', reason: 'neverRun' })
    expect(ghostfolioCheck(probe('ok'))).toEqual({ status: 'ok', reason: null })
    expect(ghostfolioCheck(probe('unreachable'))).toEqual({
      status: 'degraded',
      reason: 'unreachable',
    })
    expect(ghostfolioCheck(probe('shape-mismatch'))).toEqual({
      status: 'failed',
      reason: 'shapeMismatch',
    })
  })
})
