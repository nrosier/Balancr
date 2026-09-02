/**
 * The history both series already had and neither was reading.
 *
 * `net_worth_snapshots` and `portfolio_metrics` are written one row per day a job
 * ran, so both charts are as long as the install is old: a fortnight before either
 * says anything, two years before either says anything about two years. The data was
 * never missing. Actual's `getAccountBalance` takes a date, and Ghostfolio's
 * performance endpoint answers `range=max` with a dated value series — the same two
 * calls the nightly passes already make, asked about the past.
 *
 * Two halves, and they are independent on purpose.
 *
 * **`portfolio_metrics`** is a per-date total, so the chart's value *is* the row. That
 * half needs no decision and always runs.
 *
 * **`net_worth_snapshots`** is stored per `account_map` row, and Ghostfolio's chart is
 * a portfolio total rather than a per-account series. Splitting that total across
 * several Ghostfolio rows would be inventing figures, which is the one thing this
 * codebase does not do — so the total is used only when it demonstrably *is* one row's
 * value: Ghostfolio counts exactly one account, and that account's row survives
 * `computeNetWorth`'s dedupe. Anything else and the month-ends inside the chart's
 * range are left alone.
 *
 * Left alone, specifically, rather than written as an Actual-only total and marked
 * incomplete. A marker is a schema decision, and it would have to be cleared by
 * whatever eventually makes attribution possible; a missing date needs neither,
 * because the next pass still sees it missing and fills it in. What the reader gets
 * either way is the thing that matters: a series drawn from the point both halves are
 * known, rather than one joined to today at a step. A cliff where a backfill meets
 * live data is worse than a shorter chart, because the cliff looks like an event.
 *
 * Dates *before* the chart starts are a different case and are written in full. The
 * `max` range begins at the first order, so a month-end before it is a month when
 * there was no portfolio to value: Actual alone is the whole truth of that date, not
 * half of it.
 *
 * Cost is why this is its own job rather than a branch in `networth`. It is the only
 * pass that talks to Actual once per month per account, so it reads both date sets
 * before it opens a connection: nothing pending means no call at all, and once the
 * net-worth half is complete it never talks to Actual again.
 *
 * The Ghostfolio chart is fetched on any night the metrics half still has a gap, and
 * on an install whose portfolio is younger than the window that is every night — the
 * month-ends before the first order can never be answered, so they stay pending for
 * ever. That is deliberate: one GET against a Ghostfolio on the same host is cheaper
 * than a stored "stop asking about these months" floor, which would then need
 * invalidating the day an older order is imported.
 */
import { fetchPortfolioPerformance } from '../adapters/ghostfolio/client.ts'
import type { PortfolioPerformance } from '../adapters/ghostfolio/types.ts'
import { config } from '../config.ts'
import type { Db } from '../db/index.ts'
import { loadAccountMap } from '../domain/aggregate/accounts.ts'
import { earliestStoredMonth } from '../domain/aggregate/month-store.ts'
import { computeNetWorth, type AccountValue } from '../domain/aggregate/networth.ts'
import { persistNetWorth, snapshotDates } from '../domain/aggregate/networth-store.ts'
import { chartStart, monthEndValues } from '../domain/portfolio/history.ts'
import { backfillPortfolioValues, metricsDates } from '../domain/portfolio/store.ts'
import type { Logger } from '../logger.ts'
import { dateIn, endOfMonth, monthIn, monthsBefore } from '../util/month.ts'
import {
  actualScope,
  actualValuesAt,
  collectAccountValues,
  type CollectedValues,
} from './networth.ts'
import type { Job, JobContext, JobDetail } from './runner.ts'

/**
 * Midday UTC on a calendar date.
 *
 * `new Date('2026-01-31')` is midnight UTC, which is still the 30th anywhere west of
 * Greenwich — so a month-end balance would be asked for as of the day before in every
 * negative-offset `TZ`. Midday is the same calendar date in every real zone.
 */
const asOf = (date: string): Date => new Date(`${date}T12:00:00Z`)

/**
 * What the investment side of a past month-end can be filled from.
 *
 * A closed set rather than a pair of booleans, because the three cases want three
 * different things done and a boolean pair permits a fourth that means nothing.
 */
type InvestmentHalf =
  /** No Ghostfolio row counts, so no date is waiting on one. Actual is the total. */
  | { kind: 'none' }
  /** One row owns the whole portfolio, and the chart can date it. */
  | {
      kind: 'chart'
      target: AccountValue
      /** First date the chart covers; earlier month-ends predate the portfolio. */
      start: string
      /** Month-end date to closing value. */
      closing: Map<string, number>
    }
  /** Nothing honest can be said about investments on a past date. `why` is logged. */
  | { kind: 'unavailable'; why: string }

/**
 * Decides which of the three cases holds, from today's picture of both sources.
 *
 * The dedupe is not re-implemented here: `contributions` is `computeNetWorth`'s own
 * answer to "which rows count", so a group where Actual is the source of truth leaves
 * no Ghostfolio row to attribute to and lands in `none` — correctly, because Actual's
 * own historical balance for that account is then the investment half and
 * `actualValuesAt` already has it.
 *
 * `ghostfolioCounted` is the second half of the test and the one that is easy to miss.
 * A single *contributing* row is not enough: the chart totals every account Ghostfolio
 * itself counts, so six accounts excluded by `include_in_net_worth` — our flag, not
 * Ghostfolio's — leave a total that spans seven and a row that owns one of them.
 * Using it would overstate the historical investment total by the other six, every
 * month, in the flattering direction.
 */
