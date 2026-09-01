import { describe, expect, it } from 'vitest'
import { capSeverity, FINDING_SPECS } from '../../src/domain/ai/codes.ts'
import type { BaselineResult } from '../../src/domain/aggregate/baseline.ts'
import { hygieneSignals } from '../../src/domain/aggregate/hygiene.ts'
import {
  benchmarkSignals,
  categorySignals,
  sortSignals,
  type Signal,
} from '../../src/domain/aggregate/overspend.ts'
import { DEFAULT_PARAMS } from '../../src/domain/aggregate/params.ts'
import type { MonthlyFact } from '../../src/domain/aggregate/spend.ts'

interface FactOverrides {
  id?: string
  name?: string
  spent?: number
  budgeted?: number
  available?: number
  isIncome?: boolean
  baseline?: Partial<BaselineResult> | null
}

function fact(overrides: FactOverrides = {}): MonthlyFact {
  const spentCents = overrides.spent ?? 0
  const budgetedCents = overrides.budgeted ?? 0
  return {
    month: '2026-01',
    categoryId: overrides.id ?? 'c1',
    categoryName: overrides.name ?? 'Category',
    isIncome: overrides.isIncome ?? false,
    hidden: false,
    spentCents,
    budgetedCents,
    // Defaults to a funded envelope so each test isolates the signal it names.
    // Left at `budgeted - spent` it would be negative whenever a fixture spends
    // from an unassigned category, and over_available would fire — correctly,
    // which is exactly why it has to be opted into rather than arrive by default.
    availableCents: overrides.available ?? 0,
    carryoverEnabled: false,
    txnCount: 1,
    recomputedSpentCents: spentCents,
    baseline: overrides.baseline
      ? {
          baselineCents: 0,
          currentCents: spentCents,
          deltaBp: null,
          monthsUsed: 12,
          windowMonths: 1,
          winsorEffectBp: 0,
          ...overrides.baseline,
        }
      : null,
  }
}

const codes = (signals: readonly Signal[]): string[] => signals.map((signal) => signal.code)

/** A month that is over, which suppresses the burn-rate projection. */
const FINISHED = 1

describe('the four overspend signals stay separate', () => {
  it('reports over_assigned alone when carry-in still covers the envelope', () => {
    // Routine in an envelope budget, and often fine: that is what a carried-over
    // balance is for. Merging this with over_available would cry wolf every month.
    const signals = categorySignals(
      [fact({ spent: 100_000, budgeted: 50_000, available: 20_000 })],
      FINISHED,
      DEFAULT_PARAMS,
    )
    expect(codes(signals)).toEqual(['over_assigned'])
    expect(signals[0]?.metrics).toEqual({
      spentCents: 100_000,
      assignedCents: 50_000,
      overAssignedCents: 50_000,
    })
  })

  it('reports both, unmerged, when the envelope is genuinely in the red', () => {
    const signals = categorySignals(
      [fact({ spent: 100_000, budgeted: 50_000, available: -30_000 })],
      FINISHED,
      DEFAULT_PARAMS,
    )
    expect(codes(signals)).toEqual(['over_available', 'over_assigned'])
    expect(signals[0]?.severity).toBe('alert')
    expect(signals[1]?.severity).toBe('warn')
  })

  it('says nothing when nothing was assigned', () => {
    // Spending from an unassigned category is over_available business, not
    // "you spent more than the zero you assigned", which is true of every euro.
    expect(codes(categorySignals([fact({ spent: 100_000, budgeted: 0, available: 0 })], FINISHED, DEFAULT_PARAMS)))
      .toEqual([])
  })

  it('leaves benchmark comparison unimplemented rather than guessing', () => {
    // The Statbel single-parent model is a later milestone; an empty array keeps
    // every caller written for it correct in the meantime.
    expect(benchmarkSignals()).toEqual([])
    expect(FINDING_SPECS.above_benchmark.maxSeverity).toBe('info')
  })

  it('ignores income, which is judged against its own baseline', () => {
    expect(
      codes(
        categorySignals(
          [fact({ isIncome: true, spent: 300_000, budgeted: 250_000, available: -50_000 })],
          FINISHED,
          DEFAULT_PARAMS,
        ),
      ),
    ).toEqual([])
  })
})

