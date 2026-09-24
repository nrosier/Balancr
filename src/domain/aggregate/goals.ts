/**
 * Progress and projection for a savings goal (#407) — pure, no DB, the same split
 * `savings.ts` uses.
 *
 * A goal is never a separately tracked balance: `currentCents` is always resolved
 * by the caller — from `NetWorthSummary` for a `liquid`/`invested`/`total` goal, or
 * from a category's pooled `availableCents` share for a `category` one — and
 * `computeGoalProgress` only ever compares that figure to the target, so a goal can
 * never disagree with the balance it is a goal about. This module stays pure and
 * DB-free; resolving *which* current figure a goal names is `goal-store.ts`'s job,
 * because a `category`-kind goal's figure depends on its pool-sharing siblings, a
 * read this module has no way to make. `projectGoal` follows the same "never claim
 * more than is known" discipline as `absolutePeriodSavings`'s `rateBp` — an ETA is
 * `null` rather than a fabricated date whenever the trend behind it doesn't support
 * one.
 */
import { addMonths, daysBetween, endOfMonth, monthOf, monthRange, monthsBetween } from '../../util/month.ts'
import type { Goal } from '../goal/vocabulary.ts'
import { GOAL_DONE_GRACE_DAYS } from '../goal/vocabulary.ts'
import type { NetWorthSummary } from './networth.ts'

export interface GoalProgress {
  readonly goalId: string
  readonly targetCents: number
  readonly targetDate: string | null
  /** `null` before the first net-worth sync — there is nothing to compare against yet. */
  readonly currentCents: number | null
  /** May exceed 10000 once the target is passed. `null` exactly when `currentCents` is. */
  readonly progressBp: number | null
  readonly met: boolean | null
}

/**
 * Resolves a `liquid`/`invested`/`total` goal's current figure off `netWorth` —
 * never a `category` one, which has no net-worth figure to read and is priced by
 * `goal-store.ts`'s pool split instead. Narrowed to exclude `'category'` so a
 * caller with one of those has to branch by kind first, rather than silently
 * falling through to `totalCents` the way the pre-#407-extension version did.
 */
export function currentCentsFor(
  goal: { kind: Exclude<Goal['kind'], 'category'> },
  netWorth: NetWorthSummary | null,
): number | null {
  if (netWorth === null) return null
  if (goal.kind === 'liquid') return netWorth.liquidCents
  if (goal.kind === 'invested') return netWorth.investedCents
  return netWorth.totalCents
}

export function computeGoalProgress(
  goal: Pick<Goal, 'id' | 'targetCents' | 'targetDate'>,
  currentCents: number | null,
): GoalProgress {
  return {
    goalId: goal.id,
    targetCents: goal.targetCents,
    targetDate: goal.targetDate,
    currentCents,
    progressBp:
      currentCents === null ? null : Math.round((currentCents / goal.targetCents) * 10_000),
    met: currentCents === null ? null : currentCents >= goal.targetCents,
  }
}

/**
 * How many trailing months a projection's rate is measured over — long enough to
 * smooth over one lump deposit or withdrawal, short enough that a household's recent
 * behaviour, not last year's, drives the ETA. The same order of magnitude as
 * `BASELINE_WINDOW_MONTHS`-style constants elsewhere in the aggregate layer.
 */
export const GOAL_TREND_WINDOW_MONTHS = 6

export interface GoalProjection {
  /** `null` with fewer than two monthly points of history to measure a rate from. */
  readonly monthlyRateCents: number | null
  /** `null` when the rate is unknown, non-positive, or the target is already passed. */
  readonly monthsToTarget: number | null
  readonly etaMonth: string | null
  /** How many of the trend's months actually had data — for the caveat line. */
  readonly months: number
  readonly from: string | null
  readonly to: string | null
}

/**
 * Resamples a (possibly sparse) daily net-worth series into the trailing
 * `GOAL_TREND_WINDOW_MONTHS + 1` month-end points `projectGoal` measures a rate
 * over. Only months that actually have a snapshot on or before their own end are
 * included, so a fresh install with two weeks of history returns fewer points
 * rather than inventing intermediate ones.
 */
