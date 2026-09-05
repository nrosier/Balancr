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

export const propertyKinds = ['primary', 'rental'] as const
export type PropertyKind = (typeof propertyKinds)[number]

/** A household owns a handful of properties, not a portfolio of them. */
export const MAX_PROPERTIES = 20

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
}

export interface Property {
  id: string
  kind: PropertyKind
  label: string
  /** Current estimated value, or null if not tracked. */
  propertyValueCents: number | null
  /** Monthly rent received. Only meaningful for a `rental`. */
  rentCents: number | null
  /** Null when the property has no mortgage — paid off, or bought outright. */
  mortgage: Mortgage | null
}

/**
 * Outstanding balance at `asOfDate`, amortizing forward from the mortgage's `anchorDate`
 * one whole month at a time. A loop over integer cents rather than the closed-form
 * annuity formula: it's easier to reason about (and to test against a hand-built table)
 * than floating-point exponents, and it makes "floor at zero once the term is exhausted"
 * a natural stopping condition instead of a separate case.
 */
export function outstandingBalanceCents(mortgage: Mortgage | null, asOfDate: string): number {
  if (mortgage === null) return 0

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

/** Equity at `asOfDate`, or null when the property's value isn't tracked. */
export function propertyEquityCents(property: Property, asOfDate: string): number | null {
  if (property.propertyValueCents === null) return null
  return property.propertyValueCents - outstandingBalanceCents(property.mortgage, asOfDate)
}

/**
 * Rent minus the mortgage payment it's funding, or null when the rent isn't tracked. Zero
 * for a property with no mortgage — the payment side of the subtraction is simply zero,
 * not "not applicable".
 */
export function netCashFlowCents(property: Property): number | null {
  if (property.rentCents === null) return null
  return property.rentCents - (property.mortgage?.monthlyPaymentCents ?? 0)
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
