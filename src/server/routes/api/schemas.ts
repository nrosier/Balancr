/**
 * The response schemas, and the reason they exist at all.
 *
 * Validating one's *own* output looks like belt and braces, and for a shape
 * mismatch it would be — TypeScript already has that covered. What it is actually
 * for is the money.
 *
 * Every amount in this application is integer cents, all the way from Actual's
 * API to the browser. That invariant is easy to state and easy to break: one
 * division, one average, one `* 0.5` in a future aggregate, and `1234` becomes
 * `1234.5`, which renders as `€ 12,345` and is wrong by an order of magnitude in
 * a way no test of that aggregate would notice. `cents()` below is a runtime
 * assertion that it has not happened, placed at the last point where the value is
 * still Balancr's problem.
 *
 * The second reason is the client contract. These schemas are the definition of
 * what the SPA in `0.6.0` may rely on, expressed once, next to nothing else.
 */
import { z } from 'zod'
import { DRIFT_STATES } from '../../../domain/advice/drift.ts'
import { BAND_CLASSES, PRESET_IDS, PROFILE_IDS } from '../../../domain/advice/profile.ts'
import {
  FUNDINGS,
  SKIP_REASONS,
  TAX_OMISSIONS,
  UNAVAILABLE_REASONS,
} from '../../../domain/advice/suggest.ts'
import { aggregateParamsSchema } from '../../../domain/aggregate/params.ts'
import { CUSTODY_BASES, CUSTODY_UNAVAILABLE } from '../../../domain/aggregate/custody.ts'
import { EXCLUSION_REASONS } from '../../../domain/aggregate/networth.ts'
import { BENCHMARK_BASES, BENCHMARK_UNAVAILABLE } from '../../../domain/benchmark/compare.ts'
import {
  BENCHMARK_BLOCKS,
  BENCHMARK_GROUPS,
  COICOP_DIVISIONS,
  OUTSIDE_CONSUMPTION,
} from '../../../domain/benchmark/vocabulary.ts'
import { AI_OFF_REASONS } from '../../../domain/ai/availability.ts'
import { ASSUMPTIONS, UNKNOWN_REASONS } from '../../../domain/tax/estimate.ts'
import { TAX_RULE_IDS } from '../../../domain/tax/rules.ts'

/**
 * An amount of money: whole cents, and never a float.
 *
 * `z.int()` rather than `z.number().int()` so the failure message says what was
 * expected. Negative is allowed — a debt, a refund and a net-outflow month are all
 * legitimately below zero.
 */
export const cents = (): z.ZodType<number> => z.int()

/** Basis points. 10 000 = 100%, and again an integer, for the same reason. */
export const basisPoints = (): z.ZodType<number> => z.int()

/**
 * Whether the AI layer can run here, on two payloads that both need the answer.
 *
 * The reason list is imported from the domain rather than retyped, so a fourth way for
 * the layer to be off cannot reach the availability function and miss the wire. A
 * client switching on `reason` gets a compile error for the case it has not handled,
 * which is the point of putting it in the contract at all.
 */
export const aiAvailabilitySchema = z.object({
  enabled: z.boolean(),
  /** Null exactly when `enabled` is true. */
  reason: z.enum(AI_OFF_REASONS).nullable(),
})

/**
 * Micro-euros: a millionth of a euro, and the unit every AI cost is stored in.
 *
 * Not cents, and not for consistency's sake either — a single model call can cost
 * €0,0004, so a ledger in cents would record a month of them as zero and a budget
 * built on it would never trip. Integer for the same reason as `cents()`.
 */
export const microEur = (): z.ZodType<number> => z.int().nonnegative()

/** `YYYY-MM`. */
export const monthKey = (): z.ZodType<string> => z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)

/** `YYYY-MM-DD`. */
export const dateKey = (): z.ZodType<string> => z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const jobFreshnessSchema = z.object({
  name: z.string(),
  status: z.enum(['idle', 'running', 'ok', 'error']),
  lastRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  error: z.string().nullable(),
})

export const freshnessSchema = z.object({
  stale: z.boolean(),
  asOf: z.string().nullable(),
  jobsEnabled: z.boolean(),
  jobs: z.array(jobFreshnessSchema),
})

/**
 * A finding as the API returns it: a code and its numbers, never a sentence.
 *
 * The client renders this through the i18n catalogue, which is why the language of
 * the response is not a question the server has to answer. It is also why a
 * finding cannot end up half-translated, and why adding a language costs a
 * catalogue rather than another model call.
 */
export const signalSchema = z.object({
  code: z.string(),
  categoryId: z.string().nullable(),
  categoryName: z.string().nullable(),
  /**
   * The same three words `codes.ts` and the `signals` table use.
   *
   * `alert` rather than a friendlier `critical`: the value is stored, ranked and capped
   * under that name everywhere behind this schema, and a rename at the wire would have
   * meant translating it in both directions — the direction that was missing turned
   * every genuine alert into a 500 from this endpoint.
   */
  severity: z.enum(['info', 'warn', 'alert']),
  /**
   * Cents as integer cents, ratios as basis points, the unit named in the key.
   * Not `cents()`, because the map holds both — but still integers throughout.
   */
  metrics: z.record(z.string(), z.int()),
})

export const hygieneSchema = z.object({
  scoreBp: basisPoints(),
  deductions: z.array(z.object({ reason: z.string(), bp: basisPoints() })),
})

/**
 * A below-threshold categorisation candidate (#216): a payee match too thin
 * for `generateCategoryProposals`'s own confidence bar (`suggestCategoryForPayee`),
 * cached rather than dropped so the owner can ask a model to guess instead of
 * leaving the transaction uncategorised.
 *
 * `payeeName` is display only. It is on this wire so the row can say who the
 * candidate is, but it is never part of what `category-guess.ts` sends to
 * Gemini — the model sees only an opaque candidate and its own category
 * history, never a name.
 */
export const categoryGuessCandidateSchema = z.object({
  transactionId: z.string(),
  payeeName: z.string().nullable(),
  amountCents: cents(),
  date: dateKey(),
  /**
   * This payee's own category history — the only evidence a guess may use.
   * `categoryName` is resolved locally from the category cache; the model
   * itself never sees it, only the opaque label built from `categoryId`.
   */
  history: z.array(
    z.object({
      categoryId: z.string(),
      categoryName: z.string(),
      count: z.int().nonnegative(),
    }),
  ),
})

// ---------------------------------------------------------------------------
//  Overview
// ---------------------------------------------------------------------------

export const netWorthPointSchema = z.object({
  date: dateKey(),
  totalCents: cents(),
})

export const overviewSchema = z.object({
  freshness: freshnessSchema,
  netWorth: z
    .object({
      date: dateKey(),
      /** Includes every property's equity (#227) — netted in, the same treatment debt gets. */
      totalCents: cents(),
      liquidCents: cents(),
      investedCents: cents(),
      debtCents: cents(),
      /** Summed across every owned property with a tracked value; null when none is. */
      propertyValueCents: cents().nullable(),
      /** Summed outstanding mortgage balance; null when no property has a mortgage. */
      mortgageBalanceCents: cents().nullable(),
    })
    .nullable(),
  history: z.array(netWorthPointSchema),
  month: monthKey().nullable(),
  totals: z
    .object({
      incomeCents: cents(),
      spentCents: cents(),
      budgetedCents: cents(),
      savingsRateBp: basisPoints().nullable(),
    })
    .nullable(),
  /**
   * Months of liquid cover at the trailing spend rate, in hundredths of a month so
   * "4.5 months" survives the trip without becoming a float.
   */
  emergencyFundCentimonths: z.int().nullable(),
  hygiene: hygieneSchema.nullable(),
})

// ---------------------------------------------------------------------------
//  Budget
// ---------------------------------------------------------------------------

