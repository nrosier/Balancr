/**
 * Balancr schema (SQLite via Drizzle).
 *
 * Conventions:
 *  - Money is ALWAYS integer cents. Actual stores amounts this way too, so no
 *    float ever touches a balance. Columns are suffixed `_cents`.
 *  - Months are text `YYYY-MM`, dates text `YYYY-MM-DD` — same as Actual, so
 *    values can be compared and sorted without conversion.
 *  - Tables are grouped as: identity, source mapping, category knowledge,
 *    computed facts, AI, ops. "Computed facts" are rebuilt idempotently from
 *    the sources and must never be hand-edited; everything else is durable
 *    state that would hurt to lose.
 */
import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  sqliteView,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

const uuid = () => text().$defaultFn(() => crypto.randomUUID())
const createdAt = () =>
  integer({ mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())

// ============================================================================
//  Identity & auth
// ============================================================================

export const users = sqliteTable(
  'users',
  {
    id: uuid().primaryKey(),
    /** Authentik subject claim. Null for a local-only account. */
    oidcSub: text('oidc_sub'),
    email: text(),
    displayName: text('display_name'),
    /** Per-user UI language. Falls back to DEFAULT_LOCALE. */
    locale: text().notNull().default('en'),
    role: text({ enum: ['owner', 'viewer'] })
      .notNull()
      .default('owner'),
    disabled: integer({ mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
  },
  (t) => [uniqueIndex('users_oidc_sub_uq').on(t.oidcSub)],
)

/**
 * Break-glass password login. Deliberately a separate table: the common case is
 * an account with no local password at all, and this keeps the hash out of every
 * user query.
 */
export const localCredentials = sqliteTable('local_credentials', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** argon2id. */
  passwordHash: text('password_hash').notNull(),
  /** TOTP is mandatory for local login, so this is not nullable. */
  totpSecret: text('totp_secret').notNull(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: integer('locked_until', { mode: 'timestamp_ms' }),
  passwordChangedAt: createdAt(),
})

export const sessions = sqliteTable(
  'sessions',
  {
    /** Opaque random id; the cookie carries this and nothing else. */
    id: text().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** How this session was established, for the audit trail. */
    method: text({ enum: ['oidc', 'local'] }).notNull(),
    createdAt: createdAt(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    ip: text(),
    userAgent: text('user_agent'),
  },
  (t) => [
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
)

// ============================================================================
//  Source mapping
// ============================================================================

/**
 * The fix for net-worth double counting.
 *
 * If Actual holds an off-budget "Investments" account AND Ghostfolio holds the
 * same positions, both appear here with the same `dedupeGroup`; exactly one row
 * in the group carries `isSourceOfTruth`. Net worth sums only source-of-truth
 * rows, so the same money can never be counted twice.
 */
export const accountMap = sqliteTable(
  'account_map',
  {
    id: uuid().primaryKey(),
    source: text({ enum: ['actual', 'ghostfolio'] }).notNull(),
    /** Account id as the source system knows it. */
    externalId: text('external_id').notNull(),
    name: text().notNull(),
    kind: text({
      enum: ['checking', 'savings', 'credit', 'investment', 'cash', 'other'],
    })
      .notNull()
      .default('other'),
    /** Off-budget accounts are excluded from spend but may still count here. */
    includeInNetWorth: integer('include_in_net_worth', { mode: 'boolean' })
      .notNull()
      .default(true),
    dedupeGroup: text('dedupe_group'),
    isSourceOfTruth: integer('is_source_of_truth', { mode: 'boolean' })
      .notNull()
      .default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('account_map_source_external_uq').on(t.source, t.externalId),
    index('account_map_dedupe_idx').on(t.dedupeGroup),
  ],
)

// ============================================================================
//  Category knowledge — the asset that accumulates value over time
// ============================================================================

/**
 * What Balancr knows about each Actual category beyond its name. This is the
 * only table whose contents cannot be regenerated from the sources, and the one
 * whose loss would actually hurt — back it up.
 */
export const categoryMeta = sqliteTable(
  'category_meta',
  {
    /** Actual's category id. */
    categoryId: text('category_id').primaryKey(),
    /** Name as last seen in Actual, so renames are detectable. */
    nameSnapshot: text('name_snapshot').notNull(),
    /**
     * Actual's own flags, refreshed on every sync.
     *
     * Unlike everything below them these are not the user's answers, they are the
     * source's — which is why the sync pass overwrites them and never overwrites a
     * description. They live here so that a later pass can reconstruct a whole
     * `MonthlyFact` out of SQLite, without Actual having to be up.
     */
    isIncome: integer('is_income', { mode: 'boolean' }).notNull().default(false),
    hidden: integer({ mode: 'boolean' }).notNull().default(false),
    /** The user's own answer to "what is this budget for?" */
    userDescription: text('user_description'),
    /** COICOP class, for the (deferred) Statbel benchmark mapping. */
    coicopCode: text('coicop_code'),
    nature: text({ enum: ['fixed', 'variable', 'discretionary', 'income'] }),
    /** Spread across the period instead of spiking in one month. */
    expectedFrequency: text('expected_frequency', {
      enum: ['monthly', 'quarterly', 'annual', 'irregular'],
    })
      .notNull()
      .default('monthly'),
    /** A cost shared with the other parent under the custody arrangement. */
    custodyShared: integer('custody_shared', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * Redaction flag. A sensitive category reaches Gemini as an opaque label
     * plus COICOP class and nature — never its name. See domain/ai/redact.ts.
     */
    sensitive: integer({ mode: 'boolean' }).notNull().default(false),
    /**
     * 0..100 — how much of the above the user confirmed rather than Balancr
     * inferred. Each answered clarification raises it; nothing lowers it.
     */
    confidence: integer().notNull().default(0),
    updatedAt: createdAt(),
  },
  (t) => [index('category_meta_sensitive_idx').on(t.sensitive)],
)

/**
 * Categories whose purpose is still unclear. Only categories above a
 * materiality threshold are enqueued — being interrogated about a €4 envelope
 * is how a tool like this gets abandoned.
 */
export const clarificationQueue = sqliteTable(
  'clarification_queue',
  {
    id: uuid().primaryKey(),
    categoryId: text('category_id').notNull(),
    /** i18n key for the question, so it renders in the user's language. */
    questionCode: text('question_code').notNull(),
    /**
     * The run whose payload produced the guess, for the audit trail. Plain text
     * rather than a foreign key, for the same reason `audit_log` has none: the
     * question outlives the ledger row that suggested it, and a pruned run must
     * neither block the delete nor blank the provenance of a question the user
     * still has to answer.
     */
    runId: text('run_id'),
    /** Share of total spend, basis points. Drives ordering. */
    materialityBp: integer('materiality_bp').notNull().default(0),
    /** The model's proposed answer — the user confirms or edits, not writes. */
    suggestionJson: text('suggestion_json'),
    /**
     * `answered` and `dismissed` rows are kept for ever, and they are what makes
     * "asked once" true: the queue is its own record of every question already
     * put to the user, including the ones whose answer is not visible in a
     * `category_meta` column (a frequency of `monthly` is both the default and a
     * legitimate answer).
     */
    status: text({ enum: ['open', 'answered', 'dismissed'] })
      .notNull()
      .default('open'),
    createdAt: createdAt(),
    answeredAt: integer('answered_at', { mode: 'timestamp_ms' }),
  },
  (t) => [
    uniqueIndex('clarification_open_uq')
      .on(t.categoryId, t.questionCode)
      .where(sql`status = 'open'`),
    index('clarification_status_idx').on(t.status, t.materialityBp),
  ],
)

// ============================================================================
//  Computed facts — rebuilt idempotently, never hand-edited
// ============================================================================

export const monthlyCategoryFacts = sqliteTable(
  'monthly_category_facts',
  {
    month: text().notNull(), // YYYY-MM
    categoryId: text('category_id').notNull(),
    /**
     * Actual's own figure for the month, sign-normalised so spend is positive.
     * Taken from `getBudgetMonth` rather than recomputed, so category totals
     * agree with Actual's UI by construction — that reconciliation is the
     * acceptance test the whole app's credibility rests on.
     */
    spentCents: integer('spent_cents').notNull().default(0),
    /** Assigned this month. Actual's `budgeted`. */
    budgetedCents: integer('budgeted_cents').notNull().default(0),
    /**
     * Actual's `balance`: what is left after carry-in. Negative means overspent
     * on the envelope, which is overspend signal #2 and is distinct from simply
     * spending more than was assigned this month.
     */
    availableCents: integer('available_cents').notNull().default(0),
    /** Actual's `carryover`: whether overspending rolls into next month. */
    carryoverEnabled: integer('carryover_enabled', { mode: 'boolean' })
      .notNull()
      .default(false),
    txnCount: integer('txn_count').notNull().default(0),
    /**
     * Our own AQL sum of the same month, kept only to compare against
     * `spentCents`. A non-zero difference means a hygiene rule is wrong; it
     * surfaces as a data-quality finding instead of waiting to be spotted by
     * eye.
     */
    recomputedSpentCents: integer('recomputed_spent_cents'),
    /** EWMA over the trailing window, winsorised. Null until enough history. */
    ewmaBaselineCents: integer('ewma_baseline_cents'),
    /** (spent - baseline) / baseline, basis points. Null when no baseline. */
    baselineDeltaBp: integer('baseline_delta_bp'),
    /**
     * The rest of `BaselineResult`, so a stored fact is the whole fact.
     *
     * Without these a later pass could read a baseline but not what it was made
     * of, and would have to recompute it from Actual to say anything about it —
     * which is the one thing this table exists to avoid. All four are null exactly
     * when `ewma_baseline_cents` is.
     */
    baselineCurrentCents: integer('baseline_current_cents'),
    /** Observations behind the average, so thin evidence is visible. */
    baselineMonthsUsed: integer('baseline_months_used'),
    /** Months per observation, from the category's expected frequency. */
    baselineWindowMonths: integer('baseline_window_months'),
    /** How far winsorisation moved the norm, basis points. */
    baselineWinsorEffectBp: integer('baseline_winsor_effect_bp'),
    computedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.month, t.categoryId] }),
    index('facts_month_idx').on(t.month),
    index('facts_category_idx').on(t.categoryId),
  ],
)

/**
 * One row per month, from Actual's own month totals.
 *
 * Derived like `monthly_category_facts`, and stored for the same reason: every
 * later pass reads the month from here rather than asking Actual again. Without
 * it the AI pass and the API would each need Actual up and a full budget download
 * to state a savings rate that was already computed hours earlier.
 *
 * The uncategorised counters live here rather than in their own table because
 * they are a property of the month: "in August, 12 transactions worth EUR 340
 * had no category". Per-transaction detail is deliberately absent — it would be
 * the one place in this schema holding a payee.
 */
export const monthlyTotals = sqliteTable(
  'monthly_totals',
  {
    month: text().primaryKey(), // YYYY-MM
    incomeCents: integer('income_cents').notNull().default(0),
    spentCents: integer('spent_cents').notNull().default(0),
    budgetedCents: integer('budgeted_cents').notNull().default(0),
    toBudgetCents: integer('to_budget_cents').notNull().default(0),
    fromLastMonthCents: integer('from_last_month_cents').notNull().default(0),
    balanceCents: integer('balance_cents').notNull().default(0),
    /** Null in a month with no income — not zero, and not minus infinity. */
    savingsRateBp: integer('savings_rate_bp'),
    uncategorisedTxnCount: integer('uncategorised_txn_count').notNull().default(0),
    /** Positive-out, so a negative figure is an unassigned refund. */
    uncategorisedCents: integer('uncategorised_cents').notNull().default(0),
    computedAt: createdAt(),
  },
)

/**
 * Where Actual's own `spent` and our AQL recomputation disagree.
 *
 * A row here means one of our hygiene rules is wrong — a transfer not paired up,
 * a split not expanded — and the category and month are the whole lead for
 * finding out which. Persisted rather than only logged, because the hygiene score
 * and the `recompute_mismatch` findings are computed in a later pass than the one
 * that spots the drift, and because "it was fine yesterday" is worth being able
 * to check.
 */
export const recomputeMismatches = sqliteTable(
  'recompute_mismatches',
  {
    month: text().notNull(),
    categoryId: text('category_id').notNull(),
    categoryName: text('category_name').notNull(),
    /** Actual's figure. */
    actualCents: integer('actual_cents').notNull(),
    /** Ours. */
    recomputedCents: integer('recomputed_cents').notNull(),
    /** `recomputed - actual`, signed so the direction of the drift is visible. */
    differenceCents: integer('difference_cents').notNull(),
    computedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.month, t.categoryId] }),
    index('mismatch_month_idx').on(t.month),
  ],
)

