/**
 * How old the numbers on the page are, and whether anything is broken.
 *
 * Every endpoint in this directory reads Balancr's own SQLite and nothing else — no
 * request ever calls Actual, Ghostfolio or Gemini. That is what makes the dashboard
 * fast and what keeps a broken upstream from turning into a broken page, but it has
 * one consequence that has to be faced rather than hidden: what is served can be
 * out of date, and a stale figure presented as current is worse than no figure.
 *
 * So every response carries this. Not an error, not a banner the client may or may
 * not draw — a field in the payload, on every read, computed from the `jobs` table
 * the scheduler already maintains.
 *
 * `stale` is deliberately about *failure and silence*, not about age alone. A
 * deployment with `JOBS_ENABLED=false` — a second instance, or someone poking at a
 * copy of the database — has data as old as its last real run and nothing is wrong
 * with it, so age is reported and the client decides. A job whose last attempt
 * errored is a different matter, and that is what `stale` says.
 */
import { config } from '../../../config.ts'
import type { Db } from '../../../db/index.ts'
import { loadJobRows, type JobRow } from '../../../jobs/index.ts'

/**
 * The jobs whose failure makes the figures wrong rather than merely incomplete.
 *
 * `ai` is not among them: a failed AI run means the narrative is yesterday's,
 * which the insights endpoint reports on its own terms. It does not make the
 * budget or net-worth numbers untrustworthy, and marking the whole dashboard
 * stale because Gemini was rate-limited would train the reader to ignore the flag.
 *
 * `backfill` is out for the same kind of reason and a sharper one. Every figure it
 * writes is for a settled month-end in the past, so its failure leaves the charts
 * shorter than they could be and leaves nothing on them wrong. It is also the job
 * most likely to fail on a slow Actual instance, being the only one that makes a
 * call per account per month — so including it would put a staleness warning over
 * correct, current numbers on exactly the installs least able to act on it.
 */
export const DATA_JOBS = ['sync', 'portfolio', 'networth', 'signals'] as const

export interface JobFreshness {
  name: string
  status: 'idle' | 'running' | 'ok' | 'error'
  lastRunAt: string | null
  lastSuccessAt: string | null
  /** Present only when the last attempt failed. The message, not a stack. */
  error: string | null
}

export interface Freshness {
  /** True when a job whose output these figures depend on last failed. */
  stale: boolean
  /**
   * The oldest successful run among the data jobs, which is the honest age of the
   * page as a whole: a fresh portfolio next to a two-day-old budget is two days old.
   * Null when nothing has ever succeeded, which is a deployment that has not run yet.
   */
  asOf: string | null
  /** False when this instance schedules nothing, so age is expected. */
  jobsEnabled: boolean
  jobs: JobFreshness[]
}

const iso = (value: Date | null): string | null => value?.toISOString() ?? null

const describe = (row: JobRow): JobFreshness => ({
  name: row.name,
  status: row.status,
  lastRunAt: iso(row.lastRunAt),
  lastSuccessAt: iso(row.lastSuccessAt),
  // Only when the status still says error: a message left behind by a failure that
  // a later run fixed would report an outage that is over.
  error: row.status === 'error' ? row.error : null,
})

/**
 * Reads the job table and says how much to trust what the other endpoints return.
 *
 * A job with no row at all counts as neither fresh nor failed — it has never run,
 * which on a new deployment is every job, and describing that as staleness would
 * mean the first thing a new user sees is a warning about nothing.
 */
export function freshness(db: Db): Freshness {
  const rows = loadJobRows(db)
  const byName = new Map(rows.map((row) => [row.name, row]))

  const data = DATA_JOBS.map((name) => byName.get(name)).filter(
    (row): row is JobRow => row !== undefined,
  )

  const successes = data
    .map((row) => row.lastSuccessAt)
    .filter((at): at is Date => at !== null)
    .map((at) => at.getTime())

  return {
    stale: data.some((row) => row.status === 'error'),
    // The oldest, not the newest. See the field's own comment.
    asOf: successes.length === 0 ? null : new Date(Math.min(...successes)).toISOString(),
    jobsEnabled: config.JOBS_ENABLED,
    jobs: rows.map(describe),
  }
}