export const categoryFactSchema = z.object({
  categoryId: z.string(),
  categoryName: z.string(),
  isIncome: z.boolean(),
  hidden: z.boolean(),
  spentCents: cents(),
  budgetedCents: cents(),
  availableCents: cents(),
  txnCount: z.int().nonnegative(),
  /**
   * Still scheduled to leave this envelope between today and month end (#159).
   *
   * Never folded into `spentCents`: one is money that has gone, the other is money
   * that will. Zero for every month but the current one, by definition. `approximate`
   * is set when a schedule states a range rather than an amount — counted at its
   * upper bound, and said so on screen rather than presented as a fact.
   */
  committedCents: cents(),
  committedApproximate: z.boolean(),
  /** The EWMA norm, or null when there is not enough history to state one. */
  baselineCents: cents().nullable(),
  deltaBp: basisPoints().nullable(),
  /**
   * Spend per month over the trailing window, aligned to `trendMonths`.
   *
   * Dense and the same length for every category, which is what makes a wall of small
   * charts comparable: a per-category window would give the newest envelope the
   * shortest axis and make its line look steeper than its neighbour's. A month with no
   * transactions is a real zero, not a gap.
   */
  trendCents: z.array(cents()),
})

// ---------------------------------------------------------------------------
//  Benchmark (#43)
// ---------------------------------------------------------------------------

/**
 * Where a reference figure came from and when anybody last checked.
 *
 * The same four fields the tax block carries, and for the same reason: a national
 * average with no citation is a number this app made up. `status` is the one worth
 * reading — `transcribed` means the figures were typed in off a summary page and
 * nobody has confirmed them against the survey's own tables.
 */
export const benchmarkSourceSchema = z.object({
  survey: z.string(),
  year: z.int(),
  citation: z.string(),
  sourceUrl: z.string().nullable(),
  lastVerified: dateKey(),
  status: z.enum(['confirmed', 'transcribed']),
})

/** One reference line: your spending on it, the published share, and the gap. */
export const benchmarkGroupSchema = z.object({
  group: z.enum(BENCHMARK_GROUPS),
  yourCents: cents(),
  /** Your share of *compared* spending — unmapped categories are in neither side. */
  yourShareBp: basisPoints(),
  referenceShareBp: basisPoints(),
  /** The reference as money, on whichever basis the comparison says it used. */
  benchmarkCents: cents(),
  /** Signed. Null where the reference is zero, which no percentage can describe. */
  deltaBp: basisPoints().nullable(),
  deltaCents: cents(),
  /** How many of your categories feed this line, so the mapping reads as a total. */
  categories: z.int().nonnegative(),
})

/**
 * Your month against the household budget survey, or the reason there is no comparison.
 *
 * A discriminated union rather than a nullable object, because "no benchmark" has four
 * distinct causes and each needs a different sentence: no file shipped, no spending in
 * the month, nothing mapped at all, and too little mapped to be worth drawing. A `null`
 * would collapse all four into a blank space on the page.
 *
 * `basis` is on the wire because the two comparisons answer different questions — see
 * `compare.ts` — and `transcribed` and `household.prorated` are there because #43 asks
 * for the assumption to be stated on screen, which means the screen has to be told.
 */
export const benchmarkComparisonSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    month: monthKey(),
    basis: z.enum(BENCHMARK_BASES),
    groups: z.array(benchmarkGroupSchema),
    comparedCents: cents(),
    consumptionCents: cents(),
    /** Savings, taxes and transfers: excluded by mapping rather than by omission. */
    outsideCents: cents(),
    mappedShareBp: basisPoints(),
    /** Categories with no COICOP code, largest first, with what they are worth. */
    unmapped: z.array(
      z.object({
        categoryId: z.string(),
        categoryName: z.string(),
        spentCents: cents(),
        shareBp: basisPoints(),
      }),
    ),
    household: z.object({
      /** The household's size on the equivalence scale, in basis points. */
      bp: basisPoints(),
      prorated: z.boolean(),
      children: z.int().nonnegative(),
      members: z.int().nonnegative(),
    }),
    referenceHouseholdBp: basisPoints().nullable(),
    source: benchmarkSourceSchema,
    transcribed: z.array(z.enum(BENCHMARK_BLOCKS)),
  }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum(BENCHMARK_UNAVAILABLE),
    mappedShareBp: basisPoints().nullable(),
  }),
])

/**
 * What a month's shared costs cost you, or why there is no split (#44).
 *
 * A union for the same reason the benchmark's is: "no split" has three causes and two of
 * them draw nothing at all. `basis` is on the wire because a derived share is Balancr's
 * guess at somebody's arrangement and a stated one is not, and the card has to say which —
 * a borne figure whose provenance is missing is a number nobody can check.
 *
 * `paidCents` is Actual's own figure and is never adjusted anywhere: the split is an extra
 * column beside it, not a correction to it.
 */
export const custodySplitSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    month: monthKey(),
    basis: z.enum(CUSTODY_BASES),
    shareBp: basisPoints(),
    /** Part-time members the derived share averaged. Zero when the share was stated. */
    members: z.int().nonnegative(),
    lines: z.array(
      z.object({
        categoryId: z.string(),
        categoryName: z.string(),
        paidCents: cents(),
        borneCents: cents(),
      }),
    ),
    paidCents: cents(),
    borneCents: cents(),
    /** `paidCents − borneCents`: the co-parent's share of what you paid. */
    offsetCents: cents(),
    shareOfSpendBp: basisPoints(),
  }),
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum(CUSTODY_UNAVAILABLE),
    /** Set for `no_basis`: what was flagged and went unsplit. */
    paidCents: cents().nullable(),
  }),
])

export const budgetSchema = z.object({
  freshness: freshnessSchema,
  month: monthKey(),
  months: z.array(monthKey()),
  totals: z
    .object({
      month: monthKey(),
      incomeCents: cents(),
      spentCents: cents(),
      budgetedCents: cents(),
      toBudgetCents: cents(),
      fromLastMonthCents: cents(),
      balanceCents: cents(),
      savingsRateBp: basisPoints().nullable(),
      /**
       * The month's whole committed figure (#159), which is deliberately **not** the
       * sum of `categories[].committedCents`: a schedule no rule assigns a category
       * to is counted here and reported as unallocated, never attributed to an
       * envelope by inference.
       */
      committedCents: cents(),
      committedUnallocatedCents: cents(),
      committedUnallocatedCount: z.int().nonnegative(),
      committedApproximate: z.boolean(),
    })
    .nullable(),
  history: z.array(
    z.object({
      month: monthKey(),
      incomeCents: cents(),
      spentCents: cents(),
      budgetedCents: cents(),
      savingsRateBp: basisPoints().nullable(),
    }),
  ),
  /** The months every `categories[].trendCents` is indexed by, oldest first. */
  trendMonths: z.array(monthKey()),
  categories: z.array(categoryFactSchema),
  signals: z.array(signalSchema),
  /**
   * The Statbel comparison, computed for this request rather than stored.
   *
   * On the budget response and not on `insights`, because it is context for a month's
   * spending and the month picker is here. Recomputed per request for the reason
   * `context.ts` gives: it is a function of the COICOP mapping and the household, both
   * of which are edited two clicks away in settings.
   */
  benchmark: benchmarkComparisonSchema,
  custody: custodySplitSchema,
  uncategorised: z
    .object({ txnCount: z.int().nonnegative(), amountCents: cents() })
    .nullable(),
})

// ---------------------------------------------------------------------------
//  Advice
// ---------------------------------------------------------------------------

/**
 * A tax estimate, in the tax module's own spelling.
 *
 * The only snake_case in this file, and deliberately so. `describeTaxEstimate` turns an
 * estimate into sentences and is written to run on both sides of the wire — the browser
 * renders the tax block, a digest email would render the same one — so the shape that
 * arrives here has to be the shape that function takes. Renaming twelve fields to house
 * style would buy a consistent camelCase at the price of a mapper in each direction whose
 * only job is spelling, plus a second vocabulary for the same numbers, and the rates and
 * the fields are named after `config/belgian-tax.yaml`, which is the document these
 * figures have to be checked against.
 *
 * `basis` is the provenance and is why the block can be trusted: the rate, the cap that
 * bit, the citation and the date it was last checked. A number without it would be a
 * number this app made up.
 */
