/**
 * Writes computed facts to SQLite, idempotently.
 *
 * `monthly_category_facts` is derived data: it is rebuilt from Actual on every
 * pass and never hand-edited. That makes idempotence the whole contract — the
 * nightly job, a manual re-run, and a re-run after a crash halfway through must
 * all leave the table in the same state.
 *
 * Two things follow from that:
 *
 *  - **Upsert, not delete-then-insert.** A `DELETE` followed by an `INSERT` has a
 *    window where a page load sees a month with no categories in it. The upsert
 *    has no such window, and the whole pass is one transaction anyway.
 *  - **Stale rows are removed explicitly.** If a category is deleted in Actual,
 *    or stops appearing in a month we recompute, its old row would otherwise
 *    survive forever and keep showing up in charts as a ghost envelope.
 */
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { categoryMeta, monthlyCategoryFacts } from '../../db/schema.ts'
import { monthsBefore } from '../../util/month.ts'
import type { ExpectedFrequency } from './baseline.ts'
import type { MonthlyFact } from './spend.ts'

/**
 * Rows per statement. SQLite's variable limit is generous on modern builds, but
 * a bounded statement keeps a wide budget (hundreds of categories over a year)
 * from depending on it.
 */
const CHUNK = 200

export interface PersistResult {
  /** Rows inserted or updated. */
  written: number
  /** Rows deleted because their category no longer appears in that month. */
  removed: number
}

/**
 * Upserts `facts` and drops rows for `months` whose category is no longer there.
 *
 * `months` is passed separately rather than derived from `facts` so that
 * recomputing a month that legitimately ends up with *no* categories still
 * clears it. Deriving the list would make that case a silent no-op.
 */
