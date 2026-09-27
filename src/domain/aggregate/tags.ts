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
import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { ActualTag, TagMonthTotal } from '../../adapters/actual/queries.ts'
import type { Db } from '../../db/index.ts'
import { tagMeta, tagMonthlyFacts } from '../../db/schema.ts'
import { addMonths, monthRange } from '../../util/month.ts'
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
 */
export function persistTagFacts(
  db: Db | Transaction,
  tenantId: string,
  totals: readonly TagMonthTotal[],
  tagsById: ReadonlyMap<string, string>,
  months: readonly string[],
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

    for (const month of months) {
      const keep = rows.filter((row) => row.month === month).map((row) => row.tagId)
      // `notInArray` with an empty list matches nothing rather than everything, so
      // the all-cleared case needs its own branch — same pitfall `persistFacts` notes.
      const where =
        keep.length > 0
          ? and(
              eq(tagMonthlyFacts.tenantId, tenantId),
              eq(tagMonthlyFacts.month, month),
              notInArray(tagMonthlyFacts.tagId, keep),
            )
          : and(eq(tagMonthlyFacts.tenantId, tenantId), eq(tagMonthlyFacts.month, month))

      result.removed += tx.delete(tagMonthlyFacts).where(where).run().changes
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
 * Every non-hidden tag with its three summary views, derived from the stored monthly
 * series rather than from a separately-maintained column — see this file's own doc
 * comment for why. "All-time" means every month `tag_monthly_facts` has ever held for
 * that tag, the same sense `monthly_category_facts`/`history.earliest` already use
 * elsewhere: since Balancr started persisting facts, not since some real-world start.
 *
 * `currentMonth` anchors both other windows: rolling 12 is the 12 months ending with
 * it, this-year is every stored month sharing its calendar year.
 */
export function loadTagTotals(db: Db, tenantId: string, currentMonth: string): TagTotal[] {
  const metaRows = db
    .select()
    .from(tagMeta)
    .where(and(eq(tagMeta.tenantId, tenantId), eq(tagMeta.hidden, false)))
    .all()
  if (metaRows.length === 0) return []

  const factRows = db.select().from(tagMonthlyFacts).where(eq(tagMonthlyFacts.tenantId, tenantId)).all()

  const byTagId = new Map<string, { month: string; netCents: number; txnCount: number }[]>()
  for (const row of factRows) {
    let series = byTagId.get(row.tagId)
    if (series === undefined) {
      series = []
      byTagId.set(row.tagId, series)
    }
    series.push({ month: row.month, netCents: row.netCents, txnCount: row.txnCount })
  }

  const rolling12 = new Set(monthRange(addMonths(currentMonth, -11), currentMonth))
  const yearPrefix = currentMonth.slice(0, 4)

  return metaRows.map((meta) => {
    const series = (byTagId.get(meta.tagId) ?? []).sort((a, b) => a.month.localeCompare(b.month))
    let allTime = 0
    let rolling = 0
    let thisYear = 0
    for (const point of series) {
      allTime += point.netCents
      if (rolling12.has(point.month)) rolling += point.netCents
      if (point.month.startsWith(yearPrefix)) thisYear += point.netCents
    }
    return {
      id: meta.tagId,
      tag: meta.tag,
      color: meta.color,
      allTimeNetCents: allTime,
      rolling12NetCents: rolling,
      thisYearNetCents: thisYear,
      byMonth: series,
    }
  })
}
