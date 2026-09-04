/**
 * #217 — the note read alongside the trailing average, for one month's pending
 * `budget_amount.set` proposals.
 *
 * `suggestBudgetAmounts` (#45) only ever looks backward at a category's own
 * history, so it has no way to know a dentist bill or an annual renewal is
 * coming. This is the *optional*, owner-priced pass that reads the running
 * "what's coming up" note (`upcoming-note.ts`) beside those suggestions and may
 * adjust one — without touching the deterministic generator at all.
 *
 * Same shape as `category-guess.ts`'s single-shot call: opaque labels
 * (`redactBudgetNudgeBatch`), a closed vocabulary (`nudgeJsonSchema`), and an
 * adjustment is only turned into a proposal once `groundNudgeResponse` has
 * checked it was actually offered and inside its magnitude bound — a
 * schema-valid but invented or wildly-off amount is dropped, not clamped.
 *
 * Unlike a category guess, no Actual call is needed: a category's name comes
 * from `loadCategoryMeta`'s `nameSnapshot`, the same trust
 * `budgetAmountSetHandler` already places in it. So the estimate is
 * synchronous, unlike `estimateCategoryGuess`.
 *
 * Two early-outs write no `ai_runs` row at all, because nothing was attempted:
 * an empty note (`no_note`, checked *before* touching candidates or budget —
 * this is what guarantees "empty note → no AI path taken at all") and a month
 * with no pending budget-amount proposal to adjust (`no_candidates`).
 */
import { callGemini, GeminiError } from '../../adapters/gemini/client.ts'
import { costMicroEur, estimateCostMicroEur } from '../../adapters/gemini/pricing.ts'
import {
  groundNudgeResponse,
  nudgeJsonSchema,
  parseNudgeResponse,
  type DroppedNudge,
} from '../../adapters/gemini/schemas.ts'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { logger } from '../../logger.ts'
import { loadCategoryMeta, loadFacts } from '../aggregate/facts.ts'
import { checkBudget } from './budget.ts'
import { hashPayload } from './payload-hash.ts'
import { composeSystemPrompt } from './prompts.ts'
import {
  createProposal,
  encodeBudgetTarget,
  pendingBudgetProposals,
  PROPOSAL_HANDLERS,
  ProposalError,
  type BudgetAmountSet,
} from './proposals.ts'
import { redactBudgetNudgeBatch, type NudgeCandidateInput, type NudgeRedaction } from './redact.ts'
import { recordRun } from './runs.ts'
import { loadUpcomingNote } from './upcoming-note.ts'

const log = logger.child({ module: 'ai.budget-nudge' })

/**
 * What one nudge is assumed to cost in output tokens, for the guard.
 *
 * Generous on purpose, same reasoning as `category-guess.ts`'s own constant: an
 * adjustment is `{label, amountCents}`, a few dozen characters, and even a full
 * batch of every category in a month is well under this.
 */
const EXPECTED_OUTPUT_TOKENS = 2_000

/**
 * The system prompt for a budget nudge.
 *
 * Not a `prompts` table key, same reasoning as `CATEGORY_GUESS_SYSTEM`: this is
 * mechanical rather than editorial, and a tunable version of it would be one
 * more place a figure could be edited into a different figure.
 */
const BUDGET_NUDGE_SYSTEM = `
You read one household's note about what is coming up, and a list of categories
with next month's suggested budget, computed from a trailing average of past
spending.

Rules:

1. Only adjust a candidate the note actually names or clearly refers to. Leave
   every other candidate alone — omit it from your answer entirely.
2. An adjustment should account for something the note describes that the
   trailing average could not know about — a one-off or unusually large
   upcoming cost. Do not adjust a candidate just because its baseline looks
   high or low.
3. Answer with a whole-euro amount in cents, using the candidate's own label.
   Do not invent a label and do not answer for a candidate not in the list.
4. If the note names nothing that matches any candidate, return no
   adjustments.
`.trim()

/**
 * The per-run instruction. Short, because the rules live in the cached system
 * prompt above and every word here is billed on every call.
 */
function budgetNudgeInstruction(payload: NudgeRedaction['payload']): string {
  return [
    `The household's note is below, alongside ${payload.candidates.length} candidate`,
    'budgets for', payload.month, '. Adjust only the ones the note speaks to.',
  ].join(' ')
}

export type BudgetNudgeStatus = 'ok' | 'capped' | 'error' | 'skipped'

export type BudgetNudgeReason =
  | 'ok'
  | 'no_note'
  | 'no_candidates'
  | 'month_budget_exceeded'
  | 'estimate_exceeds_remaining'
  | 'call_failed'
  | 'bad_response'