describe('materiality floor', () => {
  it('suppresses an arithmetically true but pointless overspend', () => {
    // A 7 EUR envelope 40% over is 2.80 EUR. Being flagged for it is how someone
    // learns to ignore the whole panel.
    expect(codes(categorySignals([fact({ spent: 980, budgeted: 700 })], FINISHED, DEFAULT_PARAMS)))
      .toEqual([])

    const material = categorySignals(
      [fact({ spent: 5_000, budgeted: 2_000 })],
      FINISHED,
      DEFAULT_PARAMS,
    )
    expect(codes(material)).toContain('over_assigned')
  })

  it('gates the relative baseline signal on the absolute excess too', () => {
    // 100% over a 10 EUR norm is still only 10 EUR.
    const trivial = fact({
      spent: 2_000,
      baseline: { baselineCents: 1_000, currentCents: 2_000, deltaBp: 10_000 },
    })
    expect(codes(categorySignals([trivial], FINISHED, DEFAULT_PARAMS))).toEqual([])
  })
})

describe('baseline signals', () => {
  const withBaseline = (baselineCents: number, currentCents: number): MonthlyFact => {
    const deltaBp = Math.round(((currentCents - baselineCents) / baselineCents) * 10_000)
    return fact({ spent: currentCents, baseline: { baselineCents, currentCents, deltaBp } })
  }

  it('escalates warn to alert at the configured thresholds', () => {
    // Defaults: 2000 bp warns, 5000 bp alerts.
    expect(codes(categorySignals([withBaseline(100_000, 115_000)], FINISHED, DEFAULT_PARAMS))).toEqual([])

    const warn = categorySignals([withBaseline(100_000, 130_000)], FINISHED, DEFAULT_PARAMS)
    expect(warn[0]?.severity).toBe('warn')
    expect(warn[0]?.metrics.deltaBp).toBe(3_000)

    const alert = categorySignals([withBaseline(100_000, 160_000)], FINISHED, DEFAULT_PARAMS)
    expect(alert[0]?.code).toBe('above_baseline')
    expect(alert[0]?.severity).toBe('alert')
    expect(alert[0]?.metrics.excessCents).toBe(60_000)
  })

  it('reports good news as well, so a change that worked is visible', () => {
    const better = categorySignals([withBaseline(100_000, 40_000)], FINISHED, DEFAULT_PARAMS)
    expect(codes(better)).toEqual(['below_baseline'])
    expect(better[0]?.severity).toBe('info')
    expect(better[0]?.metrics.savedCents).toBe(60_000)
    expect(FINDING_SPECS.below_baseline.negative).toBe(false)
  })

  it('calls a first-ever expense irregular rather than infinitely over', () => {
    // deltaBp is null when the norm is zero: this is a new cost, not an overspend.
    const first = fact({ spent: 90_000, baseline: { baselineCents: 0, deltaBp: null } })
    const signals = categorySignals([first], FINISHED, DEFAULT_PARAMS)
    expect(codes(signals)).toEqual(['irregular_expense'])
    expect(signals[0]?.metrics.amountCents).toBe(90_000)
  })

  it('stays quiet while there is not enough history to have a norm', () => {
    expect(codes(categorySignals([fact({ spent: 90_000, baseline: null })], FINISHED, DEFAULT_PARAMS)))
      .toEqual([])
  })
})

