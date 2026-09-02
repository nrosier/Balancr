/**
 * Ghostfolio's performance chart reduced to month-ends.
 *
 * Every case here is a way the reduction could produce a *plausible wrong number*
 * rather than nothing, which is the only failure that matters for a series somebody
 * reads for its shape:
 *
 *  - a month the chart stops partway through, whose last entry would be stamped as
 *    the month's close and read that way for ever;
 *  - the frontier month, which is the same bug with a guaranteed trigger;
 *  - a missing `value`, which becomes € 0,00 the moment anyone treats nullish as zero
 *    — a portfolio that vanished for a month;
 *  - unparseable dates from an unversioned endpoint, which must narrow the answer
 *    rather than widen it.
 *
 * Charts here carry an entry past the last month asked for, because that is what the
 * real one does: `range=max` runs to today and only settled months are backfilled.
 */
import { describe, expect, it } from 'vitest'
import type { PortfolioPerformance } from '../../src/adapters/ghostfolio/types.ts'
import { chartStart, monthEndValues } from '../../src/domain/portfolio/history.ts'

/** A chart from `[date, value]` pairs; `null` is Ghostfolio omitting the value. */
const chart = (...entries: [string, number | null][]): PortfolioPerformance => ({
  chart: entries.map(([date, value]) => ({ date, value })),
})

describe('chartStart', () => {
  it('is the earliest usable date, whatever order the entries arrive in', () => {
    expect(chartStart(chart(['2025-06-30', 900], ['2025-04-30', 500]))).toBe('2025-04-30')
  })

  it('is null for an empty chart, which reads as "no portfolio history"', () => {
    expect(chartStart(chart())).toBeNull()
  })

  it('ignores entries with no value, since an unpriced day is not a start date', () => {
    expect(chartStart(chart(['2025-04-30', null], ['2025-05-31', 500]))).toBe('2025-05-31')
  })
})

describe('monthEndValues', () => {
  it('takes the last entry in each month as its close', () => {
    const performance = chart(
      ['2026-01-15', 1_000],
      ['2026-01-30', 1_100],
      ['2026-01-31', 1_234.56],
      ['2026-02-28', 1_300],
      ['2026-03-01', 1_310],
    )
    expect(monthEndValues(performance, ['2026-01', '2026-02'])).toEqual([
      { date: '2026-01-31', valueCents: 123_456 },
      { date: '2026-02-28', valueCents: 130_000 },
    ])
  })

  it('answers a month whose last entry precedes the month-end', () => {
    // 2026-05-31 is a Sunday. If the chart carries only the days the portfolio could
    // be priced, the Friday close *is* May's closing value, and demanding an entry
    // dated 2026-05-31 would drop every month that ends on a weekend.
    const performance = chart(['2026-05-29', 2_000], ['2026-06-01', 2_050])
    expect(monthEndValues(performance, ['2026-05'])).toEqual([
      { date: '2026-05-31', valueCents: 200_000 },
    ])
  })

  it('refuses a month the chart stops partway through', () => {
    // The chart ends on the 20th — Ghostfolio was down since, or this is the current
    // month. Either way the 20th's value is not the month's close, and stamping it
    // 2026-03-31 would make it one permanently.
    expect(monthEndValues(chart(['2026-03-10', 500], ['2026-03-20', 600]), ['2026-03'])).toEqual([])
  })

  it('refuses the month the chart ends in even when it ends on the month-end', () => {
    // A chart ending exactly at a month-end is indistinguishable from one that stopped
    // there, so the frontier month is refused. It costs nothing in practice: the chart
    // runs to today, and the current month is never backfilled.
    const performance = chart(['2026-02-28', 900], ['2026-03-31', 1_000])
    expect(monthEndValues(performance, ['2026-02', '2026-03'])).toEqual([
      { date: '2026-02-28', valueCents: 90_000 },
    ])
  })

  it('refuses a month with no entries rather than reaching into the previous one', () => {
    const performance = chart(['2026-01-31', 1_000], ['2026-03-31', 1_200], ['2026-04-01', 1_210])
    expect(monthEndValues(performance, ['2026-01', '2026-02', '2026-03'])).toEqual([
      { date: '2026-01-31', valueCents: 100_000 },
      { date: '2026-03-31', valueCents: 120_000 },
    ])
  })

  it('drops a nullish value instead of closing the month at zero', () => {
    const performance = chart(
      ['2026-01-30', 1_000],
      ['2026-01-31', null],
      ['2026-02-28', 1_100],
      ['2026-03-01', 1_150],
    )
    // January closes on the 30th, the last day it was priced — not at zero, and not
    // at February's figure.
    expect(monthEndValues(performance, ['2026-01', '2026-02'])).toEqual([
      { date: '2026-01-31', valueCents: 100_000 },
      { date: '2026-02-28', valueCents: 110_000 },
    ])
  })

  it('accepts a full ISO instant, because the endpoint is unversioned', () => {
    const performance = chart(
      ['2026-01-31T00:00:00.000Z', 1_000],
      ['2026-02-01T00:00:00.000Z', 1_010],
    )
    expect(monthEndValues(performance, ['2026-01'])).toEqual([
      { date: '2026-01-31', valueCents: 100_000 },
    ])
  })

  it('drops an unparseable date rather than guessing at it', () => {
    const performance = chart(['not-a-date', 9_999], ['2026-01-31', 1_000], ['2026-02-01', 1_010])
    expect(monthEndValues(performance, ['2026-01'])).toEqual([
      { date: '2026-01-31', valueCents: 100_000 },
    ])
  })

  it('returns months ascending however they were asked for', () => {
    const performance = chart(
      ['2026-01-31', 100],
      ['2026-02-28', 200],
      ['2026-03-31', 300],
      ['2026-04-01', 310],
    )
    expect(
      monthEndValues(performance, ['2026-03', '2026-01', '2026-02']).map((point) => point.date),
    ).toEqual(['2026-01-31', '2026-02-28', '2026-03-31'])
  })

  it('is empty for an empty chart, not an error', () => {
    expect(monthEndValues(chart(), ['2026-01'])).toEqual([])
  })
})
