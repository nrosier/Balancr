/**
 * `monthFingerprint` only has one job: move when a fact `signals.ts` cares about
 * moves, and stay put when something outside its scope does (#162). Every test
 * here is really about the boundary of that scope, not the hash itself.
 */
import { describe, expect, it } from 'vitest'
import { monthFingerprint } from '../../src/domain/aggregate/fingerprint.ts'
import type { MonthlyFact, MonthTotals } from '../../src/domain/aggregate/spend.ts'

function fact(overrides: Partial<MonthlyFact> = {}): MonthlyFact {
  return {
    month: '2026-08',
    categoryId: 'cat-groceries',
    categoryName: 'Groceries',
    isIncome: false,
    hidden: false,
    spentCents: 12_345,
    budgetedCents: 15_000,
    availableCents: 2_655,
    carryoverEnabled: true,
    txnCount: 7,
    recomputedSpentCents: 12_345,
    committedCents: 0,
    committedToDateCents: 0,
    committedApproximate: false,
    baseline: null,
    ...overrides,
  }
}

function totals(overrides: Partial<MonthTotals> = {}): MonthTotals {
  return {
    month: '2026-08',
    incomeCents: 250_000,
    spentCents: 180_000,
    budgetedCents: 200_000,
    toBudgetCents: 20_000,
    fromLastMonthCents: 5_000,
    balanceCents: 70_000,
    savingsRateBp: 2_800,
    committedCents: 0,
    committedUnallocatedCents: 0,
    committedUnallocatedCount: 0,
    committedApproximate: false,
    ...overrides,
  }
}

describe('monthFingerprint', () => {
  it('is deterministic: the same facts and totals hash the same', () => {
    const facts = [fact()]
    expect(monthFingerprint(facts, totals())).toBe(monthFingerprint(facts, totals()))
  })

  it('does not depend on the order facts are passed in', () => {
    const a = fact({ categoryId: 'cat-groceries' })
    const b = fact({ categoryId: 'cat-rent' })
    expect(monthFingerprint([a, b], totals())).toBe(monthFingerprint([b, a], totals()))
  })

  it.each([
    ['spentCents', { spentCents: 99_999 }],
    ['budgetedCents', { budgetedCents: 1 }],
    ['availableCents', { availableCents: -500 }],
    ['carryoverEnabled', { carryoverEnabled: false }],
    ['txnCount', { txnCount: 8 }],
  ] as const)('changing a fact\'s %s moves the hash', (_field, override) => {
    const before = monthFingerprint([fact()], totals())
    const after = monthFingerprint([fact(override)], totals())
    expect(after).not.toBe(before)
  })

  it.each([
    ['incomeCents', { incomeCents: 1 }],
    ['spentCents', { spentCents: 1 }],
    ['budgetedCents', { budgetedCents: 1 }],
    ['toBudgetCents', { toBudgetCents: 1 }],
    ['fromLastMonthCents', { fromLastMonthCents: 1 }],
    ['balanceCents', { balanceCents: 1 }],
    ['savingsRateBp', { savingsRateBp: 0 }],
  ] as const)('changing totals\' %s moves the hash', (_field, override) => {
    const before = monthFingerprint([fact()], totals())
    const after = monthFingerprint([fact()], totals(override))
    expect(after).not.toBe(before)
  })

  it('ignores a fact\'s baseline, which is a norm over history and not a fact about this month', () => {
    const before = monthFingerprint([fact()], totals())
    const after = monthFingerprint(
      [
        fact({
          baseline: {
            baselineCents: 1_000,
            currentCents: 1_200,
            deltaBp: 2_000,
            monthsUsed: 6,
            windowMonths: 12,
            winsorEffectBp: null,
          },
        }),
      ],
      totals(),
    )
    expect(after).toBe(before)
  })

  it('ignores a fact\'s committed figures, which are a function of today rather than of what changed', () => {
    const before = monthFingerprint([fact()], totals())
    const after = monthFingerprint(
      [fact({ committedCents: 5_000, committedToDateCents: 2_000, committedApproximate: true })],
      totals(),
    )
    expect(after).toBe(before)
  })

  it('ignores totals\' committed figures for the same reason', () => {
    const before = monthFingerprint([fact()], totals())
    const after = monthFingerprint(
      [fact()],
      totals({
        committedCents: 5_000,
        committedUnallocatedCents: 1_000,
        committedUnallocatedCount: 2,
        committedApproximate: true,
      }),
    )
    expect(after).toBe(before)
  })

  it('ignores a fact\'s category name and income/hidden flags, which are dimensions rather than figures', () => {
    const before = monthFingerprint([fact()], totals())
    const after = monthFingerprint(
      [fact({ categoryName: 'Renamed', isIncome: true, hidden: true })],
      totals(),
    )
    expect(after).toBe(before)
  })
})
