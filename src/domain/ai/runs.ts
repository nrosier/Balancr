/**
 * The AI ledger: one row per attempt, whether or not it reached Google.
 *
 * Three jobs in one table, on purpose:
 *
 *  - **The audit record.** `payload_json` is exactly what was prepared for the
 *    call, stored verbatim. It is what makes the privacy claim checkable by hand
 *    instead of by argument: open a row, read the JSON, look for a payee.
 *  - **The cost ledger.** `ai_spend_monthly` sums this table and nothing else, so
 *    there is no second counter to drift away from what was actually spent.
 *  - **The cache.** A page shows the most recent successful run for a kind, which
 *    is what lets the budget guard degrade to "yesterday's answer, with a banner"
 *    rather than to an error.
 *
 * A refused attempt is still a row. `status: 'capped'` (over budget) and
 * `'blocked'` (the call was refused before it went out) carry the payload they
 * would have sent and cost nothing — that is how a missing answer explains itself
 * instead of just being absent.
 */
import { and, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, like, lt, or, sql } from 'drizzle-orm'
import { costMicroEur } from '../../adapters/ai/pricing.ts'
import { ZERO_USAGE, type AiProvider, type TokenUsage } from '../../adapters/ai/types.ts'
import type { Db } from '../../db/index.ts'
import { aiRuns } from '../../db/schema.ts'
import { resolvedIntegrations } from '../../db/tenant-integrations.ts'

export type AiRunRow = typeof aiRuns.$inferSelect
export type RunKind = AiRunRow['kind']
export type RunStatus = AiRunRow['status']

export interface RecordRun {
  kind: RunKind
  /** The provider selected for a refusal/reuse, or the one that answered a call. */
  provider: AiProvider
  model: string
  locale: string
  /** The redacted payload. Serialised here, so no caller can store a summary. */
  payload: unknown
  /**
   * Hash of `payload`, computed by the caller once per attempt and reused
   * across every `recordRun` call in it — a `capped`/`error` row carries it
   * too, so a later attempt with the same inputs can find it (#160).
   */
  payloadHash: string
  status: RunStatus
  /**
   * The exact system+instruction+data text prepared for this attempt (#497),
   * or null if it could not be assembled (a fence-marker refusal on a
   * `blocked`/`capped` row that was never going to send anything anyway).
   */
  requestText?: string | null
  /**
   * The provider's raw reply, verbatim, wherever a result was actually
   * received — null for `capped`/`blocked`/`reused` rows and for an `error`
   * before any response existed.
   */
  responseText?: string | null
  /** The `ok` run this one served for free instead of calling the model. */
  reusedFromRunId?: string | null
  /** Null for a run that used the built-in prompt rather than a stored version. */
  promptId?: string | null
  /**
   * The month the run was about, `YYYY-MM`, or null for a run about no month.
   *
   * Optional so a caller cannot be forced to invent one, but every producer that has
   * a month passes it: without it the insights ledger can only recover a month by
   * joining to what the run produced, which is exactly nothing for the `capped` and
   * `blocked` rows the ledger exists to explain (#158).
   */
  period?: string | null
  usage?: TokenUsage
  /**
   * The already-computed tenant/provider price for a result. Required by callers
   * using explicit custom prices; built-in providers may leave it out and use the
   * dated table below.
   */
  costMicroEurOverride?: number
  error?: string | null
  durationMs?: number | null
  userId?: string | null
}

/**
 * Writes one run and returns its id.
 *
 * Cost is computed here rather than passed in. The alternative — every call site
 * doing its own multiplication — is how a ledger ends up with one kind of run
 * priced differently from another.
 */
export function recordRun(db: Db, tenantId: string, run: RecordRun): string {
  const usage = run.usage ?? ZERO_USAGE
  // A call that never went out has no tokens, so this is zero for `capped` and
  // `blocked` without a status check.
  const cost = run.costMicroEurOverride ?? costMicroEur(run.provider, run.model, usage)

  const rows = db
    .insert(aiRuns)
    .values({
      tenantId,
      kind: run.kind,
      provider: run.provider,
      model: run.model,
      promptId: run.promptId ?? null,
      locale: run.locale,
      period: run.period ?? null,
      payloadJson: JSON.stringify(run.payload),
      payloadHash: run.payloadHash,
      requestText: run.requestText ?? null,
      responseText: run.responseText ?? null,
      reusedFromRunId: run.reusedFromRunId ?? null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costMicroEur: cost,
      status: run.status,
      error: run.error ?? null,
      durationMs: run.durationMs ?? null,
      userId: run.userId ?? null,
    })
    .returning({ id: aiRuns.id })
    .all()

  const id = rows[0]?.id
  if (id === undefined) throw new Error(`failed to record ${run.kind} run`)
  return id
}

