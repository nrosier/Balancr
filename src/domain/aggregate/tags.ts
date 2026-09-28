/**
 * Per-tag net cost/gain totals (#663), cached at sync time.
 *
 * `tag_monthly_facts` holds one signed net-total row per tag per month — the same
 * upsert-not-delete-then-insert, explicit-stale-row-removal shape `facts.ts` already
 * uses for `monthly_category_facts`, and for the same reason: this table is rebuilt
 * from Actual on every sync and never hand-edited, so a delete-then-insert's window
 * with no rows for a tag mid-transaction is a bug waiting to be seen on a page load.
 *
 * All three requested views — all-time, rolling 12 months, this calendar year — are
 * derived from that one stored series at read time (`loadTagTotals`), not stored as
 * separate columns: there is nothing a read-time sum over the series can't answer.
 */
import { and, eq, gte, inArray, notInArray, sql } from 'drizzle-orm'
import type { ActualTag, TagMonthTotal } from '../../adapters/actual/queries.ts'
import type { Db } from '../../db/index.ts'
import { tagMeta, tagMonthlyFacts } from '../../db/schema.ts'
import { addMonths } from '../../util/month.ts'
import type { Transaction } from '../audit.ts'
import type { PersistResult } from './facts.ts'

/** Mirrors `facts.ts`'s own `CHUNK`: a bounded statement size, not a real limit. */
const CHUNK = 200

/**
 * Upserts `tag_meta` from a nightly `fetchTags` pass. Like `syncScheduleMeta`, every
 * column is refreshed on every sync — Actual owns all of it, and there is no
 * user-entered column here to protect.
 */
