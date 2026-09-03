/**
 * Running one job, and writing down what happened.
 *
 * Three rules, each with a failure it exists to prevent:
 *
 *  - **Everything is serialised through one queue.** Actual's API is a local sync
 *    engine over a SQLite cache with no documented concurrency guarantees, and
 *    the nightly pass and an operator pressing "Sync now" will overlap
 *    eventually. One queue for all jobs, not one per job.
 *  - **A job never throws at its caller.** The ticker is the only thing keeping
 *    this app's data fresh; an unhandled rejection from a Ghostfolio timeout
 *    would take it down and nothing would notice until someone opened a page and
 *    read a three-week-old figure.
 *  - **The `jobs` row is written even on failure**, with the message. "Last
 *    success 4 days ago" is the signal that matters, and it only exists if
 *    failures are recorded as attempts rather than silence.
 */
import { eq } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { jobs as jobsTable } from '../db/schema.ts'
import { config } from '../config.ts'
import { logger } from '../logger.ts'
import type { Logger } from '../logger.ts'
import { createSerialiser } from '../util/serialise.ts'
import { describeSchedule, isDue, nextRunAt, type Schedule } from './schedule.ts'

const log = logger.child({ module: 'jobs' })

/** Shared by every job in the process. See the header. */
const queue = createSerialiser()

/**
 * The jobs this process has started and not yet finished — queued ones included.
 *
 * The `jobs` table cannot answer this question. A row says `running`, but a row can
 * say `running` because the process was killed mid-job, and it says nothing at all
 * about a job that is third in the queue and has therefore not written a row yet.
 * The first case makes a database check refuse a refresh for ever; the second makes
 * it accept one that will sit behind three others.
 *
 * So the authority on "is the pipeline busy" is this set, which is only ever true of
 * the process asking. It is mutated **synchronously** in `runJob`, before the queue
 * is touched, because the check and the claim have to be one step: two requests
 * arriving in the same tick would both read an empty set otherwise, and the second
 * would be accepted into a queue it was supposed to be refused from.
 */
const inFlight = new Set<string>()

/** The jobs running or queued in this process, in the order they were claimed. */
export function jobsInFlight(): readonly string[] {
  return [...inFlight]
}

export interface JobContext {
  /**
   * Passed in rather than imported from `db/index.ts` so a test can run a real
   * job against `createTestDb()` without the module-level singleton — which
   * opens the configured file the moment it is imported.
   */
  readonly db: Db
  /** The tick's instant, passed in so a run is reproducible and testable. */
  readonly now: Date
  readonly log: Logger
}

/** Counts and dates worth logging. Never a payee, never an amount. */
export type JobDetail = Record<string, string | number | boolean | null>

export interface Job {
  readonly name: string
  readonly schedule: Schedule
  run(ctx: JobContext): Promise<JobDetail | void>
}

export interface JobRun {
  name: string
  status: 'ok' | 'error'
  durationMs: number
  detail: JobDetail
  error?: string
}

export type JobRow = typeof jobsTable.$inferSelect

function upsert(db: Db, name: string, set: Partial<JobRow>): void {
  db.insert(jobsTable)
    .values({ name, ...set })
    .onConflictDoUpdate({ target: jobsTable.name, set })
    .run()
}

/**
 * Runs `job` now, whatever its schedule says, and records the attempt.
 *
 * Used by the ticker once a schedule is due, and directly by the "run now"
 * action — which is why it does not consult `isDue` itself.
 */
export function runJob(db: Db, job: Job, now = new Date()): Promise<JobRun> {
  // Before the queue, and synchronously. See `inFlight`.
  inFlight.add(job.name)

  return queue(async () => {
    const jobLog = log.child({ job: job.name })
    const started = Date.now()

    upsert(db, job.name, { status: 'running', lastRunAt: now, error: null })
    jobLog.debug({ schedule: describeSchedule(job.schedule) }, 'job started')

    try {
      const detail = (await job.run({ db, now, log: jobLog })) ?? {}
      const durationMs = Date.now() - started
      const finished = new Date()
      upsert(db, job.name, {
        status: 'ok',
        lastRunAt: now,
        lastSuccessAt: finished,
        nextRunAt: nextRunAt(job.schedule, finished, finished, config.TZ),
        lastDurationMs: durationMs,
        error: null,
      })
      jobLog.info({ durationMs, ...detail }, 'job finished')
      return { name: job.name, status: 'ok', durationMs, detail }
    } catch (error) {
      const durationMs = Date.now() - started
      // Truncated: an Actual migration mismatch or a Zod report can run to
      // kilobytes, and this column is read by a status panel.
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
      const finished = new Date()
      upsert(db, job.name, {
        status: 'error',
        lastRunAt: now,
        // `lastSuccessAt` deliberately untouched: how stale the data is matters
        // more than when we last tried.
        nextRunAt: nextRunAt(job.schedule, finished, finished, config.TZ),
        lastDurationMs: durationMs,
        error: message,
      })
      jobLog.error({ err: error, durationMs }, 'job failed')
      return { name: job.name, status: 'error', durationMs, detail: {}, error: message }
    } finally {
      // In a `finally` rather than at the end of each branch: both of them return, and
      // a claim released in one but not the other would refuse every later refresh for
      // the lifetime of the process.
      inFlight.delete(job.name)
    }
  })
}

/**
 * Runs the jobs whose schedule is due, in registry order.
 *
 * Order matters and is the registry's, not a dependency graph's: aggregation
 * reads what the sync wrote, and net worth reads the account map the sync
 * created. Since everything shares one queue, sequencing is automatic — but a
 * failed sync still lets the later jobs run, so they work from the previous
 * pass's data rather than being cancelled. Stale is better than absent, and the
 * `jobs` row says which it is.
 */
export async function runDueJobs(
  db: Db,
  registry: readonly Job[],
  now = new Date(),
): Promise<JobRun[]> {
  const state = new Map(loadJobRows(db).map((row) => [row.name, row]))
  const runs: JobRun[] = []

  for (const job of registry) {
    const lastRunAt = state.get(job.name)?.lastRunAt ?? null
    if (!isDue(job.schedule, now, lastRunAt, config.TZ)) continue
    runs.push(await runJob(db, job, now))
  }

  return runs
}

export function loadJobRows(db: Db): JobRow[] {
  return db.select().from(jobsTable).orderBy(jobsTable.name).all()
}

/**
 * Clears a `running` status left behind by a crash or a `docker kill`.
 *
 * Called once at startup. Without it a job interrupted mid-run shows as running
 * for ever, and the status panel's most useful field becomes the one nobody
 * believes.
 */
export function clearStaleRunning(db: Db): number {
  return db
    .update(jobsTable)
    .set({
      status: 'error',
      error: 'interrupted — the process stopped while this job was running',
    })
    .where(eq(jobsTable.status, 'running'))
    .run().changes
}
