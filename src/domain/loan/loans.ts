/**
 * The stored fixed-schedule loans: list, create, edit, delete (#441).
 *
 * The half of `domain/loan/` that reaches the database, for the reason
 * `property/properties.ts` gives about itself: a browser can import `vocabulary.ts` and
 * `amortization.ts`, and it cannot import Drizzle, the schema or the logger. The
 * arithmetic is over there; what is here is the zod schema and the four row operations.
 *
 * Row operations, not a load/save pair — unlike every settings singleton in this codebase,
 * and the reason is in `db/schema.ts` above the table. A loan has an identity that
 * outlives any one edit: created once, re-anchored against a statement for years, then
 * deleted. `saveLoans(everything)` would make editing one loan a rewrite of all of them,
 * which is how a concurrent edit is lost, and it would leave the audit trail naming the
 * whole list where it should name one loan.
 *
 * Tenant-scoped explicitly, per #376: every function takes `tenantId` and every statement
 * filters or sets it. Nothing here infers a tenant from a session, and an id belonging to
 * another tenant reads and writes as "no such loan" — `updateLoan` and `deleteLoan`
 * answer null/false rather than throwing, and the route turns that into a 404.
 *
 * There is no rate-history table, exactly as for mortgages: when the rate, payment or
 * remaining term changes, the owner re-enters today's real outstanding balance as the new
 * `anchorDate`/`principalCents`. A re-anchor, not an appended row.
 */
import { and, asc, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { loans } from '../../db/schema.ts'
import { loanKinds, MAX_LOANS, type Loan } from './vocabulary.ts'

export {
  amortizationOf,
  effectiveMonthlyPaymentCents,
  loanBalanceCents,
  loanKinds,
  loanPaidOffBp,
  loanPayoffDate,
  MAX_LOANS,
  totalLoanBalanceCents,
  totalMonthlyPaymentCents,
} from './vocabulary.ts'
export type { Loan, LoanKind } from './vocabulary.ts'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * One loan as it may be written.
 *
 * The bounds are the domain's, not the HTTP boundary's — 50% on a rate and 50 years on a
 * term, the same fat-finger ceilings `property/properties.ts` sets on a mortgage, and the
 * same division of labour: the Fastify-level schema in `routes/settings.ts` checks shapes,
 * this checks what the numbers may be, and the route turns a `ZodError` from here into a
 * 400 with the field named.
 *
 * `.strict()` so a misspelt field is refused rather than silently dropped, which on a form
 * would answer 200 with a payload that looks saved.
 */
export const loanInputSchema = z
  .object({
    kind: z.enum(loanKinds).default('personal'),
    label: z.string().max(80).default(''),
    openingDate: isoDate,
    principalCents: z.int().min(0),
    anchorDate: isoDate,
    /** Bounded at 50% as a sanity check on fat fingers. */
    rateBp: z.int().min(0).max(5_000),
    monthlyPaymentCents: z.int().min(0),
    /** Bounded at 50 years. */
    remainingTermMonths: z.int().min(0).max(600),
    /** What the loan started at, or null when nobody has entered it (#392). */
    originalPrincipalCents: z.int().min(0).nullable().default(null),
    /** A voluntary amount on top of the contractual payment, or null when there is none. */
    extraMonthlyPaymentCents: z.int().min(0).nullable().default(null),
  })
  .strict()

export type LoanInput = z.input<typeof loanInputSchema>

/**
 * Thrown when a create would push the tenant past `MAX_LOANS`.
 *
 * Its own error rather than a `ZodError`, because it is not a fact about the body: the
 * same request would have been fine one loan ago. The route answers 409 for it, which is
 * the status that says "the state, not the request, is what refuses this".
 */
export class TooManyLoansError extends Error {
  constructor() {
    super(`A tenant may track at most ${String(MAX_LOANS)} loans.`)
    this.name = 'TooManyLoansError'
  }
}

type LoanRow = typeof loans.$inferSelect

/**
 * A row as the domain and the wire see it.
 *
 * Drops `createdAt`/`updatedAt`: they are bookkeeping the audit log already answers
 * better, and putting a timestamp on the wire invites a client to sort by it and
 * disagree with `openingDate`, which is the date that actually orders a list of loans.
 *
 * The annotated return type is what keeps `loans.kind`'s column enum and `LoanKind`
 * agreeing — a kind added to one and not the other fails to compile here, which is the
 * check that lets `db/schema.ts` stay free of domain imports.
 */
const toLoan = (row: LoanRow): Loan => ({
  id: row.id,
  kind: row.kind,
  label: row.label,
  openingDate: row.openingDate,
  principalCents: row.principalCents,
  anchorDate: row.anchorDate,
  rateBp: row.rateBp,
  monthlyPaymentCents: row.monthlyPaymentCents,
  remainingTermMonths: row.remainingTermMonths,
  originalPrincipalCents: row.originalPrincipalCents,
  extraMonthlyPaymentCents: row.extraMonthlyPaymentCents,
})

/**
 * Every loan this tenant tracks, most recently taken out first.
 *
 * Ordered by `openingDate` rather than by creation: somebody entering three existing
 * loans in one sitting creates them seconds apart, and the order that means anything is
 * the order they were signed. `id` breaks the tie, so the list is stable across reads
 * rather than left to SQLite's discretion.
 */
export function listLoans(db: Db, tenantId: string): Loan[] {
  return db
    .select()
    .from(loans)
    .where(eq(loans.tenantId, tenantId))
    .orderBy(desc(loans.openingDate), asc(loans.id))
    .all()
    .map(toLoan)
}

/** One loan of this tenant's, or null — including when the id belongs to another tenant. */
export function loadLoan(db: Db, tenantId: string, id: string): Loan | null {
  const row = db
    .select()
    .from(loans)
    .where(and(eq(loans.id, id), eq(loans.tenantId, tenantId)))
    .get()
  return row === undefined ? null : toLoan(row)
}

export function createLoan(db: Db, tenantId: string, input: LoanInput): Loan {
  const next = loanInputSchema.parse(input)
  if (listLoans(db, tenantId).length >= MAX_LOANS) throw new TooManyLoansError()

  const created = db.insert(loans).values({ tenantId, ...next }).returning().all()[0]
  if (created === undefined) throw new Error('creating the loan returned no row')
  return toLoan(created)
}

/**
 * Replaces every field of one loan, or answers null when this tenant has no such loan.
 *
 * A whole-row replace rather than a partial merge: every field is on the form at once, so
 * "leave this one alone" is not a gesture the screen can make, and a merge would make an
 * omitted field ambiguous between "unchanged" and "cleared" for the two nullable ones.
 *
 * `updatedAt` is set explicitly — the column's default only fires on insert.
 */
export function updateLoan(
  db: Db,
  tenantId: string,
  id: string,
  input: LoanInput,
): Loan | null {
  const next = loanInputSchema.parse(input)

  const updated = db
    .update(loans)
    .set({ ...next, updatedAt: new Date() })
    .where(and(eq(loans.id, id), eq(loans.tenantId, tenantId)))
    .returning()
    .all()[0]
  return updated === undefined ? null : toLoan(updated)
}

/** True when a loan of this tenant's was deleted, false when there was none to delete. */
export function deleteLoan(db: Db, tenantId: string, id: string): boolean {
  const deleted = db
    .delete(loans)
    .where(and(eq(loans.id, id), eq(loans.tenantId, tenantId)))
    .returning()
    .all()
  return deleted.length > 0
}