function investmentHalf(
  collected: CollectedValues,
  contributions: readonly AccountValue[],
  performance: PortfolioPerformance | null,
  months: readonly string[],
): InvestmentHalf {
  const rows = contributions.filter((account) => account.source === 'ghostfolio')
  const target = rows[0]
  if (target === undefined) return { kind: 'none' }

  if (rows.length > 1) {
    return { kind: 'unavailable', why: 'more than one Ghostfolio row counts toward net worth' }
  }
  if (performance === null) {
    return { kind: 'unavailable', why: 'Ghostfolio performance series unavailable' }
  }
  if (collected.ghostfolioCounted !== 1) {
    return {
      kind: 'unavailable',
      why:
        `Ghostfolio counts ${collected.ghostfolioCounted ?? 'an unknown number of'} accounts, ` +
        'so its portfolio total is not one account_map row',
    }
  }

  const start = chartStart(performance)
  if (start === null) {
    return { kind: 'unavailable', why: 'Ghostfolio returned no usable performance history' }
  }

  return {
    kind: 'chart',
    target,
    start,
    closing: new Map(
      monthEndValues(performance, months).map((point) => [point.date, point.valueCents]),
    ),
  }
}

/** Month-ends this install reports on, oldest first, excluding the current month. */
function targetMonths(db: Db, now: Date): { metrics: string[]; netWorth: string[]; all: string[] } {
  // The current month is excluded because its end has not happened; the nightly pass
  // owns today, and the backfill only ever touches settled months.
  //
  // The window comes from the run's own `now` rather than the wall clock, so every
  // date this job writes is derived from the single instant the runner recorded — a
  // run that starts at 02:59:59 on the 1st cannot write one half of a snapshot into
  // the old month and the other into the new one.
  const all = monthsBefore(monthIn(now, config.TZ), config.JOBS_HISTORY_MONTHS)

  const haveMetrics = metricsDates(db)
  const haveSnapshots = snapshotDates(db)
  const earliest = earliestStoredMonth(db)

  return {
    all,
    metrics: all.filter((month) => !haveMetrics.has(endOfMonth(month))),
    // Clamped to the budget history: see `earliestStoredMonth`. Null means the sync
    // job has never run, and there is nothing to stand a net-worth history on.
    netWorth:
      earliest === null
        ? []
        : all.filter((month) => month >= earliest && !haveSnapshots.has(endOfMonth(month))),
  }
}

async function backfillNetWorth(
  db: Db,
  months: readonly string[],
  performance: PortfolioPerformance | null,
  now: Date,
  log: Logger,
): Promise<{ written: number; skipped: number; half: InvestmentHalf['kind'] }> {
  const collected = await collectAccountValues(db, now, log)
  // Today's figure, computed only to be asked which rows count. Cheap next to the
  // month-ends below, and it means the historical dates are classified by exactly the
  // function that classifies the live one.
  const today = computeNetWorth(dateIn(now, config.TZ), collected.values)
  const half = investmentHalf(collected, today.contributions, performance, months)

  if (half.kind === 'unavailable') {
    log.warn(
      { reason: half.why, months: months.length },
      'net-worth history not backfilled: the investment half of each date cannot be established',
    )
    return { written: 0, skipped: months.length, half: half.kind }
  }

  const scope = await actualScope(loadAccountMap(db))
  let written = 0
  let skipped = 0

  for (const month of months) {
    const date = endOfMonth(month)
    const values = await actualValuesAt(scope, asOf(date))

    if (half.kind === 'chart' && date >= half.start) {
      const valueCents = half.closing.get(date)
      if (valueCents === undefined) {
        // Inside the chart's range with no closing value: a hole in Ghostfolio's
        // series, not a month without a portfolio. Nothing honest to write.
        skipped += 1
        continue
      }
      values.push({ ...half.target, valueCents })
    }

    persistNetWorth(db, computeNetWorth(date, values))
    written += 1
  }

  return { written, skipped, half: half.kind }
}

async function run({ db, now, log }: JobContext): Promise<JobDetail> {
  const months = targetMonths(db, now)
  if (months.metrics.length === 0 && months.netWorth.length === 0) {
    // The steady state, and the reason this check comes before every fetch.
    return { months: months.all.length, pending: 0 }
  }

  let performance: PortfolioPerformance | null = null
  try {
    performance = await fetchPortfolioPerformance()
  } catch (error) {
    log.warn(
      { err: error },
      'Ghostfolio performance history unavailable; portfolio value not backfilled',
    )
  }

  const metrics =
    performance === null || months.metrics.length === 0
      ? { written: 0, kept: 0 }
      : backfillPortfolioValues(db, monthEndValues(performance, months.metrics))

  const netWorth =
    months.netWorth.length === 0
      ? { written: 0, skipped: 0, half: 'none' as const }
      : await backfillNetWorth(db, months.netWorth, performance, now, log)

  return {
    months: months.all.length,
    metricsWritten: metrics.written,
    metricsPending: months.metrics.length - metrics.written,
    snapshotsWritten: netWorth.written,
    snapshotsSkipped: netWorth.skipped,
    investmentHalf: netWorth.half,
  }
}

export const backfillJob: Job = {
  name: 'backfill',
  // Daily, and after the nightly pass in registry order so a month-end that has just
  // become settled is filled the same night. Re-running is safe: every date is either
  // already stored and skipped, or upserted.
  schedule: { kind: 'daily', hour: config.JOBS_NIGHTLY_HOUR },
  run,
}
