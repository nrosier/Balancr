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
import { aggregateParamsSchema } from '../../../domain/aggregate/params.ts'

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
  locale: z.string(),
  /**
   * What a run would use right now — which is not always a row in `versions`.
   *
   * `resolvePrompt` falls back to `DEFAULT_LOCALE`'s active version and then to the
   * built-in text, and the editor has to say which of the three it is looking at:
   * editing "the active prompt" that is really the English one, or really the
   * built-in constant, is how someone saves a Dutch prompt over nothing. `id: null`
   * with `version: 0` is the built-in text.
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
    z.object({ ghostfolioId: z.string(), possibleMirrorIds: z.array(z.string()) }),
  ),
  ai: z.object({
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
  month: monthKey(),
  model: z.string(),
  /** Null when the month has no facts, which is also when a dry run is pointless. */
  payloadChars: z.int().nonnegative().nullable(),
  estimateMicroEur: microEur(),
  allowed: z.boolean(),
  /** A code for the catalogue, never a sentence. Null when allowed. */
  reason: z.string().nullable(),
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
export type Settings = z.infer<typeof settingsSchema>
export type PromptSetting = z.infer<typeof promptSchema>
export type PromptVersionSetting = z.infer<typeof promptVersionSchema>
export type PromptBody = z.infer<typeof promptBodySchema>
export type PromptDiff = z.infer<typeof promptDiffSchema>
export type AccountSetting = z.infer<typeof accountSettingSchema>
export type SpendMonthSetting = z.infer<typeof spendMonthSchema>
export type AiEstimate = z.infer<typeof aiEstimateSchema>
export type AiDryRun = z.infer<typeof aiDryRunSchema>
