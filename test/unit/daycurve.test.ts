import { describe, expect, it } from 'vitest'
import type { RecomputedSpendDaily } from '../../src/adapters/actual/queries.ts'
import {
  buildDayCurves,
  computeDayCurve,
  type DayCurveMonthSeries,
} from '../../src/domain/aggregate/daycurve.ts'
import type { AggregateParams } from '../../src/domain/aggregate/params.ts'

const PARAMS: AggregateParams['dayCurve'] = {
  windowMonths: 12,
  minMonths: 4,
  maxDispersionBp: 2_500,
}

describe('computeDayCurve', () => {
  it('refuses a sparse or unordered series, naming both months', () => {
    const sparse: DayCurveMonthSeries[] = [
      { month: '2026-01', days: [] },
      { month: '2026-03', days: [] },
    ]
    expect(() => computeDayCurve(sparse, 0.5, PARAMS)).toThrow(
      /dense and ascending: 2026-01 is followed by 2026-03, expected 2026-02/,
    )
  })

  it('returns null rather than a shape derived from too little history', () => {
    const months: DayCurveMonthSeries[] = [
      { month: '2026-01', days: [{ date: '2026-01-05', cents: 200 }] },
      { month: '2026-02', days: [{ date: '2026-02-05', cents: 200 }] },
      { month: '2026-03', days: [{ date: '2026-03-05', cents: 200 }] },
    ]
    // Three sampled months, minMonths 4: an honest "not yet".
    expect(computeDayCurve(months, 0.5, PARAMS)).toBeNull()
  })

  it('excludes a month with nothing spent from the sample, rather than reading it as a zero fraction', () => {
    // Day 5 (before the day-15 cutoff at progress 0.5) then day 20 (after), split
    // so each month's fraction-by-cutoff is a distinct, hand-checkable value.
    // February has no spend at all and is skipped — a category that took a month
    // off is not evidence its spending arrives at fraction zero.
    const months: DayCurveMonthSeries[] = [
      {
        month: '2026-01',
        days: [
          { date: '2026-01-05', cents: 200 },
          { date: '2026-01-20', cents: 800 },
        ],
      },
      { month: '2026-02', days: [] },
      {
        month: '2026-03',
        days: [
          { date: '2026-03-05', cents: 600 },
          { date: '2026-03-20', cents: 400 },
        ],
      },
      {
        month: '2026-04',
        days: [
          { date: '2026-04-05', cents: 800 },
          { date: '2026-04-20', cents: 200 },
        ],
      },
      {
        month: '2026-05',
        days: [
          { date: '2026-05-05', cents: 400 },
          { date: '2026-05-20', cents: 600 },
        ],
      },
    ]
    const result = computeDayCurve(months, 0.5, PARAMS)
    expect(result?.monthsUsed).toBe(4)
  })

  it('computes the median and IQR by hand: fractions 0.2, 0.4, 0.6, 0.8', () => {
    // Same split as above, without the empty month: cutoff always lands between
    // day 5 and day 20 regardless of the month's length, so the fraction each
    // month contributes is exactly 0.2, 0.4, 0.6 or 0.8.
    const months: DayCurveMonthSeries[] = [
      {
        month: '2026-01',
        days: [
          { date: '2026-01-05', cents: 200 },
          { date: '2026-01-20', cents: 800 },
        ],
      },
      {
        month: '2026-02',
        days: [
          { date: '2026-02-05', cents: 400 },
          { date: '2026-02-20', cents: 600 },
        ],
      },
      {
        month: '2026-03',
        days: [
          { date: '2026-03-05', cents: 600 },
          { date: '2026-03-20', cents: 400 },
        ],
      },
      {
        month: '2026-04',
        days: [
          { date: '2026-04-05', cents: 800 },
          { date: '2026-04-20', cents: 200 },
        ],
      },
    ]
    const result = computeDayCurve(months, 0.5, PARAMS)
    // quantile() interpolates: p50 of [.2,.4,.6,.8] is .5, p75 is .65, p25 is .35.
    expect(result).toEqual({
      medianFractionBp: 5_000,
      dispersionBp: 3_000,
      monthsUsed: 4,
      // 3_000bp of dispersion is above the default 2_500bp gate.
      reliable: false,
    })
  })

  it('clamps a fraction above 1 when a later refund shrinks the eventual total', () => {
    // EUR 10 spent by the cutoff, then a EUR 3 refund after it: the eventual
    // total is only EUR 7, so the naive ratio (10/7) reads as 143% spent.
    const months: DayCurveMonthSeries[] = [
      {
        month: '2026-01',
        days: [
          { date: '2026-01-05', cents: 1_000 },
          { date: '2026-01-20', cents: -300 },
        ],
      },
    ]
    const result = computeDayCurve(months, 0.5, { ...PARAMS, minMonths: 1 })
    expect(result?.medianFractionBp).toBe(10_000)
  })

  it('clamps a fraction below 0 when a refund lands before the cutoff', () => {
    // A EUR 5 refund on day 5, then EUR 10 spent on day 20: nothing but a credit
    // has landed by the cutoff, so the naive ratio (-5/5) is negative.
    const months: DayCurveMonthSeries[] = [
      {
        month: '2026-01',
        days: [
          { date: '2026-01-05', cents: -500 },
          { date: '2026-01-20', cents: 1_000 },
        ],
      },
    ]
    const result = computeDayCurve(months, 0.5, { ...PARAMS, minMonths: 1 })
    expect(result?.medianFractionBp).toBe(0)
  })
})

