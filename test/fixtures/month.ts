/**
 * One month in the database, built from the smallest set of writes that makes it
 * real: totals, category metadata, facts, mismatches and a judged signals row.
 *
 * Shared rather than copied per test file because the shape of a `MonthlyFact` is
 * the thing most likely to change, and a fixture that only exists in one test file
 * is a fixture the next test file quietly reinvents with different numbers — at
 * which point two tests disagree about what an ordinary month looks like.
 *
 * `seedMonth` deliberately goes through the real persistence functions instead of
 * inserting rows. A fixture that wrote its own SQL could set up a state the
 * aggregation layer cannot actually produce.
 */
import type { Db } from '../../src/db/index.ts'
import { persistFacts, syncCategoryMeta } from '../../src/domain/aggregate/facts.ts'
import { persistMismatches, persistMonthTotals } from '../../src/domain/aggregate/month-store.ts'
import { persistSignals } from '../../src/domain/aggregate/signals-store.ts'
import type { HygieneScore } from '../../src/domain/aggregate/hygiene.ts'
import type { Signal } from '../../src/domain/aggregate/overspend.ts'
import type {
  MonthlyFact,
  MonthTotals,
  RecomputeMismatch,
  UncategorisedBucket,
} from '../../src/domain/aggregate/spend.ts'

/** A month with nothing wrong with it: full marks, no deductions. */
export const clean: HygieneScore = { scoreBp: 10_000, deductions: [] }

export function totals(month: string, overrides: Partial<MonthTotals> = {}): MonthTotals {
  return {
    month,
    incomeCents: 380_000,
    spentCents: 310_000,
    budgetedCents: 320_000,
    toBudgetCents: 0,
    fromLastMonthCents: 12_000,
    balanceCents: 70_000,
    savingsRateBp: 1_842,
    committedCents: 0,
    committedUnallocatedCents: 0,
    committedUnallocatedCount: 0,
    committedApproximate: false,
    ...overrides,
  }
}

export function fact(month: string, id: string, overrides: Partial<MonthlyFact> = {}): MonthlyFact {
  return {
    month,
    categoryId: id,
    categoryName: id,
    isIncome: false,
    hidden: false,
    spentCents: 10_000,
    budgetedCents: 12_000,
    availableCents: 2_000,
    carryoverEnabled: false,
    txnCount: 3,
    recomputedSpentCents: 10_000,
    committedCents: 0,
    committedToDateCents: 0,
    committedApproximate: false,
    baseline: null,
    ...overrides,
  }
}

export interface SeedMonthOptions {
  facts?: readonly MonthlyFact[]
  uncategorised?: readonly UncategorisedBucket[]
  mismatches?: readonly RecomputeMismatch[]
  signals?: readonly Signal[]
  hygiene?: HygieneScore
  /** False leaves the month un-judged, which is how a bundle comes back null. */
  judged?: boolean
}

/** A month with facts, totals and a hygiene row — the minimum for a bundle. */
export function seedMonth(db: Db, month: string, opts: SeedMonthOptions = {}): void {
  const facts = opts.facts ?? [fact(month, 'food'), fact(month, 'rent')]
  persistMonthTotals(db, [totals(month)], opts.uncategorised ?? [])
  syncCategoryMeta(db, facts)
  persistFacts(db, facts, [month])
  persistMismatches(db, opts.mismatches ?? [], [month])
  if (opts.judged !== false) {
    persistSignals(db, month, opts.signals ?? [], opts.hygiene ?? clean)
  }
}