export function persistFacts(
  db: Db,
  facts: readonly MonthlyFact[],
  months: readonly string[],
): PersistResult {
  const computedAt = new Date()
  const result: PersistResult = { written: 0, removed: 0 }

  db.transaction((tx) => {
    for (let start = 0; start < facts.length; start += CHUNK) {
      const chunk = facts.slice(start, start + CHUNK)
      tx.insert(monthlyCategoryFacts)
        .values(
          chunk.map((fact) => ({
            month: fact.month,
            categoryId: fact.categoryId,
            spentCents: fact.spentCents,
            budgetedCents: fact.budgetedCents,
            availableCents: fact.availableCents,
            carryoverEnabled: fact.carryoverEnabled,
            txnCount: fact.txnCount,
            recomputedSpentCents: fact.recomputedSpentCents,
            ewmaBaselineCents: fact.baseline?.baselineCents ?? null,
            baselineDeltaBp: fact.baseline?.deltaBp ?? null,
            baselineCurrentCents: fact.baseline?.currentCents ?? null,
            baselineMonthsUsed: fact.baseline?.monthsUsed ?? null,
            baselineWindowMonths: fact.baseline?.windowMonths ?? null,
            baselineWinsorEffectBp: fact.baseline?.winsorEffectBp ?? null,
            computedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [monthlyCategoryFacts.month, monthlyCategoryFacts.categoryId],
          set: {
            spentCents: sql`excluded.spent_cents`,
            budgetedCents: sql`excluded.budgeted_cents`,
            availableCents: sql`excluded.available_cents`,
            carryoverEnabled: sql`excluded.carryover_enabled`,
            txnCount: sql`excluded.txn_count`,
            recomputedSpentCents: sql`excluded.recomputed_spent_cents`,
            ewmaBaselineCents: sql`excluded.ewma_baseline_cents`,
            baselineDeltaBp: sql`excluded.baseline_delta_bp`,
            baselineCurrentCents: sql`excluded.baseline_current_cents`,
            baselineMonthsUsed: sql`excluded.baseline_months_used`,
            baselineWindowMonths: sql`excluded.baseline_window_months`,
            baselineWinsorEffectBp: sql`excluded.baseline_winsor_effect_bp`,
            computedAt: sql`excluded.computed_at`,
          },
        })
        .run()
      result.written += chunk.length
    }

    for (const month of months) {
      const keep = facts.filter((fact) => fact.month === month).map((fact) => fact.categoryId)
      // `notInArray` with an empty list is not a tautology in SQL — it would
      // match nothing and quietly skip the cleanup this loop exists to do.
      const where =
        keep.length > 0
          ? and(
              eq(monthlyCategoryFacts.month, month),
              notInArray(monthlyCategoryFacts.categoryId, keep),
            )
          : eq(monthlyCategoryFacts.month, month)

      result.removed += tx.delete(monthlyCategoryFacts).where(where).run().changes
    }
  })

  return result
}

/**
 * Records every category we have seen, and keeps its name current.
 *
 * This table is the app's accumulating asset — the user's own answer to "what is
 * this envelope for", plus the nature and frequency that drive the baseline. So
 * the upsert touches `name_snapshot` and nothing else: a rename in Actual must
 * not reset a description someone typed, and re-running the nightly job must not
 * either.
 */
export function syncCategoryMeta(db: Db, facts: readonly MonthlyFact[]): number {
  // Facts arrive one row per (month, category); the latest month wins, which is
  // the same "latest name" rule `aggregateSpend` applies.
  const latest = new Map<string, MonthlyFact>()
  for (const fact of [...facts].sort((a, b) => a.month.localeCompare(b.month))) {
    latest.set(fact.categoryId, fact)
  }
  if (latest.size === 0) return 0

  const rows = [...latest.values()].map((fact) => ({
    categoryId: fact.categoryId,
    nameSnapshot: fact.categoryName,
    isIncome: fact.isIncome,
    hidden: fact.hidden,
    nature: fact.isIncome ? ('income' as const) : null,
  }))

  db.transaction((tx) => {
    for (let start = 0; start < rows.length; start += CHUNK) {
      tx.insert(categoryMeta)
        .values(rows.slice(start, start + CHUNK))
        .onConflictDoUpdate({
          target: categoryMeta.categoryId,
          set: {
            nameSnapshot: sql`excluded.name_snapshot`,
            // Actual owns these two, so they are refreshed rather than preserved.
            // `nature` deliberately is not: it is seeded from `is_income` on the
            // first sighting and is the user's to correct after that.
            isIncome: sql`excluded.is_income`,
            hidden: sql`excluded.hidden`,
            updatedAt: new Date(),
          },
        })
        .run()
    }
  })

  return rows.length
}

/**
 * The frequency map `aggregateSpend` needs, straight from `category_meta`.
 *
 * A category with no row yet is simply absent, and the caller defaults it to
 * monthly — which is why the first pass of a fresh install still produces
 * baselines rather than nothing.
 */
export function loadFrequencies(db: Db): Map<string, ExpectedFrequency> {
  const rows = db
    .select({
      categoryId: categoryMeta.categoryId,
      expectedFrequency: categoryMeta.expectedFrequency,
    })
    .from(categoryMeta)
    .all()

  return new Map(rows.map((row) => [row.categoryId, row.expectedFrequency]))
}

/**
 * A month's facts, rebuilt out of SQLite.
 *
 * The inverse of `persistFacts`, and the reason the fact table carries the whole
 * of `BaselineResult` and `category_meta` carries Actual's own flags: every pass
 * after the sync — signals, the AI payload, the API — works from this rather than
 * from a budget download, so none of them needs Actual to be reachable.
 *
 * The join is inner: a fact whose category has no meta row cannot exist, because
 * `syncCategoryMeta` runs first in the same pass. If one ever did, it would be a
 * fact with no name, and dropping it is better than inventing one.
 */
export function loadFacts(db: Db, month: string): MonthlyFact[] {
  const rows = db
    .select({
      fact: monthlyCategoryFacts,
      name: categoryMeta.nameSnapshot,
      isIncome: categoryMeta.isIncome,
      hidden: categoryMeta.hidden,
    })
    .from(monthlyCategoryFacts)
    .innerJoin(categoryMeta, eq(categoryMeta.categoryId, monthlyCategoryFacts.categoryId))
    .where(eq(monthlyCategoryFacts.month, month))
    .orderBy(monthlyCategoryFacts.categoryId)
    .all()

  return rows.map(({ fact, name, isIncome, hidden }) => ({
    month: fact.month,
    categoryId: fact.categoryId,
    categoryName: name,
    isIncome,
    hidden,
    spentCents: fact.spentCents,
    budgetedCents: fact.budgetedCents,
    availableCents: fact.availableCents,
    carryoverEnabled: fact.carryoverEnabled,
    txnCount: fact.txnCount,
    recomputedSpentCents: fact.recomputedSpentCents,
    // All four companion columns are written with `ewma_baseline_cents` or not at
    // all, so this one null check settles the whole object. `?? 0` never fires;
    // it is there because the columns are nullable in the type.
    baseline:
      fact.ewmaBaselineCents === null
        ? null
        : {
            baselineCents: fact.ewmaBaselineCents,
            currentCents: fact.baselineCurrentCents ?? 0,
            deltaBp: fact.baselineDeltaBp,
            monthsUsed: fact.baselineMonthsUsed ?? 0,
            windowMonths: fact.baselineWindowMonths ?? 1,
            winsorEffectBp: fact.baselineWinsorEffectBp,
          },
  }))
}

export interface CategoryTrends {
  /** Oldest first. The index every series in `byCategory` is aligned to. */
  months: string[]
  /** One spend figure per month, in `months` order, for each category with a row. */
  byCategory: Map<string, number[]>
}

/**
 * Trailing spend per category, as a dense series.
 *
 * Dense because the client draws it as a line, and a line with holes in it is a
 * different claim from a line that touches zero. A category with no transactions in a
 * month genuinely spent nothing that month — the aggregation pass already treats
 * absent as zero when it writes the facts — so filling the gap with `0` states what
 * happened rather than papering over a gap in the data.
 *
 * Unlike `loadTrailingTotals`, this does not trim to the dense run ending at `month`.
 * The window is the same for every category on the screen, which is what makes twelve
 * small charts comparable at a glance; a per-category window would silently give the
 * newest envelope the shortest x axis and make its line look steeper than its
 * neighbour's.
 */
export function loadCategoryTrends(db: Db, month: string, count: number): CategoryTrends {
  if (count <= 0) return { months: [], byCategory: new Map() }

  const months = [...monthsBefore(month, count - 1), month]
  const index = new Map(months.map((key, at) => [key, at]))

  const rows = db
    .select({
      month: monthlyCategoryFacts.month,
      categoryId: monthlyCategoryFacts.categoryId,
      spentCents: monthlyCategoryFacts.spentCents,
    })
    .from(monthlyCategoryFacts)
    .where(inArray(monthlyCategoryFacts.month, months))
    .all()

  const byCategory = new Map<string, number[]>()
  for (const row of rows) {
    const at = index.get(row.month)
    if (at === undefined) continue
    let series = byCategory.get(row.categoryId)
    if (series === undefined) {
      series = new Array<number>(months.length).fill(0)
      byCategory.set(row.categoryId, series)
    }
    series[at] = row.spentCents
  }

  return { months, byCategory }
}

/** Every category with a stored meta row, keyed by id. */
export function loadCategoryMeta(db: Db): Map<string, typeof categoryMeta.$inferSelect> {
  return new Map(db.select().from(categoryMeta).all().map((row) => [row.categoryId, row]))
}
