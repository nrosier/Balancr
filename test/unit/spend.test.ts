import { describe, expect, it } from 'vitest'
import type { RecomputedSpend } from '../../src/adapters/actual/queries.ts'
import { emptyCommitted, type CommittedMonth } from '../../src/domain/aggregate/committed.ts'
import { DEFAULT_PARAMS } from '../../src/domain/aggregate/params.ts'
import { aggregateSpend, type MonthlyFact } from '../../src/domain/aggregate/spend.ts'
import { budgetMonth, history } from '../fixtures/budget.ts'

const NO_FREQUENCIES = new Map<string, never>()

/** Actual's own sign convention: expenses negative, income positive. */
function recomputed(
  month: string,
  categoryId: string | null,
  amountCents: number,
  txnCount = 1,
): RecomputedSpend {
  return { month, categoryId, amountCents, txnCount }
}

describe('aggregateSpend density', () => {
  it('emits a zero row for a month a category saw no activity', () => {
    // The baseline engine refuses a series with holes, and a rolling window over
    // a gap averages across it — so a quiet month must be a real zero.
    const months = history('2026-01', 3, (_, index) =>
      index === 1 ? [{ id: 'rent', spent: 90_000 }] : [{ id: 'rent', spent: 90_000 }, { id: 'gift', spent: 5_000 }],
    )

    const { facts } = aggregateSpend({
      history: months,
      recomputed: [],
      frequencies: NO_FREQUENCIES,
      targetMonths: ['2026-01', '2026-02', '2026-03'],
      params: DEFAULT_PARAMS,
    })

    const gift = facts.filter((fact) => fact.categoryId === 'gift')
    expect(gift.map((fact) => fact.month)).toEqual(['2026-01', '2026-02', '2026-03'])
    expect(gift.map((fact) => fact.spentCents)).toEqual([5_000, 0, 5_000])
  })

  it('refuses a sparse history and a target month it does not cover', () => {
    const sparse = [budgetMonth('2026-01', []), budgetMonth('2026-03', [])]
    expect(() =>
      aggregateSpend({
        history: sparse,
        recomputed: [],
        frequencies: NO_FREQUENCIES,
        targetMonths: ['2026-03'],
        params: DEFAULT_PARAMS,
      }),
    ).toThrow(/budget history must be dense and ascending: 2026-01 is followed by 2026-03/)

    expect(() =>
      aggregateSpend({
        history: [budgetMonth('2026-01', [])],
        recomputed: [],
        frequencies: NO_FREQUENCIES,
        targetMonths: ['2026-02'],
        params: DEFAULT_PARAMS,
      }),
    ).toThrow(/does not contain target month 2026-02/)
  })

  it('keeps a renamed category as one series, under its latest name', () => {
    const months = [
      budgetMonth('2026-01', [{ id: 'c1', name: 'Boodschappen', spent: 40_000 }]),
      budgetMonth('2026-02', [{ id: 'c1', name: 'Groceries', spent: 42_000 }]),
    ]
    const { facts } = aggregateSpend({
      history: months,
      recomputed: [],
      frequencies: NO_FREQUENCIES,
      targetMonths: ['2026-01', '2026-02'],
      params: DEFAULT_PARAMS,
    })
    expect(facts.map((fact) => fact.categoryName)).toEqual(['Groceries', 'Groceries'])
  })

  it('skips a hidden category that has no row in the month at all', () => {
    const months = [
      budgetMonth('2026-01', [{ id: 'old', hidden: true, spent: 1_000 }]),
      budgetMonth('2026-02', [{ id: 'live', spent: 1_000 }]),
    ]
    const { facts } = aggregateSpend({
      history: months,
      recomputed: [],
      frequencies: NO_FREQUENCIES,
      targetMonths: ['2026-02'],
      params: DEFAULT_PARAMS,
    })
    expect(facts.map((fact) => fact.categoryId)).toEqual(['live'])
  })
})