/**
 * The hygiene score for a month, with the deductions that produced it.
 *
 * A single number for "can these figures be trusted" is only useful if it can be
 * taken apart, so the deductions are stored beside it — `hygiene.ts` computes the
 * score by subtracting named amounts from 10 000, and a score on a page with no
 * explanation behind it is exactly the kind of figure people learn to ignore.
 *
 * Its own table rather than a column on `monthly_totals`: the score is computed a
 * pass later than the totals are, and a second writer to that row would have the
 * sync pass wipe the score every time it ran.
 */
export const monthlyHygiene = sqliteTable('monthly_hygiene', {
  month: text().primaryKey(),
  /** 0..10000. 10 000 means nothing was deducted. */
  scoreBp: integer('score_bp').notNull(),
  /** `[{reason, bp}]` — what was taken off and why. */
  deductionsJson: text('deductions_json').notNull(),
  computedAt: createdAt(),
})

/**
 * The deterministic findings for a month, as computed — not as ranked.
 *
 * These are facts, so all of them are kept: the per-category and total caps in
 * `domain/ai/findings.ts` are a presentation decision and are applied when the
 * page or the payload is built, not when the row is written. Capping here would
 * mean a threshold change silently rewrote history.
 *
 * `subject_key` exists because SQLite treats NULLs as distinct in a unique
 * index, so a nullable `category_id` in the primary key would let the same
 * household signal be inserted twice. Empty string for "no subject".
 */