describe('buildDayCurves', () => {
  const HISTORY = ['2026-01', '2026-02', '2026-03', '2026-04']

  /** One expense (Actual's negative sign) on the 10th of every history month. */
  function monthlyExpense(categoryId: string, cents: number): RecomputedSpendDaily[] {
    return HISTORY.map((month) => ({
      date: `${month}-10`,
      categoryId,
      amountCents: -cents,
    }))
  }

  it('flips Actual\'s sign the same way computeDayCurve expects, agreeing with a hand-built series', () => {
    const daily = monthlyExpense('groceries', 1_000)
    const result = buildDayCurves({
      daily,
      historyMonths: HISTORY,
      month: '2026-05',
      incomeCategoryIds: new Set(),
      progress: 0.5,
      params: PARAMS,
    })

    const bySignExpectation = computeDayCurve(
      HISTORY.map((month) => ({ month, days: [{ date: `${month}-10`, cents: 1_000 }] })),
      0.5,
      PARAMS,
    )
    expect(result.categories.get('groceries')).toEqual(bySignExpectation)
  })

  it('drops uncategorised and income rows before they can shape any curve', () => {
    const daily: RecomputedSpendDaily[] = [
      ...monthlyExpense('groceries', 1_000),
      ...monthlyExpense('salary', 400_000).map((row) => ({ ...row, categoryId: 'salary' })),
      ...HISTORY.map((month) => ({ date: `${month}-10`, categoryId: null, amountCents: -500 })),
    ]
    const result = buildDayCurves({
      daily,
      historyMonths: HISTORY,
      month: '2026-05',
      incomeCategoryIds: new Set(['salary']),
      progress: 0.5,
      params: PARAMS,
    })
    expect([...result.categories.keys()]).toEqual(['groceries'])
  })

  it('fills the months a category has no rows in as empty, rather than throwing on a sparse history', () => {
    // Spend in only the first two of four dense history months: buildDayCurves
    // must still cover the other two with empty days (an excluded, not an
    // erroring, zero-total month) rather than passing a sparse series into
    // computeDayCurve's dense-months assertion.
    const daily: RecomputedSpendDaily[] = [
      { date: '2026-01-10', categoryId: 'haircut', amountCents: -1_000 },
      { date: '2026-02-10', categoryId: 'haircut', amountCents: -1_000 },
    ]
    expect(() =>
      buildDayCurves({
        daily,
        historyMonths: HISTORY,
        month: '2026-05',
        incomeCategoryIds: new Set(),
        progress: 0.5,
        params: PARAMS,
      }),
    ).not.toThrow()
  })

  it('omits a category whose curve came back null, rather than storing it with no value', () => {
    // Same two-month category as above: 2 sampled months against minMonths 4
    // is null, and null results are left out of the map entirely.
    const daily: RecomputedSpendDaily[] = [
      { date: '2026-01-10', categoryId: 'haircut', amountCents: -1_000 },
      { date: '2026-02-10', categoryId: 'haircut', amountCents: -1_000 },
      ...monthlyExpense('groceries', 1_000),
    ]
    const result = buildDayCurves({
      daily,
      historyMonths: HISTORY,
      month: '2026-05',
      incomeCategoryIds: new Set(),
      progress: 0.5,
      params: PARAMS,
    })
    expect(result.categories.has('haircut')).toBe(false)
    expect(result.categories.has('groceries')).toBe(true)
  })

  it("carries the month it was built for, so spend.ts can gate on it the way it gates committed", () => {
    const result = buildDayCurves({
      daily: [],
      historyMonths: HISTORY,
      month: '2026-05',
      incomeCategoryIds: new Set(),
      progress: 0.5,
      params: PARAMS,
    })
    expect(result.month).toBe('2026-05')
    expect(result.categories.size).toBe(0)
  })
})
