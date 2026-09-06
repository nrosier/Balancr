/**
 * `projectCashflow` reads three tables a job already wrote and nothing else, so
 * this test builds exactly those rows by hand rather than running a sync: a
 * month total (for `latestStoredMonth`), a net-worth snapshot (for the starting
 * balance), and category facts (for classification, baselines and history).
 */
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { categoryMeta } from '../../src/db/schema.ts'
import { loadAccountMap, syncAccountMap } from '../../src/domain/aggregate/accounts.ts'
import type { ExpectedFrequency } from '../../src/domain/aggregate/baseline.ts'
import { persistFacts, syncCategoryMeta } from '../../src/domain/aggregate/facts.ts'
import { FORECAST_HORIZON_MONTHS, projectCashflow } from '../../src/domain/aggregate/forecast.ts'
import { persistMonthTotals } from '../../src/domain/aggregate/month-store.ts'
import { computeNetWorth, type AccountValue } from '../../src/domain/aggregate/networth.ts'
import { persistNetWorth } from '../../src/domain/aggregate/networth-store.ts'
import type { MonthlyFact, MonthTotals } from '../../src/domain/aggregate/spend.ts'

const ANCHOR = '2026-08'

let ctx: ReturnType<typeof createTestDb>
let ids: Record<string, string>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  syncAccountMap(ctx.db, [{ source: 'actual', externalId: 'checking', name: 'Zichtrekening' }])
  ids = Object.fromEntries(loadAccountMap(ctx.db).map((row) => [row.externalId, row.id]))
})

function totals(month: string, overrides: Partial<MonthTotals> = {}): MonthTotals {
  return {
    month,
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
  }
}

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
    ...overrides,
  }
}

/** Marks `ANCHOR` as the latest aggregated month, with a starting balance. */
function seedAnchor(liquidCents = 500_000): void {
  persistMonthTotals(ctx.db, [totals(ANCHOR)], [])
  persistNetWorth(
    ctx.db,
    computeNetWorth(`${ANCHOR}-28`, [
      {
        accountMapId: ids.checking as string,
        source: 'actual',
        externalId: 'checking',
        name: 'checking',
        kind: 'checking',
        valueCents: liquidCents,
        includeInNetWorth: true,
        dedupeGroup: null,
        isSourceOfTruth: true,
      } satisfies AccountValue,
    ]),
  )
}

function classify(
  id: string,
  nature: 'fixed' | 'variable' | 'discretionary' | 'income' | null,
  overrides: { expectedFrequency?: ExpectedFrequency; hidden?: boolean } = {},
): void {
  ctx.db.update(categoryMeta).set({ nature, ...overrides }).where(eq(categoryMeta.categoryId, id)).run()
}

