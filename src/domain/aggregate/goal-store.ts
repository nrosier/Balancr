/**
 * Every one of a tenant's goals, priced and projected (#407 extension).
 *
 * The one place `GET /api/overview`, `GET /api/budget` and `domain/ai/bundle.ts`
 * all read goal progress from, so a category goal's pooled share is computed once,
 * not three times with three chances to disagree. `domain/aggregate/goals.ts`
 * stays pure and DB-free; this is the DB-touching orchestration its `category`-kind
 * pool split needs — the same split `networth-store.ts` draws against
 * `domain/aggregate/networth.ts`.
 *
 * `asOfMonth` anchors every "as of" figure this returns: progress, trend,
 * required-monthly savings, pace, and the pool split itself. `today` anchors ONLY
 * the lifecycle visibility filter (`isGoalVisible`) — "is this goal currently
 * archived" is present-tense regardless of which month is being narrated, so an AI
 * rejudge of a past month still passes real wall-clock `today` for it, never
 * `asOfMonth`.
 *
 * A done goal within its grace window is returned with every progress/pace field
 * null, its stored `status`/`doneAt` intact — it freezes rather than keeps
 * recomputing, and stops drawing from any shared pool, freeing its share for
 * active siblings. A done goal past its grace window is omitted entirely.
 *
 * A `category`-kind goal's trend is the category's own `availableCents` history,
 * scaled by this goal's urgency-weight share of the pool, with its latest point
 * pinned to the same `currentCents` figure the pool split itself reports (the two
 * can disagree by a rounding cent otherwise — see the comment at the trend's
 * construction below) — so `projectGoal`'s rate is measured on the same series
 * its ETA is stated against, not a second, unscaled one.
 */
import type { Db } from '../../db/index.ts'
import { listGoals, type Goal } from '../goal/goals.ts'
import { loadCategoryAvailableTrend } from './facts.ts'
import {
  computeGoalPace,
  computeGoalProgress,
  currentCentsFor,
  existedAsOf,
  GOAL_TREND_WINDOW_MONTHS,
  goalPoolShareRatio,
  isGoalVisible,
  monthlyGoalTrend,
  projectGoal,
  requiredMonthlySavingsCents,
  splitCategoryPool,
  type CategoryPoolCandidate,
  type GoalPace,
} from './goals.ts'
import { loadNetWorthComponentHistory } from './networth-store.ts'
import type { NetWorthSummary } from './networth.ts'

export interface GoalWithProgress extends Goal {
  currentCents: number | null
  progressBp: number | null
  met: boolean | null
  monthlyRateCents: number | null
  monthsToTarget: number | null
  etaMonth: string | null
  trendMonths: number
  trendFrom: string | null
  trendTo: string | null
  requiredMonthlyCents: number | null
  pace: GoalPace | null
}

/** Every progress/pace field a frozen (done, within grace) goal reports. */
const FROZEN_PROGRESS = {
  currentCents: null,
  progressBp: null,
  met: null,
  monthlyRateCents: null,
  monthsToTarget: null,
  etaMonth: null,
  trendMonths: 0,
  trendFrom: null,
  trendTo: null,
  requiredMonthlyCents: null,
  pace: null,
} as const

function isCategoryGoal(goal: Goal): goal is Goal & { kind: 'category'; categoryId: string } {
  return goal.kind === 'category'
}

