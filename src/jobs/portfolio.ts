/**
 * Today's holdings and metrics, from Ghostfolio.
 *
 * Snapshot date is the **local** calendar date: at 01:00 CEST the UTC date is
 * still yesterday, and a nightly pass that stamped yesterday would overwrite the
 * previous snapshot every single night and never advance the series.
 *
 * Performance is fetched separately from holdings and its failure is tolerated:
 * `twrBp` is one field on a page whose holdings and total are the point, so
 * losing the return figure must not lose the snapshot too.
 */
import {
  fetchPortfolioDetails,
  fetchPortfolioPerformance,
} from '../adapters/ghostfolio/client.ts'
import type { PortfolioPerformance } from '../adapters/ghostfolio/types.ts'
import { config } from '../config.ts'
import { computePortfolioMetrics } from '../domain/portfolio/metrics.ts'
import { toHoldingSnapshots } from '../domain/portfolio/snapshot.ts'
import {
  persistPortfolioMetrics,
  persistPortfolioSnapshots,
} from '../domain/portfolio/store.ts'
import { dateIn } from '../util/month.ts'
import type { Job, JobContext, JobDetail } from './runner.ts'

async function run({ db, now, log }: JobContext): Promise<JobDetail> {
  const date = dateIn(now, config.TZ)

  const details = await fetchPortfolioDetails()
  const holdings = toHoldingSnapshots(date, details, config.BASE_CURRENCY)

  let performance: PortfolioPerformance | null = null
  try {
    performance = await fetchPortfolioPerformance()
  } catch (error) {
    log.warn({ err: error }, 'Ghostfolio performance unavailable; twr will be null')
  }

  const metrics = computePortfolioMetrics(date, holdings, performance)
  const stored = persistPortfolioSnapshots(db, date, holdings)
  persistPortfolioMetrics(db, metrics)

  return {
    date,
    holdings: stored.written,
    holdingsRemoved: stored.removed,
    totalValueCents: metrics.totalValueCents,
    twrBp: metrics.twrBp,
    assetClasses: metrics.allocation.length,
  }
}

export const portfolioJob: Job = {
  name: 'portfolio',
  schedule: { kind: 'interval', minutes: config.JOBS_SYNC_INTERVAL_MINUTES },
  run,
}
