/**
 * `computeSignals` is the seam between the producers and everything that reads
 * them, so what is tested here is the wiring rather than any individual signal —
 * those have their own tests in `signals.test.ts`.
 *
 * Two guarantees carry the weight:
 *
 *  - **Every producer is actually called.** A producer that exists but is never
 *    run fails no test and produces no finding; nobody notices a finding that is
 *    missing, which is the same failure `ai-render.test.ts` exists to prevent one
 *    layer down.
 *  - **The window and the month agree.** A trailing series that does not end at
 *    the month being judged would have the household signals describe a different
 *    month from the categories, on the same page, with no way to tell.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../../src/domain/aggregate/params.ts'
import type { DriftPersistence } from '../../src/domain/advice/persistence.ts'
import { computeSignals, type SignalInput } from '../../src/domain/aggregate/signals.ts'
import type { MonthlyFact, MonthTotals } from '../../src/domain/aggregate/spend.ts'

function totals(month: string, overrides: Partial<MonthTotals> = {}): MonthTotals {
  return {
    month,
    incomeCents: 380_000,
    spentCents: 300_000,
    budgetedCents: 300_000,
    toBudgetCents: 0,
    fromLastMonthCents: 0,
    balanceCents: 80_000,
    savingsRateBp: 2_105,
    committedCents: 0,
    committedUnallocatedCents: 0,
    committedUnallocatedCount: 0,
    committedApproximate: false,
    ...overrides,
  }
}

function fact(overrides: Partial<MonthlyFact> = {}): MonthlyFact {
  return {
    month: '2026-03',
    categoryId: 'food',
    categoryName: 'Food',
    isIncome: false,
    hidden: false,
    spentCents: 40_000,
    budgetedCents: 40_000,
    availableCents: 0,
    carryoverEnabled: false,
    txnCount: 6,
    recomputedSpentCents: 40_000,
    committedCents: 0,
    committedToDateCents: 0,
    committedApproximate: false,
    baseline: null,
    ...overrides,
  }
}

function input(overrides: Partial<SignalInput> = {}): SignalInput {
  return {
    month: '2026-03',
    today: '2026-03-31',
    // A finished month, so nothing here depends on the burn-rate projection.
    monthProgress: 1,
    facts: [],
    totalsHistory: [totals('2026-01'), totals('2026-02'), totals('2026-03')],
    netWorth: null,
    netWorthHistory: [],
    uncategorised: [],
    mismatches: [],
    accounts: [],
    latestPortfolioSnapshot: null,
    // No benchmark file in a unit fixture: the comparison is a caller's input here
    // precisely because it reads a YAML and a settings row, neither of which this
    // orchestrator should have to have on disk to be tested.
    benchmark: { kind: 'unavailable', reason: 'no_file', mappedShareBp: null },
    // Nothing flagged as shared, for the same reason: the split is a caller's input.
    custody: { kind: 'unavailable', reason: 'no_shared', paidCents: null },
    drift: null,
    params: DEFAULT_PARAMS,
    ...overrides,
  }
}

const codes = (result: { signals: readonly { code: string }[] }): string[] =>
  result.signals.map((signal) => signal.code)

/**
 * Equities over their ceiling for three month ends.
 *
 * Written out rather than run through `driftPersistence`, so a change in how the count is
 * derived cannot make this test pass or fail: what is being tested here is that the
 * producer is called at all.
 */
const drifted: DriftPersistence = {
  profile: 'balanced',
  isPreset: true,
  monthsObserved: 3,
  lines: [
    {
      assetClass: 'EQUITY',
      valueCents: 3_600_000,
      shareBp: 8_500,
      minBp: 5_500,
      targetBp: 6_500,
      maxBp: 7_500,
      driftBp: -2_000,
      state: 'above',
      outsideBp: 1_000,
      gapCents: -720_000,
      monthsOutside: 3,
    },
  ],
}

