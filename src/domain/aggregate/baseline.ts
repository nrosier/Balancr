/**
 * "Is this a lot?" — answered without a language model.
 *
 * Three problems have to be solved together, and solving only one produces a
 * baseline that gets ignored within a month:
 *
 *  1. **Recency.** A plain 12-month mean treats last January as evidence about
 *     this September. An EWMA with a 3-month half-life does not.
 *  2. **Outliers.** One boiler repair in a maintenance category would otherwise
 *     become the definition of normal. Values are winsorised — clamped to the
 *     p5/p95 range rather than dropped, because a real €900 month is data, just
 *     not nine hundred euros' worth of it.
 *  3. **Non-monthly costs.** An annual insurance premium is not a spike; it is a
 *     yearly cost that happens to land in one month. Comparing single months
 *     would flag it every year and flag the other eleven as suspiciously low.
 *     So a category's `expectedFrequency` sets a window, and the comparison is
 *     between *rates* (mean spend per month over that window), not months.
 *
 * Everything here is pure: no database, no clock, no Actual. That is what makes
 * the golden test meaningful.
 */
import { assertDenseMonths } from '../../util/month.ts'
import type { AggregateParams } from './params.ts'

export type ExpectedFrequency = 'monthly' | 'quarterly' | 'annual' | 'irregular'

/**
 * Months averaged into one observation, per frequency.
 *
 * `irregular` gets the annual window deliberately: if we cannot say when the
 * cost recurs, the widest smoothing is the honest choice — it under-reacts
 * instead of crying wolf.
 */
export const FREQUENCY_WINDOW: Record<ExpectedFrequency, number> = {
  monthly: 1,
  quarterly: 3,
  annual: 12,
  irregular: 12,
}

export interface MonthValue {
  /** `YYYY-MM` */
  month: string
  /** Positive-out cents, as stored in `monthly_category_facts.spent_cents`. */
  cents: number
}

export interface BaselineResult {
  /** EWMA of the historical rates, cents per month. */
  baselineCents: number
  /** The rate being judged, on the same per-month scale. */
  currentCents: number
  /**
   * `(current - baseline) / baseline` in basis points, or null when the baseline
   * is zero — a first-ever expense is not "infinitely over budget", it is a new
   * expense, and `irregular_expense` is the finding for that.
   */
  deltaBp: number | null
  /** Historical observations that fed the average. */
  monthsUsed: number
  /** Months per observation, from the category's expected frequency. */
  windowMonths: number
  /**
   * How far winsorisation moved the baseline, in basis points, or null when the
   * unclamped baseline is zero.
   *
   * Deliberately a magnitude and not a boolean: because the quantiles are
   * interpolated, the p5/p95 clamp nudges the extremes of *any* series that is
   * not perfectly flat, so "was something clamped" is true for nearly every real
   * category and tells a reader nothing. The size does — `-5499` means an
   * outlier was inflating this norm by more than half, which is worth surfacing;
   * `-12` means the clamp was cosmetic.
   */
  winsorEffectBp: number | null
}

/**
 * Linear-interpolated quantile over a copy of `values`.
 *
 * Interpolated rather than nearest-rank because with 12 observations the p95 of
 * the nearest-rank definition is simply the maximum — which would make the
 * upper clamp do nothing at exactly the window size we use.
 */
export function quantile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('quantile of an empty series')
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0] as number

  const position = (sorted.length - 1) * Math.min(1, Math.max(0, p))
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const lowerValue = sorted[lower] as number
  if (lower === upper) return lowerValue
  return lowerValue + (position - lower) * ((sorted[upper] as number) - lowerValue)
}

/** Clamps to the [lowerP, upperP] quantile range. Values are kept, not dropped. */
export function winsorise(
  values: readonly number[],
  lowerP: number,
  upperP: number,
): { values: number[]; clamped: boolean } {
  if (values.length < 3) return { values: [...values], clamped: false }

  const low = quantile(values, lowerP)
  const high = quantile(values, upperP)
  let clamped = false
  const out = values.map((value) => {
    if (value < low) {
      clamped = true
      return low
    }
    if (value > high) {
      clamped = true
      return high
    }
    return value
  })
  return { values: out, clamped }
}

/**
 * Exponentially weighted mean. `values` ascending in time, last = most recent.
 * Weight halves every `halfLifeMonths`, so a 3-month half-life gives the newest
 * observation eight times the pull of one a year old.
 */
export function ewma(values: readonly number[], halfLifeMonths: number): number {
  if (values.length === 0) throw new Error('ewma of an empty series')
  if (halfLifeMonths <= 0) throw new Error('halfLifeMonths must be positive')

  const decay = Math.log(2) / halfLifeMonths
  let weighted = 0
  let weights = 0
  for (const [index, value] of values.entries()) {
    const age = values.length - 1 - index
    const weight = Math.exp(-decay * age)
    weighted += weight * value
    weights += weight
  }
  return weighted / weights
}

/**
 * Mean spend per month over the `window` months ending at each position.
 *
 * The first `window - 1` positions have no complete window and are omitted, so
 * the result is shorter than the input — a partial window would read as a dip.
 */
export function rollingRates(values: readonly number[], window: number): number[] {
  if (window < 1) throw new Error('window must be at least 1')
  if (values.length < window) return []

  const rates: number[] = []
  let sum = 0
  for (const [index, value] of values.entries()) {
    sum += value
    if (index >= window) sum -= values[index - window] as number
    if (index >= window - 1) rates.push(sum / window)
  }
  return rates
}

/**
 * The baseline for one category as of `month`.
 *
 * `series` must be dense, ascending, and include `month` as well as the months
 * before it. Returns null when there is not enough history — an honest absence
 * beats a confident norm derived from two months, and the UI shows "not enough
 * history yet" instead of a number nobody should act on.
 */
export function computeBaseline(
  series: readonly MonthValue[],
  month: string,
  frequency: ExpectedFrequency,
  params: AggregateParams['baseline'],
): BaselineResult | null {
  assertDenseMonths(
    series.map((entry) => entry.month),
    'baseline series',
  )

  const targetIndex = series.findIndex((entry) => entry.month === month)
  if (targetIndex === -1) {
    throw new Error(`baseline series does not contain ${month}`)
  }

  const windowMonths = FREQUENCY_WINDOW[frequency]
  const values = series.slice(0, targetIndex + 1).map((entry) => entry.cents)

  // Rates are aligned to the *end* of their window, so the rate at series index
  // i sits at rates index i - (window - 1).
  const rates = rollingRates(values, windowMonths)
  const currentRateIndex = targetIndex - (windowMonths - 1)
  if (currentRateIndex < 0) return null

  const currentCents = rates[currentRateIndex] as number
  const history = rates.slice(0, currentRateIndex).slice(-params.windowMonths)
  if (history.length < params.minMonths) return null

  const { values: clampedHistory } = winsorise(
    history,
    params.winsorLowerPct,
    params.winsorUpperPct,
  )
  const baselineCents = Math.round(ewma(clampedHistory, params.halfLifeMonths))
  // Computed on the same history so the difference is attributable to the clamp
  // and nothing else.
  const rawBaselineCents = Math.round(ewma(history, params.halfLifeMonths))

  return {
    baselineCents,
    currentCents: Math.round(currentCents),
    deltaBp:
      baselineCents > 0
        ? Math.round(((currentCents - baselineCents) / baselineCents) * 10_000)
        : null,
    monthsUsed: history.length,
    windowMonths,
    winsorEffectBp:
      rawBaselineCents > 0
        ? Math.round(((baselineCents - rawBaselineCents) / rawBaselineCents) * 10_000)
        : null,
  }
}
