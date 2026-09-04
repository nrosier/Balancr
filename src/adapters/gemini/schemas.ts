/**
 * What the model is allowed to say back.
 *
 * `redact.ts` decides what goes out; this decides what may come in. The model
 * never returns prose for a finding and never returns a number: it returns a
 * code from `FINDING_CODES`, the label of something that is already in the
 * payload, and a severity. The sentence is rendered locally from the i18n
 * catalogue, off the numbers the aggregation layer computed.
 *
 * Two layers, and both are needed:
 *
 *  1. **The wire schema** (`z.toJSONSchema` → Gemini's `responseJsonSchema`)
 *     restricts `code` to the vocabulary, so a made-up code is a parse failure
 *     rather than a rendered claim.
 *  2. **`selectFindings`** then requires every finding to match a signal that is
 *     actually in the payload. A model can return a real code about a real
 *     category and still be wrong — "you overspent on c7" when nothing computed
 *     an overspend for c7 is exactly the hallucination the closed vocabulary
 *     alone does not catch.
 *
 * A parse failure is an error. Never a partial render, never a guess: if the
 * response does not fit, the run is recorded with `status: 'error'` and the page
 * shows the previous one.
 */
import { z } from 'zod'
import { toGeminiSchema } from './json-schema.ts'
import { CLARIFICATION_CODES, FINDING_CODES, FINDING_SPECS, SEVERITY_RANK } from '../../domain/ai/codes.ts'
import type { ClarificationCode, FindingCode, Severity } from '../../domain/ai/codes.ts'
import type {
  RedactedGuessBatch,
  RedactedNudgeBatch,
  RedactedPayload,
  RedactedSignal,
} from '../../domain/ai/redact.ts'

/**
 * The label a household-level finding carries.
 *
 * A sentinel rather than `null` because nullable properties widen the JSON
 * schema to a union type, and the narrowest schema is the one most likely to
 * survive a model or provider change. `c1…cN` and `a1…aN` are the only other
 * labels a payload contains, so `household` cannot collide with one.
 */
export const HOUSEHOLD_LABEL = 'household'

/** A guess is an answer to a one-line question, not an essay. */
export const GUESS_MAX_CHARS = 200

const severitySchema = z.enum(['info', 'warn', 'alert'])

/**
 * One prioritised finding. Array order is the ranking — an explicit `rank`
 * field would be a second source of truth for the same thing, and a model that
 * numbered them 1, 2, 2, 4 would need a tie-break rule nobody wants to define.
 */
export const findingSelectionSchema = z.object({
  code: z.enum(FINDING_CODES as [FindingCode, ...FindingCode[]]),
  /** A payload label, or `household`. Not a name — the model never sees ids. */
  label: z.string().min(1).max(32),
  severity: severitySchema,
  /** 0–100. How sure the model is that this is worth the user's attention. */
  confidence: z.number().int().min(0).max(100),
})

export const clarificationSelectionSchema = z.object({
  code: z.enum(CLARIFICATION_CODES as [ClarificationCode, ...ClarificationCode[]]),
  label: z.string().min(1).max(32),
  /**
   * The model's proposed answer, which the user confirms or edits. Capped and
   * single-lined here rather than at display time: a card is one line of UI, and
   * a thousand-word "guess" is a prompt-injection payload wearing a hat.
   */
  guess: z.string().max(GUESS_MAX_CHARS).default(''),
})

/**
 * How many of each a response may carry.
 *
 * Exported because these numbers are stated twice on purpose: enforced here, and
 * said in words in `analysisInstruction`. They cannot be sent as `maxItems` — see
 * `json-schema.ts` for the provider budget that refuses them (#96) — so prose is
 * the only way the model learns of them, and this constant keeps the two in step.
 */
export const RESPONSE_LIMITS = { findings: 48, clarifications: 12 } as const

export const analysisResponseSchema = z.object({
  findings: z.array(findingSelectionSchema).max(RESPONSE_LIMITS.findings),
  clarifications: z.array(clarificationSelectionSchema).max(RESPONSE_LIMITS.clarifications),
})

export type FindingSelection = z.infer<typeof findingSelectionSchema>
export type ClarificationSelection = z.infer<typeof clarificationSelectionSchema>
export type AnalysisResponse = z.infer<typeof analysisResponseSchema>

