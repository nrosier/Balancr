/**
 * `GET /api/overview` — the landing page's figures.
 *
 * Net worth now and over time, this month's income against spend, how many months
 * of cover the liquid balance represents, and the hygiene score. All of it read
 * from tables a job wrote; nothing here touches Actual, Ghostfolio or Gemini.
 *
 * Every field is nullable, and that is the design rather than defensiveness. A
 * fresh deployment has run no jobs, so it has no net worth and no month — and the
 * honest answer to "what is my net worth" before the first sync is "not known yet",
 * not zero. Zero is a number someone would act on.
 */
import type { Db } from '../../../db/index.ts'
import { loadLatestNetWorth, loadNetWorthHistory } from '../../../domain/aggregate/networth-store.ts'
import { latestStoredMonth, loadMonthTotals, loadTrailingTotals } from '../../../domain/aggregate/month-store.ts'
import { loadHygiene } from '../../../domain/aggregate/signals-store.ts'
import { freshness } from './freshness.ts'
import { overviewSchema, type Overview } from './schemas.ts'

/**
 * Months of liquid cover, in hundredths of a month.
 *
 * The denominator is the mean spend of the months given rather than this month's,
 * because a single month with a holiday or an annual insurance premium in it would
 * otherwise halve the figure and read as an emergency. `null` when there is no
 * spend to divide by — a household that has spent nothing has infinite cover, and
 * `Infinity` is not a thing to render.
 *
 * Hundredths rather than a float for the reason the whole API avoids floats: the
 * client formats `450` as `4,5`, and no arithmetic anywhere has to be trusted with
 * a fraction.
 */
export function emergencyFundCentimonths(
  liquidCents: number,
  spendHistory: readonly { spentCents: number }[],
): number | null {
  if (spendHistory.length === 0) return null
  const total = spendHistory.reduce((sum, month) => sum + month.spentCents, 0)
  const mean = total / spendHistory.length
  if (mean <= 0) return null
  return Math.round((liquidCents / mean) * 100)
}

/** How many months of spend the cover figure averages over. A year, seasonality and all. */
export const COVER_WINDOW_MONTHS = 12

export function buildOverview(db: Db): Overview {
  const month = latestStoredMonth(db)
  const totals = month === null ? null : (loadMonthTotals(db, [month])[0] ?? null)
  const netWorth = loadLatestNetWorth(db)
  const history = month === null ? [] : loadTrailingTotals(db, month, COVER_WINDOW_MONTHS)

  return overviewSchema.parse({
    freshness: freshness(db),
    netWorth:
      netWorth === null
        ? null
        : {
            date: netWorth.date,
            totalCents: netWorth.totalCents,
            liquidCents: netWorth.liquidCents,
            investedCents: netWorth.investedCents,
            debtCents: netWorth.debtCents,
          },
    history: loadNetWorthHistory(db),
    month,
    totals:
      totals === null
        ? null
        : {
            incomeCents: totals.incomeCents,
            spentCents: totals.spentCents,
            budgetedCents: totals.budgetedCents,
            savingsRateBp: totals.savingsRateBp,
          },
    emergencyFundCentimonths:
      netWorth === null ? null : emergencyFundCentimonths(netWorth.liquidCents, history),
    hygiene: month === null ? null : loadHygiene(db, month),
  })
}