describe('projectCashflow', () => {
  it('is null before the first aggregation pass', () => {
    expect(projectCashflow(ctx.db)).toBeNull()
  })

  it('is null with a stored month but no net-worth snapshot yet', () => {
    persistMonthTotals(ctx.db, [totals(ANCHOR)], [])
    expect(projectCashflow(ctx.db)).toBeNull()
  })

  it('folds a monthly income and a monthly fixed cost into every one of the 12 months', () => {
    seedAnchor(500_000)
    const salary = fact(ANCHOR, 'salary', {
      isIncome: true,
      baseline: { baselineCents: 300_000, currentCents: 300_000, deltaBp: 0, monthsUsed: 6, windowMonths: 1, winsorEffectBp: 0 },
    })
    const rent = fact(ANCHOR, 'rent', {
      baseline: { baselineCents: 90_000, currentCents: 90_000, deltaBp: 0, monthsUsed: 6, windowMonths: 1, winsorEffectBp: 0 },
    })
    syncCategoryMeta(ctx.db, [salary, rent])
    persistFacts(ctx.db, [salary, rent], [ANCHOR])
    classify('rent', 'fixed')

    const forecast = projectCashflow(ctx.db)
    expect(forecast?.months).toHaveLength(FORECAST_HORIZON_MONTHS)
    expect(forecast?.months.map((m) => m.month)).toEqual([
      '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02',
      '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08',
    ])
    for (const month of forecast?.months ?? []) {
      expect(month.incomeCents).toBe(300_000)
      expect(month.fixedCents).toBe(90_000)
      expect(month.netCents).toBe(210_000)
      expect(month.bills).toEqual([])
    }
    expect(forecast?.months[0]?.balanceCents).toBe(500_000 + 210_000)
    expect(forecast?.months[11]?.balanceCents).toBe(500_000 + 210_000 * 12)
    expect(forecast?.startBalanceCents).toBe(500_000)
    expect(forecast?.startDate).toBe(`${ANCHOR}-28`)
  })

  it('places a quarterly bill in each month it recurs rather than smearing it', () => {
    seedAnchor()
    // Last seen two months before the anchor, so the next occurrence is one
    // month after it, then every three months from there.
    const gas = fact('2026-06', 'gas', { spentCents: 24_000 })
    syncCategoryMeta(ctx.db, [gas])
    persistFacts(ctx.db, [gas], ['2026-06'])
    classify('gas', 'fixed', { expectedFrequency: 'quarterly' })

    const forecast = projectCashflow(ctx.db)
    const withBills = forecast?.months.filter((m) => m.bills.length > 0) ?? []
    expect(withBills.map((m) => m.month)).toEqual(['2026-09', '2026-12', '2027-03', '2027-06'])
    for (const month of withBills) {
      expect(month.bills).toEqual([{ categoryId: 'gas', name: 'gas', amountCents: 24_000 }])
      expect(month.fixedCents).toBe(24_000)
    }
    const withoutBills = forecast?.months.filter((m) => m.bills.length === 0) ?? []
    for (const month of withoutBills) expect(month.fixedCents).toBe(0)
  })

  it('places an annual bill exactly once, twelve months after it last landed', () => {
    seedAnchor()
    const insurance = fact('2026-03', 'insurance', { spentCents: 48_000 })
    syncCategoryMeta(ctx.db, [insurance])
    persistFacts(ctx.db, [insurance], ['2026-03'])
    classify('insurance', 'fixed', { expectedFrequency: 'annual' })

    const forecast = projectCashflow(ctx.db)
    const withBills = forecast?.months.filter((m) => m.bills.length > 0) ?? []
    expect(withBills.map((m) => m.month)).toEqual(['2027-03'])
    expect(withBills[0]?.bills).toEqual([{ categoryId: 'insurance', name: 'insurance', amountCents: 48_000 }])
  })

  it('excludes an unclassified, hidden, or history-less category', () => {
    seedAnchor()
    const unclassified = fact(ANCHOR, 'misc', { spentCents: 5_000 })
    const hidden = fact(ANCHOR, 'archived', {
      hidden: true,
      baseline: { baselineCents: 20_000, currentCents: 20_000, deltaBp: 0, monthsUsed: 6, windowMonths: 1, winsorEffectBp: 0 },
    })
    const noHistory = fact(ANCHOR, 'newbill', { spentCents: 0 })
    syncCategoryMeta(ctx.db, [unclassified, hidden, noHistory])
    persistFacts(ctx.db, [unclassified, hidden, noHistory], [ANCHOR])
    classify('archived', 'fixed')
    classify('newbill', 'fixed', { expectedFrequency: 'annual' })
    // 'misc' is left with nature: null (the default), never classified.

    const forecast = projectCashflow(ctx.db)
    for (const month of forecast?.months ?? []) {
      expect(month.incomeCents).toBe(0)
      expect(month.fixedCents).toBe(0)
      expect(month.bills).toEqual([])
    }
  })

  it('lets the running balance go negative without clamping', () => {
    seedAnchor(10_000)
    const rent = fact(ANCHOR, 'rent', {
      baseline: { baselineCents: 90_000, currentCents: 90_000, deltaBp: 0, monthsUsed: 6, windowMonths: 1, winsorEffectBp: 0 },
    })
    syncCategoryMeta(ctx.db, [rent])
    persistFacts(ctx.db, [rent], [ANCHOR])
    classify('rent', 'fixed')

    const forecast = projectCashflow(ctx.db)
    expect(forecast?.months[0]?.balanceCents).toBe(10_000 - 90_000)
    expect(forecast?.months[11]?.balanceCents).toBe(10_000 - 90_000 * 12)
  })
})