export const taxBasisSchema = z.object({
  rate_bp: basisPoints(),
  base_cents: cents(),
  /** The per-transaction ceiling, or `null` where the rule has none. */
  cap_cents: cents().nullable(),
  capped: z.boolean(),
  /** Which beurstaks tier applied, for the rules that have tiers. */
  tier: z.string().optional(),
  citation: z.string(),
  source_url: z.string().optional(),
  last_verified: dateKey(),
  /**
   * Whether a person has checked this rule against its citation.
   *
   * On the wire because the page says so out loud. Every rule in the shipped file is
   * `transcribed`, and an estimate that presented a transcribed rate with the same
   * confidence as a confirmed one would be overstating what anybody has verified.
   */
  status: z.enum(['confirmed', 'transcribed']),
  effective_from: dateKey(),
})

export const taxLineSchema = z.object({
  rule: z.enum(TAX_RULE_IDS),
  /** `null` when a fact is missing; `bounds` then says what it lies between. */
  amount_cents: cents().nullable(),
  bounds: z.object({ min_cents: cents(), max_cents: cents() }).optional(),
  /** Which missing fact, named after the field to go and record. */
  unknown: z.enum(UNKNOWN_REASONS).optional(),
  basis: taxBasisSchema.nullable(),
  assumptions: z.array(z.enum(ASSUMPTIONS)),
})

export const taxEstimateSchema = z.object({
  lines: z.array(taxLineSchema),
  /** The sum of what is known — a floor when `complete` is false. */
  total_cents: cents(),
  total_min_cents: cents(),
  /** `null` when an unknown line has no bounds at all. */
  total_max_cents: cents().nullable(),
  complete: z.boolean(),
  transcribed: z.array(z.enum(TAX_RULE_IDS)),
  effective_from: dateKey(),
  last_verified: dateKey(),
})

/**
 * One class measured against its band — the reason a suggestion exists.
 *
 * The band's three numbers travel on the line rather than beside the advice as a copy of
 * the profile, because the line is where they are read: a page drawing a marker at the
 * target and a bar between the edges needs them per class, and a second copy is a second
 * thing to keep in step with the settings the user just changed.
 */
export const driftLineSchema = z.object({
  assetClass: z.enum(BAND_CLASSES),
  valueCents: cents(),
  shareBp: basisPoints(),
  minBp: basisPoints(),
  targetBp: basisPoints(),
  maxBp: basisPoints(),
  /** Signed distance from target: positive means overweight. */
  driftBp: basisPoints(),
  state: z.enum(DRIFT_STATES),
  /** How far past the band edge. Zero when inside — this, not `driftBp`, is the alarm. */
  outsideBp: basisPoints(),
  /** The drift as money. Not the size of the trade: see `funding` below. */
  gapCents: cents(),
})

export const driftReportSchema = z.object({
  /** Worst first, and one line per band class, so a zero holding is still visible. */
  lines: z.array(driftLineSchema),
  /**
   * Value in classes no band covers, largest first.
   *
   * `assetClass` is a plain string here rather than the band enum: this is exactly the
   * case of a class Ghostfolio has and the profile does not, which is a thing to report
   * and not a thing to fail on.
   */
  unmapped: z.array(
    z.object({ assetClass: z.string(), valueCents: cents(), shareBp: basisPoints() }),
  ),
  /** What the shares are shares of: the invested value, cash excluded. */
  investedValueCents: cents(),
  worstOutsideBp: basisPoints(),
})

export const suggestionSchema = z.object({
  action: z.enum(['buy', 'sell']),
  assetClass: z.enum(BAND_CLASSES),
  /** Cents, and never negative — the direction is `action`, not the sign. */
  amountCents: z.int().nonnegative(),
  /**
   * Where the money comes from, which is why the amount is what it is.
   *
   * `paired` means a trade the other way funds it and the invested total does not move,
   * so the amount is the gap. `cash` means the total does move, and closing a gap then
   * takes nearly three times the gap at a 65% target. A client that showed the amount
   * without this would be showing a figure that only makes sense in one of the two cases.
   */
  funding: z.enum(FUNDINGS),
  /** The drift that motivates it. The issue's requirement, as a required field. */
  reason: driftLineSchema,
  /**
   * The fund a purchase names, or `null` with `unavailable` set.
   *
   * Only ever an instrument from the curated universe (#40) — nothing here can name a
   * ticker that came out of a model. `terPercent` is the one genuine float on this wire:
   * a TER is 0,12% and rounding it to cents or basis points would flatten the difference
   * between two funds that is the only reason the cheaper one was chosen.
   */
  fund: z
    .object({
      isin: z.string(),
      name: z.string(),
      terPercent: z.number().nonnegative(),
      /** How many funds could have filled this line, this one included. */
      alternatives: z.int().positive(),
    })
    .nullable(),
  /** For a sale: the position it would come out of, when the snapshot can name one. */
  position: z
    .object({
      isin: z.string().nullable(),
      name: z.string().nullable(),
      valueCents: cents(),
      alternatives: z.int().positive(),
    })
    .nullable(),
  unavailable: z.enum(UNAVAILABLE_REASONS).optional(),
  /** What acting would cost, or `null` when there are no tax rules to price it with. */
  tax: taxEstimateSchema.nullable(),
  /**
   * What that estimate leaves out.
   *
   * Never empty for a sale: the realised gain depends on a cost base this app never
   * sees, so capital gains are absent from the total rather than guessed at, and the
   * page has to be able to say so. A total that quietly excluded a 10% tax would read
   * as a complete one.
   */
  taxOmits: z.array(z.enum(TAX_OMISSIONS)),
})

/**
 * The bands as the settings page edits them.
 *
 * `z.record` over the class enum rather than four spelled-out keys, because Zod 4 makes
 * an enum-keyed record exhaustive: a band missing for one class is a rejected payload
 * rather than a class that silently has no target. That is also what makes a partial
 * `bands` patch impossible, which is the rule `saveProfile` states — four targets, one of
 * them left over from the previous profile, is exactly the state that adds up to 97%.
 */
export const bandsSettingSchema = z.record(
  z.enum(BAND_CLASSES),
  z.object({ minBp: basisPoints(), targetBp: basisPoints(), maxBp: basisPoints() }),
)

/**
 * The risk profile as the settings screen shows it (#41).
 *
 * The presets travel with it, numbers included. The picker has to be able to say what
 * "defensive" *means* before somebody commits to it, and `PROFILE_PRESETS` cannot be
 * imported into the browser — it lives beside the settings table and the logger. A
 * hand-written copy in the page would be a second definition of the profile the advice
 * was actually computed against.
 */
export const riskProfileSettingSchema = z.object({
  profile: z.enum(PROFILE_IDS),
  /** Whether the bands are still exactly the preset they are named after. */
  isPreset: z.boolean(),
  /** The bands in force, whichever they came from — never null, never partial. */
  bands: bandsSettingSchema,
  toleranceBp: basisPoints(),
  minTradeCents: cents(),
  presets: z.record(z.enum(PRESET_IDS), bandsSettingSchema),
})

export const adviceSchema = z.object({
  profile: z.enum(PROFILE_IDS),
  /** Whether the bands are still exactly the preset they are named after. */
  isPreset: z.boolean(),
  toleranceBp: basisPoints(),
  minTradeCents: cents(),
  drift: driftReportSchema,
  /** Worst drift first, in the drift report's own order. */
  suggestions: z.array(suggestionSchema),
  /**
   * Lines outside their band that produced no suggestion, and why.
   *
   * On the wire because "the page draws a red band and suggests nothing" is a bug
   * report waiting to be filed. `amountCents` is the trade that was suppressed, so the
   * threshold can be judged against the number it suppressed.
   */
  skipped: z.array(
    z.object({
      assetClass: z.enum(BAND_CLASSES),
      outsideBp: basisPoints(),
      amountCents: z.int().nonnegative(),
      reason: z.enum(SKIP_REASONS),
    }),
  ),
})

// ---------------------------------------------------------------------------
//  Portfolio
// ---------------------------------------------------------------------------

export const holdingSchema = z.object({
  /** ISIN when the provider knew one, otherwise the symbol. The row's identity. */
  instrument: z.string(),
  symbol: z.string().nullable(),
  isin: z.string().nullable(),
  name: z.string().nullable(),
  /**
   * A decimal string, not a number.
   *
   * Fractional shares are real, so a quantity genuinely is not an integer — and it
   * is also not money, so the cents trick does not apply. Carried as the exact text
   * the provider gave, which is the only representation that neither rounds nor
   * invents precision. The client formats it; nothing here does arithmetic on it.
   */
  quantity: z.string(),
  priceCents: cents(),
  /**
   * ISO 4217 code for `priceCents`, which is the instrument's own quote currency
   * and so need not match `currency`. A euro portfolio holding a US-listed ETF
   * reports a dollar price beside a euro value; a client that assumed one code per
   * row would render the price with the wrong symbol and understate it silently.
   */
  priceCurrency: z.string(),
  valueCents: cents(),
  currency: z.string(),
})

