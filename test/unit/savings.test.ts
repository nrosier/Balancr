/**
 * The savings rate over a period (#288), and the one thing it must not do.
 *
 * The arithmetic is three lines, so almost everything below is about the failure mode
 * the issue was filed against: a period rate that is the **mean of the monthly rates**
 * carries every calendar-boundary distortion straight into the average and answers a
 * question nobody asked. The first test states that as an inequality — two months whose
 * monthly rates average to one figure and whose flows sum to a different one — so an
 * implementation that averaged would fail rather than round differently.
 *
 * The rest is window selection, which is where a period figure quietly lies: a "year to
 * date" that runs into the next year, a "previous month" that skips a gap in the
 * history, a twelve-month window anchored on the end of the array rather than on the
 * month the reader selected.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SAVINGS_PERIOD,
  periodSavings,
  SAVINGS_PERIODS,
  TRAILING_MONTHS,
  type SavingsMonth,
} from '../../src/domain/aggregate/savings.ts'

/** A month of flows. Round, invented figures — this file never sees real ones. */
const month = (key: string, incomeCents: number, spentCents: number): SavingsMonth => ({
  month: key,
  incomeCents,
  spentCents,
})

/**
 * Twelve months of a household that earns steadily and spends unevenly, plus the two
 * months either side of the year boundary, so every window has something to select.
 */
const YEAR: SavingsMonth[] = [
  month('2025-11', 400_000, 380_000),
  month('2025-12', 400_000, 500_000),
  month('2026-01', 400_000, 300_000),
  month('2026-02', 400_000, 320_000),
  month('2026-03', 400_000, 340_000),
  month('2026-04', 400_000, 360_000),
  month('2026-05', 400_000, 300_000),
  month('2026-06', 400_000, 380_000),
  month('2026-07', 400_000, 340_000),
  month('2026-08', 400_000, 360_000),
]

describe('summing before dividing', () => {
  it('is not the mean of the monthly rates, which is the whole point', () => {
    // A paycheck in one month paying for rent recorded in the next: the first month
    // looks catastrophic and the second looks unreal, and the pair is ordinary.
    const boundary = [month('2026-07', 0, 200_000), month('2026-08', 400_000, 200_000)]

    // The monthly rates are null (no income) and 50%. Any mean of those is 50% or
    // undefined; neither is what the two months together did.
    const result = periodSavings(boundary, '2026-08', 'twelve_months')
    expect(result.incomeCents).toBe(400_000)
    expect(result.spentCents).toBe(400_000)
    expect(result.rateBp).toBe(0)
    expect(result.rateBp).not.toBe(5_000)
  })

  it('reports a negative rate rather than clamping it', () => {
    // Spending more than came in is a state to act on, and the card colours it — a
    // floor at zero would print the same figure as breaking even.
    const result = periodSavings([month('2026-08', 400_000, 500_000)], '2026-08', 'this_month')
    expect(result.rateBp).toBe(-2_500)
  })

  it('has no rate when the window has no income to divide by', () => {
    const result = periodSavings([month('2026-08', 0, 120_000)], '2026-08', 'this_month')
    expect(result.rateBp).toBeNull()
    // The flows are still reported: "no rate" is not "no data", and the span line
    // still has a month to name.
    expect(result.spentCents).toBe(120_000)
    expect(result.months).toBe(1)
  })
})

