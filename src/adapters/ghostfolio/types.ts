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

/**
 * The identity fields Balancr consumes, wherever Ghostfolio decided to put them.
 *
 * Current releases moved all of them one level down into `assetProfile`
 * (`PortfolioPosition.assetProfile`, verified against a live 2026 instance and
 * against Ghostfolio's own interface), leaving the holding itself with nothing but
 * figures. Older releases carry them on the holding. Both are accepted, for the
 * reason recorded above `withKeyAsSymbol`: Balancr has to survive an upgrade in
 * either direction, and a version probe would be a second thing to keep true.
 *
 * `assetClass` is in this list for a sharper reason than the rest. It is what the
 * allocation treemap groups by, and reading it from the level Ghostfolio no longer
 * uses does not fail — it puts every position in `unknown` and draws one grey
 * block. A wrong answer is worse than a refused payload, so it is hoisted with the
 * identity rather than left to fall back to a default.
 */
const PROFILE_FIELDS = [
  'assetClass',
  'assetSubClass',
  'currency',
  'dataSource',
  'isin',
  'name',
  'symbol',
] as const

/**
 * Lifts `assetProfile`'s fields onto the holding, without overriding what the
 * holding already says.
 *
 * A fallback and never an override, the same rule `withKeyAsSymbol` follows: on a
 * release that sends both, the outer object is the one this schema was written
 * against and the one a future release is more likely to keep. Absent and empty
 * are treated alike, because an empty ISIN identifies nothing.
 */
function withProfileFields(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const holding = value as Record<string, unknown>
  const profile = holding['assetProfile']
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return value

  const lifted: Record<string, unknown> = { ...holding }
  for (const field of PROFILE_FIELDS) {
    const own = lifted[field]
    if (own !== undefined && own !== null && own !== '') continue
    const fromProfile = (profile as Record<string, unknown>)[field]
    if (fromProfile !== undefined) lifted[field] = fromProfile
  }
  return lifted
}

export const holdingSchema = z.preprocess(
  withProfileFields,
  z
    .object({
      /**
       * Nullish, because Ghostfolio ships releases whose holdings carry no `symbol`
       * inside the object at all: it is the key of the record they arrive in, and
       * `holdingsSchema` folds it back in below.
       *
       * Requiring it here failed the entire portfolio pass on a live instance for a
       * value that was sitting in the response one level up. What actually has to be
       * true is weaker — *something* identifies the position — and that is checked
       * once, after the ISIN has had its say, by the `refine` at the bottom.
       */
      symbol: z.string().nullish(),
      /** Absent for some data sources; the symbol is the fallback label. */
      name: z.string().nullish(),
      /**
       * The instrument's own quote currency — the one `marketPrice` is in.
       *
       * Nullish because a live instance omits it on some data sources, and a
       * required field we cannot guarantee would fail the whole pass over one
       * label. `toHoldingSnapshots` falls back to the base currency when it is
       * missing, which is the only assumption available and is at least the
       * common case.
       */
      currency: z.string().nullish(),
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
    /**
     * The one identity requirement, checked here rather than field by field.
     *
     * `toHoldingSnapshots` keys a row on `isin ?? symbol`, so either will do and
     * neither alone is mandatory. A position with no ISIN, no symbol and no record
     * key cannot be stored — and must not simply be skipped, because
     * `totalValueCents` is the sum of the holdings that *were* stored: dropping one
     * would quietly shrink the portfolio total and every allocation share computed
     * from it. Refusing the payload is the honest outcome, and the message carries
     * the keys the object did have so the next shape change diagnoses itself.
     *
     * The key list is taken after `withProfileFields` has run, so it names what was
     * actually available — including anything lifted out of `assetProfile`. That is
     * the list worth printing: it says what Balancr could see, not where it looked.
     */
    .refine((holding) => (holding.isin ?? holding.symbol ?? '') !== '', {
      error: (issue) =>
        'holding has neither an ISIN nor a symbol, so it cannot be identified; ' +
        `keys present: ${Object.keys(issue.input as object).sort().join(', ')}`,
    }),
)

/**
 * Ghostfolio has shipped `holdings` both ways: keyed by symbol
 * (`{"IWDA.AS": {…}}`) on the releases this adapter was written against, and as a
 * plain list on current ones. Both are accepted and normalised to a list.
 *
 * A union rather than a version probe, because Balancr has to survive an upgrade in
 * either direction and a probe would be a second thing to keep true. Preprocessing
 * the container rather than unioning two validated shapes, because then only one
 * shape is ever item-checked and a bad field still reports as `holdings[0].symbol`
 * instead of collapsing into "invalid union".
 *
 * **The key is folded in as the symbol**, which is the correction this function
 * exists for. It used to flatten with `Object.values` on the reasoning that the key
 * was the symbol and every position carried `symbol` in the object as well. The
 * first half of that is still true; the second half is not, on at least one
 * Ghostfolio release, and the result was a required field being reported as missing
 * by the same code that had just discarded the only copy of it.
 *
 * An object that already names itself keeps its own value: the key is a fallback,
 * never an override, because a record keyed by something other than the symbol
 * would otherwise rename every position it contains.
 */
function withKeyAsSymbol(key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const own = (value as { symbol?: unknown }).symbol
  if (typeof own === 'string' && own !== '') return value
  return { ...value, symbol: key }
}

const holdingsSchema = z.preprocess(
  (raw) =>
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.entries(raw as Record<string, unknown>).map(([key, value]) =>
          withKeyAsSymbol(key, value),
        )
      : raw,
  z.array(holdingSchema),
)

export const portfolioDetailsSchema = z
  .object({
    /** A list, whichever of the two shapes Ghostfolio sent. */
    holdings: holdingsSchema,
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
