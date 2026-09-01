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
import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { categoryMeta, monthlyCategoryFacts } from '../../db/schema.ts'
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
