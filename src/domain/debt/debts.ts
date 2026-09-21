/**
 * The stored revolving debts: list, create, edit, delete (#442).
 *
 * The half of `domain/debt/` that reaches the database, for the reason `loans.ts` gives
 * about itself: a browser can import `vocabulary.ts`, and it cannot import Drizzle, the
 * schema or the logger.
 *
 * Row operations, not a load/save pair, for the same reason `loans.ts` is: a revolving
 * debt has an identity that outlives any one edit — created once, its balance kept
 * current against statements for years, then deleted (paid off, or closed). A
 * `saveDebts(everything)` would make editing one debt a rewrite of every other one.
 *
 * Tenant-scoped explicitly, per #376: every function takes `tenantId` and every
 * statement filters or sets it. An id belonging to another tenant reads and writes as
 * "no such debt" — `updateDebt` and `deleteDebt` answer null/false rather than throwing,
 * and the route turns that into a 404.
 *
 * There is no history table, exactly as for loans: the owner updates `balanceCents`
 * directly against a new statement, and the audit log is what remembers what it said
 * before.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { revolvingDebts } from '../../db/schema.ts'
import { debtKinds, MAX_DEBTS, type Debt } from './vocabulary.ts'

export {
  debtKinds,
  estimatedMonthlyInterestCents,
  MAX_DEBTS,
  totalDebtBalanceCents,
  totalMinimumPaymentCents,
} from './vocabulary.ts'
export type { Debt, DebtKind } from './vocabulary.ts'

/**
 * One debt as it may be written.
 *
 * The bounds are the domain's, not the HTTP boundary's — same division `loanInputSchema`
 * explains: the Fastify-level schema in `routes/settings.ts` checks shapes, this checks
 * what the numbers may be, and the route turns a `ZodError` from here into a 400 with the
 * field named. The rate ceiling is looser than a loan's: revolving credit routinely runs
 * well above a mortgage or car loan's rate, so 100% is the fat-finger ceiling here rather
 * than 50%.
 *
 * `.strict()` so a misspelt field is refused rather than silently dropped.
 */
export const debtInputSchema = z
  .object({
    kind: z.enum(debtKinds).default('creditCard'),
    label: z.string().max(80).default(''),
    balanceCents: z.int().min(0),
    minimumPaymentCents: z.int().min(0),
    /** Bounded at 100% as a sanity check on fat fingers. */
    aprBp: z.int().min(0).max(10_000).nullable().default(null),
  })
  .strict()

export type DebtInput = z.input<typeof debtInputSchema>

/**
 * Thrown when a create would push the tenant past `MAX_DEBTS`.
 *
 * Its own error rather than a `ZodError` — see `TooManyLoansError`'s own doc comment for
 * why: it is not a fact about the body, and the route answers 409 for it rather than 400.
 */
export class TooManyDebtsError extends Error {
  constructor() {
    super(`A tenant may track at most ${String(MAX_DEBTS)} revolving debts.`)
    this.name = 'TooManyDebtsError'
  }
}

type DebtRow = typeof revolvingDebts.$inferSelect

/**
 * A row as the domain and the wire see it. Drops `createdAt`/`updatedAt` — bookkeeping
 * the audit log already answers better, same reasoning as `toLoan`.
 */
const toDebt = (row: DebtRow): Debt => ({
  id: row.id,
  kind: row.kind,
  label: row.label,
  balanceCents: row.balanceCents,
  minimumPaymentCents: row.minimumPaymentCents,
  aprBp: row.aprBp,
})

/**
 * Every revolving debt this tenant tracks, most recently added first.
 *
 * Ordered by `createdAt` rather than by any date on the row itself — unlike a loan there
 * is no `openingDate` to order by, a credit card was not "taken out" on a day worth
 * remembering the way a loan was. Ties on `createdAt` break on `rowid` rather than `id`
 * (a random UUID, so no relation to insertion order) — see `recentRuns`'s own doc comment
 * on the same trap: two debts created synchronously, as a fast test does, can share the
 * same millisecond.
 */
export function listDebts(db: Db, tenantId: string): Debt[] {
  return db
    .select()
    .from(revolvingDebts)
    .where(eq(revolvingDebts.tenantId, tenantId))
    .orderBy(desc(revolvingDebts.createdAt), desc(sql`rowid`))
    .all()
    .map(toDebt)
}

/** One debt of this tenant's, or null — including when the id belongs to another tenant. */
export function loadDebt(db: Db, tenantId: string, id: string): Debt | null {
  const row = db
    .select()
    .from(revolvingDebts)
    .where(and(eq(revolvingDebts.id, id), eq(revolvingDebts.tenantId, tenantId)))
    .get()
  return row === undefined ? null : toDebt(row)
}

export function createDebt(db: Db, tenantId: string, input: DebtInput): Debt {
  const next = debtInputSchema.parse(input)
  if (listDebts(db, tenantId).length >= MAX_DEBTS) throw new TooManyDebtsError()

  const created = db.insert(revolvingDebts).values({ tenantId, ...next }).returning().all()[0]
  if (created === undefined) throw new Error('creating the debt returned no row')
  return toDebt(created)
}

/**
 * Replaces every field of one debt, or answers null when this tenant has no such debt.
 *
 * A whole-row replace rather than a partial merge, same reasoning as `updateLoan`: every
 * field is on the form at once, so a merge would leave an omitted `aprBp` ambiguous
 * between "unchanged" and "cleared".
 *
 * `updatedAt` is set explicitly — the column's default only fires on insert.
 */
export function updateDebt(
  db: Db,
  tenantId: string,
  id: string,
  input: DebtInput,
): Debt | null {
  const next = debtInputSchema.parse(input)

  const updated = db
    .update(revolvingDebts)
    .set({ ...next, updatedAt: new Date() })
    .where(and(eq(revolvingDebts.id, id), eq(revolvingDebts.tenantId, tenantId)))
    .returning()
    .all()[0]
  return updated === undefined ? null : toDebt(updated)
}

/** True when a debt of this tenant's was deleted, false when there was none to delete. */
export function deleteDebt(db: Db, tenantId: string, id: string): boolean {
  const deleted = db
    .delete(revolvingDebts)
    .where(and(eq(revolvingDebts.id, id), eq(revolvingDebts.tenantId, tenantId)))
    .returning()
    .all()
  return deleted.length > 0
}