/**
 * One owned property, priced at request time rather than at the snapshot's own `date`
 * (#227) — see `portfolioSchema.properties`.
 */
export const portfolioPropertySchema = z.object({
  id: z.string(),
  kind: z.enum(['primary', 'rental']),
  label: z.string(),
  propertyValueCents: cents().nullable(),
  mortgageBalanceCents: cents(),
  equityCents: cents().nullable(),
  /** Monthly rent received. Only meaningful for a `rental`. */
  rentCents: cents().nullable(),
  netCashFlowCents: cents().nullable(),
  grossYieldBp: basisPoints().nullable(),
})

export const portfolioSchema = z.object({
  freshness: freshnessSchema,
  date: dateKey().nullable(),
  totalValueCents: cents().nullable(),
  /**
   * The invested and cash halves of the total.
   *
   * A tool that syncs bank accounts into Ghostfolio leaves the bank balance there as
   * a `LIQUIDITY` holding, and on the reporting instance that was about half the
   * portfolio. `allocation` covers the invested half only, so a client adding up its
   * slices and comparing them with `totalValueCents` needs to be told where the rest
   * went. Null for a date whose row predates the split, or one the history backfill
   * wrote — the total is all those dates have.
   */
  investedValueCents: cents().nullable(),
  cashValueCents: cents().nullable(),
  twrBp: basisPoints().nullable(),
  allocation: z.array(
    z.object({
      assetClass: z.string(),
      valueCents: cents(),
      shareBp: basisPoints(),
    }),
  ),
  holdings: z.array(holdingSchema),
  history: z.array(netWorthPointSchema),
  /**
   * The risk profile, the drift against it, and what would close the drift (#41).
   *
   * Null when there is no invested value to measure — a fresh install, or a date whose
   * row predates the invested/cash split. Bands are shares of the invested value, so
   * without one every class is trivially 100% below target, and an empty portfolio would
   * be shown four red bands and four suggestions to buy nothing.
   */
  advice: adviceSchema.nullable(),
  /**
   * Owned properties and their mortgages, tracked by Balancr rather than Ghostfolio
   * (#227) — deliberately outside `allocation`/`advice` entirely, see `properties.ts`.
   * Priced as of the request, not as of `date`: a mortgage amortizes with the calendar,
   * not with Ghostfolio's own sync cadence.
   */
  properties: z.array(portfolioPropertySchema),
  /** Summed across every property with a tracked value; null when none of them are. */
  totalPropertyEquityCents: cents().nullable(),
})

// ---------------------------------------------------------------------------
//  Insights
// ---------------------------------------------------------------------------

/**
 * One row of the AI ledger, without the payload that is the point of it.
 *
 * The payload is deliberately not here. Twenty redacted bundles of a few thousand
 * tokens each would be most of this response, fetched on every page load, to render
 * a list of dates and costs — `GET /api/insights/runs/:id/payload` fetches one when
 * somebody actually opens it.
 *
 * A row exists whether or not the call went out, which is why `status` is on the
 * wire beside the tokens: `capped` and `blocked` rows have a payload and cost
 * nothing, and they are the ones worth reading, because they are the answers that
 * are missing from the page. `error` is the upstream message stored verbatim — the
 * only text in this file that Balancr did not write — and it is here because a
 * failed run that will not say why is indistinguishable from one that never ran.
 */
export const aiRunSchema = z.object({
  id: z.string(),
  kind: z.enum([
    'findings',
    'narrative',
    'clarify',
    'chat',
    'dryrun',
    'category_guess',
    'budget_nudge',
  ]),
  model: z.string(),
  locale: z.string(),
  status: z.enum(['ok', 'error', 'blocked', 'capped', 'reused']),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cachedTokens: z.int().nonnegative(),
  costMicroEur: microEur(),
  durationMs: z.int().nonnegative().nullable(),
  error: z.string().nullable(),
  /**
   * The month the run was about, or null for a run about no month.
   *
   * Null is a fact and not a gap: a chat turn answers a question, and a run that
   * failed before it knew which month it was for never had one. The insights ledger
   * filters to the selected month *plus* the null rows for that reason — a row nobody
   * can reach from any month is not an audit (#158).
   */
  period: monthKey().nullable(),
  /** The `ok` run this one served for free instead of calling the model (#160). */
  reusedFromRunId: z.string().nullable(),
  createdAt: z.string(),
})

export const insightsSchema = z.object({
  freshness: freshnessSchema,
  /**
   * Whether a model can run here at all, and which variable to change if not.
   *
   * First in the payload because it decides how everything after it reads. Three of
   * the five sections on this page — the narrative, the open clarification cards and
   * the proposals — exist only if a model ran; on a deployment with no key they are
   * empty arrays, and an empty array is indistinguishable from "nothing to report".
   * So the page needs to be told which of the two it is looking at, or it draws four
   * blank cards and reads as broken (#165).
   *
   * `signals` is on the other side of that line and is not affected: it is
   * deterministic TypeScript over the aggregated facts, and it is the whole reason an
   * AI-less Balancr is still worth opening.
   *
   * A code rather than a sentence, like every other reason on the wire — see
   * `domain/ai/availability.ts` for what the three of them mean.
   */
  ai: aiAvailabilitySchema,
  /**
   * Whether this reader may start a run from the page.
   *
   * On the payload for the same reason `profile.role` is on `/api/settings`: the
   * browser has no session of its own to read a role off, and a button that appears
   * for everyone and then 403s is worse than one that was never offered. The server
   * still decides — `POST /api/ai/narrative` is owner-gated on its own — so this is
   * about what is drawn, never about what is allowed (#158).
   */
  owner: z.boolean(),
  month: monthKey().nullable(),
  /**
   * When the selected month's fact fingerprint last actually changed (#162),
   * or null if it was never computed. Compared against `narrative.generatedAt`
   * to decide whether a stale-analysis notice belongs on the page — the
   * server does not make that comparison itself, since deciding whether an
   * answer can still be reused is #160's job, built on top of this signal.
   */
  factsChangedAt: z.string().nullable(),
  /**
   * Every month with aggregated figures, newest first — the picker's options.
   *
   * Every stored month rather than the ones this payload has findings for: the picker
   * has to keep offering August while July is on screen, and a month whose analysis was
   * capped is exactly the one worth being able to select (#158). Same field and same
   * meaning as `/api/budget`, so the two pages' pickers cannot disagree about which
   * months exist.
   */
  months: z.array(monthKey()),
  signals: z.array(signalSchema),
  /**
   * This month's below-threshold candidates, scoped the same way `signals`
   * is: sourced per month like `monthlySignals`, unlike the genuinely
   * unscoped `questions`/`proposals` below (#216).
   */
  categoryGuessCandidates: z.array(categoryGuessCandidateSchema),
  narrative: z
    .object({
      period: z.string(),
      locale: z.string(),
      /**
       * The narrative as HTML, generated in this locale. The one free-text field
       * in the API.
       *
       * Rendered here rather than shipped as its stored Markdown, because the
       * stored text is not readable by anything: the model was given the month as
       * opaque labels (`c7`, `a3`) and wrote them back, so `bodyMd` says "c7 is
       * 18% above" and only the server can resolve `c7` to a name. Substituting
       * on the way out is also what keeps the names out of the row — the translate
       * action sends `bodyMd` back to Google, and a sensitive category's name must
       * not be in it.
       *
       * Sanitised by `util/markdown.ts`, which escapes first and emits a fixed tag
       * list with no attributes. It is meant to be inserted as HTML; that is the
       * contract, and it is why the sanitiser is on this side of the wire.
       */
      html: z.string(),
      generatedAt: z.string(),
      /**
       * Which model wrote it, for the byline — `null` only if the run it hangs off
       * has been pruned, which cannot happen while the row exists (`ai_narratives.
       * run_id` cascades) but is on the wire as nullable rather than as a lie.
       */
      model: z.string().nullable(),
    })
    .nullable(),
  /**
   * The clarification cards, which are the one place the server does render text.
   *
   * A deliberate exception, decided in `0.4.0`: the question and the guess label
   * come from the catalogue in `domain/ai/clarify.ts`, which already resolves the
   * real category name locally — a sensitive category never sent one to the model.
   * The `code` is returned alongside so a client that would rather render its own
   * wording can.
   */
  questions: z.array(
    z.object({
      id: z.string(),
      categoryId: z.string(),
      categoryName: z.string(),
      code: z.string(),
      question: z.string(),
      guess: z.string(),
      guessLabel: z.string().nullable(),
      choices: z.array(z.object({ value: z.string(), label: z.string() })).nullable(),
      materialityBp: basisPoints(),
      createdAt: z.string(),
    }),
  ),
  /**
   * Pending proposals, as the review screen needs them: a before/after per field.
   *
   * Rendered by `domain/ai/proposals.ts` for the same reason as the clarification
   * cards — the labels and the `warn` text come from the catalogue, and the target
   * name is resolved locally rather than taken from anything the model said.
   */
  proposals: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      targetRef: z.string(),
      targetName: z.string(),
      fields: z.array(
        z.object({
          field: z.string(),
          label: z.string(),
          before: z.string(),
          after: z.string(),
          warn: z.string().nullable(),
        }),
      ),
      createdAt: z.string(),
      expiresAt: z.string().nullable(),
      /** The raw proposed amount for a `budget_amount.set` card (#220); null otherwise. */
      amountCents: z.int().nullable(),
    }),
  ),
  spend: z.object({
    month: monthKey(),
    spentMicroEur: z.int().nonnegative(),
    budgetMicroEur: z.int().nonnegative(),
    usedBp: basisPoints(),
    exceeded: z.boolean(),
  }),
  /**
   * The recent ledger, newest first — every attempt, not only the ones that
   * produced what is above.
   *
   * On the insights payload rather than on settings, where the monthly totals
   * live, because this is the page that shows what the model concluded and the
   * ledger is where "and here is what it was told" hangs off. A page that shows
   * conclusions and hides the input is asking to be trusted.
   */
  runs: z.array(aiRunSchema),
})

