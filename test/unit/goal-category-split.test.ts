/**
 * Splitting one shared category's pool across the goals that target it (#407
 * extension) — pure math, no DB.
 *
 * The worked example from the plan: a goal due within the current month needing
 * €500 and a goal due two months out needing €1000 draw the *same* weight —
 * targetCents/monthsRemaining — because both need €500/month starting from zero
 * today, even though one target is double the other. Urgency, not size, is what
 * the split is proportional to. `asOfMonth`/`targetDate` here are month-granular,
 * matching `monthsBetween`'s own contract (`assertMonth`) rather than day counts.
 */
import { describe, expect, it } from 'vitest'
import {
  goalUrgencyWeight,
  splitCategoryPool,
  type CategoryPoolCandidate,
} from '../../src/domain/aggregate/goals.ts'

describe('goalUrgencyWeight', () => {
  it('is targetCents divided by whole months remaining, floored at one month', () => {
    // Due within the same month as asOfMonth -> 1 month remaining.
    expect(goalUrgencyWeight(50_000, '2026-09-30', '2026-09')).toBe(50_000)
    // Due two calendar months later.
    expect(goalUrgencyWeight(100_000, '2026-11-30', '2026-09')).toBe(50_000)
  })

  it('floors at one month for a target date in the past or the current month', () => {
    expect(goalUrgencyWeight(60_000, '2026-01-01', '2026-09')).toBe(60_000)
  })
})

describe('splitCategoryPool', () => {
  it('is empty for no candidates', () => {
    expect(splitCategoryPool(30_000, [], '2026-09')).toEqual(new Map())
  })

  it('gives a lone candidate the whole pool', () => {
    const candidates: CategoryPoolCandidate[] = [
      { goalId: 'a', targetCents: 50_000, targetDate: '2026-09-30' },
    ]
    expect(splitCategoryPool(30_000, candidates, '2026-09')).toEqual(new Map([['a', 30_000]]))
  })

  it('worked example: a nearer, smaller goal and a farther, larger goal split evenly', () => {
    // A: due this month, target €500 -> weight 50 000/1mo = 50 000.
    // B: due two months out, target €1000 -> weight 100 000/2mo = 50 000.
    const candidates: CategoryPoolCandidate[] = [
      { goalId: 'a', targetCents: 50_000, targetDate: '2026-09-30' },
      { goalId: 'b', targetCents: 100_000, targetDate: '2026-11-30' },
    ]

    const shares = splitCategoryPool(30_000, candidates, '2026-09')

    expect(shares.get('a')).toBe(15_000)
    expect(shares.get('b')).toBe(15_000)
  })

  it('splits three equal-weight candidates by largest-remainder rounding, ties by goalId', () => {
    const candidates: CategoryPoolCandidate[] = [
      { goalId: 'c', targetCents: 10_000, targetDate: '2026-09-30' },
      { goalId: 'a', targetCents: 10_000, targetDate: '2026-09-30' },
      { goalId: 'b', targetCents: 10_000, targetDate: '2026-09-30' },
    ]

    const shares = splitCategoryPool(100, candidates, '2026-09')

    // 100 / 3 = 33.33 each; the extra cent goes to the tie-break winner by goalId.
    expect([...shares.values()].reduce((sum, value) => sum + value, 0)).toBe(100)
    expect(shares.get('a')).toBe(34)
    expect(shares.get('b')).toBe(33)
    expect(shares.get('c')).toBe(33)
  })

  it('dilutes every sharing goal for a negative pool, still summing exactly', () => {
    const candidates: CategoryPoolCandidate[] = [
      { goalId: 'a', targetCents: 50_000, targetDate: '2026-09-30' },
      { goalId: 'b', targetCents: 100_000, targetDate: '2026-11-30' },
    ]

    const shares = splitCategoryPool(-30_000, candidates, '2026-09')

    expect(shares.get('a')).toBe(-15_000)
    expect(shares.get('b')).toBe(-15_000)
    expect([...shares.values()].reduce((sum, value) => sum + value, 0)).toBe(-30_000)
  })
})
