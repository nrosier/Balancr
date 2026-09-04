/**
 * What is still to come this month, from Actual's own schedules (#159).
 *
 * A budget knows what has been spent. Between the 1st and the 28th it does not know
 * what is *coming*, and the two together are what "can I still spend this" actually
 * asks: an envelope with € 80 assigned, € 0 spent and € 84,50 due on the 28th reads as
 * untouched on every screen in this application and is already over. Actual holds the
 * answer — the schedules are right there — and nothing was reading them.
 *
 * Five decisions, and the last two are the ones to disagree with:
 *
 *  - **A separate figure, never folded into spend.** `spentCents` stays byte-identical
 *    to what Actual's own UI reports, because "every category total agrees with Actual"
 *    is the property that makes the rest of this application believable. A projection
 *    that quietly included next week's rent would break it in a way nobody could see.
 *  - **Only the current month.** A past month's committed figure is zero by definition:
 *    whatever was scheduled either happened, and is spend, or did not, and never will
 *    be. Asking for a month that is not the one `today` falls in returns nothing rather
 *    than a guess in either direction.
 *  - **Costs only.** A scheduled salary is not a commitment, and netting one against a
 *    bill would answer "what is still to come" with two different things at once — and
 *    would take the weight off an overspend warning with money that has not arrived.
 *    An inflow schedule is skipped, which is why every figure here is positive-out.
 *  - **An occurrence due today counts as still to come.** #159 says "between today and
 *    month end", and on the one day a month a bill falls due it may or may not have
 *    posted yet. Counting it means a schedule Actual has already posted is briefly in
 *    both `spentCents` and this figure, which overstates the day's projection by one
 *    bill; not counting it would understate every manual schedule for a whole day. Both
 *    are wrong on that day and only one of them is wrong in the safe direction.
 *  - **Uncertainty resolves upward, and unattributed money is not guessed.** The
 *    adapter already takes the upper bound of a range rather than Actual's average; a
 *    schedule no rule assigns a category to lands in `unallocatedCents` and is counted
 *    in the month total only — never attributed to an envelope by inference. The month
 *    total therefore does not always add up from the categories, and the unallocated
 *    line on screen is what says why.
 *
 * The recurrence expansion below mirrors `@actual-app/core/src/shared/schedules.ts`
 * (`recurConfigToRSchedule`, `getDateWithSkippedWeekend`) rather than calling it:
 * `@actual-app/core` publishes raw `.ts` with `#server/...` internal imports and pulls
 * its recurrence engine from a transitive `@rschedule` dependency, so none of it can be
 * imported at runtime. The one place this deliberately diverges is the amount, and that
 * divergence is documented where it happens, in `queries.ts`.
 *
 * Pure: dates in, dates out. `today` arrives as a string, like everywhere else in this
 * folder, so a test can be run on the 28th in July.
 */
import type { ActualSchedule, RecurPatternType, ScheduleDate, ScheduleRecurrence } from '../../adapters/actual/queries.ts'
import {
  addDays,
  addMonths,
  assertMonth,
  dayOfWeek,
  daysBetween,
  daysInMonth,
  endOfMonth,
  monthOf,
  startOfMonth,
} from '../../util/month.ts'

/**
 * How far outside the window occurrences are generated.
 *
 * A weekend skip moves a date by up to two days and can carry it into the window from
 * either side — a Sunday the 1st solved backwards is paid on the previous Friday, in
 * the month before. Filtering before the shift would lose exactly those.
 */
const SCAN_SLACK_DAYS = 4

/**
 * Loop guards. Neither is reachable from a real schedule; both are cheaper than the
 * alternative, which is a `while (true)` over a recurrence somebody hand-edited.
 */
const MAX_STEPS = 20_000
const MAX_PERIODS = 5_000

const WEEKDAY_INDEX: Readonly<Record<RecurPatternType, number>> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  // Never looked up: `day` patterns are days of the month, handled separately.
  day: -1,
}

export interface CommittedCategory {
  /** Still to come between today and month end. Positive: money leaving. */
  remainingCents: number
  /**
   * Occurrences that already fell earlier this month.
   *
   * Not a figure anybody wants on screen — it is what lets the burn-rate projection
   * tell scheduled spending from variable spending. Rent paid on the 1st is not
   * evidence that the month will cost thirty times that.
   */
  toDateCents: number
  /** How many occurrences are still to come, for "2 payments due". */
  occurrences: number
  /** True when any amount behind these figures was a range or an approximation. */
  approximate: boolean
}