export function syncTagMeta(db: Db | Transaction, tenantId: string, tags: readonly ActualTag[]): number {
  if (tags.length === 0) return 0

  const rows = tags.map((tag) => ({
    tenantId,
    tagId: tag.id,
    tag: tag.tag,
    color: tag.color,
    hidden: tag.hidden,
  }))

  db.transaction((tx) => {
    for (let start = 0; start < rows.length; start += CHUNK) {
      tx.insert(tagMeta)
        .values(rows.slice(start, start + CHUNK))
        .onConflictDoUpdate({
          target: [tagMeta.tenantId, tagMeta.tagId],
          set: {
            tag: sql`excluded.tag`,
            color: sql`excluded.color`,
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
 * Upserts `tag_monthly_facts` and drops rows for `months` whose tag no longer
 * appears there — the same reasoning `persistFacts` gives for categories. `tagsById`
 * resolves the tag *string* `fetchTagMonthlyTotals` groups by to the tag *id* the
 * table keys on; a total for a tag not in the map (deleted in Actual between the
 * fetch and here) is dropped rather than guessed at.
 *
 * `months` is passed separately from `totals` for the same reason `persistFacts`
 * takes it separately from `facts`: a month that legitimately ends up with no tagged
 * transactions at all must still be cleared of any stale rows from a previous sync.
 *
 * `activeTagIds` scopes that stale-row cleanup to tags `sync.ts` actually asked
 * Actual about this pass (#750): hiding a tag makes `sync.ts` stop including it in
 * `fetchTagMonthlyTotals`'s tag list, so it never appears in `totals` for any month —
 * indistinguishable, from `totals` alone, from a tag that genuinely had no matching
 * transactions this month. Without this scope the cleanup below would read that
 * absence as staleness and erase the hidden tag's entire history on the very next
 * sync. Restricting deletion to `activeTagIds` means hiding a tag only stops it
 * gaining new rows; a still-active tag with a real gap this month is unaffected.
 */
export function persistTagFacts(
  db: Db | Transaction,
  tenantId: string,
  totals: readonly TagMonthTotal[],
  tagsById: ReadonlyMap<string, string>,
  months: readonly string[],
  activeTagIds: ReadonlySet<string>,
): PersistResult {
  const computedAt = new Date()
  const result: PersistResult = { written: 0, removed: 0 }

  const rows = totals.flatMap((total) => {
    const tagId = tagsById.get(total.tag)
    if (tagId === undefined) return []
    return [{ tenantId, month: total.month, tagId, netCents: total.netCents, txnCount: total.txnCount, computedAt }]
  })

  db.transaction((tx) => {
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK)
      tx.insert(tagMonthlyFacts)
        .values(chunk)
        .onConflictDoUpdate({
          target: [tagMonthlyFacts.tenantId, tagMonthlyFacts.month, tagMonthlyFacts.tagId],
          set: {
            netCents: sql`excluded.net_cents`,
            txnCount: sql`excluded.txn_count`,
            computedAt: sql`excluded.computed_at`,
          },
        })
        .run()
      result.written += chunk.length
    }

    if (activeTagIds.size > 0) {
      const active = [...activeTagIds]
      for (const month of months) {
        const keep = rows.filter((row) => row.month === month).map((row) => row.tagId)
        // `notInArray` with an empty list matches nothing rather than everything, so
        // the all-cleared case needs its own branch — same pitfall `persistFacts` notes.
        const where =
          keep.length > 0
            ? and(
                eq(tagMonthlyFacts.tenantId, tenantId),
                eq(tagMonthlyFacts.month, month),
                inArray(tagMonthlyFacts.tagId, active),
                notInArray(tagMonthlyFacts.tagId, keep),
              )
            : and(
                eq(tagMonthlyFacts.tenantId, tenantId),
                eq(tagMonthlyFacts.month, month),
                inArray(tagMonthlyFacts.tagId, active),
              )

        result.removed += tx.delete(tagMonthlyFacts).where(where).run().changes
      }
    }
  })

  return result
}

export interface TagTotal {
  id: string
  tag: string
  color: string | null
  /** Signed, Actual's own convention: negative is a net cost, positive a net gain. */
  allTimeNetCents: number
  rolling12NetCents: number
  thisYearNetCents: number
  /** Ascending. One entry per month that has ever had a matching transaction. */
  byMonth: { month: string; netCents: number; txnCount: number }[]
}

/**
 * How much of the per-month series a page load returns — a display decision, not the
 * sync job's own retention window (`config.JOBS_HISTORY_MONTHS`), the same split
 * `budget.ts`'s own `HISTORY_MONTHS` draws for its trend charts (#692). Facts outside
 * this window still count fully toward `allTimeNetCents` below; only the chart-sized
 * `byMonth` series is bounded.
 */
const TAG_SERIES_MONTHS = 24

/**
 * Every non-hidden tag with its three summary views, derived from the stored monthly
 * series rather than from a separately-maintained column — see this file's own doc
 * comment for why. "All-time" means every month `tag_monthly_facts` has ever held for
 * that tag, the same sense `monthly_category_facts`/`history.earliest` already use
 * elsewhere: since Balancr started persisting facts, not since some real-world start.
 *
 * `currentMonth` anchors both other windows: rolling 12 is the 12 months ending with
 * it, this-year is every stored month sharing its calendar year.
 *
 * The three summary figures are summed in SQL, not read row-by-row into JS: this is a
 * request-time read, and `tag_monthly_facts` grows monotonically with tenant age × tag
 * count with no retention cleanup of its own (#692), the same reasoning
 * `loadNetWorthHistory` already gives for pushing its own sum into SQL. Only the
 * `byMonth` series — capped to `TAG_SERIES_MONTHS` — still needs individual rows.
 */
export function loadTagTotals(db: Db, tenantId: string, currentMonth: string): TagTotal[] {
  const metaRows = db
    .select()
    .from(tagMeta)
    .where(and(eq(tagMeta.tenantId, tenantId), eq(tagMeta.hidden, false)))
    .all()
  if (metaRows.length === 0) return []

  const rolling12Start = addMonths(currentMonth, -11)
  const yearPrefix = currentMonth.slice(0, 4)

  const totalsRows = db
    .select({
      tagId: tagMonthlyFacts.tagId,
      allTimeNetCents: sql<number>`sum(${tagMonthlyFacts.netCents})`,
      rolling12NetCents: sql<number>`sum(case when ${tagMonthlyFacts.month} >= ${rolling12Start} then ${tagMonthlyFacts.netCents} else 0 end)`,
      thisYearNetCents: sql<number>`sum(case when ${tagMonthlyFacts.month} like ${`${yearPrefix}%`} then ${tagMonthlyFacts.netCents} else 0 end)`,
    })
    .from(tagMonthlyFacts)
    .where(eq(tagMonthlyFacts.tenantId, tenantId))
    .groupBy(tagMonthlyFacts.tagId)
    .all()
  const totalsByTagId = new Map(totalsRows.map((row) => [row.tagId, row]))

  const seriesCutoff = addMonths(currentMonth, -(TAG_SERIES_MONTHS - 1))
  const factRows = db
    .select({
      tagId: tagMonthlyFacts.tagId,
      month: tagMonthlyFacts.month,
      netCents: tagMonthlyFacts.netCents,
      txnCount: tagMonthlyFacts.txnCount,
    })
    .from(tagMonthlyFacts)
    .where(and(eq(tagMonthlyFacts.tenantId, tenantId), gte(tagMonthlyFacts.month, seriesCutoff)))
    .orderBy(tagMonthlyFacts.month)
    .all()

  const byTagId = new Map<string, { month: string; netCents: number; txnCount: number }[]>()
  for (const row of factRows) {
    let series = byTagId.get(row.tagId)
    if (series === undefined) {
      series = []
      byTagId.set(row.tagId, series)
    }
    series.push({ month: row.month, netCents: row.netCents, txnCount: row.txnCount })
  }

  return metaRows.map((meta) => {
    const totals = totalsByTagId.get(meta.tagId)
    return {
      id: meta.tagId,
      tag: meta.tag,
      color: meta.color,
      allTimeNetCents: totals?.allTimeNetCents ?? 0,
      rolling12NetCents: totals?.rolling12NetCents ?? 0,
      thisYearNetCents: totals?.thisYearNetCents ?? 0,
      byMonth: byTagId.get(meta.tagId) ?? [],
    }
  })
}
