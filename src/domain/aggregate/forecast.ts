/**
 * A floor for the checking balance, twelve months out — #49.
 *
 * "Floor" rather than "prediction": this leans on income and fixed costs
 * that are already classified as such, plus a known annual or quarterly bill
 * placed in the month it actually lands, wherever that classification exists.
 * Everything else a household actually spends still leaves the account, so
 * it is covered too — see the average-spend paragraph below — just at a
 * coarser, blended precision than a tagged category or a detected bill gets.
 *
 * Everything here is read from tables a job already wrote — `category_meta`,
 * `monthly_category_facts` and `net_worth_snapshots` — the same convention
 * every route under `server/routes/api/` depends on. No raw transaction
 * history exists in this schema to re-derive a bill's timing from; the only
 * signal available is the dense monthly spend series `loadCategoryTrends`
 * already builds for the trend charts.
 *
 * **A monthly-cadence category** uses its already-computed EWMA baseline
 * (`baseline.ts`) as a flat monthly rate, the same figure the budget page
 * already calls "usual" — reusing it here rather than a second average keeps
 * the two screens from disagreeing about what "usual" means.
 *
 * **A quarterly or annual category** is different: `baseline.ts` deliberately
 * smooths it into a monthly rate, because for judging "is this a lot?" a
 * yearly premium is not a spike. A forecast wants the opposite — the whole
 * point of showing a bill on a timeline is the month it actually hits, not an
 * averaged trickle across all twelve. So this instead finds the most recent
 * month the category actually had a non-zero spend, and repeats that amount
 * forward at the cadence's own step size (`FREQUENCY_WINDOW`, the same map
 * `baseline.ts` uses to size its averaging window) until the occurrences run
 * past the horizon.
 *
 * **`irregular` is excluded from that repetition on purpose.** It means "no
 * known cadence" — `baseline.ts` borrows the annual window for it only to
 * size its own smoothing, not as a claim that the cost recurs every twelve
 * months. A one-off bonus or gift tagged `irregular` is real income, once;
 * projecting its exact amount forward every year would manufacture income
 * that was never promised to recur.
 *
 * **Everything else — spend not tagged `fixed` or `income` at all — still
 * has to leave the account.** Rather than requiring every category to be
 * tagged before it counts (most households will not have tagged more than a
 * handful), the household's own already-computed average total spend
 * (the same EWMA `household.ts` uses for the emergency-fund cushion) is
 * added as a flat monthly cost on top of the tagged categories and bills
 * above. It is a coarser number than a per-category baseline — it re-averages
 * some of the same noisy discretionary spend a `fixed`-tagged category and a
 * known bill already count precisely — but a floor that ignores most of a
 * household's real spending is a worse trade than a floor that double-counts
 * a little of it.
 */
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { addMonths, monthsBetween } from '../../util/month.ts'
import { ewma, FREQUENCY_WINDOW } from './baseline.ts'
import { loadCategoryMeta, loadCategoryTrends, loadFacts } from './facts.ts'
import { latestStoredMonth, loadTrailingTotals } from './month-store.ts'
import { loadLatestNetWorth } from './networth-store.ts'
import { loadParams } from './params.ts'

/** Months projected forward from the latest aggregated month. */
export const FORECAST_HORIZON_MONTHS = 12

/**
 * Trailing months of spend looked at to find a non-monthly bill's last
 * occurrence. Twice the widest cadence (`annual`, 12 months) so a bill that
 * landed close to a year ago is still inside the window rather than just
 * missing it and reading as "not known yet".
 */
export const DETECTION_WINDOW_MONTHS = 24

export interface ForecastBill {
  categoryId: string
  name: string
  /** Positive-out for a fixed cost, positive-in for income — never negated. */
  amountCents: number
}

export interface ForecastMonth {
  /** `YYYY-MM`. */
  month: string
  incomeCents: number
  fixedCents: number
  netCents: number
  /** Running total from `Forecast.startBalanceCents`. Can go negative. */
  balanceCents: number
  /**
   * Only the non-monthly items landing this month. A monthly-cadence category
   * is folded into the totals above with no entry here — it recurs every
   * month, so it is not a notable event in any one of them.
   */
  bills: ForecastBill[]
}

