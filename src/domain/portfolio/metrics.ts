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
  /** Everything the broker holds, cash included — the figure that reconciles. */
  totalValueCents: number
  /** The part that is actually invested, and the base `allocation` shares are of. */
  investedValueCents: number
  /** Cash sitting at the broker. Not an asset class, and not a market value. */
  cashValueCents: number
  /** Ghostfolio's reported net performance over its `max` range. */
  twrBp: number | null
  mwrBp: null
  allocation: AllocationSlice[]
  driftJson: null
  terAnnualCents: null
}

/**
 * The invested/cash split, or two nulls when this date does not have one.
 *
 * Here rather than beside the one route that used to hold it, because three callers now
 * need the same condition and it is a fact about a metrics row: the two halves are known
 * together or not at all, and one present with the other missing would be a third state
 * for every one of them to get wrong. `loadPortfolioMetrics` reads an absent split back
 * as zero, which is the honest reading of "nothing recorded" and also indistinguishable
 * from a portfolio that really holds no cash — the halves adding up to the total is what
 * separates the two.
 *
 * It matters beyond the wire, because band shares are shares of the *invested* value: a
 * date with no denominator measured against the total puts every class below its floor
 * on any instance whose Ghostfolio syncs a bank balance, and produces four confident
 * suggestions to buy.
 */
export function knownSplit(
  metrics: PortfolioMetricsResult | null,
): { investedValueCents: number | null; cashValueCents: number | null } {
  if (metrics === null) return { investedValueCents: null, cashValueCents: null }
  const known = metrics.investedValueCents + metrics.cashValueCents === metrics.totalValueCents
  if (!known) return { investedValueCents: null, cashValueCents: null }
  return {
    investedValueCents: metrics.investedValueCents,
    cashValueCents: metrics.cashValueCents,
  }
}

/**
 * Asset classes that are cash rather than an investment.
 *
 * Ghostfolio labels a cash position `LIQUIDITY`; `CASH` is accepted too because the
 * label is an unversioned internal detail and the cost of it changing is a current
 * account reappearing in the treemap as an asset class.
 */
const CASH_CLASSES: ReadonlySet<string> = new Set(['LIQUIDITY', 'CASH'])

/** Whether a holding is cash held at the broker rather than something invested. */
export function isCashHolding(holding: Pick<HoldingSnapshot, 'assetClass'>): boolean {
  return holding.assetClass !== null && CASH_CLASSES.has(holding.assetClass.toUpperCase())
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

const sum = (holdings: readonly HoldingSnapshot[]): number =>
  holdings.reduce((total, holding) => total + holding.valueCents, 0)

/**
 * The figures for one date, with cash held apart from what is invested.
 *
 * Allocation is over the invested holdings only. A `LIQUIDITY` position is a bank
 * balance a syncing tool wrote into Ghostfolio, and drawing it as a slice of the
 * treemap said a current account was an asset class — on the reporting instance the
 * largest one, at about half the portfolio. The total still counts it, because that
 * is the figure that reconciles against the Ghostfolio dashboard.
 *
 * `twrBp` is unchanged and still Ghostfolio's own: it is a return over whatever base
 * Ghostfolio computed it on, and recomputing it here from an invested subtotal would
 * be inventing a number. Asking Ghostfolio for the return of the investment accounts
 * alone is possible — `accounts=<id>` is honoured — and belongs to the job that knows
 * which accounts those are, not to this function.
 */
export function computePortfolioMetrics(
  date: string,
  holdings: readonly HoldingSnapshot[],
  performance: PortfolioPerformance | null,
): PortfolioMetricsResult {
  const cash = holdings.filter((holding) => isCashHolding(holding))
  const invested = holdings.filter((holding) => !isCashHolding(holding))

  return {
    date,
    totalValueCents: sum(holdings),
    investedValueCents: sum(invested),
    cashValueCents: sum(cash),
    twrBp: performance === null ? null : reportedTwrBp(performance),
    mwrBp: null,
    allocation: allocationByAssetClass(invested),
    driftJson: null,
    terAnnualCents: null,
  }
}
