/**
 * #216 — the AI-assisted fallback below the payee-history confidence bar.
 *
 * `generateCategoryProposals` already proposes a category for a confident payee
 * match (≥2 samples, ≥80% one category) and caches everything below that bar as
 * a candidate instead of dropping it (`proposal-generators.ts`,
 * `categoryGuessCandidates`). This is what turns a *selected* candidate into a
 * real `transaction_category.set` proposal: one call, priced and pressed by the
 * owner, never run by the nightly job.
 *
 * Same shape as `narrative.ts`'s single-shot call, with the analysis pass's
 * grounding discipline bolted on: the model sees only opaque labels
 * (`redactCategoryGuessBatch`) and a closed vocabulary (`guessJsonSchema`), and
 * a guess is only turned into a proposal once `groundGuessResponse` has checked
 * it was actually among *that* candidate's own offered labels — a schema-valid
 * but borrowed or invented label is dropped, not mapped.
 *
 * A stale or already-categorised candidate does not fail the batch: `createProposal`
 * refuses a no-op with `ProposalError`, caught per item exactly as
 * `generateCategoryProposals` already catches it.
 */
import { callGemini, GeminiError } from '../../adapters/gemini/client.ts'
import { costMicroEur, estimateCostMicroEur } from '../../adapters/gemini/pricing.ts'
import {
  guessJsonSchema,
  groundGuessResponse,
  parseGuessResponse,
  type DroppedGuess,
} from '../../adapters/gemini/schemas.ts'
import { fetchCategories } from '../../adapters/actual/queries.ts'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { logger } from '../../logger.ts'
import { loadCategoryMeta } from '../aggregate/facts.ts'
import {
  loadCategoryGuessCandidatesByIds,
  type CategoryGuessCandidate,
} from '../aggregate/signals-store.ts'
import { checkBudget } from './budget.ts'
import { hashPayload } from './payload-hash.ts'
import { composeSystemPrompt } from './prompts.ts'
import { createProposal, ProposalError } from './proposals.ts'
import { redactCategoryGuessBatch, type GuessCandidateInput, type GuessRedaction } from './redact.ts'
import { recordRun } from './runs.ts'

const log = logger.child({ module: 'ai.category-guess' })

/**
 * What one guess is assumed to cost in output tokens, for the guard.
 *
 * Generous on purpose, same reasoning as every other estimate in this layer: a
 * guess is `{clientId, categoryLabel}`, a few dozen characters, and even the
 * maximum batch of 50 is well under this.
 */
const EXPECTED_OUTPUT_TOKENS = 2_000

/**
 * The system prompt for a category guess.
 *
 * Not a `prompts` table key, for the same reason `TRANSLATION_SYSTEM`
 * (`narrative.ts`) is not one: this is mechanical rather than editorial — "pick
 * the category this payee's own history most supports" has no room for a tone
 * or a house style, and a tunable version of it would be one more place a
 * figure could be edited into a different figure.
 */
const CATEGORY_GUESS_SYSTEM = `
You categorise financial transactions from a payee's own history.

Rules:

1. For each candidate, pick the one category its own history most supports —
   normally the category with the highest count in that candidate's history.
2. Use only labels that appear in that specific candidate's own history array.
   Never use a label from a different candidate's history, and never invent one.
3. If a candidate's history gives no clear preference, or you are not
   reasonably confident, omit that candidate from your answer rather than
   guessing at random.
4. Return one guess per candidate you are answering for, referencing it by its
   clientId. Nothing else.
`.trim()

/**
 * The per-run instruction. Short, because the rules live in the cached system
 * prompt above and every word here is billed on every call.
 */
function categoryGuessInstruction(payload: GuessRedaction['payload']): string {
  return [
    `Guess the category for each of the ${payload.candidates.length} candidates below,`,
    'using only that candidate’s own history. Skip any candidate you are not',
    'reasonably confident about.',
  ].join(' ')
}

export type CategoryGuessStatus = 'ok' | 'capped' | 'error' | 'skipped'

export type CategoryGuessReason =
  | 'ok'
  | 'no_candidates'
  | 'month_budget_exceeded'
  | 'estimate_exceeds_remaining'
  | 'call_failed'
  | 'bad_response'

export interface CategoryGuessItemResult {
  id: string
  ok: boolean
  /** A code safe to show inline next to the row, null on success. */
  reason: string | null
}

export interface CategoryGuessOutcome {
  status: CategoryGuessStatus
  reason: CategoryGuessReason
  runId: string | null
  locale: string
  /** True whenever no new proposal could come out of this call. */
  degraded: boolean
  /** One entry per candidate that was actually cached for the selected ids. */
  results: CategoryGuessItemResult[]
  /** What the model returned and grounding threw away. Recorded, not hidden. */
  dropped: DroppedGuess[]
  costMicroEur: number
}

