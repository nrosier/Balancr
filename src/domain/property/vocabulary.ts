/**
 * Property and mortgage arithmetic, in a module a browser can import (#227).
 *
 * Split out of `properties.ts` for the reason `advice/vocabulary.ts` gives: that file
 * reaches the database — it imports Drizzle, the schema, and the logger, because loading
 * or saving a property list is a `SELECT`/`INSERT`. The settings panel and the portfolio
 * card need the *arithmetic* — what a mortgage amortizes to, what a rental nets after its
 * payment — not the storage, so it lives here: no zod, no `node:` anything, nothing that
 * reads a row. `web/src/shared.ts` re-exports it, the same arrangement `domain/ai/codes.ts`
 * has with the finding vocabulary.
 */

export const propertyKinds = ['primary', 'rental', 'owned'] as const
export type PropertyKind = (typeof propertyKinds)[number]

/** A household owns a handful of properties, not a portfolio of them. */
export const MAX_PROPERTIES = 20

/** A primary mortgage, a second/HELOC, a renovation loan — not an open-ended ledger (#393). */
export const MAX_MORTGAGES_PER_PROPERTY = 3

export interface Mortgage {
  /** Outstanding balance as of `anchorDate` — the re-anchor point, not the original loan amount. */
  principalCents: number
  /** The date `principalCents` was true, `YYYY-MM-DD`. */
  anchorDate: string
  /** Annual interest rate, basis points, e.g. 350 = 3.50%. */
  rateBp: number
  monthlyPaymentCents: number
  /** Months remaining as of `anchorDate`. */
  remainingTermMonths: number
  /**
   * What the loan started at, or null when nobody has entered it (#392) — every mortgage
   * stored before this field existed, and any re-anchor since that didn't bother typing it
   * in. Kept separate from `principalCents` rather than inferred from the first row a
   * mortgage ever had, because there is no history table (see `properties.ts`): a re-anchor
   * overwrites `principalCents` in place, so nothing on disk remembers what the loan was
   * before the first statement anyone entered.
   */
  originalPrincipalCents: number | null
}

export interface Property {
  id: string
  kind: PropertyKind
  label: string
  /** Current estimated value, or null if not tracked. */
  propertyValueCents: number | null
  /** Monthly rent received. Only meaningful for a `rental`. */
  rentCents: number | null
  /** Empty when the property has no mortgage — paid off, or bought outright (#393). */
  mortgages: Mortgage[]
}

/**
 * Outstanding balance at `asOfDate` for one mortgage, amortizing forward from its
 * `anchorDate` one whole month at a time. A loop over integer cents rather than the
 * closed-form annuity formula: it's easier to reason about (and to test against a
 * hand-built table) than floating-point exponents, and it makes "floor at zero once the
 * term is exhausted" a natural stopping condition instead of a separate case.
 */
function amortizedBalanceCents(mortgage: Mortgage, asOfDate: string): number {
  const months = Math.max(0, monthsBetween(mortgage.anchorDate, asOfDate))
  const n = Math.min(months, mortgage.remainingTermMonths)
  const monthlyRate = mortgage.rateBp / 10_000 / 12

  let balance = mortgage.principalCents
  for (let i = 0; i < n && balance > 0; i++) {
    const interest = monthlyRate === 0 ? 0 : balance * monthlyRate
    balance = balance + interest - mortgage.monthlyPaymentCents
  }
  return Math.max(0, Math.round(balance))
}

/** Summed outstanding balance across every mortgage on the property, 0 if it has none. */
export function outstandingBalanceCents(mortgages: readonly Mortgage[], asOfDate: string): number {
  return mortgages.reduce((sum, mortgage) => sum + amortizedBalanceCents(mortgage, asOfDate), 0)
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
 * when there is nothing to compare the current balance against — no mortgage, or *any*
 * mortgage whose original amount nobody has entered (#392). Not a partial sum over the
 * mortgages that do have one: that would silently answer "how much of the debt I bothered
 * to record an original for is paid off" instead of the question the label asks.
 */
export function paidOffBp(mortgages: readonly Mortgage[], asOfDate: string): number | null {
  if (mortgages.length === 0) return null
  if (mortgages.some((m) => m.originalPrincipalCents === null || m.originalPrincipalCents === 0)) {
    return null
  }
  const outstanding = outstandingBalanceCents(mortgages, asOfDate)
  const original = mortgages.reduce((sum, m) => sum + (m.originalPrincipalCents ?? 0), 0)
  return Math.round((1 - outstanding / original) * 10_000)
}

/**
 * The earliest (most-stale) anchor date across a property's mortgages, or null when it has
 * none. The conservative choice when several mortgages disagree: the combined balance is
 * only as fresh as its stalest input (#393).
 */
export function earliestAnchorDate(mortgages: readonly Mortgage[]): string | null {
  if (mortgages.length === 0) return null
  return mortgages.map((m) => m.anchorDate).reduce((earliest, date) => (date < earliest ? date : earliest))
}

/** Equity at `asOfDate`, or null when the property's value isn't tracked. */
export function propertyEquityCents(property: Property, asOfDate: string): number | null {
  if (property.propertyValueCents === null) return null
  return property.propertyValueCents - outstandingBalanceCents(property.mortgages, asOfDate)
}

/**
 * Rent minus the mortgage payments it's funding, or null when the rent isn't tracked. Zero
 * for a property with no mortgage — the payment side of the subtraction is simply zero,
 * not "not applicable".
 */
export function netCashFlowCents(property: Property): number | null {
  if (property.rentCents === null) return null
  const payments = property.mortgages.reduce((sum, m) => sum + m.monthlyPaymentCents, 0)
  return property.rentCents - payments
}

/** Annualized rent over value, in basis points. Null unless both rent and value are tracked. */
export function grossYieldBp(property: Property): number | null {
  if (property.rentCents === null || property.propertyValueCents === null) return null
  if (property.propertyValueCents === 0) return null
  return Math.round((property.rentCents * 12 * 10_000) / property.propertyValueCents)
}

/** Summed equity across every property, or null when none of them track a value. */
export function totalEquityCents(properties: readonly Property[], asOfDate: string): number | null {
  const values = properties.map((property) => propertyEquityCents(property, asOfDate))
  const tracked = values.filter((value): value is number => value !== null)
  return tracked.length === 0 ? null : tracked.reduce((sum, value) => sum + value, 0)
}

function monthsBetween(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00Z`)
  const to = new Date(`${toDate}T00:00:00Z`)
  const months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth())
  return to.getUTCDate() < from.getUTCDate() ? months - 1 : months
}