/**
 * `GET /api/insights/runs/:id/payload` — exactly what was prepared for one call.
 *
 * The privacy claim, checkable from the browser rather than from a SQLite prompt on
 * the host. `payload` is whatever the redactor produced, echoed unshaped: giving it
 * a schema of its own here would mean this endpoint decides what a payload may
 * contain, and a payload containing something it should not would then be quietly
 * dropped on the way out instead of shown to the person looking for exactly that.
 *
 * `null` means the stored JSON would not parse, which is a finding rather than an
 * error — the row is still worth showing, and the page says so.
 */
export const aiRunPayloadSchema = aiRunSchema.extend({
  payload: z.json(),
})

// ---------------------------------------------------------------------------
//  Settings
//
//  Served from `src/server/routes/settings.ts` rather than from this directory,
//  because the settings screen writes. The schema still belongs here: this file is
//  the client contract, and splitting it by which handler happens to answer would
//  leave the SPA importing its types from two places.
// ---------------------------------------------------------------------------

/**
 * One stored prompt version, without its text.
 *
 * `chars` instead of `body` on purpose. The version list exists to be scanned —
 * four keys times two locales times every edit ever made — and shipping every body
 * would put the whole editing history of a multi-kilobyte prompt into a payload
 * that renders as a list of dates. The body arrives from
 * `GET /api/settings/prompts/:id` when a version is opened.
 */
export const promptVersionSchema = z.object({
  id: z.string(),
  version: z.int().positive(),
  active: z.boolean(),
  note: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  chars: z.int().nonnegative(),
})

export const promptSchema = z.object({
  key: z.string(),
  /**
   * `*` for the shared text every language uses, or a language code for an override
   * someone wrote deliberately. See `domain/ai/prompt-locale.ts`.
   *
   * The payload carries the shared entry plus only those overrides that exist, so an
   * entry appearing under a language code *is* a divergence rather than a copy of the
   * seed — which is what the editor needs in order to say so.
   */
  locale: z.string(),
  /**
   * What a run would use right now — which is not always a row in `versions`.
   *
   * `resolvePrompt` falls back to the shared text and then to the built-in constant,
   * and the editor has to say which of the three it is looking at: editing "the active
   * prompt" that is really the shared one, or really the built-in constant, is how
   * someone saves a Dutch prompt over nothing. `id: null` with `version: 0` is the
   * built-in text.
   */
  active: z.object({
    id: z.string().nullable(),
    version: z.int().nonnegative(),
    locale: z.string(),
    body: z.string(),
  }),
  versions: z.array(promptVersionSchema),
})

/**
 * An account as the mapping panel shows it.
 *
 * `externalId` is deliberately absent. The panel keys on Balancr's own id, and the
 * upstream account identifier is the one field here that names something inside
 * Actual or Ghostfolio — no screen needs it, so it does not leave the server.
 */
export const accountSettingSchema = z.object({
  id: z.string(),
  source: z.enum(['actual', 'ghostfolio']),
  name: z.string(),
  kind: z.enum(['checking', 'savings', 'credit', 'investment', 'cash', 'other']),
  includeInNetWorth: z.boolean(),
  dedupeGroup: z.string().nullable(),
  isSourceOfTruth: z.boolean(),
  /**
   * Which of this row's fields a person decided, rather than a rule.
   *
   * On screen so that a suggestion can say what it would overwrite and a reader can
   * tell an answer they gave from one that was derived for them. Sent as an array
   * rather than the stored JSON string: the client should not be parsing a column.
   */
  decidedFields: z.array(z.enum(['kind', 'includeInNetWorth', 'dedupeGroup', 'isSourceOfTruth'])),
  /**
   * Why this row's value isn't in net worth, or `null` when it is counted (#245).
   *
   * Derived from the same three fields already on this object, so it never
   * disagrees with `computeNetWorth` — but a person reading `includeInNetWorth:
   * true` and a dedupe group with no source of truth has no way to see that the
   * two together still add up to "not counted" without this.
   */
  netWorthExclusionReason: z.enum(EXCLUSION_REASONS).nullable(),
})