describe('burn rate', () => {
  const halfSpent = fact({ spent: 50_000, budgeted: 100_000 })

  it('projects mid-month so the alert can still be acted on', () => {
    // A quarter through the month with half the envelope gone projects to 200%.
    const signals = categorySignals([halfSpent], 0.25, DEFAULT_PARAMS)
    expect(codes(signals)).toEqual(['burn_rate_over'])
    expect(signals[0]?.metrics).toEqual({
      projectedCents: 200_000,
      assignedCents: 100_000,
      spentCents: 50_000,
      projectedOverrunCents: 100_000,
      monthProgressBp: 2_500,
    })
  })

  it('refuses to extrapolate from the first days of the month', () => {
    // Projecting from day two produces a number that is wrong by construction.
    expect(codes(categorySignals([halfSpent], 0.05, DEFAULT_PARAMS))).toEqual([])
  })

  it('does not project a month that is already over', () => {
    // That would just restate over_assigned in more confident language.
    expect(codes(categorySignals([halfSpent], 1, DEFAULT_PARAMS))).toEqual([])
  })

  it('tolerates a small projected overrun', () => {
    // Default tolerance is 1000 bp: 5% over projection is within noise.
    const slightly = fact({ spent: 52_500, budgeted: 100_000 })
    expect(codes(categorySignals([slightly], 0.5, DEFAULT_PARAMS))).toEqual([])

    const clearly = fact({ spent: 60_000, budgeted: 100_000 })
    expect(codes(categorySignals([clearly], 0.5, DEFAULT_PARAMS))).toEqual(['burn_rate_over'])
  })
})

describe('hygiene', () => {
  it('reports one backlog signal for the window, not one per month', () => {
    const signals = hygieneSignals({
      uncategorised: [
        { month: '2026-01', txnCount: 4, amountCents: 12_000 },
        { month: '2026-02', txnCount: 9, amountCents: -3_000 },
      ],
      mismatches: [],
      params: DEFAULT_PARAMS,
    })
    expect(codes(signals)).toEqual(['uncategorised_backlog'])
    // Amounts are summed as magnitudes: a refund cancelling out a charge does not
    // mean there is nothing left to categorise.
    expect(signals[0]?.metrics).toEqual({ count: 13, amountCents: 15_000, months: 2 })
  })

  it('tolerates a handful of uncategorised transactions', () => {
    expect(
      hygieneSignals({
        uncategorised: [{ month: '2026-01', txnCount: 5, amountCents: 100 }],
        mismatches: [],
        params: DEFAULT_PARAMS,
      }),
    ).toEqual([])
  })

  it('reports a recomputation mismatch per category, because that is the lead', () => {
    // A mismatch means one of our own hygiene rules is wrong — most likely a
    // transfer or a split — and the category and month are how it gets found.
    const signals = hygieneSignals({
      uncategorised: [],
      mismatches: [
        {
          month: '2026-01',
          categoryId: 'food',
          categoryName: 'Food',
          actualCents: 40_000,
          recomputedCents: 41_000,
          differenceCents: 1_000,
        },
      ],
      params: DEFAULT_PARAMS,
    })
    expect(signals).toEqual([
      {
        code: 'recompute_mismatch',
        categoryId: 'food',
        categoryName: 'Food',
        severity: 'alert',
        metrics: { differenceCents: 1_000, actualCents: 40_000, recomputedCents: 41_000 },
      },
    ])
  })
})

describe('ordering and the severity ceiling', () => {
  it('sorts alert before warn before info, then by size, then by name', () => {
    const signals: Signal[] = [
      { code: 'below_baseline', categoryId: 'a', categoryName: 'Aaa', severity: 'info', metrics: {} },
      { code: 'over_assigned', categoryId: 'b', categoryName: 'Bbb', severity: 'warn', metrics: { spentCents: 100 } },
      { code: 'over_assigned', categoryId: 'c', categoryName: 'Ccc', severity: 'warn', metrics: { spentCents: 9_000 } },
      { code: 'over_available', categoryId: 'd', categoryName: 'Ddd', severity: 'alert', metrics: {} },
    ]
    expect(sortSignals(signals).map((signal) => signal.categoryId)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('lowers a severity that exceeds what the code may carry', () => {
    // The ceiling in FINDING_SPECS is a rule, not documentation: the model's own
    // output goes through the same function.
    expect(capSeverity('above_benchmark', 'alert')).toBe('info')
    expect(capSeverity('over_assigned', 'alert')).toBe('warn')
    expect(capSeverity('over_available', 'info')).toBe('info')
  })
})
