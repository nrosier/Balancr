/**
 * Fixed-schedule loan arithmetic, shared by every kind of loan Balancr tracks (#441).
 *
 * Extracted from `domain/property/vocabulary.ts`, where it lived typed against
 * `Mortgage` — not because the arithmetic ever needed a house, but because a mortgage
 * was the only fixed-schedule loan in the codebase. Nothing in here reads a home value,
 * a rent or an equity share: a balance amortizes from a principal, a rate, a payment and
 * a remaining term, and that is the whole input. A car loan and a personal loan are the
 * same shape minus the property, so #441 parameterized the shape rather than writing a
 * second amortization loop that would have to be kept agreeing with the first.
 *
 * Pure, like the vocabulary module it came out of: no zod, no `node:` anything, nothing
 * that reads a row, so `web/src/shared.ts` can re-export it and the settings panels can
 * show what a figure reads as before it is saved.
 */

/**
 * The part of any loan that amortizes: what is owed, when that was true, and the
 * schedule that pays it down.
 *
 * A structural contract rather than a base class, so `Mortgage` and `Loan` are both
 * *this* without either having to know about the other. Every field is documented here
 * because this is where the meaning is decided; the two aliases only name it.
 */
export interface AmortizedLoan {
  /** Outstanding balance as of `anchorDate` — the re-anchor point, not the original loan amount. */
  principalCents: number
  /** The date `principalCents` was true, `YYYY-MM-DD`. */
  anchorDate: string
  /** Annual interest rate, basis points, e.g. 350 = 3.50%. */
  rateBp: number
  /** What is paid every month. Includes any voluntary extra — see `Loan.extraMonthlyPaymentCents`. */
  monthlyPaymentCents: number
  /** Months remaining as of `anchorDate`. */
  remainingTermMonths: number
  /**
   * What the loan started at, or null when nobody has entered it (#392) — every loan
   * stored before this field existed, and any re-anchor since that didn't bother typing
   * it in. Kept separate from `principalCents` rather than inferred from the first row a
   * loan ever had, because there is no history table: a re-anchor overwrites
   * `principalCents` in place, so nothing on disk remembers what the loan was before the
   * first statement anyone entered.
   */
  originalPrincipalCents: number | null
}

/**
 * Outstanding balance at `asOfDate` for one loan, amortizing forward from its
 * `anchorDate` one whole month at a time. A loop over integer cents rather than the
 * closed-form annuity formula: it's easier to reason about (and to test against a
 * hand-built table) than floating-point exponents, and it makes "floor at zero once the
 * term is exhausted" a natural stopping condition instead of a separate case.
 */
export function amortizedBalanceCents(loan: AmortizedLoan, asOfDate: string): number {
  const months = Math.max(0, monthsBetween(loan.anchorDate, asOfDate))
  const n = Math.min(months, loan.remainingTermMonths)
  const monthlyRate = loan.rateBp / 10_000 / 12

  let balance = loan.principalCents
  for (let i = 0; i < n && balance > 0; i++) {
    const interest = monthlyRate === 0 ? 0 : balance * monthlyRate
    balance = balance + interest - loan.monthlyPaymentCents
  }
  return Math.max(0, Math.round(balance))
}

/** Summed outstanding balance across every loan given, 0 for an empty list. */
export function outstandingBalanceCents(
  loans: readonly AmortizedLoan[],
  asOfDate: string,
): number {
  return loans.reduce((sum, loan) => sum + amortizedBalanceCents(loan, asOfDate), 0)
}

/**
 * The standard annuity payment for a principal/rate/term — offered by the settings panel
 * as a suggestion when the owner hasn't entered a payment, never applied on their behalf.
 */
export function standardMonthlyPaymentCents(
  principalCents: number,
  rateBp: number,
  termMonths: number,
): number {
  if (termMonths <= 0) return 0
  const monthlyRate = rateBp / 10_000 / 12
  if (monthlyRate === 0) return Math.round(principalCents / termMonths)

  const factor = Math.pow(1 + monthlyRate, termMonths)
  return Math.round((principalCents * monthlyRate * factor) / (factor - 1))
}