export const spendMonthSchema = z.object({
  month: monthKey(),
  runCount: z.int().nonnegative(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cachedTokens: z.int().nonnegative(),
  costMicroEur: microEur(),
})

/**
 * The operational status of this instance: checks, jobs, upstream probes.
 *
 * `reason` is a closed vocabulary rather than a message because the settings page is
 * rendered in two languages and a sentence composed here can only be in one of them.
 * The strings that *are* text — a job's recorded error, a probe check's detail — are
 * quoted from what an upstream or a job actually said, and are shown as quotations
 * rather than as the application's own words.
 */
/**
 * camelCase, unlike the hyphenated `shape-mismatch` the probe stores.
 *
 * These are the client's i18n keys — `t('status.reason.shapeMismatch')` — and every
 * other catalogue key in this project is camelCase. The probe's own vocabulary stays
 * hyphenated because it is written to a database column and read back by builds that
 * did not write it; this one is a wire format between two files that ship together.
 */
export const checkReasons = [
  /** No probe has run and no job has ever run. A new deployment, not a fault. */
  'neverRun',
  /** `JOBS_ENABLED=false`. Supported, and the reason everything else looks old. */
  'jobsOff',
  /** The job that reaches this upstream failed on its last attempt. */
  'jobFailed',
  /** Reachable, but not with anything we parse. Needs a code change, not patience. */
  'shapeMismatch',
  /** Down, restarting, or the token was rejected. Resolves itself. */
  'unreachable',
  /** Balancr's own database could not be read, so nothing else could be determined. */
  'unreadable',
] as const

export const checkSchema = z.object({
  name: z.enum(['database', 'actual', 'ghostfolio', 'jobs']),
  status: z.enum(['ok', 'degraded', 'failed', 'unknown']),
  reason: z.enum(checkReasons).nullable(),
})

export const jobStatusSchema = z.object({
  name: z.string(),
  status: z.enum(['idle', 'running', 'ok', 'error']),
  lastRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  lastDurationMs: z.int().nonnegative().nullable(),
  error: z.string().nullable(),
  /** `every 60 minutes`, `daily at 03:00`. Null for a row no registry entry owns. */
  schedule: z.string().nullable(),
})

export const probeStatusSchema = z.object({
  source: z.string(),
  status: z.enum(['ok', 'unreachable', 'shape-mismatch']),
  checkedAt: z.string(),
  checks: z.array(
    z.object({
      path: z.string(),
      status: z.enum(['ok', 'unreachable', 'shape-mismatch']),
      detail: z.string(),
      error: z.string().optional(),
    }),
  ),
  warnings: z.array(z.string()),
  /** False when the stored report could not be read; the status still stands. */
  detailAvailable: z.boolean(),
})

export const statusSchema = z.object({
  /** Whether traffic should be routed here. One input: the database. */
  ready: z.boolean(),
  /** Something is wrong that does not stop this instance serving. */
  degraded: z.boolean(),
  at: z.string(),
  version: z.string().nullable(),
  revision: z.string().nullable(),
  jobsEnabled: z.boolean(),
  checks: z.array(checkSchema),
  jobs: z.array(jobStatusSchema),
  probes: z.array(probeStatusSchema),
})

/**
 * `GET /api/settings` — everything the settings screen shows, in one response.
 *
 * One request rather than six, because every panel on that page is small and the
 * page is opened to compare them: which prompt is active, what the thresholds are,
 * what the month has cost. Six endpoints would each carry a round trip and none of
 * them would be reusable elsewhere.
 *
 * `params` and `paramDefaults` are the domain schema itself rather than a copy of
 * its twenty-odd fields. A hand-written mirror would drift on the first threshold
 * anyone adds, and drift here means a form that silently drops a field.
 */
/**
 * What the benchmark panel edits, and the file it is editing against.
 *
 * `file` is null when no benchmark is configured, which is a supported deployment and
 * not a fault — the panel then says the comparison is off rather than drawing an empty
 * form. Everything under it is read-only: the shares are the survey's, and a screen that
 * let somebody edit them would be a screen that manufactures a reference.
 *
 * The two editable things are `household` and the per-category `coicop` code. The
 * mapping is offered as the **twelve COICOP divisions** plus `00`, not as the ten
 * reference groups, because three divisions share the survey's "other" line and picking
 * "other" would leave the code ambiguous. `groups` travels with the file so the form can
 * show which reference line each division feeds.
 */
export const benchmarkSettingSchema = z.object({
  file: z
    .object({
      source: benchmarkSourceSchema,
      equivalence: z.object({
        scale: z.string(),
        firstPersonBp: basisPoints(),
        additionalPersonBp: basisPoints(),
        childBp: basisPoints(),
        childAgeBelow: z.int().positive(),
        citation: z.string(),
        sourceUrl: z.string().nullable(),
        lastVerified: dateKey(),
        status: z.enum(['confirmed', 'transcribed']),
      }),
      groups: z.array(
        z.object({
          id: z.enum(BENCHMARK_GROUPS),
          shareBp: basisPoints(),
          coicop: z.array(z.enum(COICOP_DIVISIONS)),
        }),
      ),
      /**
       * Whether the file carries the average household's euro total and size.
       *
       * Without it only the `mix` comparison is possible, and the panel has to say so —
       * otherwise the euro figures nobody can see look like a bug rather than a block
       * left blank on purpose.
       */
      hasReferenceHousehold: z.boolean(),
      transcribed: z.array(z.enum(BENCHMARK_BLOCKS)),
    })
    .nullable(),
  household: z.object({
    members: z.array(
      z.object({
        birthYear: z.int(),
        custodyBp: basisPoints(),
        label: z.string().optional(),
      }),
    ),
    /** A name for the first person on the scale, or absent for the panel's placeholder (#215). */
    selfLabel: z.string().optional(),
    /**
     * The stated share of a shared cost that is yours, or null to derive it from the
     * roster (#44). Null is a value the form has to be able to show and to send back:
     * clearing the box means "go back to deriving it", which absent could not express.
     */
    sharedCostBp: basisPoints().nullable(),
  }),
  /** The code that means "not household consumption", for the picker's own entry. */
  outsideCode: z.literal(OUTSIDE_CONSUMPTION),
  /**
   * Every category Balancr has seen, with the division it is mapped to.
   *
   * From `category_meta` rather than from a month's facts: a category with no spending
   * this month still needs mapping, and the point of this list is to get through it.
   * `spentCents` is the latest computed month, so the biggest unmapped envelope can be
   * dealt with first.
   */
  categories: z.array(
    z.object({
      categoryId: z.string(),
      categoryName: z.string(),
      isIncome: z.boolean(),
      hidden: z.boolean(),
      coicop: z.string().nullable(),
      /**
       * Whether this category's cost is split with a co-parent (#44).
       *
       * In the same list as the mapping because it is the same table and the same
       * screen, and because until this field was on the wire the flag had no control
       * anywhere: it could only be set by approving a proposal or answering a
       * clarification, both of which need a Gemini key. The split is the one feature
       * that would otherwise have been unreachable without AI.
       */
      custodyShared: z.boolean(),
      spentCents: cents(),
    }),
  ),
})

/**
 * One owned property and its mortgage, if it has one (#227). Sent as-is — the wire shape
 * is the stored record, not a derived balance: `outstandingBalanceCents` needs a date,
 * and `today` is a fact about the request, not about settings.
 */
const propertyMortgageSchema = z.object({
  principalCents: cents(),
  /** The date `principalCents` was true. */
  anchorDate: z.string(),
  rateBp: basisPoints(),
  monthlyPaymentCents: cents(),
  remainingTermMonths: z.int(),
})

const propertySchema = z.object({
  id: z.string(),
  kind: z.enum(['primary', 'rental']),
  label: z.string(),
  propertyValueCents: cents().nullable(),
  /** Monthly rent received. Only meaningful for a `rental`. */
  rentCents: cents().nullable(),
  /** Null when the property has no mortgage — paid off, or bought outright. */
  mortgage: propertyMortgageSchema.nullable(),
})

export const propertiesSettingSchema = z.object({
  properties: z.array(propertySchema),
})

export const settingsSchema = z.object({
  /**
   * Which build is answering.
   *
   * On this page rather than on `/bootstrap`, which is public: the commit a
   * container was built from is exactly the fact an unauthenticated caller should
   * not be handed, and the person who needs it is signed in and looking at
   * settings.
   */
  build: z.object({ version: z.string().nullable(), revision: z.string().nullable() }),
  /**
   * How far back this instance looks, and how far back it actually has figures.
   *
   * `months` is `JOBS_HISTORY_MONTHS` itself — the setting, not a fact about the data.
   * `earliest`/`latest` are what the sync pass has actually covered so far, which lags
   * the setting on a deployment younger than its own window and is nullable for the
   * same reason `months` on `/api/insights` is: nothing aggregated yet. An edit outside
   * this range is never picked up (#162), and this is where that boundary is visible.
   */
  history: z.object({
    months: z.number().int(),
    earliest: monthKey().nullable(),
    latest: monthKey().nullable(),
  }),
  profile: z.object({
    email: z.string().nullable(),
    displayName: z.string().nullable(),
    locale: z.string(),
    role: z.enum(['owner', 'viewer']),
  }),
  /** What the language control may offer, from `SUPPORTED_LOCALES`. */
  locales: z.object({ supported: z.array(z.string()), default: z.string() }),
  params: aggregateParamsSchema,
  paramDefaults: aggregateParamsSchema,
  /** The risk profile advice is measured against. See `riskProfileSettingSchema`. */
  advice: riskProfileSettingSchema,
  /** The benchmark file, the household it is scaled to, and the mapping. */
  benchmark: benchmarkSettingSchema,
  /** The owned properties and their mortgages, tracked by Balancr rather than Ghostfolio (#227). */
  property: propertiesSettingSchema,
  prompts: z.array(promptSchema),
  accounts: z.array(accountSettingSchema),
  /**
   * Accounts that may be the same money, as ids rather than rows.
   *
   * The rows are already in `accounts`; repeating them would leave two copies of
   * `isSourceOfTruth` in one payload, and the copy the screen happened to read
   * would decide whether it drew the warning.
   */
  dedupe: z.array(
    z.object({
      ghostfolioId: z.string(),
      /**
       * One Actual account, not a list. The previous shape sent every ungrouped
       * Actual row for every Ghostfolio row, having compared nothing.
       */
      actualId: z.string(),
      /**
       * Why this pair is suspected, strongest first and never empty.
       *
       * On the wire so the panel can say "same name, same balance" rather than
       * asking a person to take the suggestion on faith. A suggestion nobody can
       * audit gets accepted blindly or silenced destructively, and silencing it
       * used to mean grouping two unrelated accounts — which drops real money out
       * of net worth.
       */
      signals: z.array(z.enum(['name', 'nameContains', 'balance', 'currency'])).min(1),
    }),
  ),
  ai: z.object({
    /**
     * Whether the panel's figures and its one paid button mean anything.
     *
     * Off, every number below is a true zero of an unused allowance, and the run-by-
     * hand control would price a call the server refuses with a `409`. The panel says
     * so instead. Same object as `insights.ai`, from the same function, because a page
     * that offered the button and a page that explained its absence disagreeing about
     * which one to draw is exactly the bug one shared answer prevents.
     */
    availability: aiAvailabilitySchema,
    /** From `.env`, not editable here: a model is a deployment decision. */
    models: z.object({ fast: z.string(), deep: z.string() }),
    month: monthKey(),
    spentMicroEur: microEur(),
    budgetMicroEur: microEur(),
    remainingMicroEur: microEur(),
    usedBp: basisPoints(),
    exceeded: z.boolean(),
    /** Newest first, so the page can show this month and the trend behind it. */
    history: z.array(spendMonthSchema),
    /** The owner's running "what's coming up" note, or `''` when none is set (#217). */
    upcomingNote: z.string(),
  }),
})

/** `GET /api/settings/prompts/:id` — one version, text included. */
export const promptBodySchema = promptVersionSchema.extend({
  key: z.string(),
  locale: z.string(),
  body: z.string(),
})

/** `POST /api/settings/prompts/diff` and the dry run's `diff` field. */
export const promptDiffSchema = z.object({
  active: z.object({
    id: z.string().nullable(),
    version: z.int().nonnegative(),
    locale: z.string(),
  }),
  stat: z.object({
    added: z.int().nonnegative(),
    removed: z.int().nonnegative(),
    identical: z.boolean(),
  }),
  lines: z.array(
    z.object({
      op: z.enum(['same', 'add', 'del']),
      text: z.string(),
      oldLine: z.int().positive().nullable(),
      newLine: z.int().positive().nullable(),
    }),
  ),
})

/**
 * `GET /api/ai/estimate` — what a run on this month would cost, having spent
 * nothing to find out.
 */
export const aiEstimateSchema = z.object({
  /**
   * Which run was priced.
   *
   * Echoed back rather than left implicit, because the two prices differ by an order
   * of magnitude: an analysis is the fast model over a month of aggregates, a narrative
   * is the deep model with room to think. A page that showed one figure under the other
   * button would understate a real charge by more than ten times, and it is the sort of
   * mix-up that only shows up on the invoice (#158).
   */
  kind: z.enum(['findings', 'narrative', 'budget_nudge']),
  month: monthKey(),
  model: z.string(),
  /** Null when the month has no facts, which is also when a dry run is pointless. */
  payloadChars: z.int().nonnegative().nullable(),
  estimateMicroEur: microEur(),
  allowed: z.boolean(),
  /**
   * A code for the catalogue, never a sentence. Null when allowed for the
   * ordinary reason — the one exception is `'reused'`, which is `allowed: true`
   * with a reason, because "free" is worth saying even though it is not a
   * refusal (#160).
   */
  reason: z.string().nullable(),
})

/**
 * `POST /api/ai/narrative` — the monthly review, written on request (#158).
 *
 * Deliberately thin: `status` and `reason` are the codes the page turns into a sentence,
 * and `costMicroEur` is what the press actually cost rather than the estimate it was
 * offered at. The prose itself is not here — the client reloads `/api/insights`, which is
 * where a narrative is read from on every other visit, so there is one renderer for it
 * and no second path that could show a review the reload would not.
 *
 * `status: 'cached'` at a cost of zero is a normal outcome and not a failure: two people
 * pressing the button, or one pressing it twice, gets the stored review back. The one
 * thing this endpoint will not do is write a second narrative for a month that has one —
 * that would need `force`, which no route exposes, because it is the only way to pay the
 * deep model twice for the same month.
 */
export const aiNarrativeRunSchema = z.object({
  status: z.enum(['ok', 'cached', 'capped', 'error', 'skipped']),
  reason: z.string(),
  runId: z.string().nullable(),
  period: monthKey(),
  locale: z.string(),
  degraded: z.boolean(),
  costMicroEur: microEur(),
})

/**
 * `POST /api/ai/budget-nudge` — the note read alongside the trailing average, for one
 * month's pending `budget_amount.set` proposals (#217).
 *
 * Thin like `aiNarrativeRunSchema`, for the same reason: the adjusted proposals are not
 * listed here — the client reloads `/api/insights`, where `createProposal`'s supersede
 * has already made the change indistinguishable from #45's own suggestion.
 */
export const aiBudgetNudgeRunSchema = z.object({
  status: z.enum(['ok', 'capped', 'error', 'skipped']),
  reason: z.string(),
  runId: z.string().nullable(),
  month: monthKey(),
  locale: z.string(),
  degraded: z.boolean(),
  costMicroEur: microEur(),
})

/**
 * `POST /api/ai/dry-run` — a real analysis whose findings are thrown away.
 *
 * `costMicroEur` is what it actually cost, not an estimate: the run happened, the
 * ledger row was written, and the editor has to show the price of what was just
 * pressed rather than the guess from before.
 */
export const aiDryRunSchema = z.object({
  status: z.enum(['ok', 'capped', 'error', 'skipped']),
  reason: z.string(),
  runId: z.string().nullable(),
  month: monthKey(),
  locale: z.string(),
  promptId: z.string().nullable(),
  promptVersion: z.int().nonnegative(),
  degraded: z.boolean(),
  costMicroEur: microEur(),
  /**
   * The findings the run produced, sentences included.
   *
   * The one place the API returns rendered text alongside the codes, and for the
   * same reason the clarification cards do: what is being judged here is the
   * model's output, and a reviewer comparing two prompt versions needs to read
   * what each one would have put on the page. `code` and `metrics` come too, so
   * nothing forces the editor to trust the sentence.
   */
  findings: z.array(
    z.object({
      code: z.string(),
      categoryId: z.string().nullable(),
      severity: z.enum(['info', 'warn', 'alert']),
      negative: z.boolean(),
      text: z.string(),
      /** 0–100, or null on a degraded run where nothing judged the order. */
      confidence: z.number().min(0).max(100).nullable(),
      metrics: z.record(z.string(), z.int()),
    }),
  ),
  /**
   * What the model asked about, as it would have reached the queue. Nothing here
   * is answerable — a dry run writes no rows — so it is a preview, not a card.
   */
  clarifications: z.array(
    z.object({
      code: z.string(),
      categoryId: z.string(),
      categoryName: z.string(),
      guess: z.string(),
    }),
  ),
  /**
   * What grounding threw away: a code the signals never carried, a duplicate, a
   * label that matches no category. Shown rather than swallowed, because it is a
   * verdict on the prompt being tested — a version that produces six dropped
   * findings is the version not to activate.
   */
  dropped: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      reason: z.enum(['no_signal', 'duplicate', 'unknown_label', 'bad_guess']),
    }),
  ),
})