/**
 * Answers a clarification may propose, where the answer is itself a vocabulary.
 *
 * These mirror `category_meta`'s enums, so an accepted guess can be written
 * straight into the column without a translation step that could drift. Codes
 * absent from this map take free text (`purpose_unknown` is the description).
 */
export const CLARIFICATION_GUESS_VALUES: Partial<Record<ClarificationCode, readonly string[]>> = {
  nature_unknown: ['fixed', 'variable', 'discretionary', 'income'],
  frequency_unknown: ['monthly', 'quarterly', 'annual', 'irregular'],
  custody_shared_unknown: ['yes', 'no'],
  sensitive_unknown: ['yes', 'no'],
}

/**
 * The JSON schema handed to Gemini as `responseJsonSchema`.
 *
 * Emitted as draft-7 and then narrowed to the keywords Gemini accepts. Without
 * that second step every structured call is rejected outright — see
 * `json-schema.ts` for which four keywords do it and why dropping them is free.
 */
export function analysisJsonSchema(): unknown {
  return toGeminiSchema(z.toJSONSchema(analysisResponseSchema, { target: 'draft-7' }))
}

export class GeminiResponseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message)
    this.name = 'GeminiResponseError'
  }
}

/**
 * Model text → a validated response, or an error.
 *
 * Gemini in JSON mode returns a bare JSON document, but a model can still wrap
 * it in a fenced block; that one tolerance is the only leniency here, because it
 * is a formatting habit rather than a content claim. Everything else — a missing
 * field, an unknown code, a confidence of 200 — is an error.
 */
export function parseAnalysisResponse(text: string): AnalysisResponse {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (error) {
    throw new GeminiResponseError(
      `model response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
      text,
    )
  }

  const result = analysisResponseSchema.safeParse(raw)
  if (!result.success) {
    throw new GeminiResponseError(
      `model response did not match the analysis schema:\n${z.prettifyError(result.error)}`,
      text,
    )
  }
  return result.data
}

// ---------------------------------------------------------------------------
//  Grounding: every finding must be backed by a computed signal
// ---------------------------------------------------------------------------

/** A finding that survived validation, tied to the signal that backs it. */
export interface GroundedFinding {
  code: FindingCode
  /** The payload label, or null for a household-level finding. */
  label: string | null
  severity: Severity
  confidence: number
  /** The deterministic signal this claim rests on. Carries the numbers. */
  signal: RedactedSignal
}

export interface GroundedClarification {
  code: ClarificationCode
  label: string
  guess: string
}

/** Why a returned item was thrown away. Recorded, so hallucination is visible. */
export interface DroppedItem {
  code: string
  label: string
  reason: 'no_signal' | 'duplicate' | 'unknown_label' | 'bad_guess'
}

export interface Grounded {
  findings: GroundedFinding[]
  clarifications: GroundedClarification[]
  dropped: DroppedItem[]
}

const signalKey = (code: string, label: string | null): string =>
  `${code} ${label ?? HOUSEHOLD_LABEL}`

/** `null` for the household sentinel, the label itself otherwise. */
const toSignalLabel = (label: string): string | null =>
  label === HOUSEHOLD_LABEL ? null : label

/**
 * A parsed response → only the claims the payload actually supports.
 *
 * Order is preserved: the model's ranking is the one thing it is being asked
 * for, and re-sorting here would throw away the answer while keeping the cost.
 *
 * Severity is clamped to the code's `maxSeverity` rather than trusted. The model
 * may judge something *less* urgent than the producer did — that is a legitimate
 * editorial call about one month — but it may not promote `above_benchmark` to
 * an alert, because the threshold that would justify an alert lives in
 * `settings`, not in a sentence.
 */
export function groundResponse(response: AnalysisResponse, payload: RedactedPayload): Grounded {
  const signals = new Map<string, RedactedSignal>()
  for (const signal of payload.signals) {
    signals.set(signalKey(signal.code, signal.label), signal)
  }
  const categoryLabels = new Set(payload.categories.map((category) => category.label))

  const out: Grounded = { findings: [], clarifications: [], dropped: [] }
  const seen = new Set<string>()

  for (const finding of response.findings) {
    const key = signalKey(finding.code, toSignalLabel(finding.label))
    if (seen.has(key)) {
      out.dropped.push({ code: finding.code, label: finding.label, reason: 'duplicate' })
      continue
    }
    const signal = signals.get(key)
    if (signal === undefined) {
      // The load-bearing case: a real code about a real category, with nothing
      // computed behind it. Rendering it would put an invented claim on the page
      // in the same typeface as a measured one.
      out.dropped.push({ code: finding.code, label: finding.label, reason: 'no_signal' })
      continue
    }
    seen.add(key)
    const ceiling = FINDING_SPECS[finding.code].maxSeverity
    const severity =
      SEVERITY_RANK[finding.severity] < SEVERITY_RANK[ceiling] ? ceiling : finding.severity
    out.findings.push({
      code: finding.code,
      label: toSignalLabel(finding.label),
      severity,
      confidence: finding.confidence,
      signal,
    })
  }

  for (const clarification of response.clarifications) {
    // A clarification is a question about a category, so an account label or the
    // household sentinel has nothing to answer.
    if (!categoryLabels.has(clarification.label)) {
      out.dropped.push({
        code: clarification.code,
        label: clarification.label,
        reason: 'unknown_label',
      })
      continue
    }
    const allowed = CLARIFICATION_GUESS_VALUES[clarification.code]
    const guess = clarification.guess.replace(/\s+/g, ' ').trim()
    if (allowed !== undefined && !allowed.includes(guess)) {
      out.dropped.push({ code: clarification.code, label: clarification.label, reason: 'bad_guess' })
      continue
    }
    const key = `${clarification.code} ${clarification.label}`
    if (seen.has(key)) {
      out.dropped.push({ code: clarification.code, label: clarification.label, reason: 'duplicate' })
      continue
    }
    seen.add(key)
    out.clarifications.push({
      code: clarification.code,
      label: clarification.label,
      guess: guess.slice(0, GUESS_MAX_CHARS),
    })
  }

  return out
}

// ---------------------------------------------------------------------------
//  #216 — a category guess: one label per candidate, nothing else
// ---------------------------------------------------------------------------

/** One candidate's guessed category, by the opaque labels it was sent. */
export const guessSelectionSchema = z.object({
  clientId: z.string().min(1).max(16),
  categoryLabel: z.string().min(1).max(16),
})

export const guessResponseSchema = z.object({
  guesses: z.array(guessSelectionSchema).max(50),
})

export type GuessSelection = z.infer<typeof guessSelectionSchema>
export type GuessResponse = z.infer<typeof guessResponseSchema>

/** Same two-layer contract as `analysisJsonSchema` — see its own comment. */
export function guessJsonSchema(): unknown {
  return toGeminiSchema(z.toJSONSchema(guessResponseSchema, { target: 'draft-7' }))
}

/** Model text → a validated guess response, or an error. Same leniency as `parseAnalysisResponse`. */
export function parseGuessResponse(text: string): GuessResponse {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (error) {
    throw new GeminiResponseError(
      `model response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
      text,
    )
  }

  const result = guessResponseSchema.safeParse(raw)
  if (!result.success) {
    throw new GeminiResponseError(
      `model response did not match the category-guess schema:\n${z.prettifyError(result.error)}`,
      text,
    )
  }
  return result.data
}