export const monthlySignals = sqliteTable(
  'monthly_signals',
  {
    month: text().notNull(),
    /** A `FindingCode`. Text, not an enum: the vocabulary lives in domain/ai. */
    code: text().notNull(),
    /** Category id, account id, or `''` for a household-level signal. */
    subjectKey: text('subject_key').notNull(),
    subjectId: text('subject_id'),
    /** Category or account name as it was when the signal was computed. */
    subjectName: text('subject_name'),
    severity: text({ enum: ['info', 'warn', 'alert'] }).notNull(),
    /** The numbers behind the claim: cents as cents, ratios as basis points. */
    metricsJson: text('metrics_json').notNull(),
    computedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.month, t.code, t.subjectKey] }),
    index('signals_month_idx').on(t.month, t.severity),
  ],
)

export const netWorthSnapshots = sqliteTable(
  'net_worth_snapshots',
  {
    date: text().notNull(), // YYYY-MM-DD
    accountMapId: text('account_map_id')
      .notNull()
      .references(() => accountMap.id, { onDelete: 'cascade' }),
    valueCents: integer('value_cents').notNull(),
    currency: text().notNull().default('EUR'),
    computedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.date, t.accountMapId] }),
    index('networth_date_idx').on(t.date),
  ],
)

export const portfolioSnapshots = sqliteTable(
  'portfolio_snapshots',
  {
    date: text().notNull(),
    /** ISIN when known, otherwise the provider symbol. */
    instrument: text().notNull(),
    symbol: text(),
    isin: text(),
    name: text(),
    /** Fractional shares are real, so quantity is not an integer. */
    quantity: text().notNull(),
    priceCents: integer('price_cents').notNull(),
    valueCents: integer('value_cents').notNull(),
    currency: text().notNull().default('EUR'),
    computedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.date, t.instrument] }),
    index('portfolio_date_idx').on(t.date),
  ],
)

