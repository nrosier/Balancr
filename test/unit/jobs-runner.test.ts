/**
 * The runner is the only thing keeping this app's data fresh, so its contract is
 * mostly about failure: a job must never throw at the ticker, a failed attempt
 * must still be written down, and `lastSuccessAt` must keep meaning "how stale
 * the data is" rather than "when we last tried".
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { asc, eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { jobRuns as jobRunsTable, jobs as jobsTable } from '../../src/db/schema.ts'
import {
  clearStaleRunning,
  deriveRunStatus,
  loadJobRows,
  pruneJobRuns,
  runDueJobs,
  runJob,
  type Job,
  type JobDetail,
  type JobStep,
} from '../../src/jobs/runner.ts'
import type { Schedule } from '../../src/jobs/schedule.ts'

let ctx: ReturnType<typeof createTestDb>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
})

const hourly: Schedule = { kind: 'interval', minutes: 60 }

function job(
  name: string,
  run: Job['run'],
  schedule: Schedule = hourly,
): Job {
  return { name, schedule, run }
}

const row = (name: string) => loadJobRows(ctx.db).find((r) => r.name === name)

const jobRuns = (name: string) =>
  ctx.db
    .select()
    .from(jobRunsTable)
    .where(eq(jobRunsTable.jobName, name))
    .orderBy(asc(jobRunsTable.startedAt))
    .all()

describe('runJob', () => {
  it('records a success, with what the job reported', async () => {
    const now = new Date('2026-01-15T10:00:00Z')
    const result = await runJob(
      ctx.db,
      job('sync', async () => ({ facts: 42 })),
      now,
    )

    expect(result).toMatchObject({ name: 'sync', status: 'ok', detail: { facts: 42 } })
    expect(row('sync')).toMatchObject({ status: 'ok', lastRunAt: now, error: null })
    expect(row('sync')!.lastSuccessAt).not.toBeNull()
    // Advisory, but it should point at the next interval rather than stay null.
    expect(row('sync')!.nextRunAt).not.toBeNull()
  })

  it('accepts a job that reports nothing', async () => {
    const result = await runJob(ctx.db, job('quiet', async () => {}))
    expect(result).toMatchObject({ status: 'ok', detail: {} })
  })

  it('passes the database and the tick instant to the job', async () => {
    // The job takes its `db` from the context rather than the module singleton,
    // which is the only reason a test like this one can exist.
    const now = new Date('2026-01-15T10:00:00Z')
    let seen: JobDetail = {}
    await runJob(
      ctx.db,
      job('probe', async (jobCtx) => {
        seen = { rows: loadJobRows(jobCtx.db).length, now: jobCtx.now.toISOString() }
      }),
      now,
    )
    expect(seen).toEqual({ rows: 1, now: '2026-01-15T10:00:00.000Z' })
  })

  it('defaults force to false, and passes it through when a caller sets it (#160)', async () => {
    let seenDefault: boolean | undefined
    await runJob(
      ctx.db,
      job('probe', async (jobCtx) => {
        seenDefault = jobCtx.force
      }),
    )
    expect(seenDefault).toBe(false)

    let seenForced: boolean | undefined
    await runJob(
      ctx.db,
      job('probe', async (jobCtx) => {
        seenForced = jobCtx.force
      }),
      new Date(),
      { force: true },
    )
    expect(seenForced).toBe(true)
  })

  it('returns a failure instead of throwing', async () => {
    // If this threw, one Ghostfolio timeout would take the ticker down and the
    // app would serve three-week-old figures without saying so.
    const result = await runJob(
      ctx.db,
      job('sync', async () => {
        throw new Error('Ghostfolio /api/v1/account returned HTTP 502')
      }),
    )

    expect(result.status).toBe('error')
    expect(result.error).toMatch(/HTTP 502/)
    expect(row('sync')).toMatchObject({ status: 'error' })
    expect(row('sync')!.error).toMatch(/HTTP 502/)
  })

  it('leaves lastSuccessAt alone when an attempt fails', async () => {
    await runJob(ctx.db, job('sync', async () => {}))
    const succeededAt = row('sync')!.lastSuccessAt

    await runJob(
      ctx.db,
      job('sync', async () => {
        throw new Error('nope')
      }),
    )

    expect(row('sync')!.lastSuccessAt).toEqual(succeededAt)
    expect(row('sync')!.status).toBe('error')
  })

  it('clears the previous error once the job succeeds again', async () => {
    await runJob(
      ctx.db,
      job('sync', async () => {
        throw new Error('nope')
      }),
    )
    await runJob(ctx.db, job('sync', async () => {}))

    expect(row('sync')).toMatchObject({ status: 'ok', error: null })
  })

  it('truncates a huge error message', async () => {
    // An Actual migration mismatch or a Zod report runs to kilobytes, and this
    // column is read by a status panel.
    await runJob(
      ctx.db,
      job('sync', async () => {
        throw new Error('x'.repeat(10_000))
      }),
    )
    expect(row('sync')!.error).toHaveLength(2_000)
  })

  it('handles a thrown non-Error', async () => {
    await runJob(
      ctx.db,
      job('sync', async () => {
        throw 'a bare string'
      }),
    )
    expect(row('sync')!.error).toBe('a bare string')
  })

  it('runs one job at a time', async () => {
    // Actual's API is a local sync engine with no documented concurrency
    // guarantees, so overlap is not a performance question.
    const order: string[] = []
    const slow = job('slow', async () => {
      order.push('slow:start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('slow:end')
    })
    const quick = job('quick', async () => {
      order.push('quick')
    })

    await Promise.all([runJob(ctx.db, slow), runJob(ctx.db, quick)])

    expect(order).toEqual(['slow:start', 'slow:end', 'quick'])
  })

  it('does not let a failed job poison the queue', async () => {
    const failing = job('failing', async () => {
      throw new Error('nope')
    })
    const [, second] = await Promise.all([
      runJob(ctx.db, failing),
      runJob(ctx.db, job('after', async () => ({ ran: true }))),
    ])

    expect(second).toMatchObject({ status: 'ok', detail: { ran: true } })
  })
})

describe('runDueJobs', () => {
  it('runs every job on the first pass', async () => {
    const runs = await runDueJobs(ctx.db, [
      job('a', async () => {}),
      job('b', async () => {}, { kind: 'daily', hour: 3 }),
    ])
    expect(runs.map((run) => run.name)).toEqual(['a', 'b'])
  })

  it('skips a job that is not due yet', async () => {
    const registry = [job('a', async () => {})]
    await runDueJobs(ctx.db, registry, new Date('2026-01-15T10:00:00Z'))

    const second = await runDueJobs(ctx.db, registry, new Date('2026-01-15T10:30:00Z'))

    expect(second).toEqual([])
  })

  it('runs a job again once its interval has passed', async () => {
    const registry = [job('a', async () => {})]
    await runDueJobs(ctx.db, registry, new Date('2026-01-15T10:00:00Z'))

    const second = await runDueJobs(ctx.db, registry, new Date('2026-01-15T11:00:00Z'))

    expect(second.map((run) => run.name)).toEqual(['a'])
  })

  it('keeps the registry order, so later jobs read what earlier ones wrote', async () => {
    const order: string[] = []
    await runDueJobs(ctx.db, [
      job('sync', async () => {
        order.push('sync')
      }),
      job('networth', async () => {
        order.push('networth')
      }),
    ])
    expect(order).toEqual(['sync', 'networth'])
  })

  it('runs the later jobs even when an earlier one fails', async () => {
    // Stale is better than absent, and the `jobs` row says which it is.
    const runs = await runDueJobs(ctx.db, [
      job('sync', async () => {
        throw new Error('Actual unreachable')
      }),
      job('networth', async () => {}),
    ])

    expect(runs.map((run) => [run.name, run.status])).toEqual([
      ['sync', 'error'],
      ['networth', 'ok'],
    ])
  })
})

describe('clearStaleRunning', () => {
  it('turns a row left running by a crash into an error', async () => {
    // Without this the status panel's most useful field is the one nobody
    // believes: a killed container leaves `running` behind for ever.
    ctx.db.insert(jobsTable).values({ name: 'sync', status: 'running' }).run()

    expect(clearStaleRunning(ctx.db)).toBe(1)
    expect(row('sync')).toMatchObject({ status: 'error' })
    expect(row('sync')!.error).toMatch(/interrupted/)
  })

  it('leaves finished rows alone', async () => {
    await runJob(ctx.db, job('sync', async () => {}))
    expect(clearStaleRunning(ctx.db)).toBe(0)
    expect(row('sync')!.status).toBe('ok')
  })

  it('also closes out a job_runs row left running by a crash', () => {
    ctx.db
      .insert(jobRunsTable)
      .values({ id: 'stuck', jobName: 'sync', status: 'running', startedAt: new Date() })
      .run()

    clearStaleRunning(ctx.db)

    expect(jobRuns('sync')).toMatchObject([{ status: 'error', finishedAt: expect.any(Date) }])
    expect(jobRuns('sync')[0]!.error).toMatch(/interrupted/)
  })
})

describe('ctx.step', () => {
  it('records each step, in order, with its own status and duration', async () => {
    await runJob(
      ctx.db,
      job('sync', async ({ step }) => {
        await step('connect', async () => {})
        await step('fetch', async () => 'data')
      }),
    )

    const steps = JSON.parse(jobRuns('sync')[0]!.stepsJson) as JobStep[]
    expect(steps.map((s) => [s.name, s.status])).toEqual([
      ['connect', 'ok'],
      ['fetch', 'ok'],
    ])
    expect(steps.every((s) => typeof s.durationMs === 'number')).toBe(true)
  })

  it('records a failing step and rethrows rather than swallowing it', async () => {
    const result = await runJob(
      ctx.db,
      job('sync', async ({ step }) => {
        await step('connect', async () => {
          throw new Error('Actual unreachable')
        })
        return {}
      }),
    )

    expect(result.status).toBe('error')
    const steps = JSON.parse(jobRuns('sync')[0]!.stepsJson) as JobStep[]
    expect(steps).toMatchObject([{ name: 'connect', status: 'error' }])
    expect(steps[0]!.error).toMatch(/Actual unreachable/)
  })

  it('a job that never calls step reports no steps, same as before this existed', async () => {
    await runJob(ctx.db, job('sync', async () => ({})))
    expect(jobRuns('sync')[0]!.stepsJson).toBe('[]')
  })
})

describe('deriveRunStatus', () => {
  it('mirrors the old behaviour when no steps were recorded', () => {
    expect(deriveRunStatus(true, [])).toBe('ok')
    expect(deriveRunStatus(false, [])).toBe('error')
  })

  it('is ok when every recorded step succeeded', () => {
    const steps: JobStep[] = [{ name: 'connect', status: 'ok', durationMs: 1, error: null }]
    expect(deriveRunStatus(true, steps)).toBe('ok')
  })

  it('is partial when the run resolved despite a failing step', () => {
    const steps: JobStep[] = [
      { name: 'connect', status: 'ok', durationMs: 1, error: null },
      { name: 'fetch', status: 'error', durationMs: 1, error: 'timeout' },
    ]
    expect(deriveRunStatus(true, steps)).toBe('partial')
  })

  it('is error when the run rejected, no matter how many steps had already succeeded', () => {
    const steps: JobStep[] = [
      { name: 'connect', status: 'ok', durationMs: 1, error: null },
      { name: 'fetch', status: 'ok', durationMs: 1, error: null },
    ]
    expect(deriveRunStatus(false, steps)).toBe('error')
  })
})

describe('job_runs', () => {
  it('writes a running row up front, then closes it out on success', async () => {
    await runJob(ctx.db, job('sync', async () => ({ facts: 1 })), new Date('2026-01-15T10:00:00Z'))

    expect(jobRuns('sync')).toMatchObject([
      { status: 'ok', startedAt: new Date('2026-01-15T10:00:00Z'), error: null },
    ])
    expect(jobRuns('sync')[0]!.finishedAt).not.toBeNull()
    expect(jobRuns('sync')[0]!.durationMs).not.toBeNull()
  })

  it('closes it out as error, with the message, on failure', async () => {
    await runJob(
      ctx.db,
      job('sync', async () => {
        throw new Error('Ghostfolio unreachable')
      }),
    )

    expect(jobRuns('sync')).toMatchObject([{ status: 'error' }])
    expect(jobRuns('sync')[0]!.error).toMatch(/Ghostfolio unreachable/)
  })

  it('keeps one row per attempt', async () => {
    await runJob(ctx.db, job('sync', async () => ({})))
    await runJob(ctx.db, job('sync', async () => ({})))
    expect(jobRuns('sync')).toHaveLength(2)
  })
})

describe('pruneJobRuns', () => {
  it('leaves the table alone while it has fewer rows than the keep count', () => {
    for (let i = 0; i < 3; i++) {
      ctx.db
        .insert(jobRunsTable)
        .values({ id: `r${i}`, jobName: 'sync', status: 'ok', startedAt: new Date(2026, 0, i + 1) })
        .run()
    }
    pruneJobRuns(ctx.db, 'sync', 5)
    expect(jobRuns('sync')).toHaveLength(3)
  })

  it('deletes the oldest rows beyond the keep count, for that job only', () => {
    for (let i = 0; i < 5; i++) {
      ctx.db
        .insert(jobRunsTable)
        .values({ id: `r${i}`, jobName: 'sync', status: 'ok', startedAt: new Date(2026, 0, i + 1) })
        .run()
    }
    ctx.db
      .insert(jobRunsTable)
      .values({ id: 'other', jobName: 'probe', status: 'ok', startedAt: new Date(2026, 0, 1) })
      .run()

    pruneJobRuns(ctx.db, 'sync', 2)

    expect(jobRuns('sync').map((r) => r.id)).toEqual(['r3', 'r4'])
    expect(jobRuns('probe')).toHaveLength(1)
  })
})
