/**
 * How far the portfolio is from its bands, in basis points and in euros (#41).
 *
 * Pure arithmetic over a stored allocation and a set of bands. No judgement lives here:
 * whether a distance is worth a trade is `suggest.ts`, and what a rebalance would cost
 * is the tax module. What this file guarantees is that every number a suggestion quotes
 * exists before the suggestion does — which is the issue's actual requirement, and the
 * reason `Suggestion` cannot be constructed without a `DriftLine`.
 *
 * Two subtleties that are easy to get wrong and expensive to get wrong:
 *
 *  - **A class with no holdings is a line, not a gap in the list.** Zero equities against
 *    a 65% target is the largest drift a portfolio can have, and a producer that iterates
 *    over the slices it *has* would report nothing at all.
 *  - **A class with no band is reported, never folded in.** Ghostfolio can introduce an
 *    asset class whenever it likes, and quietly counting `PRIVATE_EQUITY` as equity —
 *    or quietly leaving it out of the denominator — would make every other line wrong by
 *    however much of it there is. It comes back as `unmapped`, with its share, so the
 *    page can say that 8% of the portfolio has no target.
 */
import { BAND_CLASSES, type Bands, type BandClass } from './profile.ts'

/** The allocation as `allocationByAssetClass` produces it. */
export interface AllocationInput {
  key: string
  valueCents: number
  shareBp: number
}

export const DRIFT_STATES = ['inside', 'above', 'below'] as const
export type DriftState = (typeof DRIFT_STATES)[number]

export interface DriftLine {
  assetClass: BandClass
  /** What this class is worth today. */
  valueCents: number
  /** Its share of the invested value, in basis points. */
  shareBp: number
  minBp: number
  targetBp: number
  maxBp: number
  /** Signed distance from target: positive means overweight. */
  driftBp: number
  state: DriftState
  /**
   * How far past the band edge, in basis points. Zero when inside.
   *
   * The threshold a suggestion is judged against, rather than `driftBp`: a band exists
   * precisely to say that a share may sit away from target without anything being wrong.
   */
  outsideBp: number
  /**
   * Euros in the wrong place, relative to target. Positive means short of it.
   *
   * The drift expressed as money, which is the figure worth printing beside a
   * percentage. Deliberately *not* the size of the trade that fixes it: a sale moves
   * money out of the invested base and a purchase from cash moves money in, so the
   * amount to trade depends on where the money comes from. `suggest.ts` sizes that.
   */
  gapCents: number
}

/** A class the portfolio holds and the profile has no band for. */
export interface UnmappedClass {
  assetClass: string
  valueCents: number
  shareBp: number
}

export interface DriftReport {
  /** One line per band class, worst first. */
  lines: readonly DriftLine[]
  unmapped: readonly UnmappedClass[]
  /** The invested value the shares are of — the denominator, stated. */
  investedValueCents: number
  /** The largest `outsideBp` on any line. Zero when everything is in its band. */
  worstOutsideBp: number
}

/** Cash is not an asset class here — see the comment on `BAND_CLASSES`. */
const CASH_CLASSES: ReadonlySet<string> = new Set(['LIQUIDITY', 'CASH'])

const isBandClass = (key: string): key is BandClass =>
  (BAND_CLASSES as readonly string[]).includes(key)

/**
 * Drift for every band class, plus whatever has no band.
 *
 * `investedValueCents` is passed rather than summed from the slices: it is the figure
 * `computePortfolioMetrics` computed the shares against, and re-deriving it here is how
 * a euro figure comes to disagree with the percentage beside it.
 */
export function driftReport(
  allocation: readonly AllocationInput[],
  bands: Bands,
  investedValueCents: number,
): DriftReport {
  const held = new Map<string, AllocationInput>()
  for (const slice of allocation) {
    if (CASH_CLASSES.has(slice.key.toUpperCase())) continue
    held.set(slice.key, slice)
  }

  const lines = BAND_CLASSES.map((assetClass) => {
    const slice = held.get(assetClass)
    const band = bands[assetClass]
    const shareBp = slice?.shareBp ?? 0
    const driftBp = shareBp - band.targetBp
    const state: DriftState =
      shareBp > band.maxBp ? 'above' : shareBp < band.minBp ? 'below' : 'inside'
    const outsideBp =
      state === 'above' ? shareBp - band.maxBp : state === 'below' ? band.minBp - shareBp : 0

    return {
      assetClass,
      valueCents: slice?.valueCents ?? 0,
      shareBp,
      minBp: band.minBp,
      targetBp: band.targetBp,
      maxBp: band.maxBp,
      driftBp,
      state,
      outsideBp,
      // `target - share` rather than `-driftBp`: the same figure, without producing
      // a negative zero for a class that is exactly on target.
      gapCents: Math.round((investedValueCents * (band.targetBp - shareBp)) / 10_000),
    }
  }).sort((a, b) => b.outsideBp - a.outsideBp || Math.abs(b.driftBp) - Math.abs(a.driftBp))

  const unmapped = [...held.values()]
    .filter((slice) => !isBandClass(slice.key))
    .map((slice) => ({ assetClass: slice.key, valueCents: slice.valueCents, shareBp: slice.shareBp }))
    .sort((a, b) => b.valueCents - a.valueCents || a.assetClass.localeCompare(b.assetClass))

  return {
    lines,
    unmapped,
    investedValueCents,
    worstOutsideBp: lines.reduce((worst, line) => Math.max(worst, line.outsideBp), 0),
  }
}

/**
 * The one-trade correction for a line, in cents, when the money comes from outside.
 *
 * Not `gapCents`. Selling moves the proceeds to cash, so the invested base shrinks and
 * the remaining share of it rises: selling exactly the gap leaves the class still
 * overweight. Solving `(v ± x) / (V ± x) = t` for `x` gives the figure below, which is
 * the amount that actually lands the share on its target.
 *
 * A target of 100% has no solution against cash — you cannot buy your way to being all
 * equities while anything else is held — and there the gap *is* the answer, because the
 * money comes from selling the other classes and the base never changes.
 */
export function correctionCents(line: DriftLine, investedValueCents: number): number {
  const room = 10_000 - line.targetBp
  if (room <= 0) return line.gapCents
  // The class's own value rather than `shareBp × V`: the share is rounded to a basis
  // point, and on a six-figure portfolio that rounding is tens of euros.
  return Math.round((line.targetBp * investedValueCents - 10_000 * line.valueCents) / room)
}