export interface BudgetNudgeEstimate {
  month: string
  model: string
  /** Null when there is no note, or nothing pending to adjust. */
  payloadChars: number | null
  estimateMicroEur: number
  allowed: boolean
  reason: string | null
}

export interface BudgetNudgeOutcome {
  status: BudgetNudgeStatus
  reason: BudgetNudgeReason
  runId: string | null
  month: string
  locale: string
  /** True whenever no adjusted proposal could come out of this call. */
  degraded: boolean
  /** How many pending proposals were actually adjusted. */
  adjusted: number
  /** What the model returned and grounding threw away. Recorded, not hidden. */
  dropped: DroppedNudge[]
  costMicroEur: number
}

export interface BudgetNudgeOptions {
  month: string
  locale?: string
  model?: string
  now?: Date
  signal?: AbortSignal
  /** Who pressed the button, for the ledger. */
  userId?: string | null
}

/**
 * Everything one call needs, gathered once — shared by the estimate and the
 * run so both price and send the same payload for the same month.
 *
 * Purely local: the pending proposals, the live facts and the category names
 * are all already mirrored into SQLite, unlike `category-guess.ts`'s
 * `prepareGuessBatch`, which reaches Actual for category names.
 */
function prepareNudgeBatch(db: Db, month: string, locale: string): NudgeRedaction | null {
  const pending = pendingBudgetProposals(db, month)
  if (pending.length === 0) return null

  const budgetedAmountFor = new Map<string, number>()
  for (const row of pending) {
    let payload: unknown
    try {
      payload = JSON.parse(row.payloadJson)
    } catch {
      continue
    }
    try {
      const clean = PROPOSAL_HANDLERS['budget_amount.set'].parse(payload) as BudgetAmountSet
      budgetedAmountFor.set(decodeBudgetTargetCategoryId(row.targetRef), clean.amountCents)
    } catch {
      // A stale or malformed proposal is simply not offered as a candidate.
    }
  }
  if (budgetedAmountFor.size === 0) return null

  const facts = loadFacts(db, month)
  const factByCategoryId = new Map(facts.map((fact) => [fact.categoryId, fact]))
  const categoryMetaById = loadCategoryMeta(db)

  const inputs: NudgeCandidateInput[] = []
  for (const [categoryId, suggestedCents] of budgetedAmountFor) {
    const fact = factByCategoryId.get(categoryId)
    if (fact === undefined) continue
    inputs.push({
      categoryId,
      suggestedCents,
      currentCents: fact.budgetedCents,
      baselineCents: fact.baseline?.baselineCents ?? null,
    })
  }
  if (inputs.length === 0) return null

  const note = loadUpcomingNote(db).text
  return redactBudgetNudgeBatch(inputs, categoryMetaById, month, locale, note)
}

function decodeBudgetTargetCategoryId(targetRef: string): string {
  const at = targetRef.lastIndexOf(':')
  return at < 0 ? targetRef : targetRef.slice(0, at)
}

/**
 * What a nudge for this month would cost, without making one.
 *
 * Free, local arithmetic — same contract as `estimateAnalysis`/`estimateNarrative`:
 * the price a button must show before it is pressed. `no_note` is checked
 * *before* anything else, so an empty note never even looks at what is pending.
 */
export function estimateBudgetNudge(
  db: Db,
  options: { month: string; locale?: string; model?: string; now?: Date },
): BudgetNudgeEstimate {
  const locale = options.locale ?? config.DEFAULT_LOCALE
  const model = options.model ?? config.GEMINI_MODEL_FAST
  const refused = (reason: string): BudgetNudgeEstimate => ({
    month: options.month,
    model,
    payloadChars: null,
    estimateMicroEur: 0,
    allowed: false,
    reason,
  })

  if (loadUpcomingNote(db).text.trim() === '') return refused('no_note')

  const redaction = prepareNudgeBatch(db, options.month, locale)
  if (redaction === null) return refused('no_candidates')

  const payloadChars = JSON.stringify(redaction.payload).length
  const estimateMicroEur = estimateCostMicroEur(model, payloadChars, EXPECTED_OUTPUT_TOKENS)
  const decision = checkBudget(db, estimateMicroEur, options.now ?? new Date())

  return {
    month: options.month,
    model,
    payloadChars,
    estimateMicroEur,
    allowed: decision.allowed,
    reason: decision.allowed ? null : decision.reason,
  }
}

/**
 * Adjusts however many of this month's pending budget-amount proposals the
 * note actually speaks to, or explains why it could not.
 *
 * Never throws for a Gemini failure, same reason as `runCategoryGuess`: the
 * ledger row is the only trace that this was attempted at all. A stale
 * candidate does not fail the batch — `createProposal`'s `ProposalError` is
 * caught per item, exactly as `runCategoryGuess` catches it.
 */
