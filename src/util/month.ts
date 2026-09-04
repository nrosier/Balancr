/**
 * Month and date arithmetic on `YYYY-MM` / `YYYY-MM-DD` strings.
 *
 * Strings rather than `Date` on purpose: Actual stores dates this way, SQLite
 * sorts them correctly as text, and there is no timezone to get wrong. `Date` is
 * used only where a real instant is unavoidable — "what is today, in Brussels".
 *
 * Every function here is total: an invalid month throws rather than yielding
 * `Invalid Date`, because a silently wrong month shifts a whole baseline window
 * by one and nothing downstream would notice.
 */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

export function isMonth(value: string): boolean {
  return MONTH_RE.test(value)
}

export function assertMonth(month: string): string {
  if (!isMonth(month)) throw new Error(`invalid month: ${month}`)
  return month
}

export function isDate(value: string): boolean {
  return DATE_RE.test(value)
}

/** `2026-08-17` -> `2026-08`. */
export function monthOf(date: string): string {
  if (!isDate(date)) throw new Error(`invalid date: ${date}`)
  return date.slice(0, 7)
}

export function assertDate(date: string): string {
  if (!isDate(date)) throw new Error(`invalid date: ${date}`)
  return date
}

export function startOfMonth(month: string): string {
  return `${assertMonth(month)}-01`
}

/**
 * Whole days from `from` to `to`, both `YYYY-MM-DD`. Negative when `to` is
 * earlier.
 *
 * Both dates are read as UTC, which is the point of keeping dates as strings:
 * "45 days since this account was reconciled" is a statement about calendar
 * days, and involving a timezone would make it wrong for two hours a year.
 */
export function daysBetween(from: string, to: string): number {
  assertDate(from)
  assertDate(to)
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * `YYYY-MM-DD` plus whole days, negative to go back.
 *
 * UTC throughout, like `daysBetween`: "four days after the 28th" is a statement about
 * the calendar, and a local timezone would make it wrong for the two hours a year the
 * clocks move.
 */
export function addDays(date: string, delta: number): string {
  assertDate(date)
  const shifted = new Date(Date.parse(`${date}T00:00:00Z`) + delta * 86_400_000)
  return shifted.toISOString().slice(0, 10)
}

/**
 * 0 for Sunday through 6 for Saturday.
 *
 * Sunday-based because Actual's recurrence patterns are: its `SU`…`SA` letters index
 * this way, and a Monday-based week would silently shift every "third Tuesday of the
 * month" schedule by a day (#159). This is not the week-start question — that is a
 * display decision and lives in `format.ts`.
 */
export function dayOfWeek(date: string): number {
  assertDate(date)
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

export function daysInMonth(month: string): number {
  assertMonth(month)
  // Day 0 of the following month is the last day of this one.
  return new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
  ).getUTCDate()
}

export function endOfMonth(month: string): string {
  return `${month}-${String(daysInMonth(month)).padStart(2, '0')}`
}

export function addMonths(month: string, delta: number): string {
  assertMonth(month)
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7)) - 1 + delta
  const shifted = new Date(Date.UTC(year, index, 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

/** Whole months from `from` to `to`; negative when `to` precedes `from`. */
export function monthsBetween(from: string, to: string): number {
  assertMonth(from)
  assertMonth(to)
  return (
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    (Number(to.slice(5, 7)) - Number(from.slice(5, 7)))
  )
}

/** Ascending, inclusive of both ends. Empty when `to` precedes `from`. */
export function monthRange(from: string, to: string): string[] {
  const span = monthsBetween(from, to)
  if (span < 0) return []
  return Array.from({ length: span + 1 }, (_, i) => addMonths(from, i))
}

/**
 * The `count` months immediately before `month`, ascending and excluding
 * `month` itself — the baseline window. Excluding the current month is the whole
 * point: comparing a month against a norm that contains it flattens exactly the
 * signal being looked for.
 */
export function monthsBefore(month: string, count: number): string[] {
  if (count <= 0) return []
  return monthRange(addMonths(month, -count), addMonths(month, -1))
}

/**
 * Asserts `months` is ascending with no gaps, naming both sides of the hole.
 *
 * A missing month is not the same as a zero month: a rolling window over a
 * sparse series silently averages across the hole, inflating every rate by
 * exactly the amount nobody would notice. Callers build dense series from the
 * fact table, where a month with no transactions is a real zero row.
 *
 * `label` names the series in the error, because by the time this throws the
 * caller is several layers away from whichever query produced the gap.
 */
export function assertDenseMonths(months: readonly string[], label: string): void {
  for (let index = 1; index < months.length; index += 1) {
    const previous = months[index - 1] as string
    const current = months[index] as string
    const expected = addMonths(previous, 1)
    if (current !== expected) {
      throw new Error(
        `${label} must be dense and ascending: ${previous} is followed by ` +
          `${current}, expected ${expected}`,
      )
    }
  }
}

interface Parts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/** Wall-clock parts of `instant` in `timeZone`. */
function partsIn(instant: Date, timeZone: string): Parts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const found: Record<string, string> = {}
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') found[part.type] = part.value
  }
  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    hour: Number(found.hour),
    minute: Number(found.minute),
  }
}

/** The calendar date `instant` falls on in `timeZone`, as `YYYY-MM-DD`. */
export function dateIn(instant: Date, timeZone: string): string {
  const { year, month, day } = partsIn(instant, timeZone)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Wall-clock hour of `instant` in `timeZone`, 0..23.
 *
 * The scheduler decides "is it past 03:00 yet" with this. Doing it in UTC would
 * drift an hour every spring and run the nightly pass in daylight.
 */
export function hourIn(instant: Date, timeZone: string): number {
  return partsIn(instant, timeZone).hour
}

/** Today in `timeZone`, as `YYYY-MM-DD`. */
export function todayIn(timeZone: string): string {
  return dateIn(new Date(), timeZone)
}

/** The current month in `timeZone`, as `YYYY-MM`. */
export function currentMonthIn(timeZone: string): string {
  return todayIn(timeZone).slice(0, 7)
}

/**
 * The month `instant` falls in, in `timeZone`, as `YYYY-MM`.
 *
 * What a job should use in place of `currentMonthIn`: the runner hands every job the
 * instant the run started, and a job that reads the clock again can straddle midnight
 * on the 1st — writing part of its output into one month and part into the next.
 */
export function monthIn(instant: Date, timeZone: string): string {
  return dateIn(instant, timeZone).slice(0, 7)
}

/**
 * How far through `month` the instant `asOf` is, as 0..1.
 *
 * Used to project a month-end total from spend so far, so it must be the local
 * wall clock: at 01:00 CEST on the 1st, UTC still says the previous month, and
 * projecting from the wrong month's elapsed fraction invents an alarming number
 * out of nothing.
 *
 * Past months return 1 and future months 0, so callers need no special cases.
 */
export function monthProgress(month: string, asOf: Date, timeZone: string): number {
  assertMonth(month)
  const now = partsIn(asOf, timeZone)
  const nowMonth = `${now.year}-${String(now.month).padStart(2, '0')}`

  const offset = monthsBetween(month, nowMonth)
  if (offset > 0) return 1
  if (offset < 0) return 0

  const elapsedDays = now.day - 1 + (now.hour * 60 + now.minute) / 1440
  return Math.min(1, Math.max(0, elapsedDays / daysInMonth(month)))
}