export interface Forecast {
  /** The net-worth snapshot this projection starts from. */
  startDate: string
  /** The liquid balance projected forward — not `totalCents`, which includes investments. */
  startBalanceCents: number
  /** Ascending, oldest (next month) first. Always `FORECAST_HORIZON_MONTHS` long. */
  months: ForecastMonth[]
}

function emptyMonth(month: string): ForecastMonth {
  return { month, incomeCents: 0, fixedCents: 0, netCents: 0, balanceCents: 0, bills: [] }
}

/**
 * The projection, or null when there is nothing to build it from: no
 * aggregated month yet, or no net-worth snapshot yet. Null rather than a
 * zeroed-out forecast, for the same reason `overview.ts` leaves every field
 * null on a fresh deployment — a forecast of €0 forever is a number someone
 * could act on, and it would be a lie.
 */
export function projectCashflow(db: Db): Forecast | null {
  const anchor = latestStoredMonth(db)
  if (anchor === null) return null

  const netWorth = loadLatestNetWorth(db)
  if (netWorth === null) return null

  const meta = loadCategoryMeta(db)
  const baselineByCategory = new Map(
    loadFacts(db, anchor).map((fact) => [fact.categoryId, fact.baseline]),
  )

  const horizon = Array.from({ length: FORECAST_HORIZON_MONTHS }, (_, index) =>
    addMonths(anchor, index + 1),
  )
  const months = new Map(horizon.map((month) => [month, emptyMonth(month)]))

  const nonMonthly: string[] = []
  for (const [categoryId, row] of meta) {
    if (row.hidden) continue
    if (row.nature !== 'income' && row.nature !== 'fixed') continue
    // No known cadence to repeat forward at — see the module doc comment.
    if (row.expectedFrequency === 'irregular') continue

    if (row.expectedFrequency !== 'monthly') {
      nonMonthly.push(categoryId)
      continue
    }

    const baseline = baselineByCategory.get(categoryId)
    if (baseline === undefined || baseline === null) continue

    const field = row.nature === 'income' ? 'incomeCents' : 'fixedCents'
    for (const bucket of months.values()) {
      bucket[field] += baseline.baselineCents
    }
  }

  if (nonMonthly.length > 0) {
    const trends = loadCategoryTrends(db, anchor, DETECTION_WINDOW_MONTHS)
    for (const categoryId of nonMonthly) {
      const row = meta.get(categoryId)
      const series = trends.byCategory.get(categoryId)
      if (row === undefined || series === undefined) continue

      let lastIndex = -1
      for (let index = series.length - 1; index >= 0; index -= 1) {
        if (series[index] !== 0) {
          lastIndex = index
          break
        }
      }
      if (lastIndex === -1) continue

      const lastMonth = trends.months[lastIndex] as string
      const amountCents = series[lastIndex] as number
      const step = FREQUENCY_WINDOW[row.expectedFrequency]
      const field = row.nature === 'income' ? 'incomeCents' : 'fixedCents'

      // The first occurrence strictly after `anchor`, then every `step` months
      // past it, until it runs off the end of the horizon.
      let steps = Math.floor(monthsBetween(lastMonth, anchor) / step) + 1
      let occurrence = addMonths(lastMonth, steps * step)
      while (months.has(occurrence)) {
        const bucket = months.get(occurrence) as ForecastMonth
        bucket[field] += amountCents
        bucket.bills.push({ categoryId, name: row.nameSnapshot, amountCents })
        steps += 1
        occurrence = addMonths(lastMonth, steps * step)
      }
    }
  }

  const totalsHistory = loadTrailingTotals(db, anchor, config.JOBS_HISTORY_MONTHS)
  const typicalSpendCents =
    totalsHistory.length > 0
      ? Math.round(
          ewma(
            totalsHistory.map((entry) => entry.spentCents),
            loadParams(db).baseline.halfLifeMonths,
          ),
        )
      : 0

  let balanceCents = netWorth.liquidCents
  const orderedMonths = horizon.map((month) => {
    const bucket = months.get(month) as ForecastMonth
    bucket.fixedCents += typicalSpendCents
    bucket.netCents = bucket.incomeCents - bucket.fixedCents
    balanceCents += bucket.netCents
    bucket.balanceCents = balanceCents
    return bucket
  })

  return { startDate: netWorth.date, startBalanceCents: netWorth.liquidCents, months: orderedMonths }
}