describe('aggregateSpend sign normalisation', () => {
  it('puts our AQL sum on the same scale as Actual, both directions', () => {
    // Actual stores an expense as -400_00 and a salary as +2500_00; the fact
    // table stores spend positive-out and income positive-in, so the two columns
    // can be compared without either caller knowing the convention.
    const months = [
      budgetMonth('2026-01', [
        { id: 'food', spent: 40_000, budgeted: 45_000 },
        { id: 'salary', spent: 250_000, isIncome: true },
      ]),
    ]
    const { facts, mismatches } = aggregateSpend({
      history: months,
      recomputed: [recomputed('2026-01', 'food', -40_000, 12), recomputed('2026-01', 'salary', 250_000, 1)],
      frequencies: NO_FREQUENCIES,
      targetMonths: ['2026-01'],
      params: DEFAULT_PARAMS,
    })

    expect(facts.map((f) => [f.categoryId, f.spentCents, f.recomputedSpentCents, f.txnCount])).toEqual([
      ['food', 40_000, 40_000, 12],
      ['salary', 250_000, 250_000, 1],
    ])
    expect(mismatches).toEqual([])
  })

  it('sums several AQL rows for the same cell instead of keeping the last', () => {
    const months = [budgetMonth('2026-01', [{ id: 'food', spent: 40_000 }])]
    const { facts } = aggregateSpend({
      history: months,
      recomputed: [recomputed('2026-01', 'food', -25_000, 5), recomputed('2026-01', 'food', -15_000, 3)],
      frequencies: NO_FREQUENCIES,
      targetMonths: ['2026-01'],
      params: DEFAULT_PARAMS,
    })
    expect(facts[0]?.recomputedSpentCents).toBe(40_000)
    expect(facts[0]?.txnCount).toBe(8)
  })
})

describe('aggregateSpend cross-check', () => {
  it('reports a difference between Actual and our own sum, signed', () => {
    // Default tolerance is zero cents: a single cent of drift means a hygiene
    // rule is wrong, and that same rule feeds every baseline and finding.
    const months = [budgetMonth('2026-01', [{ id: 'food', name: 'Food', spent: 40_000 }])]
    const { mismatches } = aggregateSpend({
      history: months,
      recomputed: [recomputed('2026-01', 'food', -41_000)],
      frequencies: NO_FREQUENCIES,
      targetMonths: ['2026-01'],
      params: DEFAULT_PARAMS,
    })
    expect(mismatches).toEqual([
      {
        month: '2026-01',
        categoryId: 'food',
        categoryName: 'Food',
        actualCents: 40_000,
        recomputedCents: 41_000,
        differenceCents: 1_000,
      },
    ])
  })

  it('honours a tolerance and stays silent when no AQL row covered the month', () => {
    const months = [budgetMonth('2026-01', [{ id: 'food', spent: 40_000 }])]
    const tolerant = {
      ...DEFAULT_PARAMS,
      hygiene: { ...DEFAULT_PARAMS.hygiene, recomputationToleranceCents: 1_000 },
    }
    expect(
      aggregateSpend({
        history: months,
        recomputed: [recomputed('2026-01', 'food', -41_000)],
        frequencies: NO_FREQUENCIES,
        targetMonths: ['2026-01'],
        params: tolerant,
      }).mismatches,
    ).toEqual([])

    // No row at all is "we did not measure", not "we measured zero" — reporting
    // a 400 EUR mismatch for a month the query never returned would be a lie.
    const unmeasured = aggregateSpend({
      history: months,
      recomputed: [],
      frequencies: NO_FREQUENCIES,
      targetMonths: ['2026-01'],
      params: DEFAULT_PARAMS,
    })
    expect(unmeasured.mismatches).toEqual([])
    expect(unmeasured.facts[0]?.recomputedSpentCents).toBeNull()
  })

  it('collects the uncategorised bucket per month, positive-out', () => {
    const months = history('2026-01', 2, () => [{ id: 'food', spent: 10_000 }])
    const { uncategorised } = aggregateSpend({
      history: months,
      recomputed: [
        recomputed('2026-01', null, -12_000, 4),
        recomputed('2026-01', null, -3_000, 2),
        recomputed('2026-02', null, 500, 1),
      ],
      frequencies: NO_FREQUENCIES,
      targetMonths: ['2026-01', '2026-02'],
      params: DEFAULT_PARAMS,
    })
    expect(uncategorised).toEqual([
      { month: '2026-01', txnCount: 6, amountCents: 15_000 },
      // Net money in: an unassigned refund, or a transfer leg the filter missed.
      { month: '2026-02', txnCount: 1, amountCents: -500 },
    ])
  })

  it('ignores an AQL row for a category none of these months contain', () => {
    const months = [budgetMonth('2026-01', [{ id: 'food', spent: 10_000 }])]
    const { facts, mismatches } = aggregateSpend({
      history: months,
      recomputed: [recomputed('2026-01', 'deleted-long-ago', -9_999)],
      frequencies: NO_FREQUENCIES,
      targetMonths: ['2026-01'],
      params: DEFAULT_PARAMS,
    })
    expect(facts).toHaveLength(1)
    expect(mismatches).toEqual([])
  })
})

