/**
 * Revolving debt — a credit card, a store card, an overdraft (#442).
 *
 * Split from #408 alongside #441's fixed-schedule loans, and deliberately not the same
 * shape as one. A car loan amortizes: a principal, a rate and a term determine the
 * balance on any future date, and `domain/loan/amortization.ts` is that arithmetic. A
 * credit card has none of that — there is no principal that was borrowed once, no term
 * after which it is paid off, and no schedule the balance follows. What changes it is a
 * statement and a payment, both of which happen outside Balancr entirely. Forcing that
 * into the amortization model would not simplify anything; it would fabricate a term and
 * a payoff date for debt that carries no promise of either.
 *
 * So this module carries far less than `domain/loan/vocabulary.ts` does: no anchor date,
 * no remaining term, no payoff projection. What the checklist actually asks for is a
 * balance, a minimum payment, and an optional APR for an *estimate* of what a month of
 * carrying that balance costs — not a forecast, not a payoff date. `estimatedMonthlyInterestCents`
 * below is exactly that estimate and nothing more.
 *
 * `debts.ts` next door adds the zod schema and the four functions that touch the
 * database, the same split `loans.ts` makes for the same reason.
 */

/**
 * What kind of revolving debt this is.
 *
 * Two entries, not a free-text field, for the same reason `loanKinds` isn't one: the
 * portfolio table groups and labels by this, and "Visa" typed three ways is three kinds.
 * `creditCard` covers the common case; `other` is the catch-all for a store card, a line
 * of credit, or an overdraft that carries a balance the same way.
 */
export const debtKinds = ['creditCard', 'other'] as const
export type DebtKind = (typeof debtKinds)[number]

/** A household carries a handful of revolving balances, not a portfolio of them. */
export const MAX_DEBTS = 20

/**
 * One revolving balance, as stored and as sent.
 *
 * No `anchorDate`, no `rateBp`-driven schedule, no term: unlike a loan's `principalCents`,
 * `balanceCents` is not amortized forward from a date on file — it is simply what is owed
 * right now, and it changes only when the owner updates it against a new statement. There
 * is no re-anchor concept here because there is nothing to re-anchor away from.
 */
export interface Debt {
  /** The row's own id — a real table, so the server assigns this, not the form. */
  id: string
  kind: DebtKind
  /** A short name the owner gave it, e.g. "Visa" or "Store card". Empty is fine. */
  label: string
  /** What is owed right now, as of the owner's last update — never amortized. */
  balanceCents: number
  /** The minimum payment the statement asks for. Not necessarily what is actually paid. */
  minimumPaymentCents: number
  /**
   * Annual percentage rate, basis points, or null when nobody has entered one. Used only
   * by `estimatedMonthlyInterestCents` below — nothing here projects a payoff date, because
   * a minimum payment against a revolving balance does not determine one the way a fixed
   * schedule's monthly payment does.
   */
  aprBp: number | null
}

/**
 * A rough estimate of what one month of carrying the current balance costs in interest,
 * or null when no APR is on file.
 *
 * Deliberately the simplest possible reading of "optional APR for interest-accrual
 * estimates": one month's interest on today's balance, not a projection of where the
 * balance goes next — a revolving balance can rise as easily as it falls, driven by
 * statements Balancr does not see, so projecting it forward would promise a number this
 * domain has no way to keep honest.
 */
export function estimatedMonthlyInterestCents(debt: Debt): number | null {
  if (debt.aprBp === null) return null
  const monthlyRate = debt.aprBp / 10_000 / 12
  return Math.round(debt.balanceCents * monthlyRate)
}

/** Summed outstanding balance across every revolving debt, 0 when there are none. */
export function totalDebtBalanceCents(debts: readonly Debt[]): number {
  return debts.reduce((sum, debt) => sum + debt.balanceCents, 0)
}

/** Summed minimum payment across every revolving debt, 0 when there are none. */
export function totalMinimumPaymentCents(debts: readonly Debt[]): number {
  return debts.reduce((sum, debt) => sum + debt.minimumPaymentCents, 0)
}