/** A guess that survived grounding: an opaque candidate paired with an opaque category. */
export interface GroundedGuess {
  clientId: string
  categoryLabel: string
}

/** Why a returned guess was thrown away. Recorded, so a hallucinated guess is visible. */
export interface DroppedGuess {
  clientId: string
  categoryLabel: string
  reason: 'duplicate' | 'unknown_client' | 'not_offered'
}

export interface GroundedGuessBatch {
  guesses: GroundedGuess[]
  dropped: DroppedGuess[]
}

/**
 * A parsed guess response → only the guesses the batch actually supports.
 *
 * The wire schema restricts `categoryLabel` to a short string, nothing more — it
 * has no way to know which labels belong to which candidate. This is the second
 * layer, exactly as `groundResponse` is for findings: a `categoryLabel` the model
 * invented, or borrowed from a *different* candidate's own history, is dropped
 * rather than turned into a proposal. Only a label that candidate's own payload
 * actually offered survives.
 */
export function groundGuessResponse(
  response: GuessResponse,
  payload: RedactedGuessBatch,
): GroundedGuessBatch {
  const offeredLabelsFor = new Map<string, ReadonlySet<string>>()
  for (const candidate of payload.candidates) {
    offeredLabelsFor.set(candidate.clientId, new Set(candidate.history.map((entry) => entry.label)))
  }

  const out: GroundedGuessBatch = { guesses: [], dropped: [] }
  const seen = new Set<string>()

  for (const guess of response.guesses) {
    if (seen.has(guess.clientId)) {
      out.dropped.push({ ...guess, reason: 'duplicate' })
      continue
    }
    const offered = offeredLabelsFor.get(guess.clientId)
    if (offered === undefined) {
      out.dropped.push({ ...guess, reason: 'unknown_client' })
      continue
    }
    if (!offered.has(guess.categoryLabel)) {
      out.dropped.push({ ...guess, reason: 'not_offered' })
      continue
    }
    seen.add(guess.clientId)
    out.guesses.push(guess)
  }

  return out
}