/**
 * What a refresh answers with.
 *
 * Deliberately thin, and the thinness is the design. A refresh starts jobs and does
 * not wait for them, so there is nothing here about progress or outcome — that lives
 * in the `freshness` block every read already carries, and inventing a second status
 * surface would mean two answers to "is it done" that can disagree.
 *
 * `accepted` and `requested` differ whenever dependents were added: asking for
 * `portfolio` accepts `portfolio`, `networth` and `signals`, because a page where the
 * holdings are current and net worth is not would be *partly* fresh with nothing on
 * it saying which half. Returning both means the client can say what it actually set
 * running rather than repeating what it asked for.
 *
 * `startedAt` is what the client compares each job's `lastRunAt` against to know its
 * refresh has been served. Without it a job that finishes between the `202` and the
 * first poll is indistinguishable from one that never started, and the button spins
 * for ever on the fastest possible outcome.
 */
export const refreshAcceptedSchema = z.object({
  accepted: z.array(z.string()),
  requested: z.array(z.string()),
  startedAt: z.string(),
})

/**
 * One `## [X.Y.Z] — <date>` section of `CHANGELOG.md`, rendered for the dialog
 * the version number in the header opens.
 *
 * `html` is produced by the same sanitiser the AI narrative uses
 * (`util/markdown.ts`): escape everything first, emit only a fixed tag list with
 * no attributes. The changelog is written by a person rather than a model, but a
 * dialog injecting raw markdown into the page wants that property regardless of
 * who wrote the source — and it means an issue reference like `[#203](...)`
 * collapses to plain text the same way it does everywhere else this renderer is
 * used. `releaseUrl` is built from `version` rather than parsed out of the
 * markdown, so it survives that collapse.
 */
