/**
 * Drift is arithmetic, so these tests are mostly arithmetic — but three of them are
 * about things a plausible implementation gets wrong in ways nobody notices for months.
 *
 *  - A class the portfolio does not hold at all still has to produce a line. Zero
 *    equities against a 65% target is the biggest drift there is, and an implementation
 *    that maps over the slices it has reports nothing.
 *  - A class with no band comes back separately rather than being folded into the
 *    nearest one, so the page can say that some of the portfolio has no target.
 *  - The euros needed to fix an underweight are not the euros that are missing. Buying
 *    from cash grows the base it is a share of, so the naive figure lands short — by a
 *    factor of nearly three at a 65% target, which is not a rounding difference.
 */
import { describe, expect, it } from 'vitest'
import {
  correctionCents,
  driftReport,
  type AllocationInput,
} from '../../src/domain/advice/drift.ts'
import { PROFILE_PRESETS, type Bands } from '../../src/domain/advice/profile.ts'

/** €100 000 invested, in cents, so a basis point is a round €10. */
const INVESTED = 10_000_000

const balanced = PROFILE_PRESETS.balanced

function slice(key: string, shareBp: number, valueCents = (INVESTED * shareBp) / 10_000): AllocationInput {
  return { key, valueCents, shareBp }
}

/** The balanced targets, held exactly. */
const onTarget: AllocationInput[] = [
  slice('EQUITY', 6_500),
  slice('FIXED_INCOME', 3_000),
  slice('REAL_ESTATE', 500),
]

describe('driftReport', () => {
  it('reports every band class as inside when the shares are on target', () => {
    const report = driftReport(onTarget, balanced, INVESTED)
    expect(report.lines).toHaveLength(4)
    expect(report.lines.every((line) => line.state === 'inside')).toBe(true)
    expect(report.worstOutsideBp).toBe(0)
    expect(report.investedValueCents).toBe(INVESTED)
  })

  it('gives a class with no holdings a line, at the full distance from its target', () => {
    const report = driftReport([slice('FIXED_INCOME', 10_000)], balanced, INVESTED)
    const equity = report.lines.find((line) => line.assetClass === 'EQUITY')
    expect(equity).toMatchObject({
      valueCents: 0,
      shareBp: 0,
      driftBp: -6_500,
      state: 'below',
      outsideBp: 5_500,
    })
    // Short of target by 65% of the portfolio, expressed as money.
    expect(equity?.gapCents).toBe(6_500_000)
  })

  it('measures outsideBp from the band edge and driftBp from the target', () => {
    // 70% equity: inside a 55–75% band, so nothing is wrong, but still 5% above target.
    const report = driftReport(
      [slice('EQUITY', 7_000), slice('FIXED_INCOME', 2_500), slice('REAL_ESTATE', 500)],
      balanced,
      INVESTED,
    )
    const equity = report.lines.find((line) => line.assetClass === 'EQUITY')
    expect(equity).toMatchObject({ driftBp: 500, outsideBp: 0, state: 'inside' })
    expect(equity?.gapCents).toBe(-500_000)
  })

  it('calls a share above the maximum above, and quotes the distance past the edge', () => {
    const report = driftReport(
      [slice('EQUITY', 8_000), slice('FIXED_INCOME', 1_500), slice('REAL_ESTATE', 500)],
      balanced,
      INVESTED,
    )
    const equity = report.lines[0]
    expect(equity).toMatchObject({
      assetClass: 'EQUITY',
      state: 'above',
      driftBp: 1_500,
      outsideBp: 500,
    })
    expect(report.worstOutsideBp).toBe(500)
  })

  it('sorts by distance outside the band first, then by distance from target', () => {
    const report = driftReport(
      [slice('EQUITY', 8_000), slice('FIXED_INCOME', 1_800), slice('REAL_ESTATE', 200)],
      balanced,
      INVESTED,
    )
    // Equities 5% over their ceiling, bonds 2% under their floor: both are outside, and
    // the further one leads. Property is inside its band but 3% under target, so it
    // still comes before a commodity line sitting exactly on a zero target.
    expect(
      report.lines.map((line) => `${line.assetClass}:${line.outsideBp}:${line.driftBp}`),
    ).toEqual([
      'EQUITY:500:1500',
      'FIXED_INCOME:200:-1200',
      'REAL_ESTATE:0:-300',
      'COMMODITY:0:0',
    ])
  })

  it('breaks a tie between two lines inside their bands by drift from target', () => {
    const report = driftReport(onTarget, balanced, INVESTED)
    expect(report.lines.map((line) => line.assetClass)).toEqual([
      'EQUITY',
      'FIXED_INCOME',
      'REAL_ESTATE',
      'COMMODITY',
    ])
    // Everything on target, so the order is the one thing left: all drifts are zero
    // except commodity's, which has a zero target and a zero holding.
    expect(report.lines.every((line) => line.driftBp === 0)).toBe(true)
  })

  it('leaves cash out entirely rather than measuring it against a band', () => {
    const withCash = [...onTarget, slice('LIQUIDITY', 0, 2_500_000)]
    expect(driftReport(withCash, balanced, INVESTED)).toEqual(driftReport(onTarget, balanced, INVESTED))
  })

  it('reports a class with no band as unmapped instead of folding it into equity', () => {
    const report = driftReport(
      [slice('EQUITY', 5_700), slice('FIXED_INCOME', 3_000), slice('PRIVATE_EQUITY', 800), slice('REAL_ESTATE', 500)],
      balanced,
      INVESTED,
    )
    expect(report.unmapped).toEqual([
      { assetClass: 'PRIVATE_EQUITY', valueCents: 800_000, shareBp: 800 },
    ])
    // And the equity line reports what is actually held in equities, not 65%.
    expect(report.lines.find((line) => line.assetClass === 'EQUITY')?.shareBp).toBe(5_700)
  })

  it('sorts unmapped classes by value, largest first', () => {
    const report = driftReport(
      [slice('PRIVATE_EQUITY', 300), slice('unknown', 900), slice('EQUITY', 8_800)],
      balanced,
      INVESTED,
    )
    expect(report.unmapped.map((row) => row.assetClass)).toEqual(['unknown', 'PRIVATE_EQUITY'])
  })

  it('takes the invested value as given rather than summing the slices', () => {
    // A denominator re-derived here is how a euro figure comes to disagree with the
    // percentage printed beside it: the shares were computed against that figure.
    const report = driftReport([slice('EQUITY', 6_500, 1)], balanced, INVESTED)
    expect(report.investedValueCents).toBe(INVESTED)
    expect(report.lines.find((line) => line.assetClass === 'EQUITY')?.gapCents).toBe(0)
  })
})

