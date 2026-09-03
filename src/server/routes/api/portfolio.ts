/**
 * `GET /api/portfolio` — the latest snapshot, its metrics and the value curve.
 *
 * Read from `portfolio_snapshots` and `portfolio_metrics`, never from Ghostfolio.
 * Which matters more here than anywhere else in the API: Ghostfolio's price
 * provider is the slowest thing in the stack and three of the four endpoints
 * Balancr reads from it are its frontend's internal API. A page that called it on
 * load would be both slow and fragile, and it would call the provider once per
 * refresh of a chart nobody is watching.
 *
 * `twrBp` is Ghostfolio's own reported net performance rather than a figure
 * computed here, and `mwrBp` is deliberately absent until the deferred work lands.
 * Reading it back as zero would be inventing a number, which is the one thing this
 * layer must never do.
 *
 * `advice` is the exception to "read, do not compute", and deliberately so. Drift is a
 * comparison between a stored allocation and a risk profile the settings page can change
 * at any moment, so a figure computed by the nightly job would disagree with the bands on
 * screen for up to a day — and it is the arithmetic of four subtractions over four rows.
 * `portfolio_metrics.drift_json` stays null for the same reason: there is nothing worth
 * storing that would not immediately be stale. Reading the profile, the fund universe and
 * the tax rules is three cheap reads, all of which degrade to "no advice" rather than to
 * a 500.
 */
import type { Db } from '../../../db/index.ts'
import { buildAdvice, type Advice, type HeldPosition } from '../../../domain/advice/suggest.ts'
import { loadProfile } from '../../../domain/advice/profile.ts'
import type { PortfolioMetricsResult } from '../../../domain/portfolio/metrics.ts'
import {
  latestSnapshotDate,
  loadPortfolioMetrics,
  loadPortfolioValueHistory,
  loadSnapshot,
} from '../../../domain/portfolio/store.ts'
import { taxRulesOrNull } from '../../../domain/tax/rules.ts'
import { universeOrEmpty } from '../../../domain/universe/universe.ts'
import { freshness } from './freshness.ts'
import { portfolioSchema, type Portfolio } from './schemas.ts'

/**
 * The invested/cash split, or two nulls when this date does not have one.
 *
 * Split out so the condition is stated once: the two halves are known together or
 * not at all, and one of them present with the other missing would be a third state
 * for a client to get wrong.
 */
function splitOrNull(
  metrics: PortfolioMetricsResult | null,
): { investedValueCents: number | null; cashValueCents: number | null } {
  if (metrics === null) return { investedValueCents: null, cashValueCents: null }
  const known = metrics.investedValueCents + metrics.cashValueCents === metrics.totalValueCents
  if (!known) return { investedValueCents: null, cashValueCents: null }
  return {
    investedValueCents: metrics.investedValueCents,
    cashValueCents: metrics.cashValueCents,
  }
}

/**
 * The drift against the stored risk profile, or `null` when there is nothing to measure.
 *
 * Bands are shares of the *invested* value, so a date without a known invested/cash split
 * has no denominator: measuring against the total would put every share below its floor on
 * an instance whose Ghostfolio holds a synced bank balance, and produce four confident
 * suggestions to buy. `investedValueCents` is null exactly when the split is unknown,
 * which is why that is the condition here rather than a check on the allocation.
 *
 * The holdings are passed as they are stored, class label included, so a sale can name
 * the position it would come out of. Rows written before `asset_class` existed carry
 * null and simply do not match a band, which reads as "the class is overweight and we
 * cannot say what in it" rather than as a suggestion to sell something unnamed.
 */
function adviceOrNull(
  db: Db,
  metrics: PortfolioMetricsResult | null,
  investedValueCents: number | null,
  holdings: readonly HeldPosition[],
): Advice | null {
  if (metrics === null || investedValueCents === null) return null
  return buildAdvice({
    allocation: metrics.allocation.map((slice) => ({
      key: slice.key,
      valueCents: slice.valueCents,
      shareBp: slice.shareBp,
    })),
    investedValueCents,
    profile: loadProfile(db),
    universe: universeOrEmpty(),
    rules: taxRulesOrNull(),
    holdings,
  })
}

export function buildPortfolio(db: Db): Portfolio {
  const date = latestSnapshotDate(db)
  const metrics = date === null ? null : loadPortfolioMetrics(db, date)
  const holdings = date === null ? [] : loadSnapshot(db, date)
  const split = splitOrNull(metrics)

  return portfolioSchema.parse({
    freshness: freshness(db),
    date,
    totalValueCents: metrics?.totalValueCents ?? null,
    // `loadPortfolioMetrics` reads an absent split back as zero, which is the honest
    // reading of "no invested value recorded" — but on the wire that would draw a
    // card saying nothing is invested. A date whose split adds up to nothing while
    // its total does not is a date that never had one, so it is sent as null and the
    // page shows no split rather than a wrong one.
    ...split,
    twrBp: metrics?.twrBp ?? null,
    allocation: (metrics?.allocation ?? []).map((slice) => ({
      assetClass: slice.key,
      valueCents: slice.valueCents,
      shareBp: slice.shareBp,
    })),
    holdings: holdings
      .map((row) => ({
        instrument: row.instrument,
        symbol: row.symbol,
        isin: row.isin,
        name: row.name,
        quantity: row.quantity,
        priceCents: row.priceCents,
        // Null for rows snapshotted before the column existed. Their native
        // currency was never recorded, so the value currency is the only honest
        // answer left — the same one those rows were rendered with all along.
        priceCurrency: row.priceCurrency ?? row.currency,
        valueCents: row.valueCents,
        currency: row.currency,
      }))
      // Largest first: a holdings table is read to see what dominates.
      .sort((a, b) => b.valueCents - a.valueCents),
    history: loadPortfolioValueHistory(db),
    advice: adviceOrNull(db, metrics, split.investedValueCents, holdings),
  })
}