export const portfolioMetrics = sqliteTable('portfolio_metrics', {
  date: text().primaryKey(),
  /** Time- and money-weighted return, basis points. */
  twrBp: integer('twr_bp'),
  mwrBp: integer('mwr_bp'),
  totalValueCents: integer('total_value_cents').notNull().default(0),
  /** Allocation and drift as JSON — shape belongs to domain/portfolio. */
  allocationJson: text('allocation_json'),
  driftJson: text('drift_json'),
  /** What the fund fees actually cost per year, in euros, not percent. */
  terAnnualCents: integer('ter_annual_cents'),
  computedAt: createdAt(),
})

// ============================================================================
//  AI
// ============================================================================

/**
 * Versioned, tunable prompts. Rollback is flipping `active` — no edit ever
 * destroys the previous text. Authored in English regardless of UI language
 * (one canonical version to maintain) but stored per locale so they can diverge.
 */
export const prompts = sqliteTable(
  'prompts',
  {
    id: uuid().primaryKey(),
    /** e.g. `analysis.system`, `narrative.monthly`. */
    key: text().notNull(),
    locale: text().notNull(),
    version: integer().notNull(),
    body: text().notNull(),
    active: integer({ mode: 'boolean' }).notNull().default(false),
    note: text(),
    createdAt: createdAt(),
    createdBy: text('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    uniqueIndex('prompts_key_locale_version_uq').on(t.key, t.locale, t.version),
    // At most one active row per (key, locale) — enforced by the database
    // rather than by whoever remembers to clear the old flag.
    uniqueIndex('prompts_one_active_uq')
      .on(t.key, t.locale)
      .where(sql`active = 1`),
  ],
)

/**
 * One row per Gemini call: the audit log and the cost ledger in one place.
 * `payloadJson` is exactly what left the machine — it is the record that lets
 * you verify by hand that no payee name was ever sent.
 */
export const aiRuns = sqliteTable(
  'ai_runs',
  {
    id: uuid().primaryKey(),
    kind: text({
      enum: ['findings', 'narrative', 'clarify', 'chat', 'dryrun'],
    }).notNull(),
    model: text().notNull(),
    promptId: text('prompt_id').references(() => prompts.id, {
      onDelete: 'set null',
    }),
    locale: text().notNull(),
    /**
     * The redacted payload verbatim — what was *prepared* for this run. `status`
     * says whether it was actually sent: a `capped` or `blocked` row carries the
     * payload it would have sent, which is what makes the refusal inspectable.
     */
    payloadJson: text('payload_json').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    /** Micro-euros: cents are too coarse for a single Flash call. */
    costMicroEur: integer('cost_micro_eur').notNull().default(0),
    status: text({ enum: ['ok', 'error', 'blocked', 'capped'] }).notNull(),
    error: text(),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('ai_runs_created_idx').on(t.createdAt),
    index('ai_runs_kind_idx').on(t.kind, t.createdAt),
  ],
)

/**
 * Month-to-date AI spend, as a view over `ai_runs`.
 *
 * A view rather than a counter table: a second place that stores cost is a second
 * place that can disagree with the ledger, and the one number a cost guard must
 * never get wrong is how much has already been spent.
 *
 * Every row counts, whatever its status. A run that failed after the call still
 * cost money, and a `capped` run costs nothing — so summing the column is right
 * in both directions and no status filter is needed.
 *
 * The month is a **UTC** month, deliberately, even though the rest of the app
 * works in `TZ`. SQLite has no timezone database, so a local month would need a
 * fixed offset that is wrong half the year; a UTC month means the budget window
 * resets at 01:00 or 02:00 Brussels time on the 1st instead of midnight, which
 * moves nothing but the boundary hour — and the nightly pass runs at 03:00.
 * `domain/ai/budget.ts` computes its month key the same way, from the same rule.
 */
export const aiSpendMonthly = sqliteView('ai_spend_monthly', {
  month: text().notNull(),
  runCount: integer('run_count').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cachedTokens: integer('cached_tokens').notNull(),
  costMicroEur: integer('cost_micro_eur').notNull(),
}).as(
  // Declared with explicit columns and raw SQL rather than built from the query
  // builder, for two reasons: the columns come back as real typed columns that
  // `where` and `orderBy` accept, and the emitted DDL is exactly this text —
  // drizzle-kit renders a column reference inside an aliased `sql` fragment
  // without the snake_case rule, which produced `"createdAt"` in the view body.
  sql`select
    strftime('%Y-%m', ai_runs.created_at / 1000, 'unixepoch') as month,
    count(*) as run_count,
    coalesce(sum(ai_runs.input_tokens), 0) as input_tokens,
    coalesce(sum(ai_runs.output_tokens), 0) as output_tokens,
    coalesce(sum(ai_runs.cached_tokens), 0) as cached_tokens,
    coalesce(sum(ai_runs.cost_micro_eur), 0) as cost_micro_eur
  from ai_runs
  group by strftime('%Y-%m', ai_runs.created_at / 1000, 'unixepoch')`,
)

/**
 * Structured findings. The model emits codes and numbers; the sentence is
 * rendered from the i18n catalogue at display time. That is what makes the
 * output translatable for free and impossible to render half in English.
 */
export const aiFindings = sqliteTable(
  'ai_findings',
  {
    id: uuid().primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => aiRuns.id, { onDelete: 'cascade' }),
    /** i18n key, e.g. `above_baseline`, `subscription_creep`. */
    code: text().notNull(),
    categoryId: text('category_id'),
    month: text(),
    metric: text(),
    /** Numeric payload interpolated into the translated string. */
    valueJson: text('value_json'),
    severity: text({ enum: ['info', 'warn', 'alert'] })
      .notNull()
      .default('info'),
    /** 0..100. */
    confidence: integer().notNull().default(50),
    createdAt: createdAt(),
  },
  (t) => [
    index('ai_findings_run_idx').on(t.runId),
    index('ai_findings_severity_idx').on(t.severity),
  ],
)

