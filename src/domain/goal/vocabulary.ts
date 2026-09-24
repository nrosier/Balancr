/**
 * A household-stated savings goal (#407): pure, no DB — importable by the browser,
 * the same split `domain/loan/vocabulary.ts` uses.
 *
 * A goal names a target amount and, optionally, a target date, and is measured
 * against one of Balancr's own already-computed figures: one of `NetWorthSummary`'s
 * (`liquid`/`invested`/`total`), or — for a `category` goal — a shared Actual Budget
 * envelope's own rolling balance, split proportionally across every other active
 * goal targeting the same envelope. Deliberately no `currentCents` here: "how close
 * is it" is always read fresh, never a value stored on the goal itself. See
 * `domain/aggregate/goals.ts` for the pure arithmetic and `domain/aggregate/goal-store.ts`
 * for the DB-touching orchestration a `category` goal's pool split needs.
 */

export const goalKinds = ['liquid', 'invested', 'total', 'category'] as const
export type GoalKind = (typeof goalKinds)[number]

export const goalPriorities = ['high', 'normal', 'low'] as const
export type GoalPriority = (typeof goalPriorities)[number]

export const goalStatuses = ['active', 'done'] as const
export type GoalStatus = (typeof goalStatuses)[number]

/**
 * How many days after being marked done a goal still shows on Overview/Budget and
 * counts against its category's shared pool — long enough to undo a wrong tick,
 * short enough that "done" still means something. See `isGoalVisible`.
 */
export const GOAL_DONE_GRACE_DAYS = 7

/** A fat-finger ceiling, the same reason `MAX_LOANS`/`MAX_DEBTS` have one. */
export const MAX_GOALS = 10

export interface Goal {
  id: string
  label: string
  kind: GoalKind
  priority: GoalPriority
  /** Actual's own category id — set iff `kind === 'category'`, null otherwise. */
  categoryId: string | null
  targetCents: number
  /**
   * YYYY-MM-DD, or null — "track progress with no ETA" is a supported goal, except
   * for a `category` goal, which requires one: a shared envelope's pool split is
   * proportional to urgency, and urgency needs a date to be measured against.
   */
  targetDate: string | null
  status: GoalStatus
  /** YYYY-MM-DD, set iff `status === 'done'` — anchors the undo grace window. */
  doneAt: string | null
}
