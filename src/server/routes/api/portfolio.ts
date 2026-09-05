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
 * `advice` is the exception to "read, do not compute", and deliberately so — the reason
 * is in `domain/advice/latest.ts`, which computes it, along with why
 * `portfolio_metrics.drift_json` stays null. It lives there rather than here because the
 * AI bundle asks the same question, and "the narrative's figures match the portfolio
 * page" is only structural while both go through one function (#183).
 *
 * `properties` is the one field on this response that never touches Ghostfolio at all
 * (#227) — deliberately outside `allocation`/`advice`, see `domain/property/vocabulary.ts`.
 * Priced as of the request rather than as of `date`: a mortgage amortizes with the
 * calendar, not with whatever night Ghostfolio's snapshot last ran, and a fresh install
 * with no Ghostfolio holdings at all (`date === null`) still has properties to show.
 */
import type { Db } from '../../../db/index.ts'
import { adviceFor } from '../../../domain/advice/latest.ts'
import { knownSplit } from '../../../domain/portfolio/metrics.ts'
import {
  latestSnapshotDate,
  loadPortfolioMetrics,
  loadPortfolioValueHistory,
  loadSnapshot,
} from '../../../domain/portfolio/store.ts'
import {
  grossYieldBp,
  loadProperties,
  netCashFlowCents,
  outstandingBalanceCents,
  propertyEquityCents,
  totalEquityCents,
} from '../../../domain/property/properties.ts'
import { freshness } from './freshness.ts'
import { portfolioSchema, type Portfolio } from './schemas.ts'

export function buildPortfolio(db: Db): Portfolio {
  const date = latestSnapshotDate(db)
  const metrics = date === null ? null : loadPortfolioMetrics(db, date)
  const holdings = date === null ? [] : loadSnapshot(db, date)
  const split = knownSplit(metrics)
  const today = new Date().toISOString().slice(0, 10)
  const properties = loadProperties(db).properties

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
    advice: adviceFor(db, metrics, split.investedValueCents, holdings),
    properties: properties.map((property) => ({
      id: property.id,
      kind: property.kind,
      label: property.label,
      propertyValueCents: property.propertyValueCents,
      mortgageBalanceCents: outstandingBalanceCents(property.mortgage, today),
      equityCents: propertyEquityCents(property, today),
      rentCents: property.rentCents,
      netCashFlowCents: netCashFlowCents(property),
      grossYieldBp: grossYieldBp(property),
    })),
    totalPropertyEquityCents: totalEquityCents(properties, today),
  })
}