/** Free-text narrative, cached per locale so a language switch is not a re-run. */
export const aiNarratives = sqliteTable(
  'ai_narratives',
  {
    id: uuid().primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => aiRuns.id, { onDelete: 'cascade' }),
    /** Period the narrative describes, e.g. `2026-08`. */
    period: text().notNull(),
    locale: text().notNull(),
    bodyMd: text('body_md').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('ai_narratives_period_locale_uq').on(t.period, t.locale)],
)

/**
 * Propose-and-apply. Nothing the AI suggests takes effect until a human
 * approves it here, which is what keeps a hostile memo field harmless.
 *
 * v1 registers only local-effect handlers (category metadata). Handlers that
 * write back to Actual arrive in a later phase.
 */
export const proposals = sqliteTable(
  'proposals',
  {
    id: uuid().primaryKey(),
    runId: text('run_id').references(() => aiRuns.id, { onDelete: 'set null' }),
    /** Selects the apply handler, e.g. `category_meta.set`. */
    type: text().notNull(),
    /** What it acts on (a category id, an account id, …). */
    targetRef: text('target_ref').notNull(),
    payloadJson: text('payload_json').notNull(),
    /** Before/after pair rendered for review. */
    renderedDiffJson: text('rendered_diff_json'),
    status: text({ enum: ['pending', 'applied', 'rejected', 'expired'] })
      .notNull()
      .default('pending'),
    createdAt: createdAt(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    appliedAt: integer('applied_at', { mode: 'timestamp_ms' }),
    appliedBy: text('applied_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    index('proposals_status_idx').on(t.status, t.createdAt),
    uniqueIndex('proposals_pending_uq')
      .on(t.type, t.targetRef)
      .where(sql`status = 'pending'`),
  ],
)

// ============================================================================
//  Ops
// ============================================================================

/**
 * Every change a human approved, and what it changed.
 *
 * Deliberately has **no foreign keys**. An audit row whose `run_id` a cascade can
 * blank, or whose actor disappears when the account is deleted, is not an audit
 * trail — it is a cache of one. The ids are stored as plain text so the row stays
 * exactly as it was written even when the run it came from has been pruned, and
 * the reader treats a dangling id as "no longer available" rather than as "never
 * happened".
 *
 * `before_json`/`after_json` hold the field-level pair, not a sentence: the same
 * reason findings store numbers rather than prose, so a trail written in a Dutch
 * session reads correctly in English.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: uuid().primaryKey(),
    at: createdAt(),
    /** `proposal.apply`, `clarification.answer`, … See domain/audit.ts. */
    action: text().notNull(),
    /** Who approved it. Null for a change the system made on its own. */
    actorId: text('actor_id'),
    /** The table the change landed in, e.g. `category_meta`. */
    entity: text().notNull(),
    /** Which row: a category id, an account id, a proposal id. */
    entityRef: text('entity_ref').notNull(),
    /** The AI run that suggested it, when one did. */
    runId: text('run_id'),
    proposalId: text('proposal_id'),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_entity_idx').on(t.entity, t.entityRef, t.at),
  ],
)

