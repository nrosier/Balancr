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
 * The rest is window selection and pro-ration: a month or year window anchored on the
 * month the reader selected rather than on the end of history, and — same as
 * `benchmarkPeriodWindow` — a still-open anchor month or year counting for only the
 * fraction of it that has elapsed, so a partial period does not read as an
 * underperforming whole one.
 */
import { describe, expect, it } from 'vitest'
import { absolutePeriodSavings, type SavingsMonth } from '../../src/domain/aggregate/savings.ts'

/** A month of flows. Round, invented figures — this file never sees real ones. */
const month = (
  key: string,
  incomeCents: number,
  spentCents: number,
  committed: { cents: number; approximate?: boolean } = { cents: 0 },
): SavingsMonth => ({
  month: key,
  incomeCents,
  spentCents,
  committedCents: committed.cents,
  committedApproximate: committed.approximate ?? false,
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

// Noon UTC on 2026-08-17, well past every month below — every one is finished.
const ASOF = new Date('2026-08-17T12:00:00Z')
const TZ = 'UTC'

describe('summing before dividing', () => {
  it('is not the mean of the monthly rates, which is the whole point', () => {
    // A paycheck in one month paying for rent recorded in the next: the first month
    // looks catastrophic and the second looks unreal, and the pair is ordinary.
    const boundary = [month('2026-06', 0, 200_000), month('2026-07', 400_000, 200_000)]

    // The monthly rates are null (no income) and 50%. Any mean of those is 50% or
    // undefined; neither is what the two months together did.
    const result = absolutePeriodSavings(boundary, 'year', '2026-07', ASOF, TZ)
    expect(result.incomeCents).toBe(400_000)
    expect(result.spentCents).toBe(400_000)
    expect(result.rateBp).toBe(0)
    expect(result.rateBp).not.toBe(5_000)
  })

  it('reports a negative rate rather than clamping it', () => {
    // Spending more than came in is a state to act on, and the card colours it — a
    // floor at zero would print the same figure as breaking even.
    const result = absolutePeriodSavings([month('2026-08', 400_000, 500_000)], 'month', '2026-08', ASOF, TZ)
    expect(result.rateBp).toBe(-2_500)
  })

  it('has no rate when the window has no income to divide by', () => {
    const result = absolutePeriodSavings([month('2026-08', 0, 120_000)], 'month', '2026-08', ASOF, TZ)
    expect(result.rateBp).toBeNull()
    // The flows are still reported: "no rate" is not "no data", and the span line
    // still has a month to name.
    expect(result.spentCents).toBe(120_000)
    expect(result.months).toBe(1)
  })
})

describe('which months a period covers', () => {
  it('reads one month, and agrees with what the month itself stores', () => {
    const result = absolutePeriodSavings(YEAR, 'month', '2026-08', ASOF, TZ)
    expect(result.months).toBe(1)
    expect(result.from).toBe('2026-08')
    expect(result.to).toBe('2026-08')
    // Same formula and same inputs as `MonthTotals.savingsRateBp`, which is what lets
    // the card use one code path for both kinds without disagreeing with the figure
    // the digest quotes.
    expect(result.rateBp).toBe(1_000)
  })

  it('starts a year at January of the anchor month, not at the array boundary', () => {
    const result = absolutePeriodSavings(YEAR, 'year', '2026-03', ASOF, TZ)
    expect(result.months).toBe(3)
    expect(result.from).toBe('2026-01')
    expect(result.to).toBe('2026-03')
    // 1 200 000 in, 960 000 out.
    expect(result.rateBp).toBe(2_000)
  })

  it('does not let a year reach into the previous one', () => {
    // December sits in the array immediately before January and is 100 000 in the red;
    // including it would turn a 20% year into something else entirely.
    const result = absolutePeriodSavings(YEAR, 'year', '2026-03', ASOF, TZ)
    expect(result.from).not.toBe('2025-12')
  })

  it('covers nothing at all when history has no month matching the window', () => {
    for (const kind of ['month', 'year'] as const) {
      const result = absolutePeriodSavings([], kind, '2026-08', ASOF, TZ)
      expect(result).toMatchObject({
        kind,
        month: '2026-08',
        rateBp: null,
        incomeCents: 0,
        spentCents: 0,
        months: 0,
        from: null,
        to: null,
      })
    }
  })

  it('never counts a month after the anchor, whatever the caller sent', () => {
    // A history that runs past the anchor month: the window must not silently include
    // months the reader has not selected.
    const result = absolutePeriodSavings(YEAR, 'year', '2026-02', ASOF, TZ)
    expect(result.to).toBe('2026-02')
    expect(result.months).toBe(2)
  })
})

describe('pro-rating a still-open period, mirroring benchmarkPeriodWindow', () => {
  // Noon UTC on 2026-08-17: August is 53.2258...% elapsed (16.5 of 31 days).
  const AUGUST_PROGRESS = 16.5 / 31

  it('a finished past month counts as a whole month', () => {
    const result = absolutePeriodSavings(YEAR, 'month', '2026-05', ASOF, TZ)
    expect(result.periodProgressBp).toBe(10_000)
  })

  it('the open current month is pro-rated by the day', () => {
    const result = absolutePeriodSavings(YEAR, 'month', '2026-08', ASOF, TZ)
    expect(result.periodProgressBp).toBe(Math.round(AUGUST_PROGRESS * 10_000))
  })

  it('a finished past year sums to exactly its month count out of twelve', () => {
    const result = absolutePeriodSavings(YEAR, 'year', '2025-12', ASOF, TZ)
    expect(result.periodProgressBp).toBe(10_000)
  })

  it('a year anchored on the open current month is pro-rated by the fraction of a year elapsed', () => {
    const result = absolutePeriodSavings(YEAR, 'year', '2026-08', ASOF, TZ)
    // 7 finished months (Jan–Jul) plus August's own fraction, out of a nominal 12.
    expect(result.periodProgressBp).toBe(Math.round(((7 + AUGUST_PROGRESS) / 12) * 10_000))
  })
})

describe('folding in what is still to come (#361)', () => {
  it('lowers the rate for the still-open month without changing the reported spend', () => {
    const posted = absolutePeriodSavings(
      [month('2026-08', 400_000, 300_000)],
      'month',
      '2026-08',
      ASOF,
      TZ,
    )
    const withCommitted = absolutePeriodSavings(
      [month('2026-08', 400_000, 300_000, { cents: 40_000 })],
      'month',
      '2026-08',
      ASOF,
      TZ,
    )
    expect(withCommitted.rateBp).toBeLessThan(posted.rateBp as number)
    // The rate moved; the figure the card labels "Spent" did not.
    expect(withCommitted.spentCents).toBe(posted.spentCents)
    expect(withCommitted.committedCents).toBe(40_000)
    expect(withCommitted.rateBp).toBe(1_500) // (400 000 − 340 000) / 400 000
  })

  it('folds in whichever month of a year window is still open, with no special-casing', () => {
    const history = [
      ...YEAR.slice(0, -1),
      month('2026-08', 400_000, 360_000, { cents: 50_000 }),
    ]
    const result = absolutePeriodSavings(history, 'year', '2026-08', ASOF, TZ)
    expect(result.committedCents).toBe(50_000)
    // Only the eight 2026 months the year window actually covers — not the two
    // 2025 ones `YEAR` also carries either side of the boundary.
    expect(result.spentCents).toBe(
      YEAR.filter((m) => m.month >= '2026-01').reduce((sum, m) => sum + m.spentCents, 0),
    )
  })

  it('leaves every finished month exactly as it was, since committed is zero there', () => {
    const result = absolutePeriodSavings(YEAR, 'year', '2026-05', ASOF, TZ)
    expect(result.committedCents).toBe(0)
    expect(result.committedApproximate).toBe(false)
  })

  it('surfaces the approximate flag only when the committed amount it describes is present', () => {
    const result = absolutePeriodSavings(
      [month('2026-08', 400_000, 300_000, { cents: 40_000, approximate: true })],
      'month',
      '2026-08',
      ASOF,
      TZ,
    )
    expect(result.committedApproximate).toBe(true)
  })
})

describe('the vocabulary', () => {
  it('carries the kind and anchor it was asked for, so the card can name it', () => {
    for (const kind of ['month', 'year'] as const) {
      const result = absolutePeriodSavings(YEAR, kind, '2026-08', ASOF, TZ)
      expect(result.kind).toBe(kind)
      expect(result.month).toBe('2026-08')
    }
  })
})