export async function runBudgetNudge(db: Db, options: BudgetNudgeOptions): Promise<BudgetNudgeOutcome> {
  const locale = options.locale ?? config.DEFAULT_LOCALE
  const model = options.model ?? config.GEMINI_MODEL_FAST
  const now = options.now ?? new Date()
  const month = options.month

  if (loadUpcomingNote(db).text.trim() === '') {
    log.info({ month }, 'no upcoming note; budget nudge skipped')
    return {
      status: 'skipped',
      reason: 'no_note',
      runId: null,
      month,
      locale,
      degraded: true,
      adjusted: 0,
      dropped: [],
      costMicroEur: 0,
    }
  }

  const redaction = prepareNudgeBatch(db, month, locale)
  if (redaction === null) {
    log.info({ month }, 'no pending budget-amount proposals for the month; budget nudge skipped')
    return {
      status: 'skipped',
      reason: 'no_candidates',
      runId: null,
      month,
      locale,
      degraded: true,
      adjusted: 0,
      dropped: [],
      costMicroEur: 0,
    }
  }

  const { payload, categoryIdFor } = redaction
  const payloadHash = hashPayload(payload)

  const estimate = estimateCostMicroEur(model, JSON.stringify(payload).length, EXPECTED_OUTPUT_TOKENS)
  const decision = checkBudget(db, estimate, now)
  if (!decision.allowed) {
    const runId = recordRun(db, {
      kind: 'budget_nudge',
      model,
      locale,
      period: month,
      payload,
      payloadHash,
      status: 'capped',
      error: decision.reason,
      userId: options.userId ?? null,
    })
    log.warn({ month, reason: decision.reason }, 'budget nudge capped by the monthly AI budget')
    return {
      status: 'capped',
      reason: decision.reason,
      runId,
      month,
      locale,
      degraded: true,
      adjusted: 0,
      dropped: [],
      costMicroEur: 0,
    }
  }

  let result
  try {
    result = await callGemini({
      model,
      systemPrompt: composeSystemPrompt(BUDGET_NUDGE_SYSTEM, locale),
      instruction: budgetNudgeInstruction(payload),
      payload,
      responseJsonSchema: nudgeJsonSchema(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    const message = error instanceof GeminiError ? error.message : String(error)
    const runId = recordRun(db, {
      kind: 'budget_nudge',
      model,
      locale,
      period: month,
      payload,
      payloadHash,
      status: 'error',
      error: message,
      userId: options.userId ?? null,
    })
    log.error({ month, err: message }, 'budget nudge call failed')
    return {
      status: 'error',
      reason: 'call_failed',
      runId,
      month,
      locale,
      degraded: true,
      adjusted: 0,
      dropped: [],
      costMicroEur: 0,
    }
  }

  const cost = costMicroEur(result.model, result.usage)

  let grounded
  try {
    grounded = groundNudgeResponse(parseNudgeResponse(result.text), payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const runId = recordRun(db, {
      kind: 'budget_nudge',
      model: result.model,
      locale,
      period: month,
      payload,
      payloadHash,
      status: 'error',
      usage: result.usage,
      durationMs: result.durationMs,
      error: message,
      userId: options.userId ?? null,
    })
    log.error({ month, err: message }, 'budget nudge response rejected')
    return {
      status: 'error',
      reason: 'bad_response',
      runId,
      month,
      locale,
      degraded: true,
      adjusted: 0,
      dropped: [],
      costMicroEur: cost,
    }
  }

  const runId = recordRun(db, {
    kind: 'budget_nudge',
    model: result.model,
    locale,
    period: month,
    payload,
    payloadHash,
    status: 'ok',
    usage: result.usage,
    durationMs: result.durationMs,
    userId: options.userId ?? null,
  })

  if (grounded.dropped.length > 0) {
    log.warn({ month, dropped: grounded.dropped }, 'grounding discarded model adjustments')
  }

  let adjusted = 0
  for (const adjustment of grounded.adjustments) {
    const categoryId = categoryIdFor.get(adjustment.label)
    if (categoryId === undefined) continue

    try {
      await createProposal(db, {
        type: 'budget_amount.set',
        targetRef: encodeBudgetTarget(categoryId, month),
        payload: { amountCents: adjustment.amountCents },
        runId,
      })
      adjusted += 1
    } catch (error) {
      if (!(error instanceof ProposalError)) throw error
      log.warn({ month, categoryId, err: error.message }, 'budget nudge could not adjust one candidate')
    }
  }

  return {
    status: 'ok',
    reason: 'ok',
    runId,
    month,
    locale,
    degraded: false,
    adjusted,
    dropped: grounded.dropped,
    costMicroEur: cost,
  }
}
