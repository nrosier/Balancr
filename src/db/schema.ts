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
    /** 0..1 — how much of the above was confirmed by the user vs inferred. */
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
    /** Share of total spend, basis points. Drives ordering. */
    materialityBp: integer('materiality_bp').notNull().default(0),
    /** The model's proposed answer — the user confirms or edits, not writes. */
    suggestionJson: text('suggestion_json'),
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
    computedAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.month, t.categoryId] }),
    index('facts_month_idx').on(t.month),
    index('facts_category_idx').on(t.categoryId),
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
    /** Verbatim redacted payload. */
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
  netWorthSnapshots,
  portfolioSnapshots,
  portfolioMetrics,
  prompts,
  aiRuns,
  aiFindings,
  aiNarratives,
  proposals,
  jobs,
  settings,
}
