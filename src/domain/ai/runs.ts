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
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lt, or, sql } from 'drizzle-orm'
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
      // One statement, so this can never race with another insert's own read of
      // the same max — see the column's doc comment in `schema.ts` (#514).
      seq: sql`(SELECT COALESCE(MAX(seq), 0) + 1 FROM ai_runs)`,
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
 *
 * The prefix match moves into the `LIKE` below rather than staying a JS `.find`
 * over every candidate (#606): `key.model` is a configured alias (`gemini-3.7-flash`),
 * never attacker input, so `${key.model}%` composes safely the same way `period`'s own
 * `LIKE` prefix does above.
 */
export function findReusableRun(db: Db, tenantId: string, key: ReuseKey): AiRunRow | null {
  const provider = resolvedIntegrations(db, tenantId).ai.provider
  return (
    db
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
          like(aiRuns.model, `${key.model}%`),
        ),
      )
      .orderBy(desc(aiRuns.createdAt))
      .limit(1)
      .get() ?? null
  )
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
 * Ties on `createdAt` break on `seq` rather than being left to chance: two runs
 * recorded synchronously (as tests, and a fast nightly job, both do) can share the
 * same millisecond, and without a second key the `period` filter's index scan
 * ordered them differently from the unfiltered scan — same rows, same requested
 * order, different answer depending on which query plan SQLite picked.
 *
 * `seq` rather than `id` (#510) or SQLite's implicit `rowid` (#514): `id` is a
 * random UUID, so its lexicographic order has nothing to do with insertion order.
 * `rowid` tracked insertion order only until a migration ever rebuilt this table,
 * which one already has. `seq` is a plain persisted column instead (see its doc
 * comment in `schema.ts`) — an ordinary data column that any future rebuild's
 * `INSERT ... SELECT` carries over unchanged, whatever order it reads the old
 * table in.
 *
 * `before` pages backwards from a previously-returned row (#502): the run list has
 * no upper bound on `ai_runs`, so a fixed `limit` alone makes anything past it
 * permanently unreachable through the log. Naming the exact `(createdAt, seq)`
 * pair this function's own `ORDER BY` produces, rather than an offset, means a run
 * recorded between two page fetches shifts nothing already paged past.
 */
export function recentRuns(
  db: Db,
  tenantId: string,
  limit = 50,
  period?: string | { kind: 'month' | 'year'; value: string },
  before?: { createdAt: Date; seq: number },
): AiRunRow[] {
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
          and(eq(aiRuns.createdAt, before.createdAt), lt(aiRuns.seq, before.seq)),
        )
  const match = and(
    eq(aiRuns.tenantId, tenantId),
    ...(periodMatch === undefined ? [] : [or(periodMatch, isNull(aiRuns.period))]),
    ...(cursorMatch === undefined ? [] : [cursorMatch]),
  )
  return db
    .select()
    .from(aiRuns)
    .where(match)
    .orderBy(desc(aiRuns.createdAt), desc(aiRuns.seq))
    .limit(limit)
    .all()
}

/**
 * The `(createdAt, seq)` pair `recentRuns`'s `before` cursor needs, resolved
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
): { createdAt: Date; seq: number } | null {
  return (
    db
      .select({ createdAt: aiRuns.createdAt, seq: aiRuns.seq })
      .from(aiRuns)
      .where(and(eq(aiRuns.id, id), eq(aiRuns.tenantId, tenantId)))
      .get() ?? null
  )
}

/**
 * Nulls `requestText`/`responseText`/`payloadJson` on every run of this tenant's
 * older than `olderThan`, leaving the rest of the row untouched (#503, #539) —
 * cost and usage accounting reads the row forever; only the verbatim text and
 * the payload it was built from are bounded. `payloadHash` is kept: it is what
 * `findReusableRun` matches on, and a hash cannot be turned back into the
 * payload it was computed from, so clearing it here would cost nothing in
 * privacy and a working reuse check in return.
 *
 * The `or(isNotNull(...))` guard is not for correctness (nulling an already-null
 * column is a no-op) — it keeps the returned count meaningful: "rows actually
 * cleared tonight", not "every old row that happened to still have nothing to clear".
 *
 * `since`, when given, adds a lower bound (#512): the caller's promise that
 * every row older than it was already cleared by an earlier successful sweep,
 * so this run only has to scan the delta since then rather than the whole
 * table again. Both bounds are applied together, so a `since` that turns out
 * to be *after* `olderThan` — which a shortened retention window can produce —
 * simply matches nothing rather than skipping rows that now qualify; it is
 * always safe to omit, only ever an optimisation to include.
 */
export function clearStaleRunData(db: Db, tenantId: string, olderThan: Date, since?: Date): number {
  return db
    .update(aiRuns)
    .set({ requestText: null, responseText: null, payloadJson: null })
    .where(
      and(
        eq(aiRuns.tenantId, tenantId),
        lt(aiRuns.createdAt, olderThan),
        ...(since === undefined ? [] : [gte(aiRuns.createdAt, since)]),
        or(
          isNotNull(aiRuns.requestText),
          isNotNull(aiRuns.responseText),
          isNotNull(aiRuns.payloadJson),
        ),
      ),
    )
    .run().changes
}

/**
 * The stored payload, parsed back.
 *
 * Returns `null` for a row whose payload was cleared by `clearStaleRunData`
 * (#539) exactly as it does for unparseable JSON: both are "nothing left to
 * show", and every caller already treats that as the audit view's own finding
 * rather than a reason to throw — see `buildRunPayload` and `noteChangedSince`.
 */
export function loadRunPayload(db: Db, tenantId: string, id: string): unknown | null {
  const row = loadRun(db, tenantId, id)
  if (row === null || row.payloadJson === null) return null
  try {
    return JSON.parse(row.payloadJson)
  } catch {
    return null
  }
}
