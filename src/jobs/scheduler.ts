/**
 * The ticker.
 *
 * A single 60-second `setInterval` that asks each job whether it is due. No cron
 * library, no per-job timers: with two schedules ("hourly" and "overnight") a
 * timer per job buys nothing and gives every job its own drift and its own way to
 * be left running after shutdown.
 *
 * 60 seconds because the finest schedule allowed is five minutes, so a minute of
 * granularity is already ten times finer than anything can ask for, and the tick
 * itself is two integer comparisons against the `jobs` table.
 */
import type { Db } from '../db/index.ts'
import { logger } from '../logger.ts'
import { describeSchedule } from './schedule.ts'
import { clearStaleRunning, runDueJobs, type Job, type JobRun } from './runner.ts'

const log = logger.child({ module: 'scheduler' })

const TICK_MS = 60_000

export interface Scheduler {
  /** Begins ticking. Also runs one tick immediately. */
  start(): void
  stop(): void
  /** True between `start` and `stop`. */
  readonly running: boolean
}

export function createScheduler(db: Db, registry: readonly Job[]): Scheduler {
  let timer: NodeJS.Timeout | null = null
  // Guards against a slow pass overlapping the next tick. The job queue already
  // serialises the work, so without this the ticks would simply pile up behind
  // each other and a 90-minute Actual sync would come back to a queue of 90.
  let ticking = false

  const tick = async (): Promise<void> => {
    if (ticking) {
      log.debug('previous tick still running; skipping this one')
      return
    }
    ticking = true
    try {
      const runs: JobRun[] = await runDueJobs(db, registry)
      if (runs.length > 0) {
        log.debug({ ran: runs.map((run) => `${run.name}:${run.status}`) }, 'tick complete')
      }
    } catch (error) {
      // `runJob` already swallows per-job failures, so reaching here means the
      // scheduler itself broke — a database read, most likely. Logged and
      // dropped, because a dead ticker means silently stale data for ever.
      log.error({ err: error }, 'scheduler tick failed')
    } finally {
      ticking = false
    }
  }

  return {
    get running() {
      return timer !== null
    },
    start() {
      if (timer !== null) return

      const interrupted = clearStaleRunning(db)
      if (interrupted > 0) {
        log.warn({ jobs: interrupted }, 'cleared job rows left in `running` by a restart')
      }

      timer = setInterval(() => void tick(), TICK_MS)
      // Unreferenced so the ticker never keeps the process alive on its own; the
      // HTTP server is what holds it open, and a scheduler that outlives it would
      // be a container that will not stop.
      timer.unref()

      log.info(
        { jobs: registry.map((job) => `${job.name} (${describeSchedule(job.schedule)})`) },
        'scheduler started',
      )
      // Immediately, not in 60 seconds: a fresh container should start filling the
      // database now rather than showing an empty overview for the first minute.
      void tick()
    },
    stop() {
      if (timer === null) return
      clearInterval(timer)
      timer = null
      log.info('scheduler stopped')
    },
  }
}
