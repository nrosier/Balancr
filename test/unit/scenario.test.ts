/**
 * `scenarioBaseline` reads the same two tables `projectCashflow` does — category
 * facts (for the investments-tagged baseline) and a net-worth snapshot (for the
 * starting value) — so this test builds them by hand the same way
 * `forecast.test.ts` does. `projectScenario` is pure and needs no database at all.
 */
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { categoryMeta } from '../../src/db/schema.ts'
import { loadAccountMap, syncAccountMap } from '../../src/domain/aggregate/accounts.ts'
import { persistFacts, syncCategoryMeta } from '../../src/domain/aggregate/facts.ts'
import { persistMonthTotals } from '../../src/domain/aggregate/month-store.ts'
import { computeNetWorth, type AccountValue } from '../../src/domain/aggregate/networth.ts'
import { persistNetWorth } from '../../src/domain/aggregate/networth-store.ts'
import { projectScenario, scenarioBaseline } from '../../src/domain/aggregate/scenario.ts'
import type { MonthlyFact, MonthTotals } from '../../src/domain/aggregate/spend.ts'

const ANCHOR = '2026-08'

let ctx: ReturnType<typeof createTestDb>
let ids: Record<string, string>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  syncAccountMap(ctx.db, [{ source: 'ghostfolio', externalId: 'broker', name: 'Broker' }])
  ids = Object.fromEntries(loadAccountMap(ctx.db).map((row) => [row.externalId, row.id]))
})

function fact(month: string, id: string, overrides: Partial<MonthlyFact> = {}): MonthlyFact {
  return {
    month,
    categoryId: id,
    categoryName: id,
    isIncome: false,
    hidden: false,
    spentCents: 0,
    budgetedCents: 0,
    availableCents: 0,
    carryoverEnabled: false,
    txnCount: 0,
    recomputedSpentCents: 0,
    committedCents: 0,
    committedToDateCents: 0,
    committedApproximate: false,
    baseline: null,
    dayCurve: null,
    ...overrides,
  }
}

type Nature = 'fixed' | 'variable' | 'discretionary' | 'income' | 'savings' | 'investments'

function classify(id: string, nature: Nature | null): void {
  ctx.db.update(categoryMeta).set({ nature }).where(eq(categoryMeta.categoryId, id)).run()
}

function seedMonth(overrides: Partial<MonthTotals> = {}): void {
  persistMonthTotals(
    ctx.db,
    [
      {
        month: ANCHOR,
        incomeCents: 0,
        spentCents: 0,
        budgetedCents: 0,
        toBudgetCents: 0,
        fromLastMonthCents: 0,
        balanceCents: 0,
        savingsRateBp: null,
        committedCents: 0,
        committedUnallocatedCents: 0,
        committedUnallocatedCount: 0,
        committedApproximate: false,
        ...overrides,
      },
    ],
    [],
  )
}

function seedNetWorth(investedCents: number): void {
  persistNetWorth(
    ctx.db,
    computeNetWorth(`${ANCHOR}-28`, [
      {
        accountMapId: ids.broker as string,
        source: 'ghostfolio',
        externalId: 'broker',
        name: 'broker',
        kind: 'investment',
        valueCents: investedCents,
        includeInNetWorth: true,
        dedupeGroup: null,
        isSourceOfTruth: true,
      } satisfies AccountValue,
    ]),
  )
}

