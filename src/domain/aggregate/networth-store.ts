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
import { and, eq, lte, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { accountMap, netWorthSnapshots, type AccountKind } from '../../db/schema.ts'
import type { AccountBalance } from './accounts.ts'
import { config } from '../../config.ts'
import { LIQUID, resolveInclusion, type NetWorthResult, type NetWorthSummary } from './networth.ts'

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
  tenantId: string,
  result: NetWorthResult,
): NetWorthPersistResult {
  const computedAt = new Date()
  const out: NetWorthPersistResult = { written: 0, removed: 0 }

  db.transaction((tx) => {
    for (const account of result.contributions) {
      tx.insert(netWorthSnapshots)
        .values({
          tenantId,
          date: result.date,
          accountMapId: account.accountMapId,
          valueCents: account.valueCents,
          currency: config.BASE_CURRENCY,
          computedAt,
        })
        .onConflictDoUpdate({
          target: [
            netWorthSnapshots.tenantId,
            netWorthSnapshots.date,
            netWorthSnapshots.accountMapId,
          ],
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
            eq(netWorthSnapshots.tenantId, tenantId),
            eq(netWorthSnapshots.date, result.date),
            notInArray(netWorthSnapshots.accountMapId, keep),
          )
        : and(eq(netWorthSnapshots.tenantId, tenantId), eq(netWorthSnapshots.date, result.date))
    out.removed += tx.delete(netWorthSnapshots).where(where).run().changes
  })

  return out
}

/**
 * Dates that already have snapshot rows.
 *
 * The backfill skips these rather than recomputing them, and the reason is not only
 * cost. A row for a past date written by the nightly pass was written *on* that date,
 * from that day's real balances — which is a better figure than a reconstruction, not
 * a worse one. So "already present" is a reason to leave it alone, and the only date
 * the nightly pass ever writes is its own.
 */
export function snapshotDates(db: Db, tenantId: string): Set<string> {
  return new Set(
    db
      .selectDistinct({ date: netWorthSnapshots.date })
      .from(netWorthSnapshots)
      .where(eq(netWorthSnapshots.tenantId, tenantId))
      .all()
      .map((row) => row.date),
  )
}

/**
 * Totals per date, ascending — the net-worth series, and the input to
 * `net_worth_high`.
 *
 * Summed in SQL rather than in JS because this is the one query that runs over
 * every snapshot ever taken.
 */
export function loadNetWorthHistory(
  db: Db,
  tenantId: string,
): { date: string; totalCents: number }[] {
  return db
    .select({
      date: netWorthSnapshots.date,
      totalCents: sql<number>`sum(${netWorthSnapshots.valueCents})`,
    })
    .from(netWorthSnapshots)
    .where(eq(netWorthSnapshots.tenantId, tenantId))
    .groupBy(netWorthSnapshots.date)
    .orderBy(netWorthSnapshots.date)
    .all()
}

/**
 * The most recent stored snapshot, summed back into a summary.
 *
 * Recomputed from the per-account rows rather than from a stored total, because
 * there is no stored total: `persistNetWorth` writes only the accounts that
 * counted, so summing them is the definition of the figure rather than a second
 * opinion on it. The kinds come from today's `account_map`, which is also what
 * makes a mapping correction show up in the summary of an older date.
 */
/**
 * The most recent stored value and currency for every account that has one.
 *
 * For the duplicate matcher, which compares balances rather than reading a total:
 * a tool that syncs two systems every quarter of an hour leaves the same figure on
 * both sides, so agreement on the number is the strongest evidence available that
 * two rows are the same money — usually stronger than the name, which people edit.
 *
 * Accounts with no snapshot yet are simply absent rather than zero. Absent means
 * "no evidence"; zero would mean "agrees with every other empty account".
 */
export function loadLatestAccountBalances(db: Db, tenantId: string): AccountBalance[] {
  const latest = db
    .select({ date: sql<string>`max(${netWorthSnapshots.date})` })
    .from(netWorthSnapshots)
    .where(eq(netWorthSnapshots.tenantId, tenantId))
    .get()
  const date = latest?.date ?? null
  if (date === null) return []

  return db
    .select({
      accountMapId: netWorthSnapshots.accountMapId,
      valueCents: netWorthSnapshots.valueCents,
      currency: netWorthSnapshots.currency,
    })
    .from(netWorthSnapshots)
    .where(and(eq(netWorthSnapshots.tenantId, tenantId), eq(netWorthSnapshots.date, date)))
    .all()
}

function summariseNetWorth(db: Db, tenantId: string, date: string): NetWorthSummary {
  const rows = db
    .select({ kind: accountMap.kind, valueCents: netWorthSnapshots.valueCents })
    .from(netWorthSnapshots)
    .innerJoin(accountMap, eq(accountMap.id, netWorthSnapshots.accountMapId))
    .where(and(eq(netWorthSnapshots.tenantId, tenantId), eq(netWorthSnapshots.date, date)))
    .all()

  const summary: NetWorthSummary = {
    date,
    totalCents: 0,
    liquidCents: 0,
    investedCents: 0,
    debtCents: 0,
  }
  for (const row of rows) {
    summary.totalCents += row.valueCents
    if (LIQUID.has(row.kind)) summary.liquidCents += row.valueCents
    if (row.kind === 'investment') summary.investedCents += row.valueCents
    if (row.valueCents < 0) summary.debtCents += -row.valueCents
  }
  return summary
}

export function loadLatestNetWorth(db: Db, tenantId: string): NetWorthSummary | null {
  const latest = db
    .select({ date: sql<string>`max(${netWorthSnapshots.date})` })
    .from(netWorthSnapshots)
    .where(eq(netWorthSnapshots.tenantId, tenantId))
    .get()
  const date = latest?.date ?? null
  return date === null ? null : summariseNetWorth(db, tenantId, date)
}

/**
 * The latest snapshot on or before `onOrBefore`, rather than the tenant's latest
 * one overall (#498). A bundle built for month `M` must not cite a snapshot from
 * after `M` just because a later month has since been synced — `loadLatestNetWorth`
 * has no such bound, which is right for its "right now" callers (`overview.ts`,
 * `scenario.ts`, `forecast.ts`, `signals.ts`'s live path) but wrong for a bundle
 * that is retroactively about a specific month.
 */
export function loadNetWorthAsOf(db: Db, tenantId: string, onOrBefore: string): NetWorthSummary | null {
  const latest = db
    .select({ date: sql<string>`max(${netWorthSnapshots.date})` })
    .from(netWorthSnapshots)
    .where(and(eq(netWorthSnapshots.tenantId, tenantId), lte(netWorthSnapshots.date, onOrBefore)))
    .get()
  const date = latest?.date ?? null
  return date === null ? null : summariseNetWorth(db, tenantId, date)
}

export interface OffBudgetAccount {
  accountMapId: string
  name: string
  kind: AccountKind
  balanceCents: number
  currency: string
}

/**
 * Off-budget Actual accounts that count toward net worth today, with their balance.
 *
 * Off-budget accounts are already summed into `loadLatestNetWorth`'s `totalCents` —
 * that has never excluded them (#353) — this only names them, so the mortgage or the
 * house-value tracker behind the total is no longer invisible. Filtered through
 * `resolveInclusion` rather than a raw `WHERE`, so an off-budget account someone has
 * explicitly excluded from net worth, or lost a dedupe tie for, does not appear here
 * either — the same three judgement calls `computeNetWorth` itself respects.
 */
export function loadOffBudgetAccounts(db: Db, tenantId: string): OffBudgetAccount[] {
  const latest = db
    .select({ date: sql<string>`max(${netWorthSnapshots.date})` })
    .from(netWorthSnapshots)
    .where(eq(netWorthSnapshots.tenantId, tenantId))
    .get()
  const date = latest?.date ?? null
  if (date === null) return []

  const candidates = db
    .select({
      accountMapId: accountMap.id,
      name: accountMap.name,
      kind: accountMap.kind,
      includeInNetWorth: accountMap.includeInNetWorth,
      dedupeGroup: accountMap.dedupeGroup,
      isSourceOfTruth: accountMap.isSourceOfTruth,
      valueCents: netWorthSnapshots.valueCents,
      currency: netWorthSnapshots.currency,
    })
    .from(accountMap)
    .innerJoin(netWorthSnapshots, eq(netWorthSnapshots.accountMapId, accountMap.id))
    .where(
      and(
        eq(netWorthSnapshots.tenantId, tenantId),
        eq(accountMap.offBudget, true),
        eq(netWorthSnapshots.date, date),
      ),
    )
    .all()

  const { included } = resolveInclusion(candidates)
  return included.map((row) => ({
    accountMapId: row.accountMapId,
    name: row.name,
    kind: row.kind,
    balanceCents: row.valueCents,
    currency: row.currency,
  }))
}

/**
 * How much of `liquidCents` (#353) is sitting in an off-budget account — a savings
 * pot Actual keeps off-budget, say, that still counts toward net worth. `null` when
 * none of the off-budget money is liquid, the same "nothing to report" convention
 * every other optional net-worth figure uses, so a page can hide the split entirely
 * rather than draw a breakdown that sums to the whole of itself.
 *
 * Scoped to `LIQUID` kinds on purpose: an off-budget mortgage or brokerage account
 * already has its own place to be seen (`debtCents`, `investedCents`, and the full
 * list `loadOffBudgetAccounts` returns) — folding every kind in here would make
 * "directly available" the wrong figure to split it out of.
 */
export function loadOffBudgetLiquidCents(db: Db, tenantId: string): number | null {
  const liquid = loadOffBudgetAccounts(db, tenantId).filter((account) => LIQUID.has(account.kind))
  if (liquid.length === 0) return null
  return liquid.reduce((sum, account) => sum + account.balanceCents, 0)
}
