/**
 * When a job is due. Pure, so it is testable without waiting for wall time.
 *
 * There is no cron dependency, on purpose. The whole requirement is "every hour"
 * and "once overnight", which is a predicate over `(now, lastRunAt)` — about
 * thirty lines, against a parser for an expression syntax nobody here needs. A
 * dependency that has to be trusted with the timing of every financial figure in
 * the app should earn its place.
 *
 * Daily schedules compare the **local** calendar date and hour. In UTC the
 * nightly pass would drift an hour every spring and run in daylight, and around
 * a DST change a UTC comparison can also skip or double a day.
 */
import { dateIn, hourIn } from '../util/month.ts'

export type Schedule =
  /** Every `minutes` since the last run. */
  | { readonly kind: 'interval'; readonly minutes: number }
  /** Once per local calendar day, at or after `hour` local time. */
  | { readonly kind: 'daily'; readonly hour: number }

/**
 * Whether `schedule` is due at `now`.
 *
 * A job that has never run is always due: a fresh container should populate the
 * database rather than show an empty overview until 03:00 tomorrow.
 *
 * A daily job that missed its hour — the machine was off, or the previous pass
 * ran long — runs late the same day rather than being skipped. Late data is
 * useful; a day-shaped hole in the net-worth series is not.
 */
export function isDue(
  schedule: Schedule,
  now: Date,
  lastRunAt: Date | null,
  timeZone: string,
): boolean {
  if (lastRunAt === null) return true

  switch (schedule.kind) {
    case 'interval':
      return now.getTime() - lastRunAt.getTime() >= schedule.minutes * 60_000
    case 'daily':
      return (
        dateIn(lastRunAt, timeZone) !== dateIn(now, timeZone) &&
        hourIn(now, timeZone) >= schedule.hour
      )
  }
}

/** Resolution of the `nextRunAt` search. Finer than this is noise in an ops table. */
const PROBE_STEP_MS = 5 * 60_000
const PROBE_HORIZON_MS = 48 * 60 * 60 * 1000

/**
 * When `schedule` will next be due, for the ops table and the `jobs` row.
 *
 * Found by probing `isDue` forward rather than by doing the calendar arithmetic a
 * second time. That is deliberate: a hand-written "next 03:00 local" would be a
 * separate implementation of the same rule, free to disagree with the predicate
 * that actually decides — and it would disagree exactly on the DST days this
 * module exists to get right. Advisory only; the ticker never reads it.
 *
 * Null when nothing inside the horizon is due, which for these two kinds means
 * the schedule is longer than two days.
 */
export function nextRunAt(
  schedule: Schedule,
  now: Date,
  lastRunAt: Date | null,
  timeZone: string,
): Date | null {
  if (isDue(schedule, now, lastRunAt, timeZone)) return now

  for (let ahead = PROBE_STEP_MS; ahead <= PROBE_HORIZON_MS; ahead += PROBE_STEP_MS) {
    const candidate = new Date(now.getTime() + ahead)
    if (isDue(schedule, candidate, lastRunAt, timeZone)) return candidate
  }
  return null
}

/** `every 60m` / `daily at 03:00` — for a log line and the settings page. */
export function describeSchedule(schedule: Schedule): string {
  return schedule.kind === 'interval'
    ? `every ${schedule.minutes}m`
    : `daily at ${String(schedule.hour).padStart(2, '0')}:00`
}
