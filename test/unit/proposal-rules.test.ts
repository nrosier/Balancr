import { describe, expect, it } from 'vitest'
import type { BaselineResult } from '../../src/domain/aggregate/baseline.ts'
import type { Signal } from '../../src/domain/aggregate/overspend.ts'
import {
  suggestBudgetAmounts,
  suggestCategoryForPayee,
} from '../../src/domain/aggregate/proposal-rules.ts'
import type { MonthlyFact } from '../../src/domain/aggregate/spend.ts'

interface FactOverrides {
  id?: string
  budgeted?: number
  baseline?: Partial<BaselineResult> | null
}

function fact(overrides: FactOverrides = {}): MonthlyFact {
  return {
    month: '2026-01',
    categoryId: overrides.id ?? 'c1',
    categoryName: 'Category',
    isIncome: false,
    hidden: false,
    spentCents: 0,
    budgetedCents: overrides.budgeted ?? 0,
    availableCents: 0,
    carryoverEnabled: false,
    txnCount: 1,
    recomputedSpentCents: 0,
    committedCents: 0,
    committedToDateCents: 0,
    committedApproximate: false,
    baseline:
      overrides.baseline === null
        ? null
        : {
            baselineCents: 0,
            currentCents: 0,
            deltaBp: null,
            monthsUsed: 12,
            windowMonths: 1,
            winsorEffectBp: 0,
            ...overrides.baseline,
          },
  }
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    code: 'over_available',
    categoryId: 'c1',
    categoryName: 'Category',
    severity: 'alert',
    metrics: {},
    ...overrides,
  }
}

describe('suggestCategoryForPayee', () => {
  it('suggests the majority category once samples and confidence both clear the bar', () => {
    const history = [
      { categoryId: 'groceries' },
      { categoryId: 'groceries' },
      { categoryId: 'groceries' },
      { categoryId: 'groceries' },
      { categoryId: 'other' },
    ]
    expect(suggestCategoryForPayee(history)).toEqual({ categoryId: 'groceries' })
  })

  it('refuses below the minimum sample count, however unanimous', () => {
    // A single prior transaction is not a history — it is a coincidence.
    expect(suggestCategoryForPayee([{ categoryId: 'groceries' }])).toBeNull()
  })

  it('refuses below the confidence threshold even with enough samples', () => {
    const history = [
      { categoryId: 'groceries' },
      { categoryId: 'groceries' },
      { categoryId: 'other' },
      { categoryId: 'other' },
    ]
    expect(suggestCategoryForPayee(history)).toBeNull()
  })

  it('ignores uncategorised entries in both the sample count and the vote', () => {
    const history = [{ categoryId: null }, { categoryId: null }, { categoryId: 'groceries' }]
    expect(suggestCategoryForPayee(history)).toBeNull()
  })

  it('respects overridden minSamples and minConfidence', () => {
    const history = [{ categoryId: 'groceries' }, { categoryId: 'other' }]
    expect(suggestCategoryForPayee(history, { minSamples: 2, minConfidence: 0.5 })).toEqual({
      categoryId: 'groceries',
    })
  })
})

describe('suggestBudgetAmounts', () => {
  // No trailing history: falls back to the rounded baseline, same as before #220.
  const noHistory = new Map<string, readonly number[]>()

  it('falls back to the rounded baseline when there is no trailing spend history', () => {
    const facts = [fact({ id: 'c1', budgeted: 5_000, baseline: { baselineCents: 8_070 } })]
    const signals = [signal({ code: 'over_available', categoryId: 'c1' })]
    expect(suggestBudgetAmounts(signals, facts, noHistory)).toEqual([{ categoryId: 'c1', amountCents: 8_100 }])
  })

  it('also triggers on above_baseline', () => {
    const facts = [fact({ id: 'c1', budgeted: 5_000, baseline: { baselineCents: 8_070 } })]
    const signals = [signal({ code: 'above_baseline', categoryId: 'c1' })]
    expect(suggestBudgetAmounts(signals, facts, noHistory)).toEqual([{ categoryId: 'c1', amountCents: 8_100 }])
  })

  it('ignores signal codes that are not about budget calibration', () => {
    const facts = [fact({ id: 'c1', budgeted: 5_000, baseline: { baselineCents: 8_070 } })]
    const signals = [signal({ code: 'over_assigned', categoryId: 'c1' })]
    expect(suggestBudgetAmounts(signals, facts, noHistory)).toEqual([])
  })

  it('skips a category already at the rounded baseline — no reason to propose a no-op', () => {
    const facts = [fact({ id: 'c1', budgeted: 8_100, baseline: { baselineCents: 8_070 } })]
    const signals = [signal({ code: 'over_available', categoryId: 'c1' })]
    expect(suggestBudgetAmounts(signals, facts, noHistory)).toEqual([])
  })

  it('skips a category with no baseline yet', () => {
    const facts = [fact({ id: 'c1', budgeted: 5_000, baseline: null })]
    const signals = [signal({ code: 'over_available', categoryId: 'c1' })]
    expect(suggestBudgetAmounts(signals, facts, noHistory)).toEqual([])
  })

  it('skips a household-level signal with no category', () => {
    const facts = [fact({ id: 'c1', budgeted: 5_000, baseline: { baselineCents: 8_070 } })]
    const signals = [signal({ code: 'over_available', categoryId: null, categoryName: null })]
    expect(suggestBudgetAmounts(signals, facts, noHistory)).toEqual([])
  })

  it('skips a category the facts list has nothing for', () => {
    const facts: MonthlyFact[] = []
    const signals = [signal({ code: 'over_available', categoryId: 'c1' })]
    expect(suggestBudgetAmounts(signals, facts, noHistory)).toEqual([])
  })

  it('proposes at most one suggestion per category, even with duplicate signals', () => {
    const facts = [fact({ id: 'c1', budgeted: 5_000, baseline: { baselineCents: 8_070 } })]
    const signals = [
      signal({ code: 'over_available', categoryId: 'c1' }),
      signal({ code: 'above_baseline', categoryId: 'c1' }),
    ]
    expect(suggestBudgetAmounts(signals, facts, noHistory)).toHaveLength(1)
  })

  it('weights the last 3 months of trailing spend at 60% against the other 9 at 40% (#220)', () => {
    const facts = [fact({ id: 'c1', budgeted: 5_000, baseline: { baselineCents: 8_070 } })]
    const signals = [signal({ code: 'over_available', categoryId: 'c1' })]
    // 9 older months at 10_000, 3 recent months at 20_000: 20_000*0.6 + 10_000*0.4 = 16_000.
    const history = [...Array(9).fill(10_000), ...Array(3).fill(20_000)]
    const trends = new Map([['c1', history]])
    expect(suggestBudgetAmounts(signals, facts, trends)).toEqual([{ categoryId: 'c1', amountCents: 16_000 }])
  })

  it('averages the recent months alone when there is not yet 12 months of history', () => {
    const facts = [fact({ id: 'c1', budgeted: 5_000, baseline: { baselineCents: 8_070 } })]
    const signals = [signal({ code: 'over_available', categoryId: 'c1' })]
    // Only 2 months of history at all, both within the 3-month "recent" window.
    const trends = new Map([['c1', [12_000, 18_000]]])
    expect(suggestBudgetAmounts(signals, facts, trends)).toEqual([{ categoryId: 'c1', amountCents: 15_000 }])
  })
})
