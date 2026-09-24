/**
 * Progress and projection for a savings goal (#407) — pure math, no DB.
 *
 * The discipline under test is the same one `savings.ts` already pins: never claim
 * more than the data supports. A goal already met answers with a zero ETA rather
 * than projecting one; a goal with fewer than two months of trend, or one whose
 * trend is flat or falling, answers `null` rather than a fabricated date.
 *
 * `computeGoalProgress` itself no longer resolves a net-worth kind to a figure —
 * that is `currentCentsFor`'s job, split out so `goal-store.ts` can resolve a
 * `category` goal's pooled share the same way without `computeGoalProgress`
 * needing to know about pools at all.
 */
import { describe, expect, it } from 'vitest'
import {
  computeGoalPace,
  computeGoalProgress,
  currentCentsFor,
  existedAsOf,
  isGoalVisible,
  monthlyGoalTrend,
  projectGoal,
  requiredMonthlySavingsCents,
  GOAL_TREND_WINDOW_MONTHS,
} from '../../src/domain/aggregate/goals.ts'
import type { NetWorthSummary } from '../../src/domain/aggregate/networth.ts'
import type { Goal } from '../../src/domain/goal/vocabulary.ts'

const GOAL: Goal = {
  id: 'goal-1',
  label: 'Emergency fund',
  kind: 'liquid',
  priority: 'normal',
  categoryId: null,
  targetCents: 1_000_000,
  targetDate: null,
  status: 'active',
  doneAt: null,
  createdAt: '2026-01-01',
}

const netWorth = (overrides: Partial<NetWorthSummary> = {}): NetWorthSummary => ({
  date: '2026-09-01',
  totalCents: 900_000,
  liquidCents: 600_000,
  investedCents: 300_000,
  debtCents: 0,
  ...overrides,
})

describe('currentCentsFor', () => {
  it('answers null with no net worth yet', () => {
    expect(currentCentsFor({ kind: 'liquid' }, null)).toBeNull()
  })

  it('reads liquidCents for a liquid goal', () => {
    expect(currentCentsFor({ kind: 'liquid' }, netWorth())).toBe(600_000)
  })

  it('reads investedCents for an invested goal', () => {
    expect(currentCentsFor({ kind: 'invested' }, netWorth())).toBe(300_000)
  })

  it('reads totalCents for a total goal', () => {
    expect(currentCentsFor({ kind: 'total' }, netWorth())).toBe(900_000)
  })
})

describe('computeGoalProgress', () => {
  it('answers null throughout when there is no current figure yet', () => {
    const progress = computeGoalProgress(GOAL, null)

    expect(progress.currentCents).toBeNull()
    expect(progress.progressBp).toBeNull()
    expect(progress.met).toBeNull()
  })

  it('compares the given current figure against the target', () => {
    const progress = computeGoalProgress(GOAL, 600_000)

    expect(progress.currentCents).toBe(600_000)
    expect(progress.progressBp).toBe(6_000)
    expect(progress.met).toBe(false)
  })

  it('lets progressBp exceed 10000 once the target is passed, and reports met', () => {
    const progress = computeGoalProgress(GOAL, 1_500_000)

    expect(progress.progressBp).toBe(15_000)
    expect(progress.met).toBe(true)
  })
})

describe('monthlyGoalTrend', () => {
  it('is empty when there is no history at all', () => {
    expect(monthlyGoalTrend([], '2026-09')).toEqual([])
  })

  it('carries the latest known value forward through a month with no new snapshot', () => {
    const history = [
      { date: '2026-06-15', valueCents: 100_000 },
      { date: '2026-08-10', valueCents: 200_000 },
      { date: '2026-08-25', valueCents: 220_000 },
    ]

    const trend = monthlyGoalTrend(history, '2026-09', 3)

    expect(trend).toEqual([
      { month: '2026-06', valueCents: 100_000 },
      { month: '2026-07', valueCents: 100_000 },
      { month: '2026-08', valueCents: 220_000 },
      { month: '2026-09', valueCents: 220_000 },
    ])
  })

  it('skips a leading month that has no snapshot before it at all', () => {
    const history = [{ date: '2026-08-10', valueCents: 200_000 }]

    const trend = monthlyGoalTrend(history, '2026-09', 3)

    expect(trend).toEqual([
      { month: '2026-08', valueCents: 200_000 },
      { month: '2026-09', valueCents: 200_000 },
    ])
  })

  it('defaults its window to GOAL_TREND_WINDOW_MONTHS', () => {
    const history = [{ date: '2026-01-01', valueCents: 1 }]

    const trend = monthlyGoalTrend(history, '2026-09')

    expect(trend.every((point) => point.month >= '2026-03')).toBe(true)
    expect(GOAL_TREND_WINDOW_MONTHS).toBe(6)
  })
})

