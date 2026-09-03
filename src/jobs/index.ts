/**
 * The job registry.
 *
 * Order is the dependency order and is load-bearing: `sync` creates the
 * `account_map` rows and the facts that `networth` reads, `signals` reads the
 * stored output of all three — including the net-worth snapshot, which it does not
 * recompute — and `ai` reads the signals `signals` judged. Every job shares one
 * queue, so listing them in this order is all the sequencing there is.
 *
 * `backfill` sits after `networth` because a month-end that has only just become
 * settled should be filled the same night the nightly pass records it, and because
 * it reads the snapshot dates that pass has already written.
 *
 * `ai` is next to last for a second reason: it is the only job that costs money, so it
 * is the one that should be looking at tonight's data rather than yesterday's.
 *
 * `backup` is last, and nothing depends on it either — a backup is read by no job, so
 * its position cannot be derived from the graph. It is last because every nightly job
 * becomes due in the same tick and runs in this order, so anywhere earlier would write
 * a file describing the state from before that night's work.
 *
 * `probe` is first and depends on nothing. It is not part of the chain at all — it
 * writes no fact any other job reads — but when Ghostfolio's contract has changed the
 * portfolio job fails as well, and a log that states the diagnosis before the symptom
 * saves the reader from working backwards from a Zod error.
 */
import { aiJob } from './ai.ts'
import { backfillJob } from './backfill.ts'
import { backupJob } from './backup.ts'
import { netWorthJob } from './networth.ts'
import { portfolioJob } from './portfolio.ts'
import { probeJob } from './probe.ts'
import { signalsJob } from './signals.ts'
import { syncJob } from './sync.ts'
import type { Job } from './runner.ts'

export const registry: readonly Job[] = [
  probeJob,
  syncJob,
  portfolioJob,
  netWorthJob,
  backfillJob,
  signalsJob,
  aiJob,
  backupJob,
]

export { createScheduler, type Scheduler } from './scheduler.ts'
export {
  loadProbe,
  loadProbes,
  saveProbe,
  type ProbeSource,
  type ProbeState,
  type StoredProbeStatus,
  type StoredReport,
} from './probe-state.ts'
export {
  DEFAULT_REFRESH,
  expand,
  REFRESHABLE,
  startRefresh,
  type Refreshable,
  type RefreshBusy,
  type RefreshStarted,
} from './refresh.ts'
export {
  clearStaleRunning,
  jobsInFlight,
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