describe('which months a period covers', () => {
  it('reads one month, and agrees with what the month itself stores', () => {
    const result = periodSavings(YEAR, '2026-08', 'this_month')
    expect(result.months).toBe(1)
    expect(result.from).toBe('2026-08')
    expect(result.to).toBe('2026-08')
    // Same formula and same inputs as `MonthTotals.savingsRateBp`, which is what lets
    // the card use one code path for all four periods without the shortest one
    // disagreeing with the figure the digest quotes.
    expect(result.rateBp).toBe(1_000)
  })

  it('reads the calendar month before the selected one, not the previous entry', () => {
    // A history with July missing: "previous month" is July, and July has no figures,
    // so the honest answer is an empty window — not June relabelled.
    const gapped = [month('2026-06', 400_000, 100_000), month('2026-08', 400_000, 360_000)]
    const result = periodSavings(gapped, '2026-08', 'previous_month')
    expect(result.months).toBe(0)
    expect(result.from).toBeNull()
    expect(result.rateBp).toBeNull()
  })

  it('crosses a year boundary backwards for the previous month', () => {
    const result = periodSavings(YEAR, '2026-01', 'previous_month')
    expect(result.from).toBe('2025-12')
    expect(result.rateBp).toBe(-2_500)
  })

  it('starts year to date at January of the year the selected month is in', () => {
    const result = periodSavings(YEAR, '2026-03', 'year_to_date')
    expect(result.months).toBe(3)
    expect(result.from).toBe('2026-01')
    expect(result.to).toBe('2026-03')
    // 1 200 000 in, 960 000 out.
    expect(result.rateBp).toBe(2_000)
  })

  it('does not let year to date reach into the previous year', () => {
    // December sits in the array immediately before January and is 100 000 in the red;
    // including it would turn a 20% year into something else entirely.
    const result = periodSavings(YEAR, '2026-03', 'year_to_date')
    expect(result.from).not.toBe('2025-12')
  })

  it('takes year to date of the year the reader selected, not of the array', () => {
    const result = periodSavings(YEAR, '2025-12', 'year_to_date')
    expect(result.from).toBe('2025-11')
    expect(result.to).toBe('2025-12')
    expect(result.months).toBe(2)
  })

  it('anchors the trailing window on the selected month, not on the end of history', () => {
    // The array runs to August; the reader has selected March. A window taken off the
    // end would show them nine months they cannot see on the page around it.
    const result = periodSavings(YEAR, '2026-03', 'twelve_months')
    expect(result.to).toBe('2026-03')
    expect(result.from).toBe('2025-11')
    expect(result.months).toBe(5)
  })

  it('takes at most twelve months, dropping the oldest end', () => {
    // The whole 24 months `/api/budget` can send, which is twice the window: the card
    // must not quietly report two years as one.
    const long = Array.from({ length: 24 }, (_, index) =>
      month(`${2025 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`, 400_000, 200_000),
    )
    const result = periodSavings(long, '2026-12', 'twelve_months')
    expect(result.months).toBe(TRAILING_MONTHS)
    expect(result.from).toBe('2026-01')
    expect(result.to).toBe('2026-12')
    expect(result.incomeCents).toBe(400_000 * TRAILING_MONTHS)
  })

  it('covers nothing at all on a deployment whose jobs have never run', () => {
    for (const period of SAVINGS_PERIODS) {
      const result = periodSavings([], '2026-08', period)
      expect(result).toMatchObject({
        period,
        rateBp: null,
        incomeCents: 0,
        spentCents: 0,
        months: 0,
        from: null,
        to: null,
      })
    }
  })

  it('never counts a month after the one selected, whatever the caller sent', () => {
    // `/api/budget` already ends its history at the selected month, and the selection
    // must not depend on that: a longer array would otherwise give a "year to date"
    // that ran into months the reader has not chosen.
    const result = periodSavings(YEAR, '2026-02', 'twelve_months')
    expect(result.to).toBe('2026-02')
    expect(result.months).toBe(4)
  })
})

describe('the vocabulary', () => {
  it('defaults to the twelve-month window', () => {
    // The report behind #288 is that the current month is the least useful of the four,
    // and twelve is the window the benchmark norms are already taken over.
    expect(DEFAULT_SAVINGS_PERIOD).toBe('twelve_months')
    expect(SAVINGS_PERIODS).toContain(DEFAULT_SAVINGS_PERIOD)
  })

  it('carries the period it was asked for, so the card can name it', () => {
    for (const period of SAVINGS_PERIODS) {
      expect(periodSavings(YEAR, '2026-08', period).period).toBe(period)
    }
  })
})
