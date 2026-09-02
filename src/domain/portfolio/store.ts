/**
 * Persistence for portfolio snapshots and metrics.
 *
 * Same shape as the net-worth store, and for the same reason: a pass that runs
 * twice in one day must correct the day rather than duplicate it. Upsert on the
 * primary key, then delete the rows for that date whose instrument is gone — a
 * position sold this morning must not linger in this afternoon's snapshot.
 */
import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { portfolioMetrics, portfolioSnapshots } from '../../db/schema.ts'
import type { ValuePoint } from './history.ts'
import type { AllocationSlice, PortfolioMetricsResult } from './metrics.ts'
import type { HoldingSnapshot } from './snapshot.ts'

export interface SnapshotPersistResult {
  written: number
  removed: number
}

export function persistPortfolioSnapshots(
  db: Db,
  date: string,
  holdings: readonly HoldingSnapshot[],
): SnapshotPersistResult {
  const computedAt = new Date()
  const out: SnapshotPersistResult = { written: 0, removed: 0 }

  db.transaction((tx) => {
    for (const holding of holdings) {
      tx.insert(portfolioSnapshots)
        .values({
          date,
          instrument: holding.instrument,
          symbol: holding.symbol,
          isin: holding.isin,
          name: holding.name,
          quantity: holding.quantity,
          priceCents: holding.priceCents,
          priceCurrency: holding.priceCurrency,
          valueCents: holding.valueCents,
          currency: holding.currency,
          computedAt,
        })
        .onConflictDoUpdate({
          target: [portfolioSnapshots.date, portfolioSnapshots.instrument],
          set: {
            symbol: sql`excluded.symbol`,
            isin: sql`excluded.isin`,
            name: sql`excluded.name`,
            quantity: sql`excluded.quantity`,
            priceCents: sql`excluded.price_cents`,
            priceCurrency: sql`excluded.price_currency`,
            valueCents: sql`excluded.value_cents`,
            currency: sql`excluded.currency`,
            computedAt: sql`excluded.computed_at`,
          },
        })
        .run()
      out.written += 1
    }

    const keep = holdings.map((holding) => holding.instrument)
    // `notInArray` with an empty list matches nothing in SQL, so an empty
    // portfolio needs its own branch or yesterday's holdings survive as today's.
    const where =
      keep.length > 0
        ? and(
            eq(portfolioSnapshots.date, date),
            notInArray(portfolioSnapshots.instrument, keep),
          )
        : eq(portfolioSnapshots.date, date)
    out.removed = tx.delete(portfolioSnapshots).where(where).run().changes
  })

  return out
}

/**
 * Allocation is stored as JSON because its shape belongs to this module, not to
 * the schema — a new slice field must not be a migration.
 */
export function persistPortfolioMetrics(db: Db, result: PortfolioMetricsResult): void {
  const computedAt = new Date()
  db.insert(portfolioMetrics)
    .values({
      date: result.date,
      twrBp: result.twrBp,
      mwrBp: result.mwrBp,
      totalValueCents: result.totalValueCents,
      allocationJson: JSON.stringify(result.allocation),
      driftJson: result.driftJson,
      terAnnualCents: result.terAnnualCents,
      computedAt,
    })
    .onConflictDoUpdate({
      target: portfolioMetrics.date,
      set: {
        twrBp: sql`excluded.twr_bp`,
        mwrBp: sql`excluded.mwr_bp`,
        totalValueCents: sql`excluded.total_value_cents`,
        allocationJson: sql`excluded.allocation_json`,
        driftJson: sql`excluded.drift_json`,
        terAnnualCents: sql`excluded.ter_annual_cents`,
        computedAt: sql`excluded.computed_at`,
      },
    })
    .run()
}

/**
 * Dates that already have a metrics row.
 *
 * Read before the backfill fetches anything, so a pass with nothing to do costs one
 * query and no network at all. That matters more than it looks: this is the only job
 * that talks to Actual once per month per account, and a backfill that re-derived
 * twenty-four settled month-ends every night would be indistinguishable from a bug.
 */
export function metricsDates(db: Db): Set<string> {
  return new Set(
    db.select({ date: portfolioMetrics.date }).from(portfolioMetrics).all().map((row) => row.date),
  )
}

export interface BackfillResult {
  written: number
  /** Dates that already had a row, which is the steady state. */
  kept: number
}