export function monthlyGoalTrend(
  history: readonly { date: string; valueCents: number }[],
  asOfMonth: string,
  windowMonths: number = GOAL_TREND_WINDOW_MONTHS,
): { month: string; valueCents: number }[] {
  const months = monthRange(addMonths(asOfMonth, -windowMonths), asOfMonth)
  const points: { month: string; valueCents: number }[] = []
  for (const month of months) {
    const cutoff = endOfMonth(month)
    let latest: { date: string; valueCents: number } | undefined
    for (const entry of history) {
      if (entry.date > cutoff) break
      latest = entry
    }
    if (latest !== undefined) points.push({ month, valueCents: latest.valueCents })
  }
  return points
}

/**
 * Whether, at the trend's own pace, this goal reaches its target — and when.
 *
 * `trend` must be ascending by month; a gap is simply a shorter trend, not an error,
 * since `monthlyGoalTrend` only ever emits months it found data for.
 */
export function projectGoal(
  progress: GoalProgress,
  trend: readonly { month: string; valueCents: number }[],
  asOfMonth: string,
): GoalProjection {
  const from = trend[0]?.month ?? null
  const to = trend.at(-1)?.month ?? null

  if (progress.met === true) {
    return { monthlyRateCents: null, monthsToTarget: 0, etaMonth: asOfMonth, months: trend.length, from, to }
  }
  if (trend.length < 2) {
    return { monthlyRateCents: null, monthsToTarget: null, etaMonth: null, months: trend.length, from, to }
  }

  const first = trend[0] as { month: string; valueCents: number }
  const last = trend.at(-1) as { month: string; valueCents: number }
  const elapsedMonths = trend.length - 1
  const monthlyRateCents = Math.round((last.valueCents - first.valueCents) / elapsedMonths)

  // A non-positive rate is still reported — "losing ground" is worth saying — but
  // it cannot produce an ETA, and neither can a goal with no current figure yet.
  if (monthlyRateCents <= 0 || progress.currentCents === null) {
    return { monthlyRateCents, monthsToTarget: null, etaMonth: null, months: trend.length, from, to }
  }

  const remainingCents = progress.targetCents - progress.currentCents
  const monthsToTarget = Math.ceil(remainingCents / monthlyRateCents)
  return {
    monthlyRateCents,
    monthsToTarget,
    etaMonth: addMonths(asOfMonth, monthsToTarget),
    months: trend.length,
    from,
    to,
  }
}

/**
 * How many whole months until `targetDate`'s month, floored at 1 — "at least a
 * month's worth of urgency," so a goal due later this same month does not get an
 * outsized (divide-by-zero-adjacent) weight or requirement just for being close.
 */
function monthsRemaining(targetDate: string, asOfMonth: string): number {
  return Math.max(1, monthsBetween(asOfMonth, monthOf(targetDate)))
}

/**
 * `targetCents / monthsRemaining` — "the monthly amount needed starting from zero
 * today." The weight a shared category's pool is split by in `splitCategoryPool`,
 * proportional to urgency rather than to raw `targetCents`: a goal due sooner
 * needs more per month for the same size, and should draw a bigger share of a
 * pool it shares with a goal due later.
 */
export function goalUrgencyWeight(targetCents: number, targetDate: string, asOfMonth: string): number {
  return targetCents / monthsRemaining(targetDate, asOfMonth)
}

export interface CategoryPoolCandidate {
  readonly goalId: string
  readonly targetCents: number
  readonly targetDate: string
}

/**
 * Splits one category's pooled `availableCents` across every active goal
 * targeting it, proportional to urgency (`goalUrgencyWeight`), not raw size.
 *
 * Largest-remainder rounding: each candidate's exact share is floored, and the
 * cents lost to flooring are handed back one at a time, largest fractional part
 * first, ties broken by `goalId`. That keeps the shares summing to exactly
 * `poolCents` — including when it is negative, where an overspent envelope
 * dilutes every sharing goal by the same method, just in the other direction.
 */
