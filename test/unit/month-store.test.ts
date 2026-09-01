/**
 * The month tables are what let every pass after the sync read SQLite instead of
 * asking Actual again, so two properties carry the weight here:
 *
 *  - **A re-run replaces a month**, rather than merging into it. A total that has
 *    changed must change, and a drift row for a mismatch that has been fixed must
 *    disappear — the failure mode of a data-quality panel is showing yesterday's
 *    resolved problem for ever.
 *  - **A window ending at the judged month is dense.** Every household producer
 *    reads a rolling series off `loadTrailingTotals`, and a gap silently averages
 *    across the hole rather than failing.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import {
  forgetMonth,
  latestStoredMonth,
  loadMismatches,
  loadMonthTotals,
  loadTrailingTotals,
  loadUncategorised,
  persistMismatches,
  persistMonthTotals,
} from '../../src/domain/aggregate/month-store.ts'
import type {
  MonthTotals,
  RecomputeMismatch,
  UncategorisedBucket,
} from '../../src/domain/aggregate/spend.ts'

let ctx: ReturnType<typeof createTestDb>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
})

function totals(month: string, overrides: Partial<MonthTotals> = {}): MonthTotals {
  return {
    month,
    incomeCents: 380_000,
    spentCents: 341_000,
    budgetedCents: 350_000,
    toBudgetCents: 9_000,
    fromLastMonthCents: 12_000,
    balanceCents: 39_000,
    savingsRateBp: 1_026,
    ...overrides,
  }
}

function mismatch(month: string, id: string, difference = 1_000): RecomputeMismatch {
  return {
    month,
    categoryId: id,
    categoryName: id,
    actualCents: 40_000,
    recomputedCents: 40_000 + difference,
    differenceCents: difference,
  }
}

describe('persistMonthTotals', () => {
  it('round-trips a month exactly, savings rate included', () => {
    expect(persistMonthTotals(ctx.db, [totals('2026-01')], [])).toBe(1)
    expect(loadMonthTotals(ctx.db, ['2026-01'])).toEqual([totals('2026-01')])
  })

  it('keeps a null savings rate null rather than storing a zero', () => {
    // A month with no income has no savings rate. Zero would read as "you saved
    // nothing", which is a different and wrong statement.
    persistMonthTotals(ctx.db, [totals('2026-01', { incomeCents: 0, savingsRateBp: null })], [])
    expect(loadMonthTotals(ctx.db, ['2026-01'])[0]?.savingsRateBp).toBeNull()
  })

  it('replaces a month rather than merging into it', () => {
    persistMonthTotals(ctx.db, [totals('2026-01', { spentCents: 341_000 })], [])
    persistMonthTotals(ctx.db, [totals('2026-01', { spentCents: 12_000 })], [])
    expect(loadMonthTotals(ctx.db, ['2026-01'])).toHaveLength(1)
    expect(loadMonthTotals(ctx.db, ['2026-01'])[0]?.spentCents).toBe(12_000)
  })

  it('matches uncategorised buckets by month, not by position', () => {
    // `aggregateSpend` only emits a bucket for a month that had uncategorised
    // transactions, so zipping the two lists would attribute March's backlog to
    // January the moment February had none.
    const buckets: UncategorisedBucket[] = [{ month: '2026-03', txnCount: 4, amountCents: 9_900 }]
    persistMonthTotals(ctx.db, ['2026-01', '2026-02', '2026-03'].map((m) => totals(m)), buckets)

    expect(loadUncategorised(ctx.db, ['2026-01', '2026-02', '2026-03'])).toEqual([
      { month: '2026-01', txnCount: 0, amountCents: 0 },
      { month: '2026-02', txnCount: 0, amountCents: 0 },
      { month: '2026-03', txnCount: 4, amountCents: 9_900 },
    ])
  })

  it('stores a net-inward backlog as the negative it is', () => {
    persistMonthTotals(ctx.db, [totals('2026-01')], [
      { month: '2026-01', txnCount: 2, amountCents: -4_500 },
    ])
    expect(loadUncategorised(ctx.db, ['2026-01'])[0]?.amountCents).toBe(-4_500)
  })

  it('writes nothing and reports nothing for an empty pass', () => {
    expect(persistMonthTotals(ctx.db, [], [])).toBe(0)
    expect(loadMonthTotals(ctx.db, [])).toEqual([])
    expect(loadUncategorised(ctx.db, [])).toEqual([])
  })

  it('skips a month that has never been computed rather than inventing a zero', () => {
    persistMonthTotals(ctx.db, [totals('2026-01')], [])
    expect(loadMonthTotals(ctx.db, ['2025-12', '2026-01']).map((m) => m.month)).toEqual(['2026-01'])
  })
})

describe('loadTrailingTotals', () => {
  const store = (months: readonly string[]) =>
    persistMonthTotals(ctx.db, months.map((month) => totals(month)), [])

  it('returns the window ascending, ending at the month asked for', () => {
    store(['2025-11', '2025-12', '2026-01', '2026-02'])
    expect(loadTrailingTotals(ctx.db, '2026-01', 3).map((m) => m.month)).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
    ])
  })

  it('stops at a gap instead of averaging across it', () => {
    // 2025-12 is missing, which happens when `JOBS_HISTORY_MONTHS` is lowered and
    // raised again. A shorter window is the honest answer; a window spanning the
    // hole would inflate every rate computed from it.
    store(['2025-10', '2025-11', '2026-01', '2026-02'])
    expect(loadTrailingTotals(ctx.db, '2026-02', 12).map((m) => m.month)).toEqual([
      '2026-01',
      '2026-02',
    ])
  })

  it('is empty when the month itself was never computed', () => {
    store(['2025-11', '2025-12'])
    expect(loadTrailingTotals(ctx.db, '2026-01', 12)).toEqual([])
  })

  it('is empty for a non-positive count', () => {
    store(['2026-01'])
    expect(loadTrailingTotals(ctx.db, '2026-01', 0)).toEqual([])
  })

  it('returns just the month when the window is one long', () => {
    store(['2025-12', '2026-01'])
    expect(loadTrailingTotals(ctx.db, '2026-01', 1).map((m) => m.month)).toEqual(['2026-01'])
  })
})

describe('persistMismatches', () => {
  it('round-trips the drift rows for a month', () => {
    expect(persistMismatches(ctx.db, [mismatch('2026-01', 'food')], ['2026-01'])).toEqual({
      months: 1,
      mismatches: 1,
    })
    expect(loadMismatches(ctx.db, ['2026-01'])).toEqual([mismatch('2026-01', 'food')])
  })

  it('clears a month that has stopped drifting', () => {
    persistMismatches(ctx.db, [mismatch('2026-01', 'food')], ['2026-01'])
    // The second pass reports no mismatch for the month, which must clear the row
    // rather than leave a fixed problem on the page.
    expect(persistMismatches(ctx.db, [], ['2026-01'])).toEqual({ months: 1, mismatches: 0 })
    expect(loadMismatches(ctx.db, ['2026-01'])).toEqual([])
  })

  it('leaves a month outside the pass alone', () => {
    persistMismatches(ctx.db, [mismatch('2025-12', 'rent')], ['2025-12'])
    persistMismatches(ctx.db, [mismatch('2026-01', 'food')], ['2026-01'])
    expect(loadMismatches(ctx.db, ['2025-12', '2026-01']).map((m) => m.month)).toEqual([
      '2025-12',
      '2026-01',
    ])
  })

  it('drops a mismatch for a month the pass did not cover', () => {
    // The extra history months a baseline needs are loaded but not reported on, so
    // a mismatch from one of them has no month row to hang on.
    const result = persistMismatches(
      ctx.db,
      [mismatch('2024-05', 'old'), mismatch('2026-01', 'food')],
      ['2026-01'],
    )
    expect(result.mismatches).toBe(1)
    expect(loadMismatches(ctx.db, ['2024-05', '2026-01']).map((m) => m.categoryId)).toEqual(['food'])
  })

  it('does nothing at all when the pass covered no months', () => {
    persistMismatches(ctx.db, [mismatch('2026-01', 'food')], ['2026-01'])
    expect(persistMismatches(ctx.db, [], [])).toEqual({ months: 0, mismatches: 0 })
    // An empty month list must not be read as "every month": that would clear the
    // whole table on a pass that found no budget months.
    expect(loadMismatches(ctx.db, ['2026-01'])).toHaveLength(1)
  })
})

describe('latestStoredMonth and forgetMonth', () => {
  it('is null before the first sync', () => {
    expect(latestStoredMonth(ctx.db)).toBeNull()
  })

  it('reports the highest month, not the last one written', () => {
    persistMonthTotals(ctx.db, [totals('2026-02'), totals('2025-12')], [])
    expect(latestStoredMonth(ctx.db)).toBe('2026-02')
  })

  it('drops a month and its drift together', () => {
    persistMonthTotals(ctx.db, [totals('2026-01'), totals('2026-02')], [])
    persistMismatches(ctx.db, [mismatch('2026-01', 'food')], ['2026-01'])

    forgetMonth(ctx.db, '2026-01')
    expect(loadMonthTotals(ctx.db, ['2026-01', '2026-02']).map((m) => m.month)).toEqual(['2026-02'])
    expect(loadMismatches(ctx.db, ['2026-01'])).toEqual([])
  })
})
