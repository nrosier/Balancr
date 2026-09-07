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
 *  - **It does not know what "now" is.** The window is anchored on the month the reader
 *    has selected, passed in, so switching the month picker moves all four periods
 *    together. A module that read the clock would disagree with the page around it every
 *    time somebody looked at a past month.
 *
 * Pure, and re-exported through `web/src/shared.ts` for the card that reads it — the
 * arrangement `custodyShare` already has, and for the same reason: two copies of this
 * would be two chances to average the percentages in one of them.
 */

/**
 * The four windows, in the order the card offers them.
 *
 * `twelve_months` is the default (see `DEFAULT_SAVINGS_PERIOD`), because the report
 * behind #288 is that the current month is the least useful of the four and twelve is
 * the window the benchmark norms are already taken over.
 */
export const SAVINGS_PERIODS = [
  'this_month',
  'previous_month',
  'year_to_date',
  'twelve_months',
] as const
export type SavingsPeriod = (typeof SAVINGS_PERIODS)[number]

export const DEFAULT_SAVINGS_PERIOD: SavingsPeriod = 'twelve_months'

/** How many months `twelve_months` asks for. Named, because the label says it too. */
export const TRAILING_MONTHS = 12

/** One month of flows. Structural, so the wire shape from `/api/budget` fits as it is. */
export interface SavingsMonth {
  readonly month: string
  readonly incomeCents: number
  readonly spentCents: number
}

export interface PeriodSavings {
  readonly period: SavingsPeriod
  /**
   * The rate, or null when the window has no income to divide by.
   *
   * Same guard as the monthly figure, and it fires far less often: a month with no
   * income has no rate and that is the correct answer, but a year with no income
   * essentially does not happen, so the longer windows are simply better defined.
   */
  readonly rateBp: number | null
  readonly incomeCents: number
  readonly spentCents: number
  /**
   * How many months the window actually covered — not how many it asked for.
   *
   * A fresh install asked for twelve months has three, and a figure whose span is not
   * on screen cannot be read correctly. The card states this, the same honesty rule
   * `committedApproximate` and the custody `basis` already follow.
   */
  readonly months: number
  /** Oldest and newest month covered. Both null when the window is empty. */
  readonly from: string | null
  readonly to: string | null
}

/** The calendar month before `month`, as a month key. */
function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7))
  return index === 1
    ? `${year - 1}-12`
    : `${year}-${String(index - 1).padStart(2, '0')}`
}

/**
 * The months a period covers, out of a contiguous history ending at `month`.
 *
 * Everything after `month` is dropped first. `history` from `/api/budget` already ends
 * there, but the selection must not depend on that — a caller that passed a longer
 * array would otherwise get a "year to date" that ran into next year.
 */
function windowFor(
  history: readonly SavingsMonth[],
  month: string,
  period: SavingsPeriod,
): readonly SavingsMonth[] {
  const upTo = history.filter((entry) => entry.month <= month)
  switch (period) {
    case 'this_month':
      return upTo.filter((entry) => entry.month === month)
    case 'previous_month': {
      const previous = previousMonth(month)
      return upTo.filter((entry) => entry.month === previous)
    }
    case 'year_to_date':
      // Not "the last N months": January of the selected month's own year, which is
      // what "year to date" means on a page where the reader may have selected a month
      // in a previous year.
      return upTo.filter((entry) => entry.month >= `${month.slice(0, 4)}-01`)
    case 'twelve_months':
      return upTo.slice(-TRAILING_MONTHS)
  }
}

/**
 * A period's savings rate, and the span it was taken over.
 *
 * `history` is the contiguous run of months `/api/budget` sends, oldest first; `month`
 * is the one the reader has selected.
 */
export function periodSavings(
  history: readonly SavingsMonth[],
  month: string,
  period: SavingsPeriod,
): PeriodSavings {
  const window = windowFor(history, month, period)
  const incomeCents = window.reduce((sum, entry) => sum + entry.incomeCents, 0)
  const spentCents = window.reduce((sum, entry) => sum + entry.spentCents, 0)

  return {
    period,
    // Summed, then divided once. The whole of #288 is in these two lines being in this
    // order rather than a mean of `entry.savingsRateBp`.
    rateBp:
      incomeCents > 0 ? Math.round(((incomeCents - spentCents) / incomeCents) * 10_000) : null,
    incomeCents,
    spentCents,
    months: window.length,
    from: window[0]?.month ?? null,
    to: window.at(-1)?.month ?? null,
  }
}
