/**
 * The ticker itself. Three things can go wrong here and none of them announce
 * themselves: a scheduler that never runs (an overview that stays empty), one
 * that keeps ticking after shutdown (a container that will not stop), and one
 * whose ticks pile up behind a slow pass. All three are cheap to pin down, and
 * none of them are visible in production until the data is already wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { jobs as jobsTable } from '../../src/db/schema.ts'
import { loadJobRows, type Job } from '../../src/jobs/runner.ts'
import { createScheduler } from '../../src/jobs/scheduler.ts'

const TICK_MS = 60_000

let ctx: ReturnType<typeof createTestDb>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

/** Lets the queued job promises settle without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0)

/** A job that counts how often it started, on the given interval. */
function counter(minutes: number): Job & { starts: number } {
  const job = {
    name: 'counted',
    schedule: { kind: 'interval' as const, minutes },
    starts: 0,
    async run() {
      job.starts += 1
    },
  }
  return job
}

describe('createScheduler', () => {
  it('runs a pass immediately rather than in a minute', async () => {
    // A fresh container should start filling the database now; an overview that
    // is empty for its first minute reads as a broken deployment.
    const job = counter(60)
    createScheduler(ctx.db, [job]).start()
    await settle()

    expect(job.starts).toBe(1)
  })

  it('reports whether it is running', () => {
    const scheduler = createScheduler(ctx.db, [counter(60)])
    expect(scheduler.running).toBe(false)

    scheduler.start()
    expect(scheduler.running).toBe(true)

    scheduler.stop()
    expect(scheduler.running).toBe(false)
  })

  it('ignores a second start instead of ticking twice as fast', async () => {
    const job = counter(5)
    const scheduler = createScheduler(ctx.db, [job])
    scheduler.start()
    scheduler.start()
    await settle()

    // One interval left behind by a duplicate `setInterval` would be
    // unreachable, so `stop` could never clear it.
    scheduler.stop()
    await vi.advanceTimersByTimeAsync(30 * TICK_MS)
    expect(job.starts).toBe(1)
  })

  it('ticks again once the job is due', async () => {
    const job = counter(5)
    createScheduler(ctx.db, [job]).start()
    await settle()

    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(job.starts).toBe(1) // ticked, not due

    await vi.advanceTimersByTimeAsync(4 * TICK_MS)
    expect(job.starts).toBe(2)
  })

  it('stops ticking when told to', async () => {
    const job = counter(5)
    const scheduler = createScheduler(ctx.db, [job])
    scheduler.start()
    await settle()
    scheduler.stop()

    await vi.advanceTimersByTimeAsync(60 * TICK_MS)
    expect(job.starts).toBe(1)
  })

  it('does not let ticks pile up behind a slow pass', async () => {
    // An Actual sync over a large budget can outlast a tick. Without the
    // re-entrancy guard, an hour of that leaves sixty passes queued and each one
    // re-reads the whole history.
    let release: () => void = () => {}
    let starts = 0
    const slow: Job = {
      name: 'slow',
      schedule: { kind: 'interval', minutes: 5 },
      async run() {
        starts += 1
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
    }

    createScheduler(ctx.db, [slow]).start()
    await settle()
    expect(starts).toBe(1)

    await vi.advanceTimersByTimeAsync(30 * TICK_MS)
    expect(starts).toBe(1)

    release()
    await settle()
    expect(starts).toBe(1)
  })

  it('clears rows left running by a restart', async () => {
    // A killed container leaves `status = running` behind for ever, which makes
    // the one field an operator actually reads the one nobody believes.
    ctx.db.insert(jobsTable).values({ name: 'sync', status: 'running' }).run()

    createScheduler(ctx.db, []).start()
    await settle()

    const row = loadJobRows(ctx.db).find((candidate) => candidate.name === 'sync')
    expect(row).toMatchObject({ status: 'error' })
    expect(row!.error).toMatch(/interrupted/)
  })

  it('survives a tick that throws outright', async () => {
    // `runDueJobs` swallows per-job failures, so reaching the scheduler's catch
    // means the tick itself broke. Dropping the ticker there would mean data that
    // is silently stale for ever.
    const job = counter(5)
    const scheduler = createScheduler(ctx.db, [job])
    scheduler.start()
    await settle()

    const broken = vi.spyOn(ctx.db, 'select').mockImplementation(() => {
      throw new Error('database is locked')
    })

    await vi.advanceTimersByTimeAsync(6 * TICK_MS)
    expect(job.starts).toBe(1) // the pass could not even read the schedule
    broken.mockRestore()

    // The lock cleared, and the job is overdue rather than lost.
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(job.starts).toBe(2)
    expect(scheduler.running).toBe(true)
  })
})