export interface CommittedMonth {
  month: string
  /** By Actual's category id. Absent means nothing is scheduled against it. */
  categories: Map<string, CommittedCategory>
  /** Still to come from schedules no rule attributes to a category. */
  unallocatedCents: number
  /** How many such schedules, so the line on screen is actionable. */
  unallocatedCount: number
  /** Everything still to come, attributed or not. */
  totalCents: number
  approximate: boolean
}

export interface CommittedInput {
  schedules: readonly ActualSchedule[]
  /** The month being computed, `YYYY-MM`. */
  month: string
  /** Today in the configured timezone, `YYYY-MM-DD`. */
  today: string
}

/** A month with nothing scheduled, which is also every past month. */
export function emptyCommitted(month: string): CommittedMonth {
  return {
    month: assertMonth(month),
    categories: new Map(),
    unallocatedCents: 0,
    unallocatedCount: 0,
    totalCents: 0,
    approximate: false,
  }
}

/**
 * What each envelope still owes this month.
 *
 * Returns an empty month — not a partial one — when `month` is not the month `today`
 * falls in, so a caller cannot accidentally state a committed figure for a month where
 * it means nothing.
 */
export function committedForMonth(input: CommittedInput): CommittedMonth {
  const { month, today } = input
  const out = emptyCommitted(month)
  if (monthOf(today) !== month) return out

  const first = startOfMonth(month)
  const last = endOfMonth(month)

  for (const schedule of input.schedules) {
    // A completed schedule is not coming, whatever its dates say.
    if (schedule.completed) continue
    // Actual's sign convention: negative is money out, and only money out is a cost.
    const costCents = -schedule.amountCents
    if (costCents <= 0) continue

    const dates = expandOccurrences(schedule.date, first, last)
    let remaining = dates.filter((date) => date >= today).length
    const toDate = dates.length - remaining

    // The tie-break, and the only use of Actual's own `next_date`: when our expansion
    // finds nothing at all this month but Actual says the next occurrence falls inside
    // the window, the cost is counted. A disagreement between the two resolves toward
    // counting the money, which is the same direction as every other decision here.
    if (
      dates.length === 0 &&
      schedule.nextDate !== null &&
      schedule.nextDate >= today &&
      schedule.nextDate <= last
    ) {
      remaining = 1
    }
    if (remaining === 0 && toDate === 0) continue

    const remainingCents = costCents * remaining
    const toDateCents = costCents * toDate

    if (schedule.categoryId === null) {
      // Not attributed, and deliberately not inferred: the month total says the money
      // is coming, and the unallocated line says nobody knows out of which envelope.
      out.unallocatedCents += remainingCents
      if (remaining > 0) out.unallocatedCount += 1
    } else {
      const row = out.categories.get(schedule.categoryId) ?? {
        remainingCents: 0,
        toDateCents: 0,
        occurrences: 0,
        approximate: false,
      }
      row.remainingCents += remainingCents
      row.toDateCents += toDateCents
      row.occurrences += remaining
      if (schedule.approximate) row.approximate = true
      out.categories.set(schedule.categoryId, row)
    }

    out.totalCents += remainingCents
    if (schedule.approximate && remaining > 0) out.approximate = true
  }

  return out
}

// ---------------------------------------------------------------------------
//  Recurrence
// ---------------------------------------------------------------------------

/**
 * Every occurrence of a schedule between `from` and `to`, both inclusive.
 *
 * Exported for its own test, because this is where a wrong answer would be invisible:
 * a quarterly schedule expanded as monthly overstates a projection by three, and
 * nothing else in the pipeline would notice.
 */
export function expandOccurrences(date: ScheduleDate, from: string, to: string): string[] {
  if (date.kind === 'once') return date.date >= from && date.date <= to ? [date.date] : []

  const recurrence = date.recurrence
  const raw = [
    ...new Set(
      rawOccurrences(recurrence, addDays(from, -SCAN_SLACK_DAYS), addDays(to, SCAN_SLACK_DAYS)),
    ),
  ].sort()

  // Deduped before the shift and not after: a Saturday and a Sunday occurrence both
  // solved forward land on the same Monday, and that is two payments, not one.
  const shifted = recurrence.skipWeekend
    ? raw.map((occurrence) => solveWeekend(occurrence, recurrence.weekendSolveMode))
    : raw

  return shifted.filter((occurrence) => occurrence >= from && occurrence <= to).sort()
}

/** Actual's `getDateWithSkippedWeekend`: forward to Monday, or back to Friday. */
function solveWeekend(date: string, mode: 'before' | 'after'): string {
  const day = dayOfWeek(date)
  if (day !== 0 && day !== 6) return date
  if (mode === 'after') return addDays(date, day === 6 ? 2 : 1)
  return addDays(date, day === 6 ? -1 : -2)
}

