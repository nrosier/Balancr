/**
 * `monthly_category_facts` is derived data, rebuilt on every pass. Idempotence is
 * therefore the whole contract: the nightly job, a manual re-run, and a re-run
 * after a crash halfway through must all leave the same table behind.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { categoryMeta, monthlyCategoryFacts } from '../../src/db/schema.ts'
import {
  loadCategoryMeta,
  loadCategoryTrends,
  loadFacts,
  loadFrequencies,
  persistFacts,
  syncCategoryMeta,
} from '../../src/domain/aggregate/facts.ts'
import type { MonthlyFact } from '../../src/domain/aggregate/spend.ts'
import { eq } from 'drizzle-orm'

let ctx: ReturnType<typeof createTestDb>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
})

function fact(month: string, id: string, overrides: Partial<MonthlyFact> = {}): MonthlyFact {
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

const rows = () =>
  ctx.db.select().from(monthlyCategoryFacts).orderBy(monthlyCategoryFacts.categoryId).all()

describe('persistFacts', () => {
  it('is idempotent: the same input twice leaves the same data', () => {
    const facts = [fact('2026-01', 'food'), fact('2026-01', 'rent')]
    expect(persistFacts(ctx.db, facts, ['2026-01'])).toEqual({ written: 2, removed: 0 })
    const first = rows()

    expect(persistFacts(ctx.db, facts, ['2026-01'])).toEqual({ written: 2, removed: 0 })
    const second = rows()

    // Everything except `computed_at`, which is *supposed* to move: it is how a
    // fact left behind by a failed pass is told apart from a current one.
    const withoutTimestamp = (all: typeof first) =>
      all.map(({ computedAt: _computedAt, ...rest }) => rest)
    expect(withoutTimestamp(second)).toEqual(withoutTimestamp(first))
    expect(second[0]?.computedAt.getTime()).toBeGreaterThanOrEqual(
      first[0]?.computedAt.getTime() ?? 0,
    )
  })

  it('updates every column in place rather than inserting a second row', () => {
    persistFacts(ctx.db, [fact('2026-01', 'food')], ['2026-01'])
    persistFacts(
      ctx.db,
      [
        fact('2026-01', 'food', {
          spentCents: 55_000,
          budgetedCents: 50_000,
          availableCents: -5_000,
          carryoverEnabled: true,
          txnCount: 9,
          recomputedSpentCents: 55_000,
          baseline: {
            baselineCents: 40_000,
            currentCents: 55_000,
            deltaBp: 3_750,
            monthsUsed: 12,
            windowMonths: 1,
            winsorEffectBp: 0,
          },
        }),
      ],
      ['2026-01'],
    )

    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toMatchObject({
      spentCents: 55_000,
      budgetedCents: 50_000,
      availableCents: -5_000,
      carryoverEnabled: true,
      txnCount: 9,
      recomputedSpentCents: 55_000,
      ewmaBaselineCents: 40_000,
      baselineDeltaBp: 3_750,
    })
  })

  it('keeps a null baseline null instead of storing a zero norm', () => {
    // Zero is a claim ("you normally spend nothing"); null is the truth ("not
    // enough history to say"), and the UI renders them differently.
    persistFacts(ctx.db, [fact('2026-01', 'new')], ['2026-01'])
    expect(rows()[0]?.ewmaBaselineCents).toBeNull()
    expect(rows()[0]?.baselineDeltaBp).toBeNull()
  })

  it('removes a category that no longer appears in a recomputed month', () => {
    // A category deleted in Actual would otherwise survive forever and keep
    // showing up in charts as a ghost envelope.
    persistFacts(ctx.db, [fact('2026-01', 'food'), fact('2026-01', 'gone')], ['2026-01'])
    expect(persistFacts(ctx.db, [fact('2026-01', 'food')], ['2026-01'])).toEqual({
      written: 1,
      removed: 1,
    })
    expect(rows().map((row) => row.categoryId)).toEqual(['food'])
  })

  it('clears a month that legitimately ends up with no categories', () => {
    // Which is why `months` is passed in rather than derived from `facts`:
    // deriving it would make this case a silent no-op.
    persistFacts(ctx.db, [fact('2026-01', 'food')], ['2026-01'])
    expect(persistFacts(ctx.db, [], ['2026-01'])).toEqual({ written: 0, removed: 1 })
    expect(rows()).toEqual([])
  })

  it('leaves months outside the recomputed window alone', () => {
    persistFacts(ctx.db, [fact('2025-12', 'food')], ['2025-12'])
    persistFacts(ctx.db, [fact('2026-01', 'food')], ['2026-01'])
    expect(rows()).toHaveLength(2)

    persistFacts(ctx.db, [], ['2026-01'])
    expect(rows().map((row) => row.month)).toEqual(['2025-12'])
  })

  it('writes more rows than one statement holds', () => {
    // The chunk boundary is a real edge: an off-by-one there loses a category
    // silently, and a wide budget over a year crosses it every night.
    const many = Array.from({ length: 450 }, (_, index) =>
      fact('2026-01', `cat-${String(index).padStart(3, '0')}`),
    )
    expect(persistFacts(ctx.db, many, ['2026-01'])).toEqual({ written: 450, removed: 0 })
    expect(rows()).toHaveLength(450)
  })
})

describe('syncCategoryMeta', () => {
  it('records what the user told us and never overwrites it', () => {
    // This table is the app's accumulating asset. A rename in Actual, or just
    // another nightly run, must not reset an answer someone typed.
    syncCategoryMeta(ctx.db, [fact('2026-01', 'c1', { categoryName: 'Boodschappen' })])
    ctx.db
      .update(categoryMeta)
      .set({ userDescription: 'Weekly supermarket run', nature: 'variable', confidence: 1 })
      .where(eq(categoryMeta.categoryId, 'c1'))
      .run()

    syncCategoryMeta(ctx.db, [fact('2026-02', 'c1', { categoryName: 'Groceries' })])

    const row = ctx.db.select().from(categoryMeta).where(eq(categoryMeta.categoryId, 'c1')).get()
    expect(row).toMatchObject({
      nameSnapshot: 'Groceries',
      userDescription: 'Weekly supermarket run',
      nature: 'variable',
      confidence: 1,
    })
  })

  it('takes the name from the latest month, whatever order the facts arrive in', () => {
    syncCategoryMeta(ctx.db, [
      fact('2026-02', 'c1', { categoryName: 'Groceries' }),
      fact('2026-01', 'c1', { categoryName: 'Boodschappen' }),
    ])
    expect(
      ctx.db.select().from(categoryMeta).where(eq(categoryMeta.categoryId, 'c1')).get()?.nameSnapshot,
    ).toBe('Groceries')
  })

  it('marks an income category as such on first sight', () => {
    syncCategoryMeta(ctx.db, [fact('2026-01', 'salary', { isIncome: true })])
    expect(
      ctx.db.select().from(categoryMeta).where(eq(categoryMeta.categoryId, 'salary')).get()?.nature,
    ).toBe('income')
  })
})

describe('loadFrequencies', () => {
  it('round-trips what aggregateSpend asks for, and omits what it has not been told', () => {
    // An absent category defaults to monthly at the call site, which is why a
    // fresh install still produces baselines rather than nothing.
    syncCategoryMeta(ctx.db, [fact('2026-01', 'insurance'), fact('2026-01', 'food')])
    ctx.db
      .update(categoryMeta)
      .set({ expectedFrequency: 'annual' })
      .where(eq(categoryMeta.categoryId, 'insurance'))
      .run()

    const frequencies = loadFrequencies(ctx.db)
    expect(frequencies.get('insurance')).toBe('annual')
    expect(frequencies.get('food')).toBe('monthly')
    expect(frequencies.has('never-seen')).toBe(false)
  })
})

describe('loadFacts', () => {
  it('reads back what was written, baseline and all', () => {
    // The round-trip that every pass after the sync depends on: the signal job and
    // the AI bundle both read facts from here, never from Actual.
    const written = fact('2026-03', 'food', {
      categoryName: 'Groceries',
      baseline: {
        baselineCents: 44_000,
        currentCents: 52_000,
        deltaBp: 1_818,
        monthsUsed: 11,
        windowMonths: 12,
        winsorEffectBp: 120,
      },
    })
    syncCategoryMeta(ctx.db, [written])
    persistFacts(ctx.db, [written], ['2026-03'])

    expect(loadFacts(ctx.db, '2026-03')).toEqual([written])
  })

  it('takes the name, income flag and hidden flag from the meta row, not the fact row', () => {
    // The name is stored once, in `category_meta`, so a rename in Actual shows up
    // on every historical month at once instead of leaving old months mislabelled.
    const march = fact('2026-03', 'food', { categoryName: 'Food', isIncome: true, hidden: true })
    syncCategoryMeta(ctx.db, [march])
    persistFacts(ctx.db, [march], ['2026-03'])
    ctx.db
      .update(categoryMeta)
      .set({ nameSnapshot: 'Groceries' })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()

    const loaded = loadFacts(ctx.db, '2026-03')[0]
    expect(loaded?.categoryName).toBe('Groceries')
    expect(loaded?.isIncome).toBe(true)
    expect(loaded?.hidden).toBe(true)
  })

  it('is ordered by category id, so a payload labels the same category the same way', () => {
    const facts = [fact('2026-03', 'rent'), fact('2026-03', 'food'), fact('2026-03', 'gas')]
    syncCategoryMeta(ctx.db, facts)
    persistFacts(ctx.db, facts, ['2026-03'])
    expect(loadFacts(ctx.db, '2026-03').map((f) => f.categoryId)).toEqual(['food', 'gas', 'rent'])
  })

  it('reads one month only', () => {
    const facts = [fact('2026-02', 'food'), fact('2026-03', 'food')]
    syncCategoryMeta(ctx.db, facts)
    persistFacts(ctx.db, facts, ['2026-02', '2026-03'])
    expect(loadFacts(ctx.db, '2026-03').map((f) => f.month)).toEqual(['2026-03'])
  })

  it('is empty for a month that was never computed', () => {
    expect(loadFacts(ctx.db, '2026-03')).toEqual([])
  })

  it('skips a fact whose category has no meta row', () => {
    // An inner join, deliberately: without a meta row there is no name, and a
    // nameless category in a bundle would reach the model as an empty string.
    // `sync.ts` calls `syncCategoryMeta` before `persistFacts` so this cannot
    // happen in the pass; the row is dropped rather than half-loaded if it does.
    persistFacts(ctx.db, [fact('2026-03', 'orphan')], ['2026-03'])
    expect(loadFacts(ctx.db, '2026-03')).toEqual([])
  })

  it('keeps a null delta on a baseline that has one', () => {
    // `deltaBp` is null when the baseline is zero — a first-ever annual bill has a
    // norm of nothing to compare against, and a percentage of zero is not a number.
    const written = fact('2026-03', 'food', {
      baseline: {
        baselineCents: 0,
        currentCents: 8_000,
        deltaBp: null,
        monthsUsed: 2,
        windowMonths: 12,
        winsorEffectBp: null,
      },
    })
    syncCategoryMeta(ctx.db, [written])
    persistFacts(ctx.db, [written], ['2026-03'])
    expect(loadFacts(ctx.db, '2026-03')[0]?.baseline).toEqual(written.baseline)
  })
})

describe('loadCategoryMeta', () => {
  it('keys every stored row by its category id', () => {
    syncCategoryMeta(ctx.db, [fact('2026-03', 'food'), fact('2026-03', 'rent')])
    const meta = loadCategoryMeta(ctx.db)
    expect([...meta.keys()].sort()).toEqual(['food', 'rent'])
    expect(meta.get('food')?.nameSnapshot).toBe('food')
  })

  it('carries the fields the redaction boundary reads', () => {
    // These five decide what a category looks like to the model — and whether it
    // is described at all. Loading them is what makes `sensitive` mean anything.
    syncCategoryMeta(ctx.db, [fact('2026-03', 'therapy')])
    ctx.db
      .update(categoryMeta)
      .set({
        userDescription: 'Weekly sessions',
        coicopCode: '06.2.2',
        nature: 'fixed',
        custodyShared: true,
        sensitive: true,
      })
      .where(eq(categoryMeta.categoryId, 'therapy'))
      .run()

    const row = loadCategoryMeta(ctx.db).get('therapy')
    expect(row).toMatchObject({
      userDescription: 'Weekly sessions',
      coicopCode: '06.2.2',
      nature: 'fixed',
      custodyShared: true,
      sensitive: true,
    })
  })

  it('is empty before the first sync', () => {
    expect(loadCategoryMeta(ctx.db).size).toBe(0)
  })
})

describe('loadCategoryTrends', () => {
  /** Three months of one category, and a second category present in the middle one. */
  const seed = (): void => {
    persistFacts(
      ctx.db,
      [
        fact('2026-01', 'food', { spentCents: 40_000 }),
        fact('2026-02', 'food', { spentCents: 45_000 }),
        fact('2026-02', 'gifts', { spentCents: 9_000 }),
        fact('2026-03', 'food', { spentCents: 38_000 }),
      ],
      ['2026-01', '2026-02', '2026-03'],
    )
  }

  it('returns the window oldest first, ending at the month asked for', () => {
    seed()
    expect(loadCategoryTrends(ctx.db, '2026-03', 3).months).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
    ])
  })

  it('aligns every series to that window', () => {
    seed()
    const trends = loadCategoryTrends(ctx.db, '2026-03', 3)
    expect(trends.byCategory.get('food')).toEqual([40_000, 45_000, 38_000])
  })

  it('fills a month a category has no row for with zero rather than a hole', () => {
    // A line with a gap in it is a different claim from a line that touches zero: the
    // category genuinely spent nothing that month, and the aggregation pass already
    // treats absent as zero when it writes the facts.
    seed()
    const trends = loadCategoryTrends(ctx.db, '2026-03', 3)
    expect(trends.byCategory.get('gifts')).toEqual([0, 9_000, 0])
  })

  it('gives every category the same window, including one that starts late', () => {
    // A per-category window would hand the newest envelope the shortest x axis and
    // make its line look steeper than the one beside it.
    seed()
    const trends = loadCategoryTrends(ctx.db, '2026-03', 3)
    for (const series of trends.byCategory.values()) {
      expect(series).toHaveLength(trends.months.length)
    }
  })

  it('reaches back past the stored history without inventing months', () => {
    seed()
    const trends = loadCategoryTrends(ctx.db, '2026-03', 5)
    expect(trends.months).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03'])
    expect(trends.byCategory.get('food')).toEqual([0, 0, 40_000, 45_000, 38_000])
  })

  it('ignores months after the one asked for', () => {
    // The budget page can be pointed at an older month, and its charts should then
    // describe that month rather than leaking the figures that came after it.
    seed()
    const trends = loadCategoryTrends(ctx.db, '2026-02', 2)
    expect(trends.months).toEqual(['2026-01', '2026-02'])
    expect(trends.byCategory.get('food')).toEqual([40_000, 45_000])
  })

  it('has no series at all before the first aggregation pass', () => {
    const trends = loadCategoryTrends(ctx.db, '2026-03', 3)
    expect(trends.byCategory.size).toBe(0)
    expect(trends.months).toHaveLength(3)
  })

  it('asks for nothing when the window is empty', () => {
    expect(loadCategoryTrends(ctx.db, '2026-03', 0)).toEqual({ months: [], byCategory: new Map() })
  })
})