describe('projectGoal', () => {
  it('reports a zero-month ETA once the goal is met, regardless of trend', () => {
    const progress = computeGoalProgress(GOAL, 1_500_000)

    const projection = projectGoal(progress, [], '2026-09')

    expect(projection.monthsToTarget).toBe(0)
    expect(projection.etaMonth).toBe('2026-09')
    expect(projection.monthlyRateCents).toBeNull()
  })

  it('answers null for rate and ETA with fewer than two trend points', () => {
    const progress = computeGoalProgress(GOAL, 600_000)

    const projection = projectGoal(progress, [{ month: '2026-09', valueCents: 600_000 }], '2026-09')

    expect(projection.monthlyRateCents).toBeNull()
    expect(projection.monthsToTarget).toBeNull()
    expect(projection.etaMonth).toBeNull()
  })

  it('projects an ETA from a positive trailing rate', () => {
    const progress = computeGoalProgress(GOAL, 600_000)
    const trend = [
      { month: '2026-07', valueCents: 400_000 },
      { month: '2026-08', valueCents: 500_000 },
      { month: '2026-09', valueCents: 600_000 },
    ]

    const projection = projectGoal(progress, trend, '2026-09')

    expect(projection.monthlyRateCents).toBe(100_000)
    // 400 000 remaining at 100 000/month.
    expect(projection.monthsToTarget).toBe(4)
    expect(projection.etaMonth).toBe('2027-01')
    expect(projection.from).toBe('2026-07')
    expect(projection.to).toBe('2026-09')
  })

  it('reports the rate but leaves the ETA null when the trend is flat or falling', () => {
    const progress = computeGoalProgress(GOAL, 500_000)
    const falling = [
      { month: '2026-07', valueCents: 600_000 },
      { month: '2026-08', valueCents: 550_000 },
      { month: '2026-09', valueCents: 500_000 },
    ]

    const projection = projectGoal(progress, falling, '2026-09')

    expect(projection.monthlyRateCents).toBe(-50_000)
    expect(projection.monthsToTarget).toBeNull()
    expect(projection.etaMonth).toBeNull()
  })
})

describe('requiredMonthlySavingsCents', () => {
  it('answers null with no target date', () => {
    const progress = computeGoalProgress(GOAL, 600_000)
    expect(requiredMonthlySavingsCents(progress, '2026-09')).toBeNull()
  })

  it('answers null with no current figure yet', () => {
    const progress = computeGoalProgress({ ...GOAL, targetDate: '2026-12-01' }, null)
    expect(requiredMonthlySavingsCents(progress, '2026-09')).toBeNull()
  })

  it('is 0 once the goal is met', () => {
    const progress = computeGoalProgress({ ...GOAL, targetDate: '2026-12-01' }, 1_500_000)
    expect(requiredMonthlySavingsCents(progress, '2026-09')).toBe(0)
  })

  it('is the remaining amount divided by the whole months left, rounded up', () => {
    // 400 000 remaining, 3 months (Sep -> Dec) -> 133 333.33, rounded up.
    const progress = computeGoalProgress({ ...GOAL, targetDate: '2026-12-01' }, 600_000)
    expect(requiredMonthlySavingsCents(progress, '2026-09')).toBe(133_334)
  })

  it('floors the remaining window at one month for a target due within the same month', () => {
    const progress = computeGoalProgress({ ...GOAL, targetDate: '2026-09-15' }, 600_000)
    expect(requiredMonthlySavingsCents(progress, '2026-09')).toBe(400_000)
  })
})

describe('computeGoalPace', () => {
  it('answers null with no required figure', () => {
    expect(computeGoalPace(null, 100_000)).toBeNull()
  })

  it('answers null with no observed rate', () => {
    expect(computeGoalPace(100_000, null)).toBeNull()
  })

  it('is onTrack unconditionally once nothing more is required', () => {
    expect(computeGoalPace(0, -50_000)).toBe('onTrack')
  })

  it('is onTrack even when no observed rate exists yet, once nothing more is required', () => {
    // projectGoal never reports a monthlyRateCents once a goal is met (there is
    // nothing left to project a rate for), so requiredMonthlyCents <= 0 must win
    // over the "no observed rate" null-out — a met goal always reads as onTrack.
    expect(computeGoalPace(0, null)).toBe('onTrack')
  })

  it('is onTrack at exactly 100% of the required rate', () => {
    expect(computeGoalPace(100_000, 100_000)).toBe('onTrack')
  })

  it('is atRisk at exactly 60% of the required rate', () => {
    expect(computeGoalPace(100_000, 60_000)).toBe('atRisk')
  })

  it('is atRisk just under 100%', () => {
    expect(computeGoalPace(100_000, 99_000)).toBe('atRisk')
  })

  it('is behind just under 60%', () => {
    expect(computeGoalPace(100_000, 59_000)).toBe('behind')
  })

  it('is behind for a negative rate — losing ground', () => {
    expect(computeGoalPace(100_000, -10_000)).toBe('behind')
  })
})

describe('isGoalVisible', () => {
  it('is always true for an active goal', () => {
    expect(isGoalVisible({ status: 'active', doneAt: null }, '2026-09-24')).toBe(true)
  })

  it('is true within the grace window, at exactly the boundary day', () => {
    expect(isGoalVisible({ status: 'done', doneAt: '2026-09-17' }, '2026-09-24')).toBe(true)
  })

  it('is false the day after the grace window closes', () => {
    expect(isGoalVisible({ status: 'done', doneAt: '2026-09-16' }, '2026-09-24')).toBe(false)
  })
})

describe('existedAsOf', () => {
  it('is true for a goal created before the narrated month', () => {
    expect(existedAsOf({ createdAt: '2026-06-15' }, '2026-09')).toBe(true)
  })

  it('is true for a goal created within the narrated month', () => {
    expect(existedAsOf({ createdAt: '2026-09-15' }, '2026-09')).toBe(true)
  })

  it('is false for a goal created after the narrated month — it has no business in a past rejudge', () => {
    expect(existedAsOf({ createdAt: '2026-10-01' }, '2026-09')).toBe(false)
  })
})
