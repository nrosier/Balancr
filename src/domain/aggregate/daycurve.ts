/**
 * "Is this category on track to overspend, given *when* it usually spends?" (#311)
 *
 * `burn_rate_over` used to extrapolate a flat daily rate from spend-so-far, which
 * misjudges two real shapes at once: a utility bill that always lands days 8-13
 * looks like "way ahead of pace" on day 3 and "way behind" on day 14, and a
 * category with a stable total but scattered timing (haircuts, anywhere from day
 * 2 to day 25) looks alarming on whichever day it happens to have spent early.
 *
 * The fix is a historical day-of-month curve: what fraction of the eventual
 * total had this category typically spent by the equivalent day, in past
 * months? That answers the first shape. It would introduce a *new* false alarm
 * for the second shape — a stable total landing early would look like "ahead of
 * pace" — if it were trusted unconditionally. So every curve carries a
 * `reliable` verdict, gated on how dispersed the historical fractions are
 * (`dispersionBp`), and `overspend.ts` only projects from a curve that passes
 * it. A category that fails falls back to the existing committed/extrapolation
 * formula, which is why the gate can afford to be conservative.
 *
 * Pure: no database, no clock, no Actual. `progress` and the historical months
 * are computed by the caller, like everywhere else in this folder.
 */
import { daysInMonth, assertDenseMonths } from '../../util/month.ts'
import type { RecomputedSpendDaily } from '../../adapters/actual/queries.ts'
import { quantile } from './baseline.ts'
import { toPositiveOut } from './spend.ts'
import type { AggregateParams } from './params.ts'

export interface DailyValue {
  /** `YYYY-MM-DD` */
  date: string
  /** Positive-out cents, like `MonthlyFact.spentCents`. */
  cents: number
}

export interface DayCurveMonthSeries {
  /** `YYYY-MM` */
  month: string
  /** Any subset of the month's days; a day with no spend has no row. */
  days: readonly DailyValue[]
}

export interface DayCurveResult {
  /** Historical median fraction of the month's eventual total already spent by the equivalent day, 0..10000. */
  medianFractionBp: number
  /** IQR (p75 - p25) of that fraction across history, in basis points. */
  dispersionBp: number
  /** Historical months that had any spend and fed the sample. */
  monthsUsed: number
  /** False when `dispersionBp` exceeds the configured gate — timing too scattered to trust. */
  reliable: boolean
}

/**
 * The day-of-month curve for one category, as of `progress` through the month.
 *
 * `months` must be dense, ascending, and historical only (never the month being
 * judged — there is nothing to learn from the month's own partial data). A
 * month with a non-positive total is excluded from the sample rather than
 * treated as a zero fraction: there is no shape to learn from a month with
 * nothing spent, and counting it would pull every median toward zero for a
 * category that simply skipped a month. Below `params.minMonths` sampled
 * months, returns null — an honest absence beats a confident shape derived
 * from one or two months, mirroring `computeBaseline`'s "not enough history"
 * convention.
 */
export function computeDayCurve(
  months: readonly DayCurveMonthSeries[],
  progress: number,
  params: AggregateParams['dayCurve'],
): DayCurveResult | null {
  assertDenseMonths(
    months.map((entry) => entry.month),
    'day curve series',
  )

  const fractions: number[] = []
  for (const { month, days } of months) {
    const total = days.reduce((sum, day) => sum + day.cents, 0)
    if (total <= 0) continue

    const length = daysInMonth(month)
    const cutoffDay = Math.min(length, Math.max(0, Math.round(progress * length)))
    const cutoffDate = `${month}-${String(cutoffDay).padStart(2, '0')}`
    const cumulative = days
      .filter((day) => day.date <= cutoffDate)
      .reduce((sum, day) => sum + day.cents, 0)
    // Clamped rather than trusted: an early refund can push the running total
    // outside the [0, total] range that a month with no refunds would stay in.
    fractions.push(Math.min(1, Math.max(0, cumulative / total)))
  }

  if (fractions.length < params.minMonths) return null

  const dispersionBp = Math.round((quantile(fractions, 0.75) - quantile(fractions, 0.25)) * 10_000)

  return {
    medianFractionBp: Math.round(quantile(fractions, 0.5) * 10_000),
    dispersionBp,
    monthsUsed: fractions.length,
    reliable: dispersionBp <= params.maxDispersionBp,
  }
}

export interface DayCurveMonth {
  /** The month this curve projects for — the current month, never one of `historyMonths`. */
  month: string
  /** By Actual's category id. Absent means not enough history, or too scattered to trust. */
  categories: ReadonlyMap<string, DayCurveResult>
}

export interface BuildDayCurvesInput {
  /** Raw signed AQL rows, Actual's own sign convention, any order. */
  daily: readonly RecomputedSpendDaily[]
  /** Dense, ascending, excludes `month`. */
  historyMonths: readonly string[]
  /** The month the resulting curves project for. */
  month: string
  /** Excluded from every curve: a scheduled salary has no "day-of-month overspend" reading. */
  incomeCategoryIds: ReadonlySet<string>
  /** How far through `month` we are, 0..1. */
  progress: number
  params: AggregateParams['dayCurve']
}

/**
 * Buckets raw daily AQL rows into a dense per-category history and computes
 * each category's day-of-month curve.
 *
 * Mirrors `CommittedMonth`'s shape and rationale: a wrapper carrying its own
 * `month` so `spend.ts` can gate on `dayCurves?.month === month` the same way
 * it already gates `committed`, and a category with no reliable curve is
 * simply absent rather than present with a `null` value.
 */
export function buildDayCurves(input: BuildDayCurvesInput): DayCurveMonth {
  const { daily, historyMonths, month, incomeCategoryIds, progress, params } = input
  assertDenseMonths(historyMonths, 'day curve history')

  const historySet = new Set(historyMonths)
  const byCategory = new Map<string, Map<string, DailyValue[]>>()

  for (const row of daily) {
    if (row.categoryId === null) continue
    if (incomeCategoryIds.has(row.categoryId)) continue
    const rowMonth = row.date.slice(0, 7)
    if (!historySet.has(rowMonth)) continue

    let byMonth = byCategory.get(row.categoryId)
    if (!byMonth) {
      byMonth = new Map()
      byCategory.set(row.categoryId, byMonth)
    }
    const days = byMonth.get(rowMonth) ?? []
    days.push({ date: row.date, cents: toPositiveOut(row.amountCents, false) })
    byMonth.set(rowMonth, days)
  }

  const categories = new Map<string, DayCurveResult>()
  for (const [categoryId, byMonth] of byCategory) {
    const series = historyMonths.map((historyMonth) => ({
      month: historyMonth,
      days: byMonth.get(historyMonth) ?? [],
    }))
    const result = computeDayCurve(series, progress, params)
    if (result) categories.set(categoryId, result)
  }

  return { month, categories }
}