export const changelogEntrySchema = z.object({
  version: z.string(),
  date: z.string(),
  html: z.string(),
  releaseUrl: z.string(),
})

/**
 * `available` is false when `CHANGELOG.md` was not shipped with this build — an
 * image built before this endpoint existed, or a dev checkout with a stale
 * `dist/`. The dialog reads that as "no changelog shipped with this build"
 * rather than treating an empty list as a repository with no history.
 */
export const changelogSchema = z.object({
  available: z.boolean(),
  entries: z.array(changelogEntrySchema),
})

/**
 * `POST /api/proposals/:id/apply` and `.../reject` (#45).
 *
 * Deliberately thin, like `refreshAcceptedSchema`: the client already reloads
 * `/api/insights` on success, which is the one place a proposal's card and the
 * data it changed both live, so this only needs to confirm which decision was
 * recorded rather than re-describe the diff.
 */
export const proposalDecisionSchema = z.object({
  id: z.string(),
  status: z.enum(['applied', 'rejected']),
})

/**
 * `POST /api/proposals/:id/adjust` (#220) — the owner edits a `budget_amount.set`
 * card's amount before applying it.
 */
export const proposalAdjustRequest = z.strictObject({
  amountCents: z.int(),
})

/**
 * Setting the amount back to what it already is supersedes to a no-op, which
 * `createProposal` refuses — so the adjust endpoint rejects the *original*
 * proposal instead of creating a new one (see `adjustProposal`). Either way
 * `id` is the row the client should now act on: apply it, or nothing further
 * to do when it comes back `rejected`.
 */
export const proposalAdjustSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'rejected']),
})

/**
 * `POST /api/proposals/apply-batch` — one result per id asked for, in request
 * order, whether or not it succeeded (#45).
 *
 * A per-id shape rather than an all-or-nothing status, because the request
 * that motivates the endpoint — "apply everything I've selected" — is exactly
 * the one where a stale id in the middle of the list must not silently take
 * the rest down with it.
 */
export const proposalBatchApplySchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      /** A sentence safe to show inline next to the row, null on success. */
      reason: z.string().nullable(),
    }),
  ),
})

/**
 * `POST /api/ai/category-guess/estimate` — what a guess batch on this
 * selection would cost, having spent nothing to find out (#216).
 *
 * Same shape as `aiEstimateSchema` minus `month`/`kind`: a guess batch is
 * priced by the selection, not by a month, and there is only the one kind of
 * call this button can make.
 */
export const categoryGuessEstimateSchema = z.object({
  ids: z.array(z.string()),
  model: z.string(),
  /** Null when none of `ids` has a cached candidate. */
  payloadChars: z.int().nonnegative().nullable(),
  estimateMicroEur: microEur(),
  allowed: z.boolean(),
  reason: z.string().nullable(),
})

/**
 * `POST /api/ai/category-guess` — however many selected candidates became a
 * real proposal, or why not (#216).
 *
 * `results` follows `proposalBatchApplySchema`'s own contract: one entry per
 * id asked for, in request order, whether or not it succeeded — an id with no
 * cached candidate, one the model was not confident about, and one that
 * became a proposal are told apart by `reason`, not by being left out.
 */
export const categoryGuessRunSchema = z.object({
  status: z.enum(['ok', 'capped', 'error', 'skipped']),
  reason: z.string(),
  runId: z.string().nullable(),
  locale: z.string(),
  degraded: z.boolean(),
  costMicroEur: microEur(),
  results: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  /** What the model returned and grounding threw away. Recorded, not hidden. */
  dropped: z.array(
    z.object({
      clientId: z.string(),
      categoryLabel: z.string(),
      reason: z.enum(['duplicate', 'unknown_client', 'not_offered']),
    }),
  ),
})

/**
 * The two shapes that appear inside more than one response, named because the
 * client renders each with one component. Structurally identical to the interfaces
 * in `freshness.ts` and `hygiene.ts`, which is the point: those describe what the
 * builders produce, these describe what the SPA is allowed to rely on, and the
 * `parse` in each handler is where the two are made to agree.
 */
export type Freshness = z.infer<typeof freshnessSchema>
export type Hygiene = z.infer<typeof hygieneSchema>

export type Overview = z.infer<typeof overviewSchema>
export type Budget = z.infer<typeof budgetSchema>
export type Portfolio = z.infer<typeof portfolioSchema>
export type Advice = z.infer<typeof adviceSchema>
export type Suggestion = z.infer<typeof suggestionSchema>
export type DriftLine = z.infer<typeof driftLineSchema>
export type Insights = z.infer<typeof insightsSchema>
export type AiRun = z.infer<typeof aiRunSchema>
export type AiRunPayload = z.infer<typeof aiRunPayloadSchema>
export type Settings = z.infer<typeof settingsSchema>
export type Status = z.infer<typeof statusSchema>
export type CheckReason = (typeof checkReasons)[number]
export type JobStatus = z.infer<typeof jobStatusSchema>
export type ProbeStatus = z.infer<typeof probeStatusSchema>
export type PromptSetting = z.infer<typeof promptSchema>
export type PromptVersionSetting = z.infer<typeof promptVersionSchema>
export type PromptBody = z.infer<typeof promptBodySchema>
export type PromptDiff = z.infer<typeof promptDiffSchema>
export type AccountSetting = z.infer<typeof accountSettingSchema>
export type SpendMonthSetting = z.infer<typeof spendMonthSchema>
export type RiskProfileSetting = z.infer<typeof riskProfileSettingSchema>
export type BenchmarkSetting = z.infer<typeof benchmarkSettingSchema>
export type PropertiesSetting = z.infer<typeof propertiesSettingSchema>
export type BenchmarkWire = z.infer<typeof benchmarkComparisonSchema>
export type BenchmarkGroupLine = z.infer<typeof benchmarkGroupSchema>
export type CustodyWire = z.infer<typeof custodySplitSchema>
export type BandsSetting = z.infer<typeof bandsSettingSchema>
export type AiAvailabilityWire = z.infer<typeof aiAvailabilitySchema>
export type AiEstimate = z.infer<typeof aiEstimateSchema>
export type AiNarrativeRun = z.infer<typeof aiNarrativeRunSchema>
export type AiBudgetNudgeRun = z.infer<typeof aiBudgetNudgeRunSchema>
export type AiDryRun = z.infer<typeof aiDryRunSchema>
export type RefreshAccepted = z.infer<typeof refreshAcceptedSchema>
export type ChangelogEntry = z.infer<typeof changelogEntrySchema>
export type Changelog = z.infer<typeof changelogSchema>
export type CategoryGuessEstimateWire = z.infer<typeof categoryGuessEstimateSchema>
export type CategoryGuessRunWire = z.infer<typeof categoryGuessRunSchema>
export type CategoryGuessCandidateWire = z.infer<typeof categoryGuessCandidateSchema>
export type ProposalDecision = z.infer<typeof proposalDecisionSchema>
export type ProposalBatchApply = z.infer<typeof proposalBatchApplySchema>
export type ProposalAdjustResult = z.infer<typeof proposalAdjustSchema>
