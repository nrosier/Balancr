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
  severity: z.enum(['info', 'warn', 'critical']),
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
      totalCents: cents(),
      liquidCents: cents(),
      investedCents: cents(),
      debtCents: cents(),
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
  uncategorised: z
    .object({ txnCount: z.int().nonnegative(), amountCents: cents() })
    .nullable(),
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
  valueCents: cents(),
  currency: z.string(),
})

export const portfolioSchema = z.object({
  freshness: freshnessSchema,
  date: dateKey().nullable(),
  totalValueCents: cents().nullable(),
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
})

// ---------------------------------------------------------------------------
//  Insights
// ---------------------------------------------------------------------------

export const insightsSchema = z.object({
  freshness: freshnessSchema,
  month: monthKey().nullable(),
  signals: z.array(signalSchema),
  narrative: z
    .object({
      period: z.string(),
      locale: z.string(),
      /** Markdown, generated in this locale. The one free-text field in the API. */
      body: z.string(),
      generatedAt: z.string(),
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
    }),
  ),
  spend: z.object({
    month: monthKey(),
    spentMicroEur: z.int().nonnegative(),
    budgetMicroEur: z.int().nonnegative(),
    usedBp: basisPoints(),
    exceeded: z.boolean(),
  }),
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
export type Insights = z.infer<typeof insightsSchema>