describe('aggregateSpend baselines and totals', () => {
  it('carries the frequency-aware baseline through to the fact', () => {
    // 1200 EUR every January for three years. As an annual category that is a
    // 100 EUR/month rate every month; mislabelled monthly it is a yearly alarm.
    const januaryOnly = history('2024-01', 36, (_, index) => [
      { id: 'insurance', spent: index % 12 === 0 ? 120_000 : 0 },
    ])
    const input = {
      history: januaryOnly,
      recomputed: [],
      targetMonths: ['2026-01'],
      params: DEFAULT_PARAMS,
    }

    const annual = aggregateSpend({
      ...input,
      frequencies: new Map([['insurance', 'annual' as const]]),
    })
    expect(annual.facts[0]?.baseline).toMatchObject({ deltaBp: 0, windowMonths: 12 })

    const monthly = aggregateSpend({ ...input, frequencies: NO_FREQUENCIES })
    expect(monthly.facts[0]?.baseline?.deltaBp).toBeGreaterThan(1_000_000)
  })

  it('reports Actual own totals and a savings rate, null when income is zero', () => {
    const months = [
      budgetMonth(
        '2026-01',
        [
          { id: 'salary', spent: 300_000, isIncome: true },
          { id: 'food', spent: 60_000, budgeted: 55_000 },
        ],
        { toBudgetCents: 12_345, fromLastMonthCents: 9_000 },
      ),
      budgetMonth('2026-02', [{ id: 'food', spent: 10_000, budgeted: 55_000 }]),
    ]
    const { totals } = aggregateSpend({
      history: months,
      recomputed: [],
      frequencies: NO_FREQUENCIES,
      targetMonths: ['2026-01', '2026-02'],
      params: DEFAULT_PARAMS,
    })

    expect(totals[0]).toEqual({
      month: '2026-01',
      incomeCents: 300_000,
      spentCents: 60_000,
      budgetedCents: 55_000,
      toBudgetCents: 12_345,
      fromLastMonthCents: 9_000,
      balanceCents: -5_000,
      savingsRateBp: 8_000,
      // No `committed` passed, so every committed figure is zero — which is what
      // makes an install without schedules behave exactly as it did before (#159).
      committedCents: 0,
      committedUnallocatedCents: 0,
      committedUnallocatedCount: 0,
      committedApproximate: false,
    })
    // A month whose salary lands on the 1st of the next one has no savings rate,
    // rather than an infinitely negative one.
    expect(totals[1]?.savingsRateBp).toBeNull()
  })

  it('is deterministic in month and category order', () => {
    const months = [
      budgetMonth('2026-01', [{ id: 'zebra' }, { id: 'apple' }]),
      budgetMonth('2026-02', [{ id: 'apple' }, { id: 'zebra' }]),
    ]
    const { facts } = aggregateSpend({
      history: months,
      recomputed: [],
      frequencies: NO_FREQUENCIES,
      // Deliberately out of order: a golden test on "the first fact" must not
      // depend on how the caller happened to list the months.
      targetMonths: ['2026-02', '2026-01'],
      params: DEFAULT_PARAMS,
    })
    expect(facts.map((fact) => `${fact.month}/${fact.categoryId}`)).toEqual([
      '2026-01/apple',
      '2026-01/zebra',
      '2026-02/apple',
      '2026-02/zebra',
    ])
  })
})

