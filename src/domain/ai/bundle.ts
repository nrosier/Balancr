/**
 * Everything the model is allowed to see, collected out of SQLite.
 *
 * The counterpart to `redact.ts`: this decides what is *in* the bundle, that
 * decides what leaves the machine. Both matter, and this one comes first — a
 * field never collected cannot leak, whatever anyone adds downstream later.
 *
 * Reads only the fact tables. No Actual call, no Ghostfolio call, no
 * recomputation: opening the insights page must not download a budget, and a
 * figure the model explains must be the same figure the page shows. That is also
 * why the hygiene score is read rather than recalculated — the signals pass
 * computed it over a specific window, and a second opinion here would be a second
 * authority for the same number.
 *
 * `collectBundle` returns null rather than an empty bundle when a month has not
 * been judged yet. An analysis of a month whose facts do not exist would be an
 * analysis of zero, and the model has no way to tell the difference.
 */
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { loadAccountMap } from '../aggregate/accounts.ts'
import { loadCategoryMeta, loadFacts } from '../aggregate/facts.ts'
import {
  loadMismatches,
  loadTrailingTotals,
  loadUncategorised,
} from '../aggregate/month-store.ts'
import { loadLatestNetWorth } from '../aggregate/networth-store.ts'
import { loadHygiene, loadSignals } from '../aggregate/signals-store.ts'
import { countSnapshotHoldings, latestSnapshotDate, loadPortfolioMetrics } from '../portfolio/store.ts'
import type { MonthlyFact } from '../aggregate/spend.ts'
import type { AnalysisBundle, BundleCategory, BundlePortfolio } from './redact.ts'

/**
 * A hidden category with nothing in it is dropped.
 *
 * Actual hides a category that is no longer used, and a budget accumulates them.
 * Sending forty empty envelopes costs tokens and invites the model to remark on
 * them; a hidden category that *did* see money is a different matter and stays,
 * because that is worth knowing about.
 */
function worthSending(fact: MonthlyFact): boolean {
  if (!fact.hidden) return true
  return fact.spentCents !== 0 || fact.budgetedCents !== 0 || fact.txnCount !== 0
}

/** The latest stored portfolio, or null when there has never been a snapshot. */
export function collectPortfolio(db: Db): BundlePortfolio | null {
  const date = latestSnapshotDate(db)
  if (date === null) return null
  const metrics = loadPortfolioMetrics(db, date)
  // A snapshot without metrics means the portfolio job wrote holdings and then
  // failed. Reporting the holdings count on its own would put a portfolio with no
  // value in front of the model.
  if (metrics === null) return null
  return { metrics, holdingCount: countSnapshotHoldings(db, date) }
}

/**
 * The month's facts, findings and context, or null when it has not been judged.
 *
 * The trailing window comes from `loadTrailingTotals`, the same call the signals
 * job makes, so the history the model sees is the history the score was computed
 * over rather than a second window that happens to be nearby.
 */
export function collectBundle(
  db: Db,
  month: string,
  locale: string = config.DEFAULT_LOCALE,
): AnalysisBundle | null {
  const hygiene = loadHygiene(db, month)
  // Present exactly when the signals pass has run for this month: `persistSignals`
  // always writes the row, even for a month with nothing to report.
  if (hygiene === null) return null

  const history = loadTrailingTotals(db, month, config.JOBS_HISTORY_MONTHS)
  const totals = history[history.length - 1]
  if (totals === undefined) return null

  const meta = loadCategoryMeta(db)
  const categories: BundleCategory[] = loadFacts(db, month)
    .filter(worthSending)
    .map((fact) => ({ fact, meta: meta.get(fact.categoryId) ?? null }))

  const window = history.map((entry) => entry.month)
  const uncategorised = loadUncategorised(db, window)

  return {
    month,
    locale,
    currency: config.BASE_CURRENCY,
    categories,
    totals,
    // The month itself is `totals`; repeating it in the history would have the
    // model read the latest point twice when it looks for a trend.
    totalsHistory: history.slice(0, -1),
    netWorth: loadLatestNetWorth(db),
    hygiene: {
      scoreBp: hygiene.scoreBp,
      uncategorisedCount: uncategorised.reduce((sum, bucket) => sum + bucket.txnCount, 0),
      // Magnitudes, as in `hygiene.ts`: a refund cancelling a charge does not mean
      // there is nothing left to categorise.
      uncategorisedCents: uncategorised.reduce(
        (sum, bucket) => sum + Math.abs(bucket.amountCents),
        0,
      ),
      mismatchCount: loadMismatches(db, [month]).length,
    },
    portfolio: collectPortfolio(db),
    accounts: loadAccountMap(db),
    signals: loadSignals(db, month),
  }
}