describe('scenarioBaseline', () => {
  it('is entirely null before the first aggregation pass', () => {
    expect(scenarioBaseline(ctx.db)).toEqual({
      month: null,
      baselineCents: null,
      snapshotDate: null,
      startingValueCents: null,
    })
  })

  it('sums the baseline across every category tagged investments', () => {
    seedMonth()
    const brokerDeposit = fact(ANCHOR, 'broker-deposit', {
      baseline: { baselineCents: 20_000, currentCents: 20_000, deltaBp: 0, monthsUsed: 6, windowMonths: 1, winsorEffectBp: 0 },
    })
    const pension = fact(ANCHOR, 'pension', {
      baseline: { baselineCents: 5_000, currentCents: 5_000, deltaBp: 0, monthsUsed: 6, windowMonths: 1, winsorEffectBp: 0 },
    })
    const groceries = fact(ANCHOR, 'groceries', {
      baseline: { baselineCents: 60_000, currentCents: 60_000, deltaBp: 0, monthsUsed: 6, windowMonths: 1, winsorEffectBp: 0 },
    })
    syncCategoryMeta(ctx.db, [brokerDeposit, pension, groceries])
    persistFacts(ctx.db, [brokerDeposit, pension, groceries], [ANCHOR])
    classify('broker-deposit', 'investments')
    classify('pension', 'investments')
    classify('groceries', 'variable')

    const result = scenarioBaseline(ctx.db)
    expect(result.month).toBe(ANCHOR)
    expect(result.baselineCents).toBe(25_000)
  })

  it('does not fold a savings-tagged category into the investments baseline', () => {
    seedMonth()
    const brokerDeposit = fact(ANCHOR, 'broker-deposit', {
      baseline: { baselineCents: 20_000, currentCents: 20_000, deltaBp: 0, monthsUsed: 6, windowMonths: 1, winsorEffectBp: 0 },
    })
    const emergencyFund = fact(ANCHOR, 'emergency-fund', {
      baseline: { baselineCents: 15_000, currentCents: 15_000, deltaBp: 0, monthsUsed: 6, windowMonths: 1, winsorEffectBp: 0 },
    })
    syncCategoryMeta(ctx.db, [brokerDeposit, emergencyFund])
    persistFacts(ctx.db, [brokerDeposit, emergencyFund], [ANCHOR])
    classify('broker-deposit', 'investments')
    classify('emergency-fund', 'savings')

    expect(scenarioBaseline(ctx.db).baselineCents).toBe(20_000)
  })

  it('is null with a stored month but no investments-tagged category', () => {
    seedMonth()
    const groceries = fact(ANCHOR, 'groceries', { spentCents: 60_000 })
    syncCategoryMeta(ctx.db, [groceries])
    persistFacts(ctx.db, [groceries], [ANCHOR])
    classify('groceries', 'variable')

    expect(scenarioBaseline(ctx.db).baselineCents).toBeNull()
  })

  it('is null when the only investments-tagged category has no baseline yet', () => {
    seedMonth()
    const brokerDeposit = fact(ANCHOR, 'broker-deposit', { spentCents: 20_000 })
    syncCategoryMeta(ctx.db, [brokerDeposit])
    persistFacts(ctx.db, [brokerDeposit], [ANCHOR])
    classify('broker-deposit', 'investments')

    expect(scenarioBaseline(ctx.db).baselineCents).toBeNull()
  })

  it('reads the starting value from the latest net-worth snapshot', () => {
    seedNetWorth(3_700_000)
    const result = scenarioBaseline(ctx.db)
    expect(result.snapshotDate).toBe(`${ANCHOR}-28`)
    expect(result.startingValueCents).toBe(3_700_000)
  })

  it('is null with no net-worth snapshot yet', () => {
    seedMonth()
    expect(scenarioBaseline(ctx.db).startingValueCents).toBeNull()
    expect(scenarioBaseline(ctx.db).snapshotDate).toBeNull()
  })
})

describe('projectScenario', () => {
  const base = {
    startingValueCents: 1_000_000,
    baselineCents: 20_000,
    growthRateBp: 500,
    horizonMonths: 12,
  }

  it('leaves the delta at zero every month with no change applied', () => {
    const months = projectScenario({ ...base, changeCents: 0, recurring: true })
    expect(months).toHaveLength(12)
    for (const month of months) expect(month.deltaCents).toBe(0)
    expect(months[0]?.baselineValueCents).toBe(months[0]?.scenarioValueCents)
  })

  it('keeps a recurring change compounding every month, a lump sum only once', () => {
    const recurring = projectScenario({ ...base, changeCents: 20_000, recurring: true })
    const lumpSum = projectScenario({ ...base, changeCents: 20_000, recurring: false })

    // Both paths receive the extra 20 000 in month 1, so the deltas start equal...
    expect(recurring[0]?.deltaCents).toBe(lumpSum[0]?.deltaCents)
    // ...but only the recurring path keeps adding it, so it pulls further ahead.
    expect(recurring.at(-1)?.deltaCents).toBeGreaterThan(lumpSum.at(-1)?.deltaCents ?? 0)
    // The lump sum's delta, once contributed, only grows with the market rate —
    // it never shrinks back down.
    expect(lumpSum.at(-1)?.deltaCents).toBeGreaterThanOrEqual(lumpSum[0]?.deltaCents ?? 0)
  })

  it('projects a smaller total the longer the horizon shrinks, all else equal', () => {
    const long = projectScenario({ ...base, changeCents: 10_000, recurring: true, horizonMonths: 24 })
    const short = projectScenario({ ...base, changeCents: 10_000, recurring: true, horizonMonths: 12 })
    expect(long.at(-1)?.scenarioValueCents).toBeGreaterThan(short.at(-1)?.scenarioValueCents ?? 0)
  })

  it('grows faster at a higher growth rate, all else equal', () => {
    const fast = projectScenario({ ...base, changeCents: 0, recurring: true, growthRateBp: 1_000 })
    const slow = projectScenario({ ...base, changeCents: 0, recurring: true, growthRateBp: 100 })
    expect(fast.at(-1)?.baselineValueCents).toBeGreaterThan(slow.at(-1)?.baselineValueCents ?? 0)
  })

  it('handles a negative change — investing less than today', () => {
    const months = projectScenario({ ...base, changeCents: -10_000, recurring: true })
    for (const month of months) expect(month.deltaCents).toBeLessThan(0)
  })
})
