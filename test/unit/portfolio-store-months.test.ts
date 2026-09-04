/**
 * The month-end reading the drift count is built on (#183).
 *
 * `monthEndMetrics` is four lines of SQL, and every way it can be subtly wrong produces a
 * plausible number rather than an error: the *first* row of each month instead of the
 * last, months newest-first, a `limit` counting rows instead of months. Each of those
 * turns "equities have been over their ceiling for three months" into a sentence about
 * three arbitrary days, and nothing on any screen would look broken.
 *
 * `knownSplit` is tested beside it because the two are one condition in practice: a month
 * whose invested value is unknown must not be measured at all, and this is the function
 * that says so.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { knownSplit, type PortfolioMetricsResult } from '../../src/domain/portfolio/metrics.ts'
import { monthEndMetrics, persistPortfolioMetrics } from '../../src/domain/portfolio/store.ts'

let ctx: ReturnType<typeof createTestDb>
let db: ReturnType<typeof createTestDb>['db']

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
})

/** A metrics row. `total` carries the identifying value, so a test can name the row it got. */
function metrics(date: string, total: number, invested = total, cash = 0): PortfolioMetricsResult {
  return {
    date,
    totalValueCents: total,
    investedValueCents: invested,
    cashValueCents: cash,
    twrBp: 500,
    mwrBp: null,
    allocation: [{ key: 'EQUITY', valueCents: invested, shareBp: 10_000 }],
    driftJson: null,
    terAnnualCents: null,
  }
}

const totals = (rows: readonly PortfolioMetricsResult[]): number[] =>
  rows.map((row) => row.totalValueCents)

describe('monthEndMetrics', () => {
  it('takes the last row of each month, not the first', () => {
    // Metrics are computed on every sync, so a month holds twenty or thirty rows. The one
    // that means "how the portfolio stood in July" is the last of them.
    persistPortfolioMetrics(db, metrics('2026-07-03', 100))
    persistPortfolioMetrics(db, metrics('2026-07-19', 200))
    persistPortfolioMetrics(db, metrics('2026-07-31', 300))
    expect(totals(monthEndMetrics(db, 6))).toEqual([300])
  })

  it('returns one row per month, oldest first', () => {
    for (const [date, total] of [
      ['2026-05-30', 10],
      ['2026-05-31', 11],
      ['2026-06-30', 20],
      ['2026-07-15', 30],
      ['2026-07-31', 31],
    ] as const) {
      persistPortfolioMetrics(db, metrics(date, total))
    }
    // Ascending, like every other history in this codebase — and the order the caller
    // reverses to count back from the newest. Newest-first here would count forwards.
    expect(totals(monthEndMetrics(db, 6))).toEqual([11, 20, 31])
  })

  it('counts months, not rows', () => {
    // The limit is a number of months. Applied to rows it would return three readings from
    // July and call them three months.
    persistPortfolioMetrics(db, metrics('2026-07-10', 1))
    persistPortfolioMetrics(db, metrics('2026-07-20', 2))
    persistPortfolioMetrics(db, metrics('2026-07-31', 3))
    persistPortfolioMetrics(db, metrics('2026-08-31', 4))
    persistPortfolioMetrics(db, metrics('2026-09-30', 5))
    expect(totals(monthEndMetrics(db, 2))).toEqual([4, 5])
  })

  it('leaves a gap absent rather than repeating the month either side of it', () => {
    // June never synced. The caller has to be able to see that, because a run counted
    // through a hole is the difference between a drift and two unrelated readings.
    persistPortfolioMetrics(db, metrics('2026-05-31', 10))
    persistPortfolioMetrics(db, metrics('2026-07-31', 30))
    const months = monthEndMetrics(db, 6).map((row) => row.date.slice(0, 7))
    expect(months).toEqual(['2026-05', '2026-07'])
  })

  it('crosses a year end in the right order', () => {
    persistPortfolioMetrics(db, metrics('2025-12-31', 10))
    persistPortfolioMetrics(db, metrics('2026-01-31', 20))
    // String months sort correctly across the boundary; a numeric month would not.
    expect(totals(monthEndMetrics(db, 3))).toEqual([10, 20])
  })

  it('is empty on an instance that has never synced, and asks for nothing', () => {
    expect(monthEndMetrics(db, 12)).toEqual([])
    // Zero months is a caller with a threshold of zero, not a request for everything.
    persistPortfolioMetrics(db, metrics('2026-07-31', 10))
    expect(monthEndMetrics(db, 0)).toEqual([])
  })

  it('carries the split through, because that is what the shares are shares of', () => {
    persistPortfolioMetrics(db, metrics('2026-07-31', 500_000, 400_000, 100_000))
    const row = monthEndMetrics(db, 6)[0]
    expect(row?.investedValueCents).toBe(400_000)
    expect(row?.cashValueCents).toBe(100_000)
  })
})

describe('knownSplit', () => {
  it('reports both halves when they add up to the total', () => {
    expect(knownSplit(metrics('2026-07-31', 500_000, 400_000, 100_000))).toEqual({
      investedValueCents: 400_000,
      cashValueCents: 100_000,
    })
  })

  it('reports neither when they do not', () => {
    // What an older row looks like: the split was added later, so it reads back as two
    // zeroes against a total of half a million. Measuring band shares against that puts
    // every class at 0% and produces four confident suggestions to buy.
    expect(knownSplit(metrics('2026-07-31', 500_000, 0, 0))).toEqual({
      investedValueCents: null,
      cashValueCents: null,
    })
  })

  it('accepts a portfolio that genuinely holds no cash', () => {
    // Indistinguishable from the row above by the cash figure alone, which is exactly why
    // the test is whether the halves reconcile rather than whether either is zero.
    expect(knownSplit(metrics('2026-07-31', 500_000, 500_000, 0))).toEqual({
      investedValueCents: 500_000,
      cashValueCents: 0,
    })
  })

  it('accepts a portfolio that is all cash', () => {
    expect(knownSplit(metrics('2026-07-31', 500_000, 0, 500_000))).toEqual({
      investedValueCents: 0,
      cashValueCents: 500_000,
    })
  })

  it('reports neither for a date with no metrics at all', () => {
    expect(knownSplit(null)).toEqual({ investedValueCents: null, cashValueCents: null })
  })
})