export function splitCategoryPool(
  poolCents: number,
  candidates: readonly CategoryPoolCandidate[],
  asOfMonth: string,
): Map<string, number> {
  if (candidates.length === 0) return new Map()

  const weights = candidates.map((candidate) => ({
    goalId: candidate.goalId,
    weight: goalUrgencyWeight(candidate.targetCents, candidate.targetDate, asOfMonth),
  }))
  const totalWeight = weights.reduce((sum, entry) => sum + entry.weight, 0)

  const withFraction = weights.map(({ goalId, weight }) => {
    const raw = (poolCents * weight) / totalWeight
    const floor = Math.floor(raw)
    return { goalId, floor, fraction: raw - floor }
  })

  const shares = new Map<string, number>(withFraction.map(({ goalId, floor }) => [goalId, floor]))
  let remainder = poolCents - withFraction.reduce((sum, entry) => sum + entry.floor, 0)

  const byLargestFraction = [...withFraction].sort((a, b) => {
    if (a.fraction !== b.fraction) return b.fraction - a.fraction
    return a.goalId < b.goalId ? -1 : a.goalId > b.goalId ? 1 : 0
  })
  for (const entry of byLargestFraction) {
    if (remainder <= 0) break
    shares.set(entry.goalId, (shares.get(entry.goalId) ?? 0) + 1)
    remainder -= 1
  }

  return shares
}

/**
 * The monthly amount still needed to reach the target on time, from today's
 * balance — `remainingCents / monthsRemaining`, rounded up so the figure never
 * understates what saving "on schedule" requires. `null` with no target date or
 * no current figure yet (the same two gates `projectGoal` uses for an ETA); `0`
 * once the goal is met.
 */
export function requiredMonthlySavingsCents(progress: GoalProgress, asOfMonth: string): number | null {
  if (progress.targetDate === null || progress.currentCents === null) return null
  if (progress.met === true) return 0
  const remainingCents = progress.targetCents - progress.currentCents
  return Math.ceil(remainingCents / monthsRemaining(progress.targetDate, asOfMonth))
}

export const goalPaces = ['onTrack', 'atRisk', 'behind'] as const
export type GoalPace = (typeof goalPaces)[number]

/**
 * How the observed monthly rate compares to what is required — two constants,
 * easy to retune independently of everything else here.
 */
const PACE_ON_TRACK_BP = 10_000
const PACE_AT_RISK_BP = 6_000

/**
 * `observedMonthlyRateCents / requiredMonthlyCents` as a pace: at or above 100%
 * of the required rate is `onTrack`, 60–99% is `atRisk`, under 60% (including
 * negative, i.e. losing ground) is `behind`. `null` when either figure is
 * unknown. A `requiredMonthlyCents` of exactly `0` (the goal is already met)
 * reads as `onTrack` unconditionally — there is nothing left to keep pace with.
 */
export function computeGoalPace(
  requiredMonthlyCents: number | null,
  observedMonthlyRateCents: number | null,
): GoalPace | null {
  if (requiredMonthlyCents === null) return null
  if (requiredMonthlyCents <= 0) return 'onTrack'
  if (observedMonthlyRateCents === null) return null
  const rateBp = Math.round((observedMonthlyRateCents / requiredMonthlyCents) * 10_000)
  if (rateBp >= PACE_ON_TRACK_BP) return 'onTrack'
  if (rateBp >= PACE_AT_RISK_BP) return 'atRisk'
  return 'behind'
}

/**
 * True for every active goal. A done goal stays visible for `GOAL_DONE_GRACE_DAYS`
 * after `doneAt` — long enough to undo a wrong tick — and is invisible after that,
 * per #407's done→archive lifecycle. Settings' own archive list never calls this:
 * it shows every done goal forever, grace window or not (see `goal-store.ts`).
 */
export function isGoalVisible(goal: Pick<Goal, 'status' | 'doneAt'>, today: string): boolean {
  if (goal.status === 'active' || goal.doneAt === null) return true
  return daysBetween(goal.doneAt, today) <= GOAL_DONE_GRACE_DAYS
}

/**
 * True when this goal already existed as of `asOfMonth`. `isGoalVisible` answers a
 * present-tense lifecycle question ("is this goal currently archived") and is the
 * same regardless of which month is being narrated; this answers the orthogonal,
 * historical one — a goal created in June has no business appearing in a rejudge
 * of March, even though it is visible today. Only `goal-store.ts`'s AI-narrative
 * path can ever see `asOfMonth < today`'s month; Overview/Budget always pass the
 * current month, where this is true by construction.
 */
export function existedAsOf(goal: Pick<Goal, 'createdAt'>, asOfMonth: string): boolean {
  return monthOf(goal.createdAt) <= asOfMonth
}

