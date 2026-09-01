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
import { and, desc, eq } from 'drizzle-orm'
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
  status: RunStatus
  /** Null for a run that used the built-in prompt rather than a stored version. */
  promptId?: string | null
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
      payloadJson: JSON.stringify(run.payload),
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

/** Recent runs of every kind, newest first — the spend page's table. */
export function recentRuns(db: Db, limit = 50): AiRunRow[] {
  return db.select().from(aiRuns).orderBy(desc(aiRuns.createdAt)).limit(limit).all()
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