describe('correctionCents', () => {
  const equityOf = (report: ReturnType<typeof driftReport>) => {
    const line = report.lines.find((candidate) => candidate.assetClass === 'EQUITY')
    if (line === undefined) throw new Error('no equity line')
    return line
  }

  it('buys nearly three times the gap, because the purchase grows the base', () => {
    const report = driftReport(
      [slice('EQUITY', 5_000), slice('FIXED_INCOME', 4_500), slice('REAL_ESTATE', 500)],
      balanced,
      INVESTED,
    )
    const equity = equityOf(report)
    expect(equity.gapCents).toBe(1_500_000)
    // €42 857,14 rather than €15 000: (5 000 000 + x) / (10 000 000 + x) = 0,65.
    expect(correctionCents(equity, INVESTED)).toBe(4_285_714)
    const share = (equity.valueCents + 4_285_714) / (INVESTED + 4_285_714)
    expect(share).toBeCloseTo(0.65, 6)
  })

  it('sells the mirror amount, because the sale shrinks the base', () => {
    const report = driftReport(
      [slice('EQUITY', 8_000), slice('FIXED_INCOME', 1_500), slice('REAL_ESTATE', 500)],
      balanced,
      INVESTED,
    )
    const equity = equityOf(report)
    expect(equity.gapCents).toBe(-1_500_000)
    expect(correctionCents(equity, INVESTED)).toBe(-4_285_714)
    const share = (equity.valueCents - 4_285_714) / (INVESTED - 4_285_714)
    expect(share).toBeCloseTo(0.65, 6)
  })

  it('is zero for a class already on target', () => {
    expect(correctionCents(equityOf(driftReport(onTarget, balanced, INVESTED)), INVESTED)).toBe(0)
  })

  it('uses the class value rather than its rounded share', () => {
    // A share is stored to the basis point. On €100 000 that is €10 of rounding, which
    // is real money in the answer if the correction is derived from the percentage.
    const rounded = driftReport([slice('EQUITY', 5_000, 5_004_900)], balanced, INVESTED)
    const fromValue = correctionCents(equityOf(rounded), INVESTED)
    const fromShare = Math.round(
      (6_500 * INVESTED - 10_000 * ((INVESTED * 5_000) / 10_000)) / 3_500,
    )
    expect(fromValue).not.toBe(fromShare)
    expect(Math.abs(fromValue - fromShare)).toBeGreaterThan(1_000)
  })

  it('falls back to the gap when the target is the whole portfolio', () => {
    // Nothing can be bought from cash to reach 100% invested in one class while another
    // is held; the money comes from selling the others and the base never moves.
    const allEquity: Bands = {
      EQUITY: { minBp: 10_000, targetBp: 10_000, maxBp: 10_000 },
      FIXED_INCOME: { minBp: 0, targetBp: 0, maxBp: 0 },
      REAL_ESTATE: { minBp: 0, targetBp: 0, maxBp: 0 },
      COMMODITY: { minBp: 0, targetBp: 0, maxBp: 0 },
    }
    const report = driftReport([slice('EQUITY', 9_000), slice('FIXED_INCOME', 1_000)], allEquity, INVESTED)
    const equity = equityOf(report)
    expect(equity.gapCents).toBe(1_000_000)
    expect(correctionCents(equity, INVESTED)).toBe(equity.gapCents)
  })
})
