/**
 * The stored savings goals: list, create, edit, delete (#407).
 *
 * The half of `domain/goal/` that reaches the database, for the reason
 * `loan/loans.ts` gives about itself: a browser can import `vocabulary.ts` and
 * `domain/aggregate/goals.ts`'s pure progress/projection functions, and it cannot
 * import Drizzle, the schema or the logger. The arithmetic is over there; what is
 * here is the zod schema and the row operations.
 *
 * Row operations, not a load/save pair, and tenant-scoped explicitly per #376 — the
 * same shape and the same reasoning as `loan/loans.ts`. An id belonging to another
 * tenant reads and writes as "no such goal"; `updateGoal`/`deleteGoal`/`markGoalDone`/
 * `reactivateGoal` answer null/false rather than throwing, and the route turns that
 * into a 404.
 *
 * `markGoalDone`/`reactivateGoal` are their own functions rather than folded into
 * `updateGoal`: `updateGoal` is whole-row-replace by design (see its own doc comment),
 * and ticking a goal done is an immediate action like `deleteGoal`, not a draft edit
 * going through that replace.
 */
import { and, asc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { categoryMeta, goals } from '../../db/schema.ts'
import { goalKinds, goalPriorities, MAX_GOALS, type Goal } from './vocabulary.ts'

export { goalKinds, goalPriorities, goalStatuses, GOAL_DONE_GRACE_DAYS, MAX_GOALS } from './vocabulary.ts'
export type { Goal, GoalKind, GoalPriority, GoalStatus } from './vocabulary.ts'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * One goal as it may be written.
 *
 * `.strict()` so a misspelt field is refused rather than silently dropped, which on
 * a form would answer 200 with a payload that looks saved — the same reasoning as
 * `loan/loans.ts`'s `loanInputSchema`.
 *
 * `status`/`doneAt` are deliberately part of this schema, not left out of it: a
 * whole-row replace has to state every column, and `createGoal`/`updateGoal` always
 * write `active`/`null` for them — see `markGoalDone`/`reactivateGoal` for the only
 * two functions allowed to change them.
 *
 * The three `.refine()`s enforce what the columns alone cannot: a `category` goal
 * names a category and a target date, and only one of `status`/`doneAt` is ever set
 * without the other.
 */
export const goalInputSchema = z
  .object({
    label: z.string().max(80).default(''),
    kind: z.enum(goalKinds).default('liquid'),
    /** Actual's own category id — set iff `kind === 'category'`. */
    categoryId: z.string().min(1).nullable().default(null),
    priority: z.enum(goalPriorities).default('normal'),
    targetCents: z.int().min(1),
    /** null means "track progress with no ETA" — a supported goal, not an omission. */
    targetDate: isoDate.nullable().default(null),
    status: z.enum(['active', 'done']).default('active'),
    doneAt: isoDate.nullable().default(null),
  })
  .strict()
  .refine((value) => (value.kind === 'category') === (value.categoryId !== null), {
    message: 'categoryId is required for, and only for, a category-kind goal',
    path: ['categoryId'],
  })
  .refine((value) => value.kind !== 'category' || value.targetDate !== null, {
    message: 'a category-kind goal requires a target date',
    path: ['targetDate'],
  })
  .refine((value) => (value.status === 'done') === (value.doneAt !== null), {
    message: 'doneAt is required for, and only for, a done goal',
    path: ['doneAt'],
  })

export type GoalInput = z.input<typeof goalInputSchema>

/**
 * Thrown when a create would push the tenant past `MAX_GOALS`.
 *
 * Its own error rather than a `ZodError`, because it is not a fact about the body:
 * the same request would have been fine one goal ago. The route answers 409 for it.
 */
export class TooManyGoalsError extends Error {
  constructor() {
    super(`A tenant may track at most ${String(MAX_GOALS)} goals.`)
    this.name = 'TooManyGoalsError'
  }
}

/**
 * Thrown when a `category`-kind goal's `categoryId` names no category this tenant
 * has ever seen. Its own error rather than a `ZodError`, for the same reason
 * `TooManyGoalsError` is: it is not a fact the shape of the body can tell, and a
 * stale or bogus id would otherwise produce a goal that can never resolve a name
 * or a balance. The route maps it to 400, same as a `ZodError`.
 */
export class UnknownCategoryError extends Error {
  constructor(categoryId: string) {
    super(`No category ${categoryId} is known for this tenant.`)
    this.name = 'UnknownCategoryError'
  }
}

/** Throws `UnknownCategoryError` when `categoryId` is set but unrecognised. */
function assertKnownCategory(db: Db, tenantId: string, categoryId: string | null): void {
  if (categoryId === null) return
  const row = db
    .select({ categoryId: categoryMeta.categoryId })
    .from(categoryMeta)
    .where(and(eq(categoryMeta.tenantId, tenantId), eq(categoryMeta.categoryId, categoryId)))
    .get()
  if (row === undefined) throw new UnknownCategoryError(categoryId)
}

type GoalRow = typeof goals.$inferSelect

const toGoal = (row: GoalRow): Goal => ({
  id: row.id,
  label: row.label,
  kind: row.kind,
  categoryId: row.categoryId,
  priority: row.priority,
  targetCents: row.targetCents,
  targetDate: row.targetDate,
  status: row.status,
  doneAt: row.doneAt,
})

/**
 * A `CASE` over `priority` rather than a second stored "sort order" column: the
 * three priorities are the whole ordering, and a household re-ranking a goal edits
 * `priority` on the form it already sees, not a rank nobody else's row would shift.
 */
const priorityRank = sql`case ${goals.priority} when 'high' then 0 when 'normal' then 1 else 2 end`

/**
 * Every goal this tenant tracks: highest priority first, then soonest target date,
 * nulls (no target date) last, `id` breaking any remaining tie so the list is
 * stable across reads rather than left to SQLite's discretion.
 */
export function listGoals(db: Db, tenantId: string): Goal[] {
  return db
    .select()
    .from(goals)
    .where(eq(goals.tenantId, tenantId))
    .orderBy(
      priorityRank,
      sql`${goals.targetDate} is null`,
      asc(goals.targetDate),
      asc(goals.id),
    )
    .all()
    .map(toGoal)
}

/** One goal of this tenant's, or null — including when the id belongs to another tenant. */
export function loadGoal(db: Db, tenantId: string, id: string): Goal | null {
  const row = db
    .select()
    .from(goals)
    .where(and(eq(goals.id, id), eq(goals.tenantId, tenantId)))
    .get()
  return row === undefined ? null : toGoal(row)
}

export function createGoal(db: Db, tenantId: string, input: GoalInput): Goal {
  const next = goalInputSchema.parse(input)
  if (listGoals(db, tenantId).length >= MAX_GOALS) throw new TooManyGoalsError()
  assertKnownCategory(db, tenantId, next.categoryId)

  const created = db.insert(goals).values({ tenantId, ...next }).returning().all()[0]
  if (created === undefined) throw new Error('creating the goal returned no row')
  return toGoal(created)
}

/**
 * Replaces every field of one goal, or answers null when this tenant has no such
 * goal. A whole-row replace rather than a partial merge, the same reasoning as
 * `loan/loans.ts`'s `updateLoan`: an omitted `targetDate` would otherwise be
 * ambiguous between "unchanged" and "cleared".
 */
export function updateGoal(db: Db, tenantId: string, id: string, input: GoalInput): Goal | null {
  const next = goalInputSchema.parse(input)
  assertKnownCategory(db, tenantId, next.categoryId)

  const updated = db
    .update(goals)
    .set({ ...next, updatedAt: new Date() })
    .where(and(eq(goals.id, id), eq(goals.tenantId, tenantId)))
    .returning()
    .all()[0]
  return updated === undefined ? null : toGoal(updated)
}

/**
 * Marks one goal done, or answers null when this tenant has no such goal — a
 * manual, immediate action like `deleteGoal`, not a draft edit through
 * `updateGoal`'s whole-row replace.
 */
export function markGoalDone(db: Db, tenantId: string, id: string): Goal | null {
  const doneAt = new Date().toISOString().slice(0, 10)
  const updated = db
    .update(goals)
    .set({ status: 'done', doneAt, updatedAt: new Date() })
    .where(and(eq(goals.id, id), eq(goals.tenantId, tenantId)))
    .returning()
    .all()[0]
  return updated === undefined ? null : toGoal(updated)
}

/**
 * Reactivates one done goal, or answers null when this tenant has no such goal —
 * the undo side of `markGoalDone`, available at any time, not only within the
 * grace window (`isGoalVisible` only governs whether an already-done goal keeps
 * showing on Overview/Budget, not whether it can be reactivated).
 */
export function reactivateGoal(db: Db, tenantId: string, id: string): Goal | null {
  const updated = db
    .update(goals)
    .set({ status: 'active', doneAt: null, updatedAt: new Date() })
    .where(and(eq(goals.id, id), eq(goals.tenantId, tenantId)))
    .returning()
    .all()[0]
  return updated === undefined ? null : toGoal(updated)
}

/** True when a goal of this tenant's was deleted, false when there was none to delete. */
export function deleteGoal(db: Db, tenantId: string, id: string): boolean {
  const deleted = db
    .delete(goals)
    .where(and(eq(goals.id, id), eq(goals.tenantId, tenantId)))
    .returning()
    .all()
  return deleted.length > 0
}