/**
 * Occurrences before the weekend shift, in Actual's own terms.
 *
 * `endMode: after_n_occurrences` is counted from the recurrence's `start` and over the
 * union of its patterns, which is the one place this is simpler than rschedule: Actual
 * builds a separate rule per pattern group, each carrying the same count. Counting the
 * union is what somebody who wrote "12 occurrences" meant.
 */
function rawOccurrences(
  recurrence: ScheduleRecurrence,
  scanFrom: string,
  scanTo: string,
): string[] {
  const { endDate, endMode, endOccurrences, frequency, interval, start } = recurrence
  const limit = endMode === 'after_n_occurrences' ? (endOccurrences ?? 0) : null
  const until = endMode === 'on_date' ? endDate : null
  const out: string[] = []

  if (frequency === 'daily' || frequency === 'weekly') {
    const step = frequency === 'daily' ? interval : interval * 7
    // Straight to the window when no occurrences have to be tallied on the way.
    const gap = daysBetween(start, scanFrom)
    let index = limit === null && gap > 0 ? Math.floor(gap / step) : 0
    for (let steps = 0; steps < MAX_STEPS; steps += 1, index += 1) {
      if (limit !== null && index >= limit) break
      const date = addDays(start, index * step)
      if (date > scanTo) break
      if (until !== null && date > until) break
      if (date >= scanFrom) out.push(date)
    }
    return out
  }

  const startDay = Number(start.slice(8, 10))
  let count = 0

  if (frequency === 'monthly') {
    const startMonth = monthOf(start)
    const lastMonth = monthOf(scanTo)
    for (let period = 0; period < MAX_PERIODS; period += 1) {
      const month = addMonths(startMonth, period * interval)
      if (month > lastMonth) break
      for (const day of monthlyDays(month, recurrence.patterns, startDay)) {
        const date = `${month}-${String(day).padStart(2, '0')}`
        // rschedule yields nothing before `start`, and a date it never yields is not
        // an occurrence — so this must not consume the count either.
        if (date < start) continue
        if (until !== null && date > until) return out
        if (limit !== null && count >= limit) return out
        count += 1
        if (date >= scanFrom && date <= scanTo) out.push(date)
      }
    }
    return out
  }

  const startYear = Number(start.slice(0, 4))
  const startMonthNumber = start.slice(5, 7)
  const lastYear = Number(scanTo.slice(0, 4))
  for (let period = 0; period < MAX_PERIODS; period += 1) {
    const year = startYear + period * interval
    if (year > lastYear) break
    const month = `${year}-${startMonthNumber}`
    // 29 February in a common year is not an occurrence, it is a date that does not
    // exist. Skipping it is what iCal does, and it must not consume the count.
    if (startDay > daysInMonth(month)) continue
    const date = `${month}-${String(startDay).padStart(2, '0')}`
    if (date < start) continue
    if (until !== null && date > until) break
    if (limit !== null && count >= limit) break
    count += 1
    if (date >= scanFrom && date <= scanTo) out.push(date)
  }
  return out
}

/**
 * Which days of `month` a monthly recurrence falls on, ascending.
 *
 * No patterns means the day of the month the recurrence started on — and a 31st in a
 * 30-day month is skipped rather than clamped to the 30th, because that is what
 * rschedule does and a budget that quietly moved a payment would disagree with Actual's
 * own "next up" list. A negative pattern value counts back from the end, so `-1` is the
 * last day of the month and the last such weekday.
 */
function monthlyDays(
  month: string,
  patterns: readonly { value: number; type: RecurPatternType }[],
  startDay: number,
): number[] {
  const length = daysInMonth(month)
  if (patterns.length === 0) return startDay > length ? [] : [startDay]

  const days = new Set<number>()
  for (const pattern of patterns) {
    if (pattern.type === 'day') {
      const day = pattern.value < 0 ? length + pattern.value + 1 : pattern.value
      if (day >= 1 && day <= length) days.add(day)
      continue
    }
    const weekday = WEEKDAY_INDEX[pattern.type]
    const matching: number[] = []
    for (let day = 1; day <= length; day += 1) {
      if (dayOfWeek(`${month}-${String(day).padStart(2, '0')}`) === weekday) matching.push(day)
    }
    // A fifth Friday in a month with four is not an occurrence; nor is a zeroth.
    const day =
      pattern.value > 0 ? matching[pattern.value - 1] : matching[matching.length + pattern.value]
    if (day !== undefined) days.add(day)
  }
  return [...days].sort((a, b) => a - b)
}