describe('the window has to match the month', () => {
  it('throws when the history ends somewhere else', () => {
    expect(() =>
      computeSignals(input({ totalsHistory: [totals('2026-01'), totals('2026-02')] })),
    ).toThrow(/must end at 2026-03/)
  })

  it('throws on an empty history rather than judging a month with no totals', () => {
    expect(() => computeSignals(input({ totalsHistory: [] }))).toThrow(/\(empty\)/)
  })

  it('throws on a gap, naming both sides of it', () => {
    expect(() =>
      computeSignals(input({ totalsHistory: [totals('2026-01'), totals('2026-03')] })),
    ).toThrow(/2026-01 is followed by 2026-03, expected 2026-02/)
  })

  it('accepts a window of exactly one month', () => {
    // The first month a budget exists has no history, and it must still be
    // judgeable — the household producers simply have nothing to compare against.
    expect(() => computeSignals(input({ totalsHistory: [totals('2026-03')] }))).not.toThrow()
  })
})

describe('every producer is wired in', () => {
  it('runs the category producers', () => {
    const result = computeSignals(
      input({ facts: [fact({ spentCents: 52_000, availableCents: -12_000 })] }),
    )
    expect(codes(result)).toContain('over_available')
  })

  it('runs the household producers', () => {
    const result = computeSignals(
      input({
        totalsHistory: [
          totals('2026-01'),
          totals('2026-02'),
          // A savings rate of 2,6% against the default 15% target.
          totals('2026-03', { spentCents: 370_000, balanceCents: 10_000, savingsRateBp: 263 }),
        ],
      }),
    )
    expect(codes(result)).toContain('savings_rate_low')
  })

  it('runs the hygiene producers and returns their score', () => {
    const result = computeSignals(
      input({
        uncategorised: [{ month: '2026-03', txnCount: 40, amountCents: 90_000 }],
        accounts: [
          { accountId: 'a1', name: 'Current', lastReconciled: null, closed: false },
        ],
      }),
    )
    expect(codes(result)).toContain('uncategorised_backlog')
    expect(codes(result)).toContain('unreconciled_account')
    // The score is the hygiene producer's, not recomputed here: two figures for
    // "can these numbers be trusted" that can disagree is worse than one.
    expect(result.hygiene.scoreBp).toBeLessThan(10_000)
    expect(result.hygiene.deductions.map((d) => d.reason).sort()).toEqual([
      'uncategorised',
      'unreconciled',
    ])
  })

  it('runs the drift producer', () => {
    const result = computeSignals(input({ drift: drifted }))
    expect(codes(result)).toContain('drift_above_band')
  })

  it('says nothing about a portfolio the caller did not pass', () => {
    // Null is the normal case: a drift belongs to the month the snapshot falls in, and
    // the pass judges twelve. If this ever started producing a finding on its own it
    // would mean the orchestrator had gone reading, which is the one thing it must not
    // do — `benchmark` and `custody` arrive pre-computed for the same reason.
    const result = computeSignals(input({ drift: null }))
    expect(codes(result)).not.toContain('drift_above_band')
    expect(codes(result)).not.toContain('drift_below_band')
  })

  it('scores a clean month at full marks', () => {
    const result = computeSignals(input())
    expect(result.hygiene).toEqual({ scoreBp: 10_000, deductions: [] })
  })
})

describe('what comes back', () => {
  it('is sorted by severity, so an alert is never below an info', () => {
    const result = computeSignals(
      input({
        facts: [
          fact({ spentCents: 52_000, availableCents: -12_000 }),
          fact({
            categoryId: 'rent',
            categoryName: 'Rent',
            spentCents: 30_000,
            budgetedCents: 20_000,
          }),
        ],
        mismatches: [
          {
            month: '2026-03',
            categoryId: 'food',
            categoryName: 'Food',
            actualCents: 40_000,
            recomputedCents: 41_000,
            differenceCents: 1_000,
          },
        ],
      }),
    )
    const severities = result.signals.map((signal) => signal.severity)
    const rank = { alert: 0, warn: 1, info: 2 } as const
    expect(severities.map((s) => rank[s])).toEqual([...severities.map((s) => rank[s])].sort())
  })

  it('is not capped, because a cap is a display decision', () => {
    // Thirty categories over their assignment produce thirty signals. Trimming
    // here would mean a threshold change rewrote what a stored month contained.
    const facts = Array.from({ length: 30 }, (_, index) =>
      fact({
        categoryId: `c${index}`,
        categoryName: `Category ${index}`,
        spentCents: 60_000,
        budgetedCents: 40_000,
      }),
    )
    expect(computeSignals(input({ facts })).signals.length).toBeGreaterThanOrEqual(30)
  })
})