/**
 * Value-only metrics rows for past month-ends, out of Ghostfolio's own chart.
 *
 * `onConflictDoNothing`, not the upsert the nightly pass uses, and that is the whole
 * design of this function. A row the portfolio job wrote carries allocation and
 * Ghostfolio's reported return alongside the total; a chart point carries the total
 * and nothing else. Upserting would silently downgrade a real row to a poorer one the
 * first time a backfill ran over a date the nightly pass had already done — worse
 * data after a job succeeded, which is the failure nobody goes looking for.
 *
 * Everything but the total is null rather than empty. `twrBp` is the sharp one: the
 * chart carries `netPerformanceInPercentage` per point, so a return figure per
 * month-end looks available — but whether that field is a fraction or a percentage is
 * not settled by anything in this repo, and `reportedTwrBp` reads its sibling on the
 * summary as a fraction. Getting it backwards is a hundredfold error on a percentage,
 * which renders as a number rather than as a gap. `loadPortfolioMetrics` reads null
 * back as "not available yet", which is true.
 *
 * Nothing is written to `portfolio_snapshots`: there are no historical holdings to
 * write. That is also what keeps these rows out of every existing reader —
 * `latestSnapshotDate` looks at the holdings table, so the portfolio page and the AI
 * bundle still read a fully computed date, and only `loadPortfolioValueHistory`,
 * which selects the date and the total, ever sees a backfilled row.
 */
export function backfillPortfolioValues(
  db: Db,
  points: readonly ValuePoint[],
): BackfillResult {
  const computedAt = new Date()
  const out: BackfillResult = { written: 0, kept: 0 }

  db.transaction((tx) => {
    for (const point of points) {
      const changes = tx
        .insert(portfolioMetrics)
        .values({
          date: point.date,
          twrBp: null,
          mwrBp: null,
          totalValueCents: point.valueCents,
          allocationJson: null,
          driftJson: null,
          terAnnualCents: null,
          computedAt,
        })
        .onConflictDoNothing({ target: portfolioMetrics.date })
        .run().changes
      if (changes > 0) out.written += 1
      else out.kept += 1
    }
  })

  return out
}

/**
 * The most recent snapshot date, or null when there is none.
 *
 * This is what the hygiene score reads to decide whether prices are stale. It
 * measures *our* snapshot age deliberately: Ghostfolio's API exposes no as-of
 * date for a price, so the age of the last successful pass is the only honest
 * signal available.
 */
export function latestSnapshotDate(db: Db): string | null {
  const row = db
    .select({ date: sql<string | null>`max(${portfolioSnapshots.date})` })
    .from(portfolioSnapshots)
    .get()
  return row?.date ?? null
}

/** Allocation back out of JSON, keeping only slices that are still well formed. */
function toAllocation(json: string | null): AllocationSlice[] {
  if (json === null) return []
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (slice): slice is AllocationSlice =>
      slice !== null &&
      typeof slice === 'object' &&
      typeof (slice as { key?: unknown }).key === 'string' &&
      typeof (slice as { valueCents?: unknown }).valueCents === 'number' &&
      typeof (slice as { shareBp?: unknown }).shareBp === 'number',
  )
}

/**
 * The stored metrics for one date, or null when that date was never computed.
 *
 * Returns the same `PortfolioMetricsResult` the computation produced, so a caller
 * cannot tell whether the figures were just calculated or read back — which is
 * what lets the AI pass work entirely off SQLite.
 */
export function loadPortfolioMetrics(db: Db, date: string): PortfolioMetricsResult | null {
  const row = db.select().from(portfolioMetrics).where(eq(portfolioMetrics.date, date)).get()
  if (row === undefined) return null

  return {
    date: row.date,
    totalValueCents: row.totalValueCents,
    twrBp: row.twrBp,
    // Both are `null` in the type until the deferred tax and drift work lands;
    // reading them back as anything else would be inventing a figure.
    mwrBp: null,
    allocation: toAllocation(row.allocationJson),
    driftJson: null,
    terAnnualCents: null,
  }
}

/** How many holdings a date's snapshot has. A count, never the instruments. */
export function countSnapshotHoldings(db: Db, date: string): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(portfolioSnapshots)
    .where(eq(portfolioSnapshots.date, date))
    .get()
  return row?.count ?? 0
}

/** Holdings for one date, ordered as `toHoldingSnapshots` produced them. */
export function loadSnapshot(db: Db, date: string): (typeof portfolioSnapshots.$inferSelect)[] {
  return db
    .select()
    .from(portfolioSnapshots)
    .where(eq(portfolioSnapshots.date, date))
    .orderBy(portfolioSnapshots.instrument)
    .all()
}

/** Total portfolio value per date, ascending — the portfolio value series. */
export function loadPortfolioValueHistory(db: Db): { date: string; totalCents: number }[] {
  return db
    .select({ date: portfolioMetrics.date, totalCents: portfolioMetrics.totalValueCents })
    .from(portfolioMetrics)
    .orderBy(portfolioMetrics.date)
    .all()
}