describe('aggregateSpend and what is still to come (#159)', () => {
  const MONTHS = [
    budgetMonth('2026-01', [
      { id: 'salary', spent: 300_000, isIncome: true },
      { id: 'rent', spent: 90_000, budgeted: 90_000 },
      { id: 'food', spent: 40_000, budgeted: 55_000 },
    ]),
    budgetMonth('2026-02', [{ id: 'food', spent: 10_000, budgeted: 55_000 }]),
  ]

  /** What `committedForMonth` produces for January, with one loose end in it. */
  const january = (): CommittedMonth => ({
    month: '2026-01',
    categories: new Map([
      ['food', { remainingCents: 12_000, toDateCents: 4_000, occurrences: 2, approximate: true }],
      // An income category, which `committedForMonth` never produces — asserted below
      // because the guard against it lives here rather than there.
      ['salary', { remainingCents: 250_000, toDateCents: 0, occurrences: 1, approximate: false }],
    ]),
    unallocatedCents: 3_000,
    unallocatedCount: 1,
    totalCents: 15_000,
    approximate: true,
  })

  const run = (committed: CommittedMonth | null) =>
    aggregateSpend({
      history: MONTHS,
      recomputed: [],
      frequencies: NO_FREQUENCIES,
      targetMonths: ['2026-01', '2026-02'],
      params: DEFAULT_PARAMS,
      committed,
    })

  const factFor = (facts: readonly MonthlyFact[], month: string, categoryId: string) =>
    facts.find((fact) => fact.month === month && fact.categoryId === categoryId)

  it('puts a category figure on the fact, beside spend rather than inside it', () => {
    // `spentCents` staying byte-identical to Actual's own figure is the property that
    // makes every other number here believable.
    const fact = factFor(run(january()).facts, '2026-01', 'food')
    expect(fact?.spentCents).toBe(40_000)
    expect(fact?.committedCents).toBe(12_000)
    expect(fact?.committedToDateCents).toBe(4_000)
    expect(fact?.committedApproximate).toBe(true)
  })

  it('leaves a category nothing is scheduled against at zero', () => {
    const fact = factFor(run(january()).facts, '2026-01', 'rent')
    expect(fact?.committedCents).toBe(0)
    expect(fact?.committedToDateCents).toBe(0)
    expect(fact?.committedApproximate).toBe(false)
  })

  it('never attributes a commitment to income', () => {
    // Money arriving is not a commitment, and the burn-rate projection would read it
    // backwards: an envelope cannot be short of being paid.
    const fact = factFor(run(january()).facts, '2026-01', 'salary')
    expect(fact?.committedCents).toBe(0)
  })

  it('states the month total separately, unallocated money included', () => {
    // Deliberately not the sum of the category figures above: a schedule no rule
    // assigns a category to is counted here and nowhere else, which is what the
    // unallocated line on screen exists to explain.
    const { totals } = run(january())
    expect(totals[0]).toMatchObject({
      month: '2026-01',
      committedCents: 15_000,
      committedUnallocatedCents: 3_000,
      committedUnallocatedCount: 1,
      committedApproximate: true,
    })
  })

  it('ignores a committed month that is not the month being aggregated', () => {
    // The figure is a function of today, so it belongs to exactly one month. February
    // gets zeros rather than January's schedules a second time.
    const { facts, totals } = run(january())
    expect(factFor(facts, '2026-02', 'food')?.committedCents).toBe(0)
    expect(totals[1]).toMatchObject({
      committedCents: 0,
      committedUnallocatedCents: 0,
      committedUnallocatedCount: 0,
      committedApproximate: false,
    })
  })

  it('reads no schedules at all as zero everywhere', () => {
    for (const committed of [null, emptyCommitted('2026-01')]) {
      const { facts, totals } = run(committed)
      expect(facts.every((fact) => fact.committedCents === 0)).toBe(true)
      expect(totals.every((month) => month.committedCents === 0)).toBe(true)
    }
  })
})
