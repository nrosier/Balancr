/**
 * Response shapes for the Ghostfolio endpoints Balancr reads.
 *
 * A deliberate note on trust: only `/api/v1/health`, `/api/v1/import`, the
 * public-share portfolio endpoint and asset-profile updates are documented.
 * The endpoints below (`/portfolio/details`, `/portfolio/performance`,
 * `/account`) are the ones Ghostfolio's own frontend calls — they work, but
 * they are unversioned and can change on any upgrade.
 *
 * Two consequences for these schemas:
 *
 *  - **Required fields are only the ones we actually consume.** Everything else
 *    is optional and every object is `.loose()`, so a Ghostfolio release that
 *    adds fields does not take Balancr down.
 *  - **Numbers are validated, not coerced.** Ghostfolio returns money as
 *    floating-point base-currency units; we convert to integer cents at the
 *    edge (`toCents`) and never let a float into the database.
 */
import { z } from 'zod'

/**
 * Ghostfolio sends floats. One rounding at the boundary, then integers for ever.
 * Not `Math.trunc`: truncating 12.99999999 to 12 would quietly lose a cent on
 * every holding.
 */
export function toCents(amount: number): number {
  return Math.round(amount * 100)
}

/** Percentages arrive as fractions (0.0734); we store basis points. */
export function toBp(fraction: number): number {
  return Math.round(fraction * 10_000)
}

export const healthSchema = z.object({ status: z.string().optional() }).loose()

export const authSchema = z.object({
  authToken: z.string().min(1),
})

const money = z.number().finite()

export const holdingSchema = z
  .object({
    symbol: z.string(),
    /** Absent for some data sources; the symbol is the fallback label. */
    name: z.string().nullish(),
    currency: z.string(),
    quantity: money,
    marketPrice: money.nullish(),
    valueInBaseCurrency: money.nullish(),
    /** Fraction of the portfolio, not a percentage. */
    allocationInPercentage: money.nullish(),
    assetClass: z.string().nullish(),
    assetSubClass: z.string().nullish(),
    dataSource: z.string().nullish(),
    /** ISIN when the data source provides one — the identifier Belgian brokers use. */
    isin: z.string().nullish(),
    netPerformancePercent: money.nullish(),
    grossPerformancePercent: money.nullish(),
  })
  .loose()

export const portfolioDetailsSchema = z
  .object({
    /** Keyed by symbol, not an array. */
    holdings: z.record(z.string(), holdingSchema),
    summary: z
      .object({
        currentValueInBaseCurrency: money.nullish(),
        totalInvestment: money.nullish(),
        netPerformance: money.nullish(),
        netPerformancePercent: money.nullish(),
        netPerformancePercentWithCurrencyEffect: money.nullish(),
        cash: money.nullish(),
      })
      .loose()
      .optional(),
  })
  .loose()

export const performanceSchema = z
  .object({
    chart: z.array(
      z
        .object({
          date: z.string(),
          value: money.nullish(),
          netPerformanceInPercentage: money.nullish(),
          netPerformanceInPercentageWithCurrencyEffect: money.nullish(),
          totalInvestment: money.nullish(),
        })
        .loose(),
    ),
    performance: z
      .object({
        currentNetPerformancePercent: money.nullish(),
        netPerformancePercentage: money.nullish(),
      })
      .loose()
      .optional(),
  })
  .loose()

export const accountsSchema = z
  .object({
    accounts: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          currency: z.string(),
          balance: money,
          /** Present when the account holds positions as well as cash. */
          valueInBaseCurrency: money.nullish(),
          isExcluded: z.boolean().nullish(),
        })
        .loose(),
    ),
  })
  .loose()

export type GhostfolioHolding = z.infer<typeof holdingSchema>
export type PortfolioDetails = z.infer<typeof portfolioDetailsSchema>
export type PortfolioPerformance = z.infer<typeof performanceSchema>
export type GhostfolioAccounts = z.infer<typeof accountsSchema>
