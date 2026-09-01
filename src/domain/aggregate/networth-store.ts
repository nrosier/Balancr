/**
 * Persistence for `computeNetWorth`'s output.
 *
 * One row per (date, account) rather than one total per date, for two reasons:
 * the overview chart wants to show what net worth is *made of*, and a figure that
 * jumped last Tuesday is only diagnosable if the accounts behind it were kept.
 *
 * Excluded accounts are not written. A deduplicated mirror stored alongside the
 * real one would be summed back into the total by the first person to write
 * `SELECT sum(value_cents)`, which defeats the entire point of the dedupe.
 */
import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { netWorthSnapshots } from '../../db/schema.ts'
import { config } from '../../config.ts'
import type { NetWorthResult } from './networth.ts'

export interface NetWorthPersistResult {
  written: number
  /** Rows for this date whose account no longer counts. */
  removed: number
}

/**
 * Upserts today's contributions and clears rows for accounts that dropped out.
 *
 * Idempotent by (date, account_map_id): running the job twice in one day updates
 * in place, so a mid-morning re-run after fixing a mapping corrects the day
 * rather than adding a second version of it.
 */
export function persistNetWorth(
  db: Db,
  result: NetWorthResult,
): NetWorthPersistResult {
  const computedAt = new Date()
  const out: NetWorthPersistResult = { written: 0, removed: 0 }

  db.transaction((tx) => {
    for (const account of result.contributions) {
      tx.insert(netWorthSnapshots)
        .values({
          date: result.date,
          accountMapId: account.accountMapId,
          valueCents: account.valueCents,
          currency: config.BASE_CURRENCY,
          computedAt,
        })
        .onConflictDoUpdate({
          target: [netWorthSnapshots.date, netWorthSnapshots.accountMapId],
          set: {
            valueCents: sql`excluded.value_cents`,
            currency: sql`excluded.currency`,
            computedAt: sql`excluded.computed_at`,
          },
        })
        .run()
      out.written += 1
    }

    const keep = result.contributions.map((account) => account.accountMapId)
    // An empty `notInArray` matches nothing in SQL rather than everything, so the
    // "nothing counts today" case needs its own branch or the stale rows survive.
    const where =
      keep.length > 0
        ? and(
            eq(netWorthSnapshots.date, result.date),
            notInArray(netWorthSnapshots.accountMapId, keep),
          )
        : eq(netWorthSnapshots.date, result.date)
    out.removed += tx.delete(netWorthSnapshots).where(where).run().changes
  })

  return out
}

/**
 * Totals per date, ascending — the net-worth series, and the input to
 * `net_worth_high`.
 *
 * Summed in SQL rather than in JS because this is the one query that runs over
 * every snapshot ever taken.
 */
export function loadNetWorthHistory(db: Db): { date: string; totalCents: number }[] {
  return db
    .select({
      date: netWorthSnapshots.date,
      totalCents: sql<number>`sum(${netWorthSnapshots.valueCents})`,
    })
    .from(netWorthSnapshots)
    .groupBy(netWorthSnapshots.date)
    .orderBy(netWorthSnapshots.date)
    .all()
}
