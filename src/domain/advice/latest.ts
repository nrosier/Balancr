/**
 * The latest drift, computed once, for whoever needs it (#183).
 *
 * Two callers now ask "how far is the portfolio from its profile": the portfolio page,
 * which draws the bands and the trade that would close them, and the AI bundle, which
 * puts the same figures through the redaction boundary so a narrative can explain them.
 * The acceptance criterion for the second is "the figures match the portfolio page
 * exactly", and the only way to make that structural rather than a test somebody has to
 * keep writing is one function both go through.
 *
 * It reads, which is why it is not in `suggest.ts` or `persistence.ts` — both of those are
 * pure by design and stay that way. What it does *not* do is store: `portfolio_metrics
 * .drift_json` is still null, because drift is a comparison against a risk profile the
 * settings page can change at any moment, so a figure written by the nightly job would
 * disagree with the bands on screen for up to a day. Recomputing it is four subtractions
 * over four rows and three cheap settings reads, all of which degrade to "no advice"
 * rather than to a 500.
 */
import type { Db } from '../../db/index.ts'
import { knownSplit, type PortfolioMetricsResult } from '../portfolio/metrics.ts'
import {
  latestSnapshotDate,
  loadPortfolioMetrics,
  loadSnapshot,
  monthEndMetrics,
} from '../portfolio/store.ts'
import { taxRulesOrNull } from '../tax/rules.ts'
import { universeOrEmpty } from '../universe/universe.ts'
import { bandsOf, isPreset, loadProfile } from './profile.ts'
import { driftPersistence, type AllocationMonth, type DriftPersistence } from './persistence.ts'
import { buildAdvice, type Advice, type HeldPosition } from './suggest.ts'

/**
 * The drift against the stored risk profile, or `null` when there is nothing to measure.
 *
 * `investedValueCents` is null exactly when the split is unknown — see `knownSplit` for
 * why that is the condition rather than a check on the allocation.
 *
 * The holdings are passed as they are stored, class label included, so a sale can name
 * the position it would come out of. Rows written before `asset_class` existed carry null
 * and simply do not match a band, which reads as "the class is overweight and we cannot
 * say what in it" rather than as a suggestion to sell something unnamed.
 */
export function adviceFor(
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

/** Today's advice for the newest snapshot, exactly as `GET /api/portfolio` reports it. */
export function latestAdvice(db: Db): Advice | null {
  const date = latestSnapshotDate(db)
  if (date === null) return null
  const metrics = loadPortfolioMetrics(db, date)
  return adviceFor(db, metrics, knownSplit(metrics).investedValueCents, loadSnapshot(db, date))
}

/**
 * How long each class has been outside its band, or `null` when nothing can be measured.
 *
 * `months` is how far back to look, and it is deliberately the caller's: the signal
 * producer needs `persistentMonths` of history to answer its own threshold and one month
 * more is one more query for a number nobody reads. A run longer than the window simply
 * reports the window, which understates rather than invents.
 *
 * The newest observation is dropped in favour of the live metrics row it duplicates —
 * `monthEndMetrics` returns the last row of each month, and for the current month that is
 * the same row `latestAdvice` reads — so the count and the figures beside it are one
 * reading of one snapshot rather than two of the same one.
 */
export function latestDriftPersistence(db: Db, months: number): DriftPersistence | null {
  const advice = latestAdvice(db)
  if (advice === null) return null

  const profile = loadProfile(db)
  const history: AllocationMonth[] = monthEndMetrics(db, months).map((metrics) => ({
    month: metrics.date.slice(0, 7),
    allocation: metrics.allocation.map((slice) => ({
      key: slice.key,
      valueCents: slice.valueCents,
      shareBp: slice.shareBp,
    })),
    // Zero when the split was never recorded, which `driftPersistence` skips — and
    // skipping ends a run rather than counting the month as inside a band.
    investedValueCents: knownSplit(metrics).investedValueCents ?? 0,
  }))

  return driftPersistence({
    drift: advice.drift,
    history,
    bands: bandsOf(profile),
    profile: profile.profile,
    isPreset: isPreset(profile),
  })
}