export function loadGoalsWithProgress(
  db: Db,
  tenantId: string,
  netWorth: NetWorthSummary | null,
  asOfMonth: string,
  today: string,
): GoalWithProgress[] {
  const visible = listGoals(db, tenantId).filter(
    (goal) => isGoalVisible(goal, today) && existedAsOf(goal, asOfMonth),
  )
  const results = new Map<string, GoalWithProgress>()

  for (const goal of visible) {
    if (goal.status === 'done') results.set(goal.id, { ...goal, ...FROZEN_PROGRESS })
  }

  const active = visible.filter((goal) => goal.status === 'active')

  for (const goal of active) {
    if (goal.kind === 'category') continue
    const kind = goal.kind
    const currentCents = currentCentsFor({ kind }, netWorth)
    const progress = computeGoalProgress(goal, currentCents)
    const trend = monthlyGoalTrend(loadNetWorthComponentHistory(db, tenantId, kind), asOfMonth)
    const projection = projectGoal(progress, trend, asOfMonth)
    const requiredMonthlyCents = requiredMonthlySavingsCents(progress, asOfMonth)
    results.set(goal.id, {
      ...goal,
      currentCents: progress.currentCents,
      progressBp: progress.progressBp,
      met: progress.met,
      monthlyRateCents: projection.monthlyRateCents,
      monthsToTarget: projection.monthsToTarget,
      etaMonth: projection.etaMonth,
      trendMonths: projection.months,
      trendFrom: projection.from,
      trendTo: projection.to,
      requiredMonthlyCents,
      pace: computeGoalPace(requiredMonthlyCents, projection.monthlyRateCents),
    })
  }

  const byCategory = new Map<string, (Goal & { kind: 'category'; categoryId: string })[]>()
  for (const goal of active) {
    if (!isCategoryGoal(goal)) continue
    const siblings = byCategory.get(goal.categoryId) ?? []
    siblings.push(goal)
    byCategory.set(goal.categoryId, siblings)
  }

  for (const [categoryId, siblings] of byCategory) {
    const rawTrend = loadCategoryAvailableTrend(
      db,
      tenantId,
      categoryId,
      asOfMonth,
      GOAL_TREND_WINDOW_MONTHS + 1,
    )
    // No fact row for `asOfMonth` itself — either none at all, or `rawTrend` (which
    // omits months with no row, see `loadCategoryAvailableTrend`) ends on some
    // earlier month — means "not known yet as of the month being narrated", the
    // same reason a goal's currentCents is null before the first net-worth sync.
    // Falling back to a stale prior month's balance here would report an old
    // figure as if it were current.
    const latest = rawTrend.at(-1)
    const poolCents = latest?.month === asOfMonth ? latest.valueCents : null

    const candidates: CategoryPoolCandidate[] = siblings.map((goal) => ({
      goalId: goal.id,
      targetCents: goal.targetCents,
      // Non-null by the write-time invariant `goalInputSchema` enforces: a
      // category-kind goal always has a target date.
      targetDate: goal.targetDate as string,
    }))
    const shares = poolCents === null ? null : splitCategoryPool(poolCents, candidates, asOfMonth)

    for (const goal of siblings) {
      const share = shares?.get(goal.id) ?? null
      const progress = computeGoalProgress(goal, share)
      // The urgency weight ratio, not `share / poolCents` — that degenerates to `0`
      // whenever this month's pool happens to be exactly `0` (an ordinary "fully
      // spent this envelope" state), which would flatten every past month of the
      // trend along with the current one instead of just reporting `currentCents: 0`.
      const scale =
        poolCents === null
          ? 0
          // Non-null by the same write-time invariant `candidates` above relies on.
          : goalPoolShareRatio({ targetCents: goal.targetCents, targetDate: goal.targetDate as string }, candidates, asOfMonth)
      // The last point (asOfMonth itself, guaranteed by the `poolCents` check above)
      // is pinned to the same `share` `currentCents` reports, not re-derived by
      // rounding `scale` against it — `scale` is a continuous urgency-weight ratio
      // while `share` is `splitCategoryPool`'s largest-remainder integer-cent split,
      // and the two can disagree by a cent. Left unpinned, that disagreement shows
      // up as a spurious month-over-month rate on an otherwise-flat balance, which
      // can inflate `monthsToTarget`/`etaMonth` into an invalid, far-future date.
      const trend =
        poolCents === null
          ? []
          : rawTrend.map((point, index) => ({
              month: point.month,
              valueCents:
                index === rawTrend.length - 1 ? share ?? 0 : Math.round(point.valueCents * scale),
            }))
      const projection = projectGoal(progress, trend, asOfMonth)
      const requiredMonthlyCents = requiredMonthlySavingsCents(progress, asOfMonth)
      results.set(goal.id, {
        ...goal,
        currentCents: progress.currentCents,
        progressBp: progress.progressBp,
        met: progress.met,
        monthlyRateCents: projection.monthlyRateCents,
        monthsToTarget: projection.monthsToTarget,
        etaMonth: projection.etaMonth,
        trendMonths: projection.months,
        trendFrom: projection.from,
        trendTo: projection.to,
        requiredMonthlyCents,
        pace: computeGoalPace(requiredMonthlyCents, projection.monthlyRateCents),
      })
    }
  }

  // Preserves `listGoals`'s own order rather than the map's insertion order.
  return visible.map((goal) => results.get(goal.id) as GoalWithProgress)
}

/** How many other active goals share this goal's category — 0 for a non-category goal. */
export function categorySiblingCount(goals: readonly GoalWithProgress[], goal: GoalWithProgress): number {
  if (goal.kind !== 'category' || goal.categoryId === null) return 0
  return goals.filter(
    (other) =>
      other.id !== goal.id &&
      other.status === 'active' &&
      other.kind === 'category' &&
      other.categoryId === goal.categoryId,
  ).length
}
