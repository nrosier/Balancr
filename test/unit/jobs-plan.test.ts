/**
 * `planMonths` decides how much history each pass loads, and getting it wrong
 * fails silently: too little history and every annual baseline comes back null,
 * so the app simply stops having an opinion about the categories that matter
 * most. The depth assertion below is checked against `computeBaseline` itself
 * rather than against a number I believe — that is the only version of this test
 * that stays true when the baseline changes.
 */
import { describe, expect, it } from 'vitest'
import { computeBaseline } from '../../src/domain/aggregate/baseline.ts'
import { DEFAULT_PARAMS } from '../../src/domain/aggregate/params.ts'
import { historyDepth, planMonths } from '../../src/jobs/sync.ts'
import { addMonths, monthRange } from '../../src/util/month.ts'

const WINDOW = DEFAULT_PARAMS.baseline.windowMonths

/** Every month from `count` months before `last`, inclusive, ascending. */
const months = (last: string, count: number) => monthRange(addMonths(last, -(count - 1)), last)

/** A rising series ending at `2026-03`, `count` months long. */
const series = (count: number) =>
  months('2026-03', count).map((month, index) => ({ month, cents: 10_000 + index * 100 }))

const annualBaseline = (count: number) =>
  computeBaseline(series(count), '2026-03', 'annual', DEFAULT_PARAMS.baseline)

describe('historyDepth', () => {
  it('is deep enough for a full-window annual baseline', () => {
    // Checked against `computeBaseline` itself, not against a number I believe:
    // `historyDepth` months *before* the target, plus the target, must yield the
    // full `windowMonths` of observations for the widest window there is.
    expect(annualBaseline(historyDepth(WINDOW) + 1)?.monthsUsed).toBe(WINDOW)
  })

  it('is not deeper than that', () => {
    // Each month is its own `getBudgetMonth` call, so over-fetching is not free.
    // One month shallower is one observation short, which pins the constant from
    // below — the baseline is still produced, just built on thinner evidence.
    expect(annualBaseline(historyDepth(WINDOW))?.monthsUsed).toBe(WINDOW - 1)
  })
})

describe('planMonths', () => {
  it('targets the last N months and loads the history behind them', () => {
    const available = months('2026-03', 60)
    const { load, targets } = planMonths(available, '2026-03', 24, WINDOW)

    expect(targets).toHaveLength(24)
    expect(targets[0]).toBe('2024-04')
    expect(targets[23]).toBe('2026-03')
    // The window has to fit before the *first* target, not the last.
    expect(load[0]).toBe(addMonths('2024-04', -historyDepth(WINDOW)))
    expect(load[load.length - 1]).toBe('2026-03')
  })

  it('ignores the future months Actual lists', () => {
    // Actual offers budget months a year ahead. A future month has no spend to
    // judge, so including one would emit facts claiming every category is far
    // under its norm.
    const available = [...months('2026-03', 36), '2026-04', '2026-05', '2027-01']
    const { load, targets } = planMonths(available, '2026-03', 24, WINDOW)

    expect(targets[targets.length - 1]).toBe('2026-03')
    expect(load).not.toContain('2026-04')
  })

  it('loads a dense, ascending range', () => {
    // `aggregateSpend` asserts density; a gap would abort the whole pass.
    const { load } = planMonths(months('2026-03', 40), '2026-03', 12, WINDOW)
    expect(load).toEqual(monthRange(load[0] as string, load[load.length - 1] as string))
  })

  it('clamps to what Actual actually has', () => {
    // A budget started six months ago cannot supply two years of history, and
    // asking for months that predate it would break the density assertion.
    const available = months('2026-03', 6)
    const { load, targets } = planMonths(available, '2026-03', 24, WINDOW)

    expect(load).toEqual(available)
    expect(targets).toEqual(available)
  })

  it('handles an empty budget without inventing a month', () => {
    expect(planMonths([], '2026-03', 24, WINDOW)).toEqual({ load: [], targets: [] })
  })

  it('handles a budget whose months are all in the future', () => {
    // A file created in advance. Nothing to aggregate is a state, not a failure.
    expect(planMonths(['2026-04', '2026-05'], '2026-03', 24, WINDOW)).toEqual({
      load: [],
      targets: [],
    })
  })

  it('sorts an unordered list from Actual', () => {
    const { targets } = planMonths(['2026-02', '2025-12', '2026-01'], '2026-03', 2, WINDOW)
    expect(targets).toEqual(['2026-01', '2026-02'])
  })
})