export function loadRun(db: Db, tenantId: string, id: string): AiRunRow | null {
  return (
    db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.id, id), eq(aiRuns.tenantId, tenantId)))
      .get() ?? null
  )
}

/**
 * The most recent successful run of a kind — what a page falls back to.
 *
 * `status = 'ok'` only: an errored run has no usable output, and serving a capped
 * run's empty payload as the cached answer would show a blank month.
 */
export function latestSuccessfulRun(db: Db, tenantId: string, kind: RunKind): AiRunRow | null {
  return (
    db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.tenantId, tenantId), eq(aiRuns.kind, kind), eq(aiRuns.status, 'ok')))
      .orderBy(desc(aiRuns.createdAt))
      .limit(1)
      .get() ?? null
  )
}

/**
 * How many runs of one kind this tenant has recorded since a point in time.
 *
 * The counter behind `PROMPT_VALIDATIONS_PER_DAY` (#454), and a ledger query rather than a
 * rate-limit bucket on purpose. `aiRateLimit()` buckets per route per IP, which is the
 * right shape for a burst guard and the wrong shape for a daily allowance: an IP rotation
 * defeats it, and the thing being limited here is how many times one tenant may ask a
 * probabilistic judge the same question. The run ledger is the one place a tenant's calls
 * are already all counted regardless of which address made them.
 *
 * `statuses` narrows it to what actually spent something. Omitted, every status counts.
 *
 * `SELECT count(*)` rather than reading the rows: this runs before a model call on a table
 * that grows without bound, and `ai_runs_kind_idx` serves it.
 */
export function countRunsSince(
  db: Db,
  tenantId: string,
  kind: RunKind,
  since: Date,
  statuses?: readonly RunStatus[],
): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(aiRuns)
    .where(
      and(
        eq(aiRuns.tenantId, tenantId),
        eq(aiRuns.kind, kind),
        gte(aiRuns.createdAt, since),
        statuses === undefined || statuses.length === 0
          ? undefined
          : inArray(aiRuns.status, [...statuses]),
      ),
    )
    .get()
  return row?.count ?? 0
}

export interface ReuseKey {
  kind: RunKind
  period: string
  locale: string
  payloadHash: string
  promptId: string | null
  model: string
}

/**
 * A past call that answered exactly this question, so this one does not have
 * to (#160).
 *
 * `status = 'ok'` only, on purpose: a `reused` row never chains to another —
 * every reuse traces back to exactly one real call — and a `capped`/`error`
 * row has nothing to serve. Newest first, so a prompt rolled back to an old
 * version still finds the most recent matching answer rather than the first
 * one ever recorded.
 *
 * `model` is matched by prefix rather than equality: a stored row's `model` is
 * *the model that answered* (`result.model` — Google's exact snapshot, e.g.
 * `gemini-3.7-flash-002`), while `key.model` is *the model about to be asked
 * for* (the configured alias, e.g. `gemini-3.7-flash`) — the same alias every
 * time, since we cannot know which snapshot would answer without already
 * having called it. An equality check would never match anything the alias
 * ever produced. This mirrors `priceFor`'s own family-match convention, which
 * already treats the two as the same model for billing.
 */
export function findReusableRun(db: Db, tenantId: string, key: ReuseKey): AiRunRow | null {
  const provider = resolvedIntegrations(db, tenantId).ai.provider
  const candidates = db
    .select()
    .from(aiRuns)
    .where(
      and(
        eq(aiRuns.tenantId, tenantId),
        eq(aiRuns.provider, provider),
        eq(aiRuns.kind, key.kind),
        eq(aiRuns.period, key.period),
        eq(aiRuns.locale, key.locale),
        eq(aiRuns.payloadHash, key.payloadHash),
        key.promptId === null ? isNull(aiRuns.promptId) : eq(aiRuns.promptId, key.promptId),
        eq(aiRuns.status, 'ok'),
      ),
    )
    .orderBy(desc(aiRuns.createdAt))
    .all()

  return candidates.find((row) => row.model.startsWith(key.model)) ?? null
}

