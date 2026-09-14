/**
 * The savings rate over a period rather than over one calendar month (#288).
 *
 * A calendar month is the wrong window for this figure in the household this was
 * reported from, and for most households: rent leaves near the end of the month and
 * the paycheck arrives near the end of the month, so the boundary falls in the middle
 * of the pattern. A month in progress has had every large outflow and none of the
 * income that pays for it, and even a finished month is distorted by which side of the
 * boundary a lump landed on.
 *
 * The fix is one line of arithmetic and it is the whole point of this module:
 *
 * ```
 * (Σ income − Σ spend) / Σ income
 * ```
 *
 * **Summed before dividing.** A period rate is not the mean of the monthly rates — the
 * mean would carry every boundary distortion straight into the average, and it answers
 * a question nobody asked. Summing first is what lets a paycheck recorded in one month
 * pay for rent recorded in another, which is exactly the effect the reader is trying to
 * see through.
 *
 * Two things this deliberately does not do:
 *
 *  - **It does not replace `MonthTotals.savingsRateBp`.** The digest, the findings and
 *    `household.ts`'s savings-target comparison all consume the monthly figure and keep
 *    consuming it. This is a reading option on one card, not a change to the quantity
 *    the domain stores.
 *  - **It does not know what "now" is** except through the `asOf`/`timeZone` it is
 *    given, used only to pro-rate a still-open anchor month or year — same reason
 *    `benchmarkPeriodWindow` takes them rather than reading the clock itself.
 *
 * Pure, and re-exported through `web/src/shared.ts` for the card that reads it — the
 * arrangement `custodyShare` already has, and for the same reason: two copies of this
 * would be two chances to average the percentages in one of them.
 */
import { monthProgress, monthRange } from '../../util/month.ts'

/** One month of flows. Structural, so the wire shape from `/api/budget` fits as it is. */
export interface SavingsMonth {
  readonly month: string
  readonly incomeCents: number
  readonly spentCents: number
}

/**
 * A month, or January through that month for the year it falls in — the same anchor
 * convention `BenchmarkPeriodKind` uses in `domain/benchmark/compare.ts`, which is what
 * lets `year` double as "year to date" for a still-open year without a third kind.
 */
export type SavingsPeriodKind = 'month' | 'year'

/** A period's nominal length in months, mirroring `PERIOD_DENOMINATOR` in `compare.ts`. */
const PERIOD_DENOMINATOR: Record<SavingsPeriodKind, number> = { month: 1, year: 12 }

export interface AbsolutePeriodSavings {
  readonly kind: SavingsPeriodKind
  /** The anchor month, `YYYY-MM`. */
  readonly month: string
  /** How much of the period's nominal length has elapsed, 0..10000. 10000 is a finished period. */
  readonly periodProgressBp: number
  readonly rateBp: number | null
  readonly incomeCents: number
  readonly spentCents: number
  readonly months: number
  readonly from: string | null
  readonly to: string | null
}

/**
 * The savings rate over a calendar month or a calendar year, pro-rated exactly the way
 * `benchmarkPeriodWindow`/`periodProgressBp` pro-rate the Benchmark card — a period that
 * ends in the still-open current month gets a fractional last month rather than a whole
 * one, so a partial year does not read as an underperforming full one.
 */
export function absolutePeriodSavings(
  history: readonly SavingsMonth[],
  kind: SavingsPeriodKind,
  anchorMonth: string,
  asOf: Date,
  timeZone: string,
): AbsolutePeriodSavings {
  const months = kind === 'month' ? [anchorMonth] : monthRange(`${anchorMonth.slice(0, 4)}-01`, anchorMonth)
  const periodMonths = months.reduce((sum, month) => sum + monthProgress(month, asOf, timeZone), 0)

  const covered = new Set(months)
  const window = history.filter((entry) => covered.has(entry.month))
  const incomeCents = window.reduce((sum, entry) => sum + entry.incomeCents, 0)
  const spentCents = window.reduce((sum, entry) => sum + entry.spentCents, 0)

  return {
    kind,
    month: anchorMonth,
    periodProgressBp: Math.round((periodMonths / PERIOD_DENOMINATOR[kind]) * 10_000),
    rateBp:
      incomeCents > 0 ? Math.round(((incomeCents - spentCents) / incomeCents) * 10_000) : null,
    incomeCents,
    spentCents,
    months: window.length,
    from: window[0]?.month ?? null,
    to: window.at(-1)?.month ?? null,
  }
}
