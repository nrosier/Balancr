import { describe, expect, it } from 'vitest'
import {
  computeBaseline,
  ewma,
  quantile,
  rollingRates,
  winsorise,
  type MonthValue,
} from '../../src/domain/aggregate/baseline.ts'
import { DEFAULT_PARAMS } from '../../src/domain/aggregate/params.ts'
import { addMonths } from '../../src/util/month.ts'

const BASELINE = DEFAULT_PARAMS.baseline

/** A dense ascending series starting at `start`, one entry per value. */
function series(start: string, cents: readonly number[]): MonthValue[] {
  return cents.map((value, index) => ({ month: addMonths(start, index), cents: value }))
}

describe('quantile', () => {
  it('interpolates rather than taking the nearest rank', () => {
    // Nearest-rank p95 of 12 observations is just the maximum, which would make
    // the upper clamp do nothing at exactly the window size we use.
    const values = [8000, 10000, 12000, 14000]
    expect(quantile(values, 0.05)).toBe(8300)
    expect(quantile(values, 0.95)).toBe(13700)
    expect(quantile(values, 0.5)).toBe(11000)
  })

  it('handles the degenerate ends', () => {
    expect(quantile([42], 0.95)).toBe(42)
    expect(quantile([1, 2, 3], 0)).toBe(1)
    expect(quantile([1, 2, 3], 1)).toBe(3)
    expect(() => quantile([], 0.5)).toThrow(/empty series/)
  })

  it("does not reorder the caller's array", () => {
    const values = [3, 1, 2]
    quantile(values, 0.5)
    expect(values).toEqual([3, 1, 2])
  })
})

describe('winsorise', () => {
  it('clamps outliers instead of dropping them', () => {
    // A real €900 month is data, just not nine hundred euros' worth of it — and
    // the count of observations must not change, or the EWMA weights shift.
    const { values, clamped } = winsorise([0, 100, 100, 100, 100, 90000], 0.05, 0.95)
    expect(values).toHaveLength(6)
    expect(clamped).toBe(true)
    expect(Math.max(...values)).toBeLessThan(90000)
    expect(Math.min(...values)).toBeGreaterThan(0)
  })

  it('nudges the extremes of any non-flat series, because the quantiles interpolate', () => {
    // p5 of [100,110,120,130] is 101.5 and p95 is 128.5, so the min and max are
    // both moved even though neither is an outlier. This is why BaselineResult
    // reports the *size* of the effect and not a "was anything clamped" boolean.
    const { values, clamped } = winsorise([100, 110, 120, 130], 0.05, 0.95)
    expect(clamped).toBe(true)
    expect(values).toEqual([101.5, 110, 120, 128.5])
  })

  it('leaves a flat series untouched', () => {
    const { values, clamped } = winsorise([100, 100, 100, 100], 0.05, 0.95)
    expect(clamped).toBe(false)
    expect(values).toEqual([100, 100, 100, 100])
  })

  it('is a no-op below three values, where quantiles are meaningless', () => {
    expect(winsorise([5, 90000], 0.05, 0.95)).toEqual({ values: [5, 90000], clamped: false })
  })
})

