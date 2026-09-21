/**
 * Non-mortgage debt with a fixed schedule — a car loan, a personal loan (#441).
 *
 * Split from #408, which covered "debt Balancr doesn't track" as one item. It isn't one
 * item: a loan with a principal, a rate and a term is the same shape as a mortgage minus
 * the house, and revolving credit-card debt has no schedule at all and is tracked
 * separately. This module is the first half — the pure vocabulary, in a module a browser
 * can import, the same arrangement `property/vocabulary.ts` has with `properties.ts`. The
 * arithmetic itself is `amortization.ts`, shared with the mortgage domain; what is added
 * here is the loan *record* (kind, label, opening date, optional extra payment) and the
 * two derived figures that depend on it.
 *
 * `loans.ts` next door adds the zod schema and the four functions that touch the
 * database.
 */
import {
  amortizedBalanceCents,
  outstandingBalanceCents,
  paidOffBp,
  projectedPayoffDate,
  type AmortizedLoan,
} from './amortization.ts'

/**
 * What kind of loan this is.
 *
 * Two entries and not a free-text field, because the kind is what the portfolio table
 * groups and labels by, and "Car" typed three different ways is three kinds. A mortgage is
 * deliberately absent: a mortgage belongs to a property and is tracked there, with the
 * home value and the equity that only make sense beside it. Revolving credit is absent
 * for the opposite reason — it has no fixed schedule, so none of the arithmetic here
 * would mean anything for it (#442).
 */
export const loanKinds = ['car', 'personal'] as const
export type LoanKind = (typeof loanKinds)[number]

/** A household carries a handful of loans, not a portfolio of them — same cap as properties. */
export const MAX_LOANS = 20

/**
 * One fixed-schedule loan, as stored and as sent.
 *
 * The amortizing half of it is `AmortizedLoan`, field for field, so every function in
 * `amortization.ts` applies to a loan directly. What this adds is what a loan has and a
 * bare schedule does not: which kind it is, what the owner calls it, when it was taken
 * out, and whether anything voluntary is being paid on top.
 */
export interface Loan {
  /** The row's own id — a real table since #441, so the server assigns this, not the form. */
  id: string
  kind: LoanKind
  /** A short name the owner gave it, e.g. "Car" or "Kitchen". Empty is fine. */
  label: string
  /**
   * When the loan was taken out, `YYYY-MM-DD`.
   *
   * Never used to amortize — `anchorDate` is what the balance is measured from, and the
   * two differ the moment anybody re-anchors from a statement. It's kept because it's the
   * one date that doesn't move: "how long have I been paying this" has no other answer,
   * and a list of loans reads in the order they were taken on.
   */
  openingDate: string
  /** Outstanding balance as of `anchorDate`. See `AmortizedLoan`. */
  principalCents: number
  anchorDate: string
  rateBp: number
  /** The contractual payment, without any voluntary extra. */
  monthlyPaymentCents: number
  remainingTermMonths: number
  originalPrincipalCents: number | null
  /**
   * A voluntary amount paid on top of `monthlyPaymentCents` every month, or null when
   * nothing is (#441's "optional extra payments").
   *
   * One number, not a ledger of one-off overpayments. A ledger is the honest model of
   * "I paid €2 000 off in March", and it is also a table, a form and a set of routes for
   * something this domain has no current reader for — while "I pay €100 extra every
   * month" is the case that actually changes a payoff date, and it is a field. Folded
   * into the effective payment by `amortizationOf` below, so every balance, payoff date
   * and paid-off share already accounts for it rather than each caller remembering to.
   */
  extraMonthlyPaymentCents: number | null
}

/**
 * The loan as the shared amortization sees it: the contractual payment plus whatever
 * extra is being paid every month.
 *
 * One place folds the extra in, so a payoff projection cannot disagree with the balance
 * shown next to it — which is exactly what two call sites each remembering to add it
 * would eventually produce.
 */
export function amortizationOf(loan: Loan): AmortizedLoan {
  return {
    principalCents: loan.principalCents,
    anchorDate: loan.anchorDate,
    rateBp: loan.rateBp,
    monthlyPaymentCents: loan.monthlyPaymentCents + (loan.extraMonthlyPaymentCents ?? 0),
    remainingTermMonths: loan.remainingTermMonths,
    originalPrincipalCents: loan.originalPrincipalCents,
  }
}

/** What one loan still owes at `asOfDate`, extra payments and all. */
export function loanBalanceCents(loan: Loan, asOfDate: string): number {
  return amortizedBalanceCents(amortizationOf(loan), asOfDate)
}

/**
 * Summed outstanding balance across every fixed-schedule loan, 0 when there are none.
 *
 * This is the figure the overview and portfolio routes *subtract* from net worth, which
 * is why it's a positive number here and negated at the call site: a balance of zero and
 * a household with no loans are the same subtraction, and neither should make the total
 * ambiguous.
 */
export function totalLoanBalanceCents(loans: readonly Loan[], asOfDate: string): number {
  return outstandingBalanceCents(loans.map(amortizationOf), asOfDate)
}

/** Share of one loan's original amount paid off, or null when nobody entered one (#392). */
export function loanPaidOffBp(loan: Loan, asOfDate: string): number | null {
  return paidOffBp([amortizationOf(loan)], asOfDate)
}

/** When the schedule clears this loan, or null when it doesn't — see `monthsToPayoff`. */
export function loanPayoffDate(loan: Loan): string | null {
  return projectedPayoffDate(amortizationOf(loan))
}

/** What is paid every month, including any voluntary extra. */
export function effectiveMonthlyPaymentCents(loan: Loan): number {
  return loan.monthlyPaymentCents + (loan.extraMonthlyPaymentCents ?? 0)
}

/** Summed monthly outgoing across every loan — what the debt costs each month. */
export function totalMonthlyPaymentCents(loans: readonly Loan[]): number {
  return loans.reduce((sum, loan) => sum + effectiveMonthlyPaymentCents(loan), 0)
}
