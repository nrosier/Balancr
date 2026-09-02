/**
 * Ghostfolio's performance chart, reduced to one value per month-end.
 *
 * `net_worth_snapshots` and `portfolio_metrics` are written one row per day a job
 * ran, so both series are exactly as long as this install is old and a chart whose
 * axis is time draws a dot. The history is not missing — Ghostfolio has been asked
 * for `range=max` all along and answers with a dated value series — it was simply
 * never read for anything but its final figure.
 *
 * Month-end granularity, not daily, and that is a decision rather than a shortcut: a
 * net-worth series is read for its shape, twenty-four month-ends is the shape, and
 * the Actual half of the same backfill costs one `getAccountBalance` call per account
 * per date. Twenty-four calls per account is a job; seven hundred and thirty is an
 * outage.
 *
 * Pure, and deliberately narrow. Two rules are worth stating because both are ways
 * this could quietly produce a wrong number rather than no number:
 *
 *  - **A month is answered only when the chart has moved past it.** The last entry
 *    inside a calendar month is that month's closing value only once the chart carries
 *    a later date. Ask for the current month and the last entry is today's, which is
 *    not the month's close; ask for a month where Ghostfolio was down from the 24th
 *    and it is the 24th's. Both would be stamped with the month-end date and read as
 *    that month's close for ever after.
 *
 *    Note what this deliberately does *not* require: an entry on the month-end date
 *    itself. Nothing in this repo settles whether the chart carries every calendar day
 *    or only the days the portfolio could be priced, and under the second shape every
 *    month ending on a weekend has no month-end entry — two months in seven, dropped
 *    for a property of the calendar. Requiring a later date instead is correct under
 *    both shapes. It refuses one month the stricter rule would allow, the one where
 *    the chart stops exactly on a month-end, and that month is never asked for: the
 *    chart runs to today and only settled months are ever backfilled.
 *  - **An absent value is dropped, never read as zero.** `value` is `nullish` in the
 *    schema because Ghostfolio omits it on days it cannot price the portfolio, and a
 *    zero there is a portfolio that vanished for a day.
 */
import { toCents, type PortfolioPerformance } from '../../adapters/ghostfolio/types.ts'
import { endOfMonth, isDate, monthOf } from '../../util/month.ts'

export interface ValuePoint {
  /** The month-end this value closes, `YYYY-MM-DD`. */
  date: string
  valueCents: number
}

/** A chart entry we can actually use: a real date and a real value. */
interface Usable {
  date: string
  valueCents: number
}

/**
 * The chart as dated values, ascending, with the unusable entries gone.
 *
 * `date` is `z.string()` in the schema rather than a date type — the performance
 * endpoint is the frontend's internal API and unversioned, so a shape change arrives
 * as data rather than as a build failure. Entries whose date does not parse are
 * dropped rather than guessed at; `chartStart` returning null then reads as "no
 * history", which is the safe direction: the net-worth backfill treats dates before
 * the chart as pre-portfolio, so a chart misread as empty produces an Actual-only
 * history rather than an invented investment total.
 */
function usable(performance: PortfolioPerformance): Usable[] {
  const out: Usable[] = []
  for (const entry of performance.chart) {
    // Ghostfolio has answered with both `YYYY-MM-DD` and a full ISO instant over the
    // versions this adapter has seen; the calendar date is the part that matters.
    const date = entry.date.slice(0, 10)
    if (!isDate(date)) continue
    const value = entry.value
    if (value === null || value === undefined) continue
    out.push({ date, valueCents: toCents(value) })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * The first date the chart covers, or null when it covers nothing usable.
 *
 * This is what tells the net-worth backfill which month-ends predate the portfolio
 * altogether. `range=max` starts at the first order, so a month-end before it is a
 * month when there was no portfolio to value — an Actual-only total for that date is
 * complete rather than partial, and that distinction is the difference between a
 * shorter chart and a wrong one.
 */
export function chartStart(performance: PortfolioPerformance): string | null {
  return usable(performance)[0]?.date ?? null
}

/**
 * Closing value for each of `months` the chart can answer, ascending.
 *
 * Takes months (`YYYY-MM`) rather than dates so a caller cannot ask for a mid-month
 * date and receive a figure labelled as a close. Months the chart cannot answer are
 * absent from the result rather than present with a null — the caller's decision is
 * "write this date or don't", and an entry it has to check first is an entry someone
 * will forget to check.
 */
export function monthEndValues(
  performance: PortfolioPerformance,
  months: readonly string[],
): ValuePoint[] {
  const entries = usable(performance)
  const last = entries[entries.length - 1]?.date
  if (last === undefined) return []

  // Last entry wins per month, and `entries` is ascending, so a plain overwrite is
  // the closing value.
  const closing = new Map<string, number>()
  for (const entry of entries) closing.set(monthOf(entry.date), entry.valueCents)

  const out: ValuePoint[] = []
  for (const month of [...months].sort()) {
    const date = endOfMonth(month)
    // The guard the header explains: the chart has to carry a date beyond this month
    // before its last entry inside the month counts as the month's close. `last` is a
    // full date and `date` is the month's final day, so one comparison says it.
    if (last <= date) continue
    const valueCents = closing.get(month)
    if (valueCents === undefined) continue
    out.push({ date, valueCents })
  }
  return out
}
