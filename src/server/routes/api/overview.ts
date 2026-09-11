/**
 * `GET /api/overview` — the landing page's figures.
 *
 * Net worth now and over time, this month's income against spend, how many months
 * of cover the liquid balance represents, and the hygiene score. All of it read
 * from tables a job wrote; nothing here touches Actual, Ghostfolio or Gemini.
 *
 * Two arrays, and they are not the same kind of thing. `history` is net-worth points —
 * a balance on a date — and `flows` is income and spend per month. The savings card was
 * stuck on one calendar month until #296 precisely because only the first existed here,
 * so there was nothing on the wire to sum over a period.
 *
 * Every field is nullable, and that is the design rather than defensiveness. A
 * fresh deployment has run no jobs, so it has no net worth and no month — and the
 * honest answer to "what is my net worth" before the first sync is "not known yet",
 * not zero. Zero is a number someone would act on.
 *
 * `netWorth.totalCents` also nets in every owned property's equity (#227) — the same
 * treatment debt already gets, folded in rather than broken out elsewhere. Gated on
 * `netWorth` itself being non-null: a property tracked before the first net-worth
 * snapshot has nothing to be netted into yet. `history` is deliberately left alone —
 * retroactively injecting today's property value into past dates would fabricate
 * equity the owner may not have held throughout that window.
 */
import type { Db } from '../../../db/index.ts'
import { HYGIENE_CODES } from '../../../domain/aggregate/hygiene.ts'
import { loadLatestNetWorth, loadNetWorthHistory } from '../../../domain/aggregate/networth-store.ts'
import { latestStoredMonth, loadMonthTotals, loadTrailingTotals } from '../../../domain/aggregate/month-store.ts'
import { TRAILING_MONTHS } from '../../../domain/aggregate/savings.ts'
import { loadHygiene, loadSignals } from '../../../domain/aggregate/signals-store.ts'
import {
  loadProperties,
  outstandingBalanceCents,
  totalEquityCents,
} from '../../../domain/property/properties.ts'
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

/**
 * How many months of flows the response carries, for the savings card's periods (#296).
 *
 * `Math.max` rather than the bare `12` both constants happen to be: the cover window is a
 * statement about seasonality and `TRAILING_MONTHS` is the longest window the card offers,
 * and they agree today by coincidence. Deriving one from the other would make a change to
 * either silently shorten the other's data.
 */
export const FLOW_HISTORY_MONTHS = Math.max(COVER_WINDOW_MONTHS, TRAILING_MONTHS)

export function buildOverview(db: Db): Overview {
  const month = latestStoredMonth(db)
  const totals = month === null ? null : (loadMonthTotals(db, [month])[0] ?? null)
  const hygiene = month === null ? null : loadHygiene(db, month)
  const netWorth = loadLatestNetWorth(db)
  const flows = month === null ? [] : loadTrailingTotals(db, month, FLOW_HISTORY_MONTHS)
  // The cover figure keeps its own, shorter window even when the two lengths agree — see
  // `FLOW_HISTORY_MONTHS`. `slice(-n)` on an ascending run takes the newest n.
  const coverWindow = flows.slice(-COVER_WINDOW_MONTHS)
  // Priced as of right now, not as of `netWorth.date`: a mortgage amortizes with the
  // calendar, not with whatever night the net-worth job last ran (#227).
  const today = new Date().toISOString().slice(0, 10)
  const properties = loadProperties(db).properties
  const propertyEquity = totalEquityCents(properties, today)

  return overviewSchema.parse({
    freshness: freshness(db),
    netWorth:
      netWorth === null
        ? null
        : {
            date: netWorth.date,
            totalCents: netWorth.totalCents + (propertyEquity ?? 0),
            liquidCents: netWorth.liquidCents,
            investedCents: netWorth.investedCents,
            debtCents: netWorth.debtCents,
            propertyValueCents: properties.some((property) => property.propertyValueCents !== null)
              ? properties.reduce((sum, property) => sum + (property.propertyValueCents ?? 0), 0)
              : null,
            mortgageBalanceCents: properties.some((property) => property.mortgage !== null)
              ? properties.reduce(
                  (sum, property) => sum + outstandingBalanceCents(property.mortgage, today),
                  0,
                )
              : null,
          },
    history: loadNetWorthHistory(db),
    flows: flows.map((entry) => ({
      month: entry.month,
      incomeCents: entry.incomeCents,
      spentCents: entry.spentCents,
      budgetedCents: entry.budgetedCents,
      savingsRateBp: entry.savingsRateBp,
    })),
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
      netWorth === null ? null : emergencyFundCentimonths(netWorth.liquidCents, coverWindow),
    hygiene:
      hygiene === null || month === null
        ? null
        : {
            ...hygiene,
            signals: loadSignals(db, month).filter((signal) => HYGIENE_CODES.has(signal.code)),
          },
  })
}