export interface CategoryGuessOptions {
  /** Actual transaction ids selected on the Insights page. */
  ids: readonly string[]
  locale?: string
  /** Defaults to `GEMINI_MODEL_FAST`: this is a mechanical, single-label pick. */
  model?: string
  now?: Date
  signal?: AbortSignal
  /** Who pressed the button, for the ledger. */
  userId?: string | null
}

export interface CategoryGuessEstimate {
  ids: readonly string[]
  model: string
  /** Null when none of `ids` has a cached candidate. */
  payloadChars: number | null
  estimateMicroEur: number
  allowed: boolean
  reason: string | null
}

interface PreparedGuessBatch {
  candidates: CategoryGuessCandidate[]
  redaction: GuessRedaction
}

/**
 * Everything one call needs, gathered once — shared by the estimate and the run
 * so both price and send the same payload for the same selection.
 *
 * Unlike `prepareMonth`, this reaches Actual directly (`fetchCategories`) rather
 * than reading a local cache: category *names* are not mirrored into any local
 * table the way facts are, and this file sits outside `routes/api/`'s
 * no-upstream rule, in the same position as `proposal-generators.ts`.
 */
async function prepareGuessBatch(
  db: Db,
  ids: readonly string[],
  locale: string,
): Promise<PreparedGuessBatch | null> {
  const candidates = loadCategoryGuessCandidatesByIds(db, ids)
  if (candidates.length === 0) return null

  const categoryMetaById = loadCategoryMeta(db)
  const categories = await fetchCategories()
  const categoryNameById = new Map(categories.map((category) => [category.id, category.name]))

  const inputs: GuessCandidateInput[] = candidates.map((candidate) => ({
    transactionId: candidate.transactionId,
    amountCents: candidate.amountCents,
    history: candidate.history,
  }))

  const redaction = redactCategoryGuessBatch(inputs, categoryMetaById, categoryNameById, locale)
  return { candidates, redaction }
}

/**
 * What a guess on this selection would cost, without making one.
 *
 * Free, local arithmetic apart from the one Actual call for category names —
 * same contract as `estimateAnalysis`/`estimateNarrative`: the price a button
 * must show before it is pressed.
 */
export async function estimateCategoryGuess(
  db: Db,
  options: { ids: readonly string[]; locale?: string; model?: string; now?: Date },
): Promise<CategoryGuessEstimate> {
  const locale = options.locale ?? config.DEFAULT_LOCALE
  const model = options.model ?? config.GEMINI_MODEL_FAST
  const prepared = await prepareGuessBatch(db, options.ids, locale)

  if (prepared === null) {
    return {
      ids: options.ids,
      model,
      payloadChars: null,
      estimateMicroEur: 0,
      allowed: false,
      reason: 'no_candidates',
    }
  }

  const payloadChars = JSON.stringify(prepared.redaction.payload).length
  const estimateMicroEur = estimateCostMicroEur(model, payloadChars, EXPECTED_OUTPUT_TOKENS)
  const decision = checkBudget(db, estimateMicroEur, options.now ?? new Date())

  return {
    ids: options.ids,
    model,
    payloadChars,
    estimateMicroEur,
    allowed: decision.allowed,
    reason: decision.allowed ? null : decision.reason,
  }
}

/**
 * Turns however many selected candidates the owner picked into
 * `transaction_category.set` proposals, or explains why it could not.
 *
 * `period` is deliberately not passed to `recordRun` — a guess batch spans
 * whatever transactions were selected, not one month, so there is no single
 * period to attribute it to (see the `aiRuns` table's own doc comment).
 *
 * Never throws for a Gemini failure, same reason as `runAnalysis`/`runNarrative`:
 * the ledger row is the only trace that this was attempted at all.
 */