describe('ewma', () => {
  it('weights the newest observation by the half-life', () => {
    // Half-life 1: the older value carries half the weight. 300 / 1.5 = 200.
    expect(ewma([0, 300], 1)).toBeCloseTo(200, 6)
  })

  it('returns the value itself for a flat series, at any half-life', () => {
    expect(ewma([100, 100, 100], 3)).toBeCloseTo(100, 6)
    expect(ewma([100, 100, 100], 0.5)).toBeCloseTo(100, 6)
    expect(ewma([7], 3)).toBe(7)
  })

  it('leans on recent months: a 3-month half-life gives the newest 8x a year-old', () => {
    const recent = ewma([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1200], 3)
    const old = ewma([1200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 3)
    expect(recent / old).toBeCloseTo(2 ** (11 / 3), 6)
  })

  it('refuses inputs that have no answer', () => {
    expect(() => ewma([], 3)).toThrow(/empty series/)
    expect(() => ewma([1], 0)).toThrow(/must be positive/)
  })
})

describe('rollingRates', () => {
  it('omits positions without a complete window', () => {
    // A partial window would read as a dip in exactly the months a new category
    // is being judged on.
    expect(rollingRates([1, 2, 3, 4], 1)).toEqual([1, 2, 3, 4])
    expect(rollingRates([1, 2, 3, 4], 2)).toEqual([1.5, 2.5, 3.5])
    expect(rollingRates([1, 2, 3, 4], 3)).toEqual([2, 3])
    expect(rollingRates([1, 2, 3, 4], 4)).toEqual([2.5])
    expect(rollingRates([1, 2, 3], 4)).toEqual([])
  })

  it('rejects a window that cannot be averaged', () => {
    expect(() => rollingRates([1, 2], 0)).toThrow(/at least 1/)
  })
})

describe('computeBaseline', () => {
  it('refuses a sparse series, naming both months', () => {
    // A missing month is not a zero month, and a rolling window over a hole
    // inflates every rate by exactly the amount nobody would notice.
    const sparse: MonthValue[] = [
      { month: '2026-01', cents: 100 },
      { month: '2026-03', cents: 100 },
    ]
    expect(() => computeBaseline(sparse, '2026-03', 'monthly', BASELINE)).toThrow(
      /dense and ascending: 2026-01 is followed by 2026-03, expected 2026-02/,
    )
  })

  it('refuses a series that does not contain the month being judged', () => {
    expect(() => computeBaseline(series('2026-01', [1, 2, 3]), '2026-07', 'monthly', BASELINE))
      .toThrow(/does not contain 2026-07/)
  })

  it('returns null rather than a norm derived from too little history', () => {
    // minMonths is 4 by default: three months of history is an honest "not yet".
    expect(computeBaseline(series('2026-01', [100, 100, 100, 100]), '2026-04', 'monthly', BASELINE))
      .toBeNull()

    const enough = computeBaseline(
      series('2026-01', [100, 100, 100, 100, 100]),
      '2026-05',
      'monthly',
      BASELINE,
    )
    expect(enough?.monthsUsed).toBe(4)
  })

  it('returns null when the frequency window is wider than the history', () => {
    // An annual category needs twelve months before its first rate exists.
    expect(computeBaseline(series('2026-01', Array(6).fill(1000)), '2026-06', 'annual', BASELINE))
      .toBeNull()
  })

  it('leaves deltaBp null for a first-ever expense instead of reporting infinity', () => {
    const result = computeBaseline(
      series('2026-01', [0, 0, 0, 0, 0, 5000]),
      '2026-06',
      'monthly',
      BASELINE,
    )
    expect(result).not.toBeNull()
    expect(result?.baselineCents).toBe(0)
    expect(result?.currentCents).toBe(5000)
    expect(result?.deltaBp).toBeNull()
  })

  it('reads a steady category as steady', () => {
    const result = computeBaseline(
      series('2025-01', Array(13).fill(45_000)),
      '2026-01',
      'monthly',
      BASELINE,
    )
    expect(result).toMatchObject({
      baselineCents: 45_000,
      currentCents: 45_000,
      deltaBp: 0,
      monthsUsed: 12,
      windowMonths: 1,
      winsorEffectBp: 0,
    })
  })

  it('flags a genuine overspend in basis points', () => {
    // Twelve months at €200, then €300: 50% over, 5000 bp.
    const result = computeBaseline(
      series('2025-01', [...Array(12).fill(20_000), 30_000]),
      '2026-01',
      'monthly',
      BASELINE,
    )
    expect(result?.baselineCents).toBe(20_000)
    expect(result?.deltaBp).toBe(5_000)
  })

  it('amortises an annual premium instead of flagging it every year', () => {
    // €1200 every January, nothing the other eleven months, for three years.
    const januaryOnly = Array.from({ length: 36 }, (_, i) => (i % 12 === 0 ? 120_000 : 0))

    // As an annual category, judged on the trailing-12-month rate: €100/month,
    // every window, forever. Silence is the correct output.
    const annual = computeBaseline(series('2024-01', januaryOnly), '2026-12', 'annual', BASELINE)
    expect(annual).toMatchObject({
      baselineCents: 10_000,
      currentCents: 10_000,
      deltaBp: 0,
      windowMonths: 12,
      winsorEffectBp: 0,
    })

    // The same data mislabelled as monthly is what the frequency window exists to
    // prevent: January reads as more than 100x the norm, and every February then
    // reads as a collapse.
    const asMonthly = computeBaseline(series('2024-01', januaryOnly), '2026-01', 'monthly', BASELINE)
    expect(asMonthly?.currentCents).toBe(120_000)
    // History is one 120_000 among eleven zeros; p95 clamps it to 54_000, which
    // the 3-month half-life then discounts to ~936 cents at eleven months old.
    expect(asMonthly?.baselineCents).toBe(936)
    // Unclamped the same history averages to ~2079, so the clamp more than halves
    // the norm — exactly the kind of effect worth showing a reader.
    expect(asMonthly?.winsorEffectBp).toBeLessThan(-5_000)
    expect(asMonthly?.deltaBp).toBeGreaterThan(1_000_000)
  })

  it('amortises a quarterly bill across its quarter', () => {
    // €300 every third month: a €100/month rate, so no month is an anomaly.
    const quarterly = Array.from({ length: 24 }, (_, i) => ((i + 1) % 3 === 0 ? 30_000 : 0))
    const result = computeBaseline(series('2025-01', quarterly), '2026-12', 'quarterly', BASELINE)
    expect(result).toMatchObject({
      baselineCents: 10_000,
      currentCents: 10_000,
      deltaBp: 0,
      windowMonths: 3,
    })
  })

  it('honours a tuned baseline window', () => {
    // The parameters are user-editable, so the engine must actually read them
    // rather than closing over the defaults.
    const values = [...Array(24).fill(10_000), 20_000]
    const narrow = computeBaseline(series('2024-01', values), '2026-01', 'monthly', {
      ...BASELINE,
      windowMonths: 6,
    })
    expect(narrow?.monthsUsed).toBe(6)

    const wide = computeBaseline(series('2024-01', values), '2026-01', 'monthly', {
      ...BASELINE,
      windowMonths: 24,
    })
    expect(wide?.monthsUsed).toBe(24)
  })
})
