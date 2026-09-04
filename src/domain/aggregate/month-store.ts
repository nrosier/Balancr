/**
 * Month-level computed facts: totals, the uncategorised backlog, and drift.
 *
 * `monthly_category_facts` answers "what happened in this envelope"; these three
 * answer "what happened this month" and "how much of it can be trusted". They are
 * stored for the same reason the category facts are: every later pass — the
 * signal pass, the AI pass, the API — reads a month from SQLite instead of asking
 * Actual again, which is what keeps a page load from needing a budget download.
 *
 * Delete-then-insert per month, inside one transaction. WAL readers hold a
 * snapshot taken before the transaction, so there is no window in which a month
 * looks empty. `facts.ts` upserts instead because a month there is hundreds of
 * rows and rewriting all of them for a one-cent change is real write
 * amplification; a month here is one row and at most a handful of drift rows.
 */
import { desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { monthlyTotals, recomputeMismatches } from '../../db/schema.ts'
import { addMonths, monthsBefore } from '../../util/month.ts'
import type { MonthTotals, RecomputeMismatch, UncategorisedBucket } from './spend.ts'

export interface MonthPersistResult {
  months: number
  mismatches: number
}

/**
 * Writes one row per month in `totals`, with its uncategorised counters.
 *
 * The buckets are matched by month rather than zipped: `aggregateSpend` only
 * emits a bucket for a month that actually had uncategorised transactions, and a
 * month without one is a real zero, not a missing row.
 */
export function persistMonthTotals(
  db: Db,
  totals: readonly MonthTotals[],
  uncategorised: readonly UncategorisedBucket[],
): number {
  if (totals.length === 0) return 0

  const buckets = new Map(uncategorised.map((bucket) => [bucket.month, bucket]))
  const computedAt = new Date()

  const rows = totals.map((month) => {
    const bucket = buckets.get(month.month)
    return {
      month: month.month,
      incomeCents: month.incomeCents,
      spentCents: month.spentCents,
      budgetedCents: month.budgetedCents,
      toBudgetCents: month.toBudgetCents,
      fromLastMonthCents: month.fromLastMonthCents,
      balanceCents: month.balanceCents,
      savingsRateBp: month.savingsRateBp,
      uncategorisedTxnCount: bucket?.txnCount ?? 0,
      uncategorisedCents: bucket?.amountCents ?? 0,
      committedCents: month.committedCents,
      committedUnallocatedCents: month.committedUnallocatedCents,
      committedUnallocatedCount: month.committedUnallocatedCount,
      committedApproximate: month.committedApproximate,
      computedAt,
    }
  })

  db.transaction((tx) => {
    tx.delete(monthlyTotals)
      .where(inArray(monthlyTotals.month, rows.map((row) => row.month)))
      .run()
    tx.insert(monthlyTotals).values(rows).run()
  })

  return rows.length
}

/**
 * The earliest month the sync job has stored totals for, or null before its first run.
 *
 * The backfill clamps to this. `getAccountBalance` answers any date, including dates
 * before the budget existed, and it answers zero — so an install whose Actual file is
 * three months old would otherwise get twenty-one month-ends of flat zero net worth
 * ahead of its real history. A zero that means "there was nothing" and a zero that
 * means "we did not look" render identically on a chart, and only one of them is true.
 */
export function earliestStoredMonth(db: Db): string | null {
  const row = db
    .select({ month: sql<string | null>`min(${monthlyTotals.month})` })
    .from(monthlyTotals)
    .get()
  return row?.month ?? null
}

/** The stored months, ascending, skipping any that has never been computed. */
export function loadMonthTotals(db: Db, months: readonly string[]): MonthTotals[] {
  if (months.length === 0) return []

  return db
    .select()
    .from(monthlyTotals)
    .where(inArray(monthlyTotals.month, [...months]))
    .orderBy(monthlyTotals.month)
    .all()
    .map((row) => ({
      month: row.month,
      incomeCents: row.incomeCents,
      spentCents: row.spentCents,
      budgetedCents: row.budgetedCents,
      toBudgetCents: row.toBudgetCents,
      fromLastMonthCents: row.fromLastMonthCents,
      balanceCents: row.balanceCents,
      savingsRateBp: row.savingsRateBp,
      committedCents: row.committedCents,
      committedUnallocatedCents: row.committedUnallocatedCents,
      committedUnallocatedCount: row.committedUnallocatedCount,
      committedApproximate: row.committedApproximate,
    }))
}

/**
 * The unbroken run of months ending at `month`, at most `count` long.
 *
 * Trimmed to a dense suffix rather than returned as-is, because every household
 * producer reads a rolling window off this series and `computeSignals` asserts
 * density before it runs. A gap can exist legitimately — lowering
 * `JOBS_HISTORY_MONTHS` and raising it again leaves one, as does a budget whose
 * earliest months were added later — and the honest answer to a hole is a
 * shorter window, not an average taken across it.
 *
 * Empty when `month` itself has never been computed: a window that does not
 * reach the month being judged is not a shorter window, it is the wrong one.
 */
export function loadTrailingTotals(
  db: Db,
  month: string,
  count: number,
): MonthTotals[] {
  if (count <= 0) return []

  const stored = loadMonthTotals(db, [...monthsBefore(month, count - 1), month])
  let start = stored.length - 1
  if (start < 0 || stored[start]?.month !== month) return []
  while (start > 0 && stored[start - 1]?.month === addMonths(stored[start]?.month as string, -1)) {
    start -= 1
  }
  return stored.slice(start)
}

/** One bucket per stored month, ascending. A zero month is still a bucket. */
export function loadUncategorised(db: Db, months: readonly string[]): UncategorisedBucket[] {
  if (months.length === 0) return []

  return db
    .select({
      month: monthlyTotals.month,
      txnCount: monthlyTotals.uncategorisedTxnCount,
      amountCents: monthlyTotals.uncategorisedCents,
    })
    .from(monthlyTotals)
    .where(inArray(monthlyTotals.month, [...months]))
    .orderBy(monthlyTotals.month)
    .all()
}

/**
 * Replaces the drift rows for `months`.
 *
 * `months` is passed separately rather than derived from `mismatches` so that a
 * month which has *stopped* drifting is cleared. Deriving the list would leave
 * yesterday's fixed mismatch on the page for ever, which is the failure mode that
 * makes a data-quality panel worthless.
 */
export function persistMismatches(
  db: Db,
  mismatches: readonly RecomputeMismatch[],
  months: readonly string[],
): MonthPersistResult {
  if (months.length === 0) return { months: 0, mismatches: 0 }

  const computedAt = new Date()
  const rows = mismatches
    .filter((mismatch) => months.includes(mismatch.month))
    .map((mismatch) => ({
      month: mismatch.month,
      categoryId: mismatch.categoryId,
      categoryName: mismatch.categoryName,
      actualCents: mismatch.actualCents,
      recomputedCents: mismatch.recomputedCents,
      differenceCents: mismatch.differenceCents,
      computedAt,
    }))

  db.transaction((tx) => {
    tx.delete(recomputeMismatches)
      .where(inArray(recomputeMismatches.month, [...months]))
      .run()
    if (rows.length > 0) tx.insert(recomputeMismatches).values(rows).run()
  })

  return { months: months.length, mismatches: rows.length }
}

export function loadMismatches(db: Db, months: readonly string[]): RecomputeMismatch[] {
  if (months.length === 0) return []

  return db
    .select({
      month: recomputeMismatches.month,
      categoryId: recomputeMismatches.categoryId,
      categoryName: recomputeMismatches.categoryName,
      actualCents: recomputeMismatches.actualCents,
      recomputedCents: recomputeMismatches.recomputedCents,
      differenceCents: recomputeMismatches.differenceCents,
    })
    .from(recomputeMismatches)
    .where(inArray(recomputeMismatches.month, [...months]))
    .orderBy(recomputeMismatches.month, recomputeMismatches.categoryId)
    .all()
}

/**
 * Every stored month, newest first.
 *
 * What a month picker offers, and deliberately not derived from a trailing window:
 * a window ending at the month being viewed shrinks as the reader looks further back,
 * so picking July would take August out of the list they picked it from and leave no
 * way forward again. It is also the answer for a month that was never computed — a
 * stale bookmark should still be able to navigate somewhere real.
 */
export function storedMonths(db: Db): string[] {
  return db
    .select({ month: monthlyTotals.month })
    .from(monthlyTotals)
    .orderBy(desc(monthlyTotals.month))
    .all()
    .map((row) => row.month)
}

/** The most recent stored month, or null before the first sync. */
export function latestStoredMonth(db: Db): string | null {
  const row = db
    .select({ month: monthlyTotals.month })
    .from(monthlyTotals)
    .orderBy(desc(monthlyTotals.month))
    .limit(1)
    .get()
  return row?.month ?? null
}

/** Drops a month entirely. Used by tests and by a manual recompute. */
export function forgetMonth(db: Db, month: string): void {
  db.transaction((tx) => {
    tx.delete(monthlyTotals).where(eq(monthlyTotals.month, month)).run()
    tx.delete(recomputeMismatches).where(eq(recomputeMismatches.month, month)).run()
  })
}