/**
 * Recent runs of every kind, newest first — the spend page's table.
 *
 * `period` narrows it to one month (or, for the ledger's year mode (#345), every
 * month in a year via a `LIKE` prefix) **plus every run about no month at all**,
 * which is the insights ledger's query (#158). The `IS NULL` half is not a leak: a
 * chat turn answers a question rather than a month, and so does a run that failed
 * before it knew which month it was for. Dropping those would hide them under every
 * period on the picker, and a ledger row nobody can reach is not an audit. Omit
 * `period` for the spend page, which is about the money and wants every row.
 *
 * Ties on `createdAt` break on `rowid` rather than being left to chance: two runs
 * recorded synchronously (as tests, and a fast nightly job, both do) can share the
 * same millisecond, and without a second key the `period` filter's index scan
 * ordered them differently from the unfiltered scan — same rows, same requested
 * order, different answer depending on which query plan SQLite picked.
 *
 * `rowid` rather than `id` (#510): `id` is a random UUID, so its lexicographic
 * order has nothing to do with insertion order — a tie on `createdAt` broke on it
 * anyway, which meant "newest of two same-millisecond runs" was a coin flip, not a
 * fact. `rowid` is assigned by SQLite in strictly increasing insertion order for
 * this table, because `ai_runs` is append-only: nothing ever deletes a row (the
 * retention sweep in `clearStaleRunText` only nulls two columns), and a `rowid`
 * table only reuses a freed id after an actual delete. It is not one of this
 * table's declared columns, so it is selected here as a raw SQL expression rather
 * than a typed one.
 *
 * `before` pages backwards from a previously-returned row (#502): the run list has
 * no upper bound on `ai_runs`, so a fixed `limit` alone makes anything past it
 * permanently unreachable through the log. Naming the exact `(createdAt, rowid)`
 * pair this function's own `ORDER BY` produces, rather than an offset, means a run
 * recorded between two page fetches shifts nothing already paged past.
 */
export function recentRuns(
  db: Db,
  tenantId: string,
  limit = 50,
  period?: string | { kind: 'month' | 'year'; value: string },
  before?: { createdAt: Date; rowid: number },
): (AiRunRow & { rowid: number })[] {
  const periodMatch =
    period === undefined
      ? undefined
      : typeof period === 'string' || period.kind === 'month'
        ? eq(aiRuns.period, typeof period === 'string' ? period : period.value)
        : like(aiRuns.period, `${period.value}-%`)
  const cursorMatch =
    before === undefined
      ? undefined
      : or(
          lt(aiRuns.createdAt, before.createdAt),
          and(eq(aiRuns.createdAt, before.createdAt), sql`rowid < ${before.rowid}`),
        )
  const match = and(
    eq(aiRuns.tenantId, tenantId),
    ...(periodMatch === undefined ? [] : [or(periodMatch, isNull(aiRuns.period))]),
    ...(cursorMatch === undefined ? [] : [cursorMatch]),
  )
  return db
    .select({ ...getTableColumns(aiRuns), rowid: sql<number>`rowid` })
    .from(aiRuns)
    .where(match)
    .orderBy(desc(aiRuns.createdAt), sql`rowid desc`)
    .limit(limit)
    .all()
}

/**
 * The `(createdAt, rowid)` pair `recentRuns`'s `before` cursor needs, resolved
 * fresh from a run's wire id (#510) — the API's cursor is just an id (see
 * `GET /api/settings/ai/runs`), never the ordering pair itself, so whoever holds
 * one has to look the pair up rather than being trusted to have kept it accurate.
 * Also why an id that no longer resolves for this tenant is `null` rather than an
 * error: a stale or foreign link should end the log, not restart or crash it.
 */
export function loadRunCursor(
  db: Db,
  tenantId: string,
  id: string,
): { createdAt: Date; rowid: number } | null {
  return (
    db
      .select({ createdAt: aiRuns.createdAt, rowid: sql<number>`rowid` })
      .from(aiRuns)
      .where(and(eq(aiRuns.id, id), eq(aiRuns.tenantId, tenantId)))
      .get() ?? null
  )
}

/**
 * Nulls `requestText`/`responseText` on every run of this tenant's older than
 * `olderThan`, leaving the rest of the row untouched (#503) — cost and usage
 * accounting reads the row forever; only the verbatim text is bounded.
 *
 * The `or(isNotNull(...))` guard is not for correctness (nulling an already-null
 * column is a no-op) — it keeps the returned count meaningful: "rows actually
 * cleared tonight", not "every old row that happened to still have nothing to clear".
 */
export function clearStaleRunText(db: Db, tenantId: string, olderThan: Date): number {
  return db
    .update(aiRuns)
    .set({ requestText: null, responseText: null })
    .where(
      and(
        eq(aiRuns.tenantId, tenantId),
        lt(aiRuns.createdAt, olderThan),
        or(isNotNull(aiRuns.requestText), isNotNull(aiRuns.responseText)),
      ),
    )
    .run().changes
}

/**
 * The stored payload, parsed back.
 *
 * Returns `null` rather than throwing on unparseable JSON: this is the audit
 * view, and a row whose payload cannot be read is itself the finding.
 */
export function loadRunPayload(db: Db, tenantId: string, id: string): unknown | null {
  const row = loadRun(db, tenantId, id)
  if (row === null) return null
  try {
    return JSON.parse(row.payloadJson)
  } catch {
    return null
  }
}