// ---------------------------------------------------------------------------
//  #217 — a budget-amount nudge: one adjustment per candidate, in whole euros
// ---------------------------------------------------------------------------

/** How far a nudge may move a candidate from its own suggested amount, either way. */
export const NUDGE_MAX_RATIO = 3

/** One candidate's adjusted amount, by the opaque label it was sent. */
export const nudgeSelectionSchema = z.object({
  label: z.string().min(1).max(16),
  amountCents: z.number().int(),
})

export const nudgeResponseSchema = z.object({
  adjustments: z.array(nudgeSelectionSchema).max(50),
})

export type NudgeSelection = z.infer<typeof nudgeSelectionSchema>
export type NudgeResponse = z.infer<typeof nudgeResponseSchema>

/** Same two-layer contract as `guessJsonSchema` — see its own comment. */
export function nudgeJsonSchema(): unknown {
  return toGeminiSchema(z.toJSONSchema(nudgeResponseSchema, { target: 'draft-7' }))
}

/** Model text → a validated nudge response, or an error. Same leniency as `parseGuessResponse`. */
export function parseNudgeResponse(text: string): NudgeResponse {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (error) {
    throw new GeminiResponseError(
      `model response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
      text,
    )
  }

  const result = nudgeResponseSchema.safeParse(raw)
  if (!result.success) {
    throw new GeminiResponseError(
      `model response did not match the budget-nudge schema:\n${z.prettifyError(result.error)}`,
      text,
    )
  }
  return result.data
}

/** An adjustment that survived grounding: an opaque candidate paired with a bounded amount. */
export interface GroundedNudge {
  label: string
  amountCents: number
}

/** Why a returned adjustment was thrown away. Recorded, so a hallucinated figure is visible. */
export interface DroppedNudge {
  label: string
  amountCents: number
  reason: 'duplicate' | 'unknown_label' | 'out_of_range'
}

export interface GroundedNudgeBatch {
  adjustments: GroundedNudge[]
  dropped: DroppedNudge[]
}

/**
 * A parsed nudge response → only the adjustments the batch actually supports.
 *
 * Two checks `groundGuessResponse` also makes — `label` must be one this batch
 * offered, and no label twice — plus one it does not need: a magnitude bound.
 * Unlike a wrong category label, a wrong euro amount is not self-evidently wrong
 * to the human approving the proposal, so a hallucinated figure is more
 * dangerous here. An adjustment outside `[suggested/NUDGE_MAX_RATIO,
 * suggested*NUDGE_MAX_RATIO]` is dropped as `out_of_range` — wide enough for a
 * genuine annual-bill jump, tight enough to catch an invented number.
 */
export function groundNudgeResponse(
  response: NudgeResponse,
  payload: RedactedNudgeBatch,
): GroundedNudgeBatch {
  const suggestedCentsFor = new Map<string, number>()
  for (const candidate of payload.candidates) {
    suggestedCentsFor.set(candidate.label, candidate.suggestedCents)
  }

  const out: GroundedNudgeBatch = { adjustments: [], dropped: [] }
  const seen = new Set<string>()

  for (const adjustment of response.adjustments) {
    if (seen.has(adjustment.label)) {
      out.dropped.push({ ...adjustment, reason: 'duplicate' })
      continue
    }
    const suggested = suggestedCentsFor.get(adjustment.label)
    if (suggested === undefined) {
      out.dropped.push({ ...adjustment, reason: 'unknown_label' })
      continue
    }
    const min = Math.min(suggested, suggested / NUDGE_MAX_RATIO)
    const max = Math.max(suggested, suggested * NUDGE_MAX_RATIO)
    if (adjustment.amountCents < min || adjustment.amountCents > max) {
      out.dropped.push({ ...adjustment, reason: 'out_of_range' })
      continue
    }
    seen.add(adjustment.label)
    out.adjustments.push(adjustment)
  }

  return out
}
