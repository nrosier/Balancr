/**
 * The job registry.
 *
 * Order is the dependency order and is load-bearing: `sync` creates the
 * `account_map` rows and the facts that `networth` reads, and `signals` reads the
 * stored output of all three — including the net-worth snapshot, which it does not
 * recompute. Every job shares one queue, so listing them in this order is all the
 * sequencing there is.
 */
import { netWorthJob } from './networth.ts'
import { portfolioJob } from './portfolio.ts'
import { signalsJob } from './signals.ts'
import { syncJob } from './sync.ts'
import type { Job } from './runner.ts'

export const registry: readonly Job[] = [syncJob, portfolioJob, netWorthJob, signalsJob]

export { createScheduler, type Scheduler } from './scheduler.ts'
export {
  clearStaleRunning,
  loadJobRows,
  runDueJobs,
  runJob,
  type Job,
  type JobContext,
  type JobDetail,
  type JobRow,
  type JobRun,
} from './runner.ts'
export { describeSchedule, isDue, nextRunAt, type Schedule } from './schedule.ts'

/** A job by name, for the "run now" action. */
export function findJob(name: string): Job | undefined {
  return registry.find((job) => job.name === name)
}
