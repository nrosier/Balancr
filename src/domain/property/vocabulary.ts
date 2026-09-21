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
 *
 * The amortization half of it now lives in `domain/loan/amortization.ts` (#441) and is
 * re-exported below unchanged. None of that arithmetic ever touched a home value, a rent
 * or an equity share — a balance amortizes from a principal, a rate, a payment and a
 * term — so a car or a personal loan needed the same functions, and the choice was
 * parameterizing the loan shape or maintaining a second copy of the same loop. What
 * stays here is everything that is genuinely about a *property*: equity against a value,
 * rent against a payment, yield against both.
 */
import { outstandingBalanceCents, type AmortizedLoan } from '../loan/amortization.ts'

export {
  amortizedBalanceCents,
  earliestAnchorDate,
  monthsToPayoff,
  outstandingBalanceCents,
  paidOffBp,
  projectedPayoffDate,
  standardMonthlyPaymentCents,
} from '../loan/amortization.ts'
export type { AmortizedLoan } from '../loan/amortization.ts'

export const propertyKinds = ['primary', 'rental', 'owned'] as const
export type PropertyKind = (typeof propertyKinds)[number]

/** A household owns a handful of properties, not a portfolio of them. */
export const MAX_PROPERTIES = 20

/** A primary mortgage, a second/HELOC, a renovation loan — not an open-ended ledger (#393). */
export const MAX_MORTGAGES_PER_PROPERTY = 3

/**
 * A mortgage: a fixed-schedule loan secured on one of the properties below.
 *
 * An alias for `AmortizedLoan` rather than a second declaration of the same six fields
 * (#441) — the fields and their meanings are documented there, where the amortization
 * that consumes them lives. A mortgage adds nothing of its own: what makes it a mortgage
 * is the `Property` it hangs off, not the schedule, which is exactly why the schedule
 * could be shared with the car and personal loans in `domain/loan/`.
 */
export type Mortgage = AmortizedLoan

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