export const jobs = sqliteTable('jobs', {
  name: text().primaryKey(),
  lastRunAt: integer('last_run_at', { mode: 'timestamp_ms' }),
  lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
  nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }),
  status: text({ enum: ['idle', 'running', 'ok', 'error'] })
    .notNull()
    .default('idle'),
  lastDurationMs: integer('last_duration_ms'),
  error: text(),
})

/**
 * Rate-limit counters, kept in SQLite rather than in memory.
 *
 * The in-memory store the plugin ships with is the right default for a stateless
 * service behind a load balancer, and the wrong one here: the tighter bucket in
 * front of the AI routes exists to cap *money* over an hour, and a process that
 * restarts — a deploy, a crash loop, a container the watchdog bounced — starts
 * that hour again from zero. A counter that survives a restart is the only version
 * of an hourly spend limit that means anything.
 *
 * One row per `(bucket, client)`. `expires_at` is when the window ends, so an
 * expired row is indistinguishable from a fresh start and can be pruned at any
 * time without coordination.
 */
export const rateLimits = sqliteTable(
  'rate_limits',
  {
    /** `<bucket>:<client key>` — the bucket keeps the AI window separate. */
    key: text().primaryKey(),
    count: integer().notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('rate_limits_expires_idx').on(t.expiresAt)],
)

/** Tunable thresholds, active prompt pointers, benchmark assumptions. */
export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: createdAt(),
})

/**
 * The account kinds `account_map.kind` may hold, as a type.
 *
 * Derived from the column rather than declared beside it: a kind added to the
 * enum and forgotten here would otherwise be a silent gap in whichever `switch`
 * decides what counts as liquid.
 */
export type AccountKind = (typeof accountMap.$inferSelect)['kind']

export const schema = {
  users,
  localCredentials,
  sessions,
  accountMap,
  categoryMeta,
  clarificationQueue,
  monthlyCategoryFacts,
  monthlyTotals,
  recomputeMismatches,
  monthlySignals,
  monthlyHygiene,
  netWorthSnapshots,
  portfolioSnapshots,
  portfolioMetrics,
  prompts,
  aiRuns,
  aiSpendMonthly,
  aiFindings,
  aiNarratives,
  proposals,
  auditLog,
  jobs,
  rateLimits,
  settings,
}