export async function runCategoryGuess(
  db: Db,
  options: CategoryGuessOptions,
): Promise<CategoryGuessOutcome> {
  const locale = options.locale ?? config.DEFAULT_LOCALE
  const model = options.model ?? config.GEMINI_MODEL_FAST
  const now = options.now ?? new Date()

  const prepared = await prepareGuessBatch(db, options.ids, locale)
  if (prepared === null) {
    log.info({ ids: options.ids }, 'none of the selected ids has a cached category-guess candidate')
    return {
      status: 'skipped',
      reason: 'no_candidates',
      runId: null,
      locale,
      degraded: true,
      results: options.ids.map((id) => ({ id, ok: false, reason: 'no_candidate' })),
      dropped: [],
      costMicroEur: 0,
    }
  }

  const { candidates, redaction } = prepared
  const { payload, transactionIdFor, categoryIdFor } = redaction
  const payloadHash = hashPayload(payload)
  const candidateIds = candidates.map((candidate) => candidate.transactionId)
  const candidateIdSet = new Set(candidateIds)

  // Every id asked for gets exactly one result, whatever the outcome: `reason`
  // is `no_candidate` for one that was never cached at all, and the branch's
  // own reason for one that was but could not be guessed this time.
  const resultsFor = (reason: string): CategoryGuessItemResult[] =>
    options.ids.map((id) => ({ id, ok: false, reason: candidateIdSet.has(id) ? reason : 'no_candidate' }))

  const estimate = estimateCostMicroEur(model, JSON.stringify(payload).length, EXPECTED_OUTPUT_TOKENS)
  const decision = checkBudget(db, estimate, now)
  if (!decision.allowed) {
    const runId = recordRun(db, {
      kind: 'category_guess',
      model,
      locale,
      payload,
      payloadHash,
      status: 'capped',
      error: decision.reason,
      userId: options.userId ?? null,
    })
    log.warn({ reason: decision.reason }, 'category guess capped by the monthly AI budget')
    return {
      status: 'capped',
      reason: decision.reason,
      runId,
      locale,
      degraded: true,
      results: resultsFor(decision.reason),
      dropped: [],
      costMicroEur: 0,
    }
  }

  let result
  try {
    result = await callGemini({
      model,
      systemPrompt: composeSystemPrompt(CATEGORY_GUESS_SYSTEM, locale),
      instruction: categoryGuessInstruction(payload),
      payload,
      responseJsonSchema: guessJsonSchema(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    const message = error instanceof GeminiError ? error.message : String(error)
    const runId = recordRun(db, {
      kind: 'category_guess',
      model,
      locale,
      payload,
      payloadHash,
      status: 'error',
      error: message,
      userId: options.userId ?? null,
    })
    log.error({ err: message }, 'category guess call failed')
    return {
      status: 'error',
      reason: 'call_failed',
      runId,
      locale,
      degraded: true,
      results: resultsFor('call_failed'),
      dropped: [],
      costMicroEur: 0,
    }
  }

  const cost = costMicroEur(result.model, result.usage)

  let grounded
  try {
    grounded = groundGuessResponse(parseGuessResponse(result.text), payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const runId = recordRun(db, {
      kind: 'category_guess',
      model: result.model,
      locale,
      payload,
      payloadHash,
      status: 'error',
      usage: result.usage,
      durationMs: result.durationMs,
      error: message,
      userId: options.userId ?? null,
    })
    log.error({ err: message }, 'category guess response rejected')
    return {
      status: 'error',
      reason: 'bad_response',
      runId,
      locale,
      degraded: true,
      results: resultsFor('bad_response'),
      dropped: [],
      costMicroEur: cost,
    }
  }

  const runId = recordRun(db, {
    kind: 'category_guess',
    model: result.model,
    locale,
    payload,
    payloadHash,
    status: 'ok',
    usage: result.usage,
    durationMs: result.durationMs,
    userId: options.userId ?? null,
  })

  if (grounded.dropped.length > 0) {
    log.warn({ dropped: grounded.dropped }, 'grounding discarded model guesses')
  }

  const payeeNameFor = new Map(candidates.map((candidate) => [candidate.transactionId, candidate.payeeName]))
  const resultById = new Map<string, CategoryGuessItemResult>()

  for (const guess of grounded.guesses) {
    const transactionId = transactionIdFor.get(guess.clientId)
    const categoryId = categoryIdFor.get(guess.categoryLabel)
    if (transactionId === undefined || categoryId === undefined) continue

    try {
      await createProposal(db, {
        type: 'transaction_category.set',
        targetRef: transactionId,
        payload: { categoryId, payeeName: payeeNameFor.get(transactionId) ?? null },
        runId,
      })
      resultById.set(transactionId, { id: transactionId, ok: true, reason: null })
    } catch (error) {
      if (!(error instanceof ProposalError)) throw error
      resultById.set(transactionId, { id: transactionId, ok: false, reason: error.message })
    }
  }

  // One result per id asked for, same contract as `POST /api/proposals/apply-batch`:
  // an id the model never grounded a guess for is a miss too — omitted deliberately
  // (rule 3) or dropped by grounding either way — and one with no cached candidate
  // at all never had a chance regardless of what the model said.
  const results: CategoryGuessItemResult[] = options.ids.map((id) => {
    const attempted = resultById.get(id)
    if (attempted !== undefined) return attempted
    if (!candidateIdSet.has(id)) return { id, ok: false, reason: 'no_candidate' }
    return { id, ok: false, reason: 'not_confident' }
  })

  return {
    status: 'ok',
    reason: 'ok',
    runId,
    locale,
    degraded: false,
    results,
    dropped: grounded.dropped,
    costMicroEur: cost,
  }
}
