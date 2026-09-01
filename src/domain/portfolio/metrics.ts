/**
 * Portfolio figures derived from a snapshot, and the ones we refuse to invent.
 *
 * What is computed here: total value and allocation by asset class, both pure
 * arithmetic over rows we already store.
 *
 * What is *reported* here: `twrBp` — Ghostfolio's own net performance, copied
 * across rather than recalculated. Recalculating would mean pulling every order
 * ever placed and reimplementing time-weighted return, producing a second number
 * that disagrees with the Ghostfolio dashboard by a few basis points for reasons
 * nobody could explain. One authority per figure; Ghostfolio owns return.
 *
 * What is deliberately null:
 *
 *  - **`mwrBp`** — money-weighted return needs the dated cashflow series, which
 *    is order history we have chosen not to ingest.
 *  - **`driftJson`** — drift is distance from a target allocation, and there is
 *    no target until the fund universe lands (v0.8.0). Drift against an implied
 *    target would be a made-up number wearing a percentage sign.
 *  - **`terAnnualCents`** — needs each fund's TER, which Ghostfolio does not
 *    expose; it arrives with the curated fund universe.
 *
 * A null here renders as "not available yet" in the UI. A guess would render as
 * a number, which is the failure mode this whole app is built to avoid.
 */
import { toBp, type PortfolioPerformance } from '../../adapters/ghostfolio/types.ts'
import type { HoldingSnapshot } from './snapshot.ts'

export interface AllocationSlice {
  /** Asset class as Ghostfolio labels it, or `unknown`. */
  key: string
  valueCents: number
  /** Share of the total, basis points. Sums to exactly 10 000. */
  shareBp: number
}

export interface PortfolioMetricsResult {
  date: string
  totalValueCents: number
  /** Ghostfolio's reported net performance over its `max` range. */
  twrBp: number | null
  mwrBp: null
  allocation: AllocationSlice[]
  driftJson: null
  terAnnualCents: null
}

/**
 * Groups holdings by asset class and gives each an exact share.
 *
 * Shares are apportioned by largest remainder so they add up to 10 000 bp. Naive
 * rounding leaves a pie chart labelled 99.97%, and the first reaction to that is
 * to distrust every other figure on the page.
 */
export function allocationByAssetClass(
  holdings: readonly HoldingSnapshot[],
): AllocationSlice[] {
  const totals = new Map<string, number>()
  for (const holding of holdings) {
    const key = holding.assetClass ?? 'unknown'
    totals.set(key, (totals.get(key) ?? 0) + holding.valueCents)
  }

  const total = [...totals.values()].reduce((sum, value) => sum + value, 0)
  const slices = [...totals.entries()]
    .map(([key, valueCents]) => ({ key, valueCents }))
    .sort((a, b) => b.valueCents - a.valueCents || a.key.localeCompare(b.key))

  // A total of zero (or a short position offsetting the rest exactly) has no
  // meaningful denominator; every share is zero rather than NaN or Infinity.
  if (total <= 0) {
    return slices.map((slice) => ({ ...slice, shareBp: 0 }))
  }

  const withRemainder = slices.map((slice) => {
    const exact = (slice.valueCents * 10_000) / total
    const floor = Math.floor(exact)
    return { ...slice, shareBp: floor, remainder: exact - floor }
  })

  let left = 10_000 - withRemainder.reduce((sum, slice) => sum + slice.shareBp, 0)
  // Descending remainder, and the existing value order breaks ties, so the same
  // input always produces the same rounding.
  for (const slice of [...withRemainder].sort((a, b) => b.remainder - a.remainder)) {
    if (left <= 0) break
    slice.shareBp += 1
    left -= 1
  }

  return withRemainder
    .map(({ key, valueCents, shareBp }) => ({ key, valueCents, shareBp }))
    .sort((a, b) => b.valueCents - a.valueCents || a.key.localeCompare(b.key))
}

/**
 * Ghostfolio's net performance as basis points, or null when it says nothing.
 *
 * Two fields carry it depending on the Ghostfolio version, which is what an
 * unversioned internal API costs: `netPerformancePercentage` is the current one,
 * `currentNetPerformancePercent` the older name. Null when neither is present —
 * an absent return is not a zero return.
 */
export function reportedTwrBp(performance: PortfolioPerformance): number | null {
  const fraction =
    performance.performance?.netPerformancePercentage ??
    performance.performance?.currentNetPerformancePercent ??
    null
  return fraction === null || fraction === undefined ? null : toBp(fraction)
}

export function computePortfolioMetrics(
  date: string,
  holdings: readonly HoldingSnapshot[],
  performance: PortfolioPerformance | null,
): PortfolioMetricsResult {
  return {
    date,
    totalValueCents: holdings.reduce((sum, holding) => sum + holding.valueCents, 0),
    twrBp: performance === null ? null : reportedTwrBp(performance),
    mwrBp: null,
    allocation: allocationByAssetClass(holdings),
    driftJson: null,
    terAnnualCents: null,
  }
}