/**
 * Combined share of the original loan(s) paid off by `asOfDate`, in basis points, or null
 * when there is nothing to compare the current balance against — no loan, or *any* loan
 * whose original amount nobody has entered (#392). Not a partial sum over the loans that
 * do have one: that would silently answer "how much of the debt I bothered to record an
 * original for is paid off" instead of the question the label asks.
 */
export function paidOffBp(loans: readonly AmortizedLoan[], asOfDate: string): number | null {
  if (loans.length === 0) return null
  if (loans.some((l) => l.originalPrincipalCents === null || l.originalPrincipalCents === 0)) {
    return null
  }
  const outstanding = outstandingBalanceCents(loans, asOfDate)
  const original = loans.reduce((sum, l) => sum + (l.originalPrincipalCents ?? 0), 0)
  return Math.round((1 - outstanding / original) * 10_000)
}

/**
 * The earliest (most-stale) anchor date across a set of loans, or null when there are
 * none. The conservative choice when several loans disagree: the combined balance is only
 * as fresh as its stalest input (#393).
 */
export function earliestAnchorDate(loans: readonly AmortizedLoan[]): string | null {
  if (loans.length === 0) return null
  return loans.map((l) => l.anchorDate).reduce((earliest, date) => (date < earliest ? date : earliest))
}

/**
 * How many months after `anchorDate` the schedule clears the balance, or null when it
 * never does within the remaining term (#441).
 *
 * Null covers two real cases and deliberately does not distinguish them, because the
 * honest answer to both is "this schedule does not pay this loan off": a payment smaller
 * than the monthly interest, where the balance grows, and a term that runs out with
 * something still owed — a balloon, or a payment that was mistyped. Either way the page
 * must not print a date.
 *
 * The same loop as `amortizedBalanceCents`, stopped on the balance rather than on a
 * date — one implementation of "interest, then payment", so a payoff date can never
 * disagree with the balance shown beside it.
 */
export function monthsToPayoff(loan: AmortizedLoan): number | null {
  const monthlyRate = loan.rateBp / 10_000 / 12

  let balance = loan.principalCents
  if (balance <= 0) return 0
  for (let month = 1; month <= loan.remainingTermMonths; month++) {
    const interest = monthlyRate === 0 ? 0 : balance * monthlyRate
    balance = balance + interest - loan.monthlyPaymentCents
    if (balance <= 0) return month
  }
  return null
}

/**
 * The date the schedule clears the balance, `YYYY-MM-DD`, or null when it doesn't — see
 * `monthsToPayoff`. Calendar months from the anchor, matching how the balance itself is
 * amortized: the day of the month is kept, and a day that doesn't exist in the target
 * month (the 31st of a 30-day month) lands on that month's last day rather than rolling
 * into the next one, which would report a payoff a month later than the schedule's.
 */
export function projectedPayoffDate(loan: AmortizedLoan): string | null {
  const months = monthsToPayoff(loan)
  if (months === null) return null
  return addMonths(loan.anchorDate, months)
}

/**
 * `fromDate` plus `months` whole calendar months, clamped to the target month's last day.
 *
 * Its own function rather than `new Date(y, m + n, d)` because that constructor rolls a
 * 31st into the next month, which is the bug this clamps: a loan anchored on the 31st
 * would otherwise be reported as paying off in the month after the one it does.
 */
export function addMonths(fromDate: string, months: number): string {
  const from = new Date(`${fromDate}T00:00:00Z`)
  const year = from.getUTCFullYear()
  const month = from.getUTCMonth() + months
  const day = from.getUTCDate()
  // Day 0 of the following month is the last day of the target month.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const target = new Date(Date.UTC(year, month, Math.min(day, lastDay)))
  return target.toISOString().slice(0, 10)
}

/**
 * Whole calendar months between two `YYYY-MM-DD` dates, counting only months that have
 * fully elapsed — the 15th to the 14th of the next month is zero months, not one.
 */
export function monthsBetween(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00Z`)
  const to = new Date(`${toDate}T00:00:00Z`)
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  return to.getUTCDate() < from.getUTCDate() ? months - 1 : months
}
