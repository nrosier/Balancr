/**
 * `savingsContext`/`splitSavingsMonth` (#252): which categories the user has
 * manually tagged `savings` or `investments`, and what a month's worth of
 * their own already-computed facts sums to.
 *
 * The one thing worth a test beyond the arithmetic: a category with neither
 * tag contributes nothing, even when it has spend and a baseline of its own —
 * the aggregate is scoped to the two tags, not to every category in the file.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { categoryMeta } from '../../src/db/schema.ts'
import { savingsContext, splitSavingsMonth } from '../../src/domain/aggregate/savings-context.ts'
import type { BaselineResult } from '../../src/domain/aggregate/baseline.ts'
import type { MonthlyFact } from '../../src/domain/aggregate/spend.ts'

const MONTH = '2026-08'

function baseline(baselineCents: number, currentCents: number): BaselineResult {
  return {
    baselineCents,
    currentCents,
    deltaBp: Math.round(((currentCents - baselineCents) / baselineCents) * 10_000),
    monthsUsed: 6,
    windowMonths: 1,
    winsorEffectBp: null,
  }
}

function fact(id: string, spentCents: number, overrides: Partial<MonthlyFact> = {}): MonthlyFact {
  return {
    month: MONTH,
    categoryId: id,
    categoryName: id,
    isIncome: false,
    hidden: false,
    spentCents,
    budgetedCents: spentCents,
    availableCents: 0,
    carryoverEnabled: false,
    txnCount: 1,
    recomputedSpentCents: spentCents,
    committedCents: 0,
    committedToDateCents: 0,
    committedApproximate: false,
    baseline: null,
    ...overrides,
  }
}

describe('the context, read off the database', () => {
  let ctx: ReturnType<typeof createTestDb>

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
  })

  const meta = (id: string, nature: 'savings' | 'investments' | null): void => {
    ctx.db
      .insert(categoryMeta)
      .values({ categoryId: id, nameSnapshot: id, nature })
      .run()
  }

  it('reads the tags, and sums only the tagged categories', () => {
    meta('emergency-fund', 'savings')
    meta('brokerage', 'investments')
    meta('rent', null)

    const context = savingsContext(ctx.db)
    expect([...context.savings]).toEqual(['emergency-fund'])
    expect([...context.investments]).toEqual(['brokerage'])

    const aggregate = splitSavingsMonth(context, [
      fact('emergency-fund', 20_000, { baseline: baseline(15_000, 20_000) }),
      fact('brokerage', 30_000, { baseline: baseline(25_000, 30_000) }),
      fact('rent', 100_000, { baseline: baseline(100_000, 100_000) }),
    ])

    expect(aggregate).toEqual({
      hasSavings: true,
      hasInvestments: true,
      spentCents: 50_000,
      baselineCents: 40_000,
    })
  })

  it('has no baseline when neither tagged envelope has one yet', () => {
    meta('emergency-fund', 'savings')
    const context = savingsContext(ctx.db)
    const aggregate = splitSavingsMonth(context, [fact('emergency-fund', 20_000)])
    expect(aggregate.baselineCents).toBeNull()
    expect(aggregate.spentCents).toBe(20_000)
  })

  it('falls back to no tags at all on an empty database', () => {
    const context = savingsContext(ctx.db)
    expect(context.savings.size).toBe(0)
    expect(context.investments.size).toBe(0)
    expect(splitSavingsMonth(context, [fact('rent', 100_000)])).toEqual({
      hasSavings: false,
      hasInvestments: false,
      spentCents: 0,
      baselineCents: null,
    })
  })
})
