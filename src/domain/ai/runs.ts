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
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { aiRuns } from '../../db/schema.ts'
import { costMicroEur, ZERO_USAGE, type TokenUsage } from '../../adapters/gemini/pricing.ts'

export type AiRunRow = typeof aiRuns.$inferSelect
export type RunKind = AiRunRow['kind']
export type RunStatus = AiRunRow['status']

export interface RecordRun {
  kind: RunKind
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
   * Only pass this to override the computed figure — Google reporting a price we
   * do not model. Otherwise the cost is derived from `model` and `usage`, so a
   * caller cannot record a call as free by forgetting a field.
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
export function recordRun(db: Db, run: RecordRun): string {
  const usage = run.usage ?? ZERO_USAGE
  // A call that never went out has no tokens, so this is zero for `capped` and
  // `blocked` without a status check.
  const cost = run.costMicroEurOverride ?? costMicroEur(run.model, usage)

  const rows = db
    .insert(aiRuns)
    .values({
      kind: run.kind,
      model: run.model,
      promptId: run.promptId ?? null,
      locale: run.locale,
      period: run.period ?? null,
      payloadJson: JSON.stringify(run.payload),
      payloadHash: run.payloadHash,
      reusedFromRunId: run.reusedFromRunId ?? null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
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

export function loadRun(db: Db, id: string): AiRunRow | null {
  return db.select().from(aiRuns).where(eq(aiRuns.id, id)).get() ?? null
}

/**
 * The most recent successful run of a kind — what a page falls back to.
 *
 * `status = 'ok'` only: an errored run has no usable output, and serving a capped
 * run's empty payload as the cached answer would show a blank month.
 */
export function latestSuccessfulRun(db: Db, kind: RunKind): AiRunRow | null {
  return (
    db
      .select()
      .from(aiRuns)
      .where(and(eq(aiRuns.kind, kind), eq(aiRuns.status, 'ok')))
      .orderBy(desc(aiRuns.createdAt))
      .limit(1)
      .get() ?? null
  )
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
export function findReusableRun(db: Db, key: ReuseKey): AiRunRow | null {
  const candidates = db
    .select()
    .from(aiRuns)
    .where(
      and(
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
 * `period` narrows it to one month **plus every run about no month at all**, which is
 * the insights ledger's query (#158). The `IS NULL` half is not a leak: a chat turn
 * answers a question rather than a month, and so does a run that failed before it knew
 * which month it was for. Dropping those would hide them under every month on the
 * picker, and a ledger row nobody can reach is not an audit. Omit `period` for the
 * spend page, which is about the money and wants every row.
 *
 * Ties on `createdAt` break on `rowid` rather than being left to chance: two runs
 * recorded synchronously (as tests, and a fast nightly job, both do) can share the
 * same millisecond, and without a second key the `period` filter's index scan
 * ordered them differently from the unfiltered scan — same rows, same requested
 * order, different answer depending on which query plan SQLite picked.
 */
export function recentRuns(db: Db, limit = 50, period?: string): AiRunRow[] {
  const query = db.select().from(aiRuns)
  const scoped =
    period === undefined
      ? query
      : query.where(or(eq(aiRuns.period, period), isNull(aiRuns.period)))
  return scoped
    .orderBy(desc(aiRuns.createdAt), desc(sql`rowid`))
    .limit(limit)
    .all()
}

/**
 * The stored payload, parsed back.
 *
 * Returns `null` rather than throwing on unparseable JSON: this is the audit
 * view, and a row whose payload cannot be read is itself the finding.
 */
export function loadRunPayload(db: Db, id: string): unknown | null {
  const row = loadRun(db, id)
  if (row === null) return null
  try {
    return JSON.parse(row.payloadJson)
  } catch {
    return null
  }
}
