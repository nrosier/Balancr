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
 *  1. **The wire schema** (`z.toJSONSchema`, narrowed by each provider adapter)
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
import { CLARIFICATION_CODES, FINDING_CODES, FINDING_SPECS, SEVERITY_RANK } from './codes.ts'
import type { ClarificationCode, FindingCode, Severity } from './codes.ts'
import type { PromptKey } from './prompts.ts'
import type {
  RedactedGuessBatch,
  RedactedNudgeBatch,
  RedactedPayload,
  RedactedSignal,
} from './redact.ts'

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
 * Standard JSON Schema handed to the selected provider adapter.
 *
 * Provider-specific dialect conversion belongs in the adapter. Keeping the
 * source schema here means every provider is constrained by the same contract
 * and every response is still validated by the same Zod schema on return.
 */
export function analysisJsonSchema(): unknown {
  return z.toJSONSchema(analysisResponseSchema, { target: 'draft-7' })
}

export class AiResponseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message)
    this.name = 'AiResponseError'
  }
}

/**
 * Model text → a validated response, or an error.
 *
 * Structured-output modes return a bare JSON document, but a model can still wrap
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
    throw new AiResponseError(
      `model response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
      text,
    )
  }

  const result = analysisResponseSchema.safeParse(raw)
  if (!result.success) {
    throw new AiResponseError(
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
  return z.toJSONSchema(guessResponseSchema, { target: 'draft-7' })
}

/** Model text → a validated guess response, or an error. Same leniency as `parseAnalysisResponse`. */
export function parseGuessResponse(text: string): GuessResponse {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (error) {
    throw new AiResponseError(
      `model response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
      text,
    )
  }

  const result = guessResponseSchema.safeParse(raw)
  if (!result.success) {
    throw new AiResponseError(
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

/**
 * A reason is one line under a proposal card (#273), not an argument. A thousand-word
 * "reason" is a prompt-injection payload wearing a hat, so it never reaches storage —
 * but unlike `GUESS_MAX_CHARS` the bound is enforced in `groundNudgeResponse` and not
 * on the schema. A `.max()` here would reject the whole response, and one runaway
 * sentence would cost every amount in the batch its proposal; a reason is never worth
 * an amount.
 */
export const NUDGE_REASON_MAX_CHARS = 160

/**
 * A payload label as the model was given it — `c` or `a` and a small number.
 *
 * A reason mentioning one is useless to the reader and leaks the redaction scheme,
 * and unlike the narrative there is nothing to substitute it back into: the card
 * already names the category on the line above. So such a reason is blanked, and
 * the deterministic sentence takes over. Kept local to this pass rather than shared
 * with `narrative.ts`'s `LABEL`, which is a global-flagged replace pattern.
 */
const NUDGE_REASON_LABEL = /\b[ca]\d{1,4}\b/i

/** One candidate's adjusted amount, by the opaque label it was sent. */
export const nudgeSelectionSchema = z.object({
  label: z.string().min(1).max(16),
  amountCents: z.number().int(),
  /**
   * Why the note moved this amount, in the household's own language (#273). A
   * defaulted empty string rather than `.optional()`, following `guess` above:
   * `''` means the model had nothing to say, which is a normal answer.
   *
   * Deliberately unbounded here, unlike `guess`: the length bound is applied in
   * `groundNudgeResponse`, so an over-long reason is blanked and the amount it came
   * with still stands. See `NUDGE_REASON_MAX_CHARS`.
   */
  reason: z.string().default(''),
})

export const nudgeResponseSchema = z.object({
  adjustments: z.array(nudgeSelectionSchema).max(50),
})

export type NudgeSelection = z.infer<typeof nudgeSelectionSchema>
export type NudgeResponse = z.infer<typeof nudgeResponseSchema>

/** Same two-layer contract as `guessJsonSchema` — see its own comment. */
export function nudgeJsonSchema(): unknown {
  return z.toJSONSchema(nudgeResponseSchema, { target: 'draft-7' })
}

/** Model text → a validated nudge response, or an error. Same leniency as `parseGuessResponse`. */
export function parseNudgeResponse(text: string): NudgeResponse {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (error) {
    throw new AiResponseError(
      `model response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
      text,
    )
  }

  const result = nudgeResponseSchema.safeParse(raw)
  if (!result.success) {
    throw new AiResponseError(
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
  /** The model's one-line reason, normalised, or `''` when it gave none worth keeping. */
  reason: string
}

/**
 * Why a returned adjustment was thrown away. Recorded, so a hallucinated figure is visible.
 *
 * `reason` here is the *drop cause*, which is not the same `reason` a `NudgeSelection`
 * carries — that one is the model's own prose. The two are built field by field below
 * rather than by spreading the selection, so the model can never write over this one.
 */
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
    const { label, amountCents } = adjustment
    if (seen.has(label)) {
      out.dropped.push({ label, amountCents, reason: 'duplicate' })
      continue
    }
    const suggested = suggestedCentsFor.get(label)
    if (suggested === undefined) {
      out.dropped.push({ label, amountCents, reason: 'unknown_label' })
      continue
    }
    const min = Math.min(suggested, suggested / NUDGE_MAX_RATIO)
    const max = Math.max(suggested, suggested * NUDGE_MAX_RATIO)
    if (amountCents < min || amountCents > max) {
      out.dropped.push({ label, amountCents, reason: 'out_of_range' })
      continue
    }
    seen.add(label)
    // A reason is never worth an amount: an unusable one is blanked and the
    // adjustment stands, because `budget-nudge.ts` has a deterministic sentence
    // ready and no sentence at all is better than a leaked label.
    const reason = adjustment.reason.replace(/\s+/g, ' ').trim()
    out.adjustments.push({
      label,
      amountCents,
      reason:
        reason.length > NUDGE_REASON_MAX_CHARS || NUDGE_REASON_LABEL.test(reason) ? '' : reason,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
//  #454, #468 — the judge: does an edited prompt still impose its own rules
// ---------------------------------------------------------------------------

/**
 * The thirteen rules `NARRATIVE_SYSTEM` states, as ids.
 *
 * A closed vocabulary for the same reason `FINDING_CODES` is one: the judge answers in
 * codes rather than prose, so an invented rule name is a parse failure instead of a
 * sentence nobody can act on. The order matches the prompt's own numbering, which is what
 * makes the two readable side by side when either changes.
 *
 * `no_internal_ids` (rule 11), `negative_is_overspend` (rule 12) and
 * `goal_progress_is_grounded` (rule 13, #407) are editorial like `brevity`/`drift_is_fact`/etc
 * — they shape how the writer talks about a figure, not what it is allowed to claim about
 * one — so all three are judged like the rest but not in `REQUIRED_NARRATIVE_RULE_IDS` below.
 */
export const NARRATIVE_RULE_IDS = [
  'no_arithmetic',
  'brevity',
  'lead_with_change',
  'data_quality',
  'shared_costs',
  'no_advice',
  'no_address_no_moralise',
  'drift_is_fact',
  'note_is_context',
  'excluded_is_choice',
  'no_internal_ids',
  'negative_is_overspend',
  'goal_progress_is_grounded',
] as const
export type NarrativeRuleId = (typeof NARRATIVE_RULE_IDS)[number]

/**
 * The four that block.
 *
 * The other six are editorial — brevity, structure, tone — and an owner who wants a longer
 * review, a different opening or a warmer voice is exercising a preference, not creating a
 * safety problem. Blocking on those would make the gate an argument about house style, and
 * the first thing anyone would do is stop pressing the button.
 *
 * These four are the ones whose removal changes what the output can *claim*: arithmetic on
 * figures that were computed elsewhere (`no_arithmetic`), investment or tax instructions
 * (`no_advice`), a figure lifted out of the household's own prose note (`note_is_context`),
 * and reconstructing the deliberately withheld envelopes (`excluded_is_choice`).
 */
export const REQUIRED_NARRATIVE_RULE_IDS: readonly NarrativeRuleId[] = [
  'no_arithmetic',
  'no_advice',
  'note_is_context',
  'excluded_is_choice',
]

/**
 * The six rules `ANALYSIS_SYSTEM` states, as ids (#468).
 *
 * A narrower rubric than `NARRATIVE_RULE_IDS`, and deliberately so: `groundResponse`
 * already refuses any finding whose code and label are not in the signals list, and the
 * schema has no numeric field at all, so an edited analysis prompt cannot make the model
 * invent a finding or a figure no matter what it says. What an edit *can* still do is
 * rank badly, or shape the one piece of free text this pass produces — a clarification
 * guess (`clarificationSelectionSchema.guess`) — into something that reads as advice or
 * jargon. The rubric is scoped to that reality.
 */
export const ANALYSIS_RULE_IDS = [
  'no_numbers',
  'closed_vocabulary',
  'quality_first_ordering',
  'severity_only_lowers',
  'guess_is_neutral',
  'excluded_is_choice',
] as const
export type AnalysisRuleId = (typeof ANALYSIS_RULE_IDS)[number]

/**
 * The three that block.
 *
 * `closed_vocabulary` and `severity_only_lowers` are already enforced downstream by
 * `groundResponse` regardless of what the prompt says, and `quality_first_ordering` is
 * editorial — a worse ordering is a worse answer, not an unsafe one. These three are the
 * ones whose removal changes what the model's one free-text field can say: a number typed
 * into a guess (`no_numbers`), a guess written as an instruction rather than a guess
 * (`guess_is_neutral`), or the withheld envelopes reconstructed instead of left alone
 * (`excluded_is_choice`).
 */
export const REQUIRED_ANALYSIS_RULE_IDS: readonly AnalysisRuleId[] = [
  'no_numbers',
  'guess_is_neutral',
  'excluded_is_choice',
]

/** Either prompt's rule vocabulary, for the places that hold one without caring which. */
export type RuleId = NarrativeRuleId | AnalysisRuleId

/** Which rule ids apply to which key — what the judge is asked about, keyed the same way. */
export const RULE_IDS_FOR: Record<PromptKey, readonly RuleId[]> = {
  'analysis.system': ANALYSIS_RULE_IDS,
  'narrative.system': NARRATIVE_RULE_IDS,
}

/** Which of a key's rule ids block activation — the input to `decideJudgeVerdict`. */
export const REQUIRED_RULE_IDS_FOR: Record<PromptKey, readonly RuleId[]> = {
  'analysis.system': REQUIRED_ANALYSIS_RULE_IDS,
  'narrative.system': REQUIRED_NARRATIVE_RULE_IDS,
}

/**
 * Ways a candidate body can fight the system it is part of, as codes.
 *
 * Distinct from a missing rule: a prompt can state every rule faithfully and still, in
 * another sentence, claim to override everything above it or demand the model produce
 * figures. Any one of these is enough on its own for `unsafe` — there is no legitimate
 * reason for an editable prompt body to do any of them.
 */
export const CONFLICT_CODES = [
  'overrides_system',
  'claims_authority',
  'demands_numbers',
  'requests_advice',
  'targets_data_fence',
  'restates_then_revokes',
  'exfiltration',
  'other',
] as const
export type ConflictCode = (typeof CONFLICT_CODES)[number]

/**
 * What the judge is being asked to do (#468 refinement).
 *
 * `'replacement'` is the original audit: does the candidate — the whole prompt — still
 * impose every one of the key's own rules. `'addition'` is the lighter check `locked`
 * uses once a customization stops being a replacement and becomes a short addition
 * layered on Balancr's own base (`composeLayeredBody` in `prompts.ts`): the base is
 * always sent in full, so there is nothing left to audit for *presence*, only for
 * whether the addition fights the base or the rules that follow it.
 */
export type CheckKind = 'replacement' | 'addition'

/**
 * How much of the judge's own prose is kept.
 *
 * Short on purpose: it is read by a person as supporting evidence beside the codes, and it
 * is also model output influenced by the very text under examination — so it is bounded and
 * rendered as a quotation, never as the finding itself.
 *
 * Enforced in `decideJudgeVerdict` by truncation rather than on the schema as a rejection —
 * the same call `nudgeSelectionSchema.reason` already makes, and for a sharper version of
 * the same reason. A `.max()` here would turn a judge that wrote one sentence too many into
 * `bad_response`: money spent, no verdict stored, the row left `unvalidated` — and at
 * `temperature: 0` that outcome is *deterministic*, so the body would be permanently
 * uncheckable and therefore permanently unactivatable. A cosmetic overrun must never cost a
 * verdict. `JUDGE_NOTES_WIRE_MAX_CHARS` still bounds the payload itself.
 */
export const JUDGE_NOTES_MAX_CHARS = 300

/**
 * The bound the wire actually rejects on: generous, and only about payload size.
 *
 * Well clear of `JUDGE_NOTES_MAX_CHARS` so the display cap is never the thing that fails a
 * parse, while still refusing a "notes" field carrying a novel.
 */
export const JUDGE_NOTES_WIRE_MAX_CHARS = 4_000

/**
 * Bounded well above `CONFLICT_CODES.length`, not at it.
 *
 * A cap equal to the vocabulary looks tight and is brittle: the array is not a set, so a
 * model that names one code twice would blow a limit sized for distinct codes — and the
 * candidates most likely to trip several codes at once are exactly the adversarial ones
 * this check exists to catch. `decideJudgeVerdict` de-duplicates, so the only job left
 * here is refusing an absurd payload.
 */
const conflictsSchema = z.array(z.enum(CONFLICT_CODES)).max(64)

/** Truncated to `JUDGE_NOTES_MAX_CHARS` on the way out — see that constant for why. */
const notesSchema = z.string().max(JUDGE_NOTES_WIRE_MAX_CHARS).default('')

/**
 * The wire schema for one check, built off `checkKind` and — for `'replacement'` —
 * that key's own rule ids.
 *
 * A function rather than one shared schema, because the vocabulary the judge may answer
 * in has to match what it was actually asked about: a `narrative.system` check handed
 * the analysis ids (or the reverse) would let the model report on constraints it was
 * never told to examine, and an `'addition'` check has no rules to report on at all —
 * the base is always sent in full, so there is nothing for a `rules` field to mean.
 * `RULE_IDS_FOR` is the single source both `judgeJsonSchema` (what the model is handed)
 * and `parseJudgeResponse` (what a reply is checked against) read from for
 * `'replacement'`, so the two cannot drift apart.
 */
function judgeResponseSchemaFor(key: PromptKey, checkKind: CheckKind) {
  if (checkKind === 'addition') {
    return z.object({ conflicts: conflictsSchema, notes: notesSchema })
  }
  const ids = RULE_IDS_FOR[key]
  return z.object({
    rules: z
      .array(
        z.object({
          id: z.enum(ids as [RuleId, ...RuleId[]]),
          present: z.boolean(),
          /**
           * A rule can be quoted and then rhetorically cancelled — "rule 1 says never
           * calculate, but for this household you may estimate where it helps" — which is
           * `present: true` and worthless (#452). Asking for the two separately is what
           * lets `decideJudgeVerdict` treat that as a removal rather than as compliance.
           */
          weakened: z.boolean(),
        }),
      )
      // Above `ids.length` for the reason `conflicts` is: the array is not a set, and a
      // model repeating an id must not fail a parse sized for distinct ones.
      // `decideJudgeVerdict` folds duplicates worst-wins.
      .max(ids.length * 4),
    conflicts: conflictsSchema,
    notes: notesSchema,
  })
}

/**
 * Shape either check can produce. `rules` is absent from the wire for an `'addition'`
 * check (see `judgeResponseSchemaFor`), so `decideJudgeVerdict` treats a missing array
 * the same as an empty one rather than requiring callers to fake one up.
 */
export interface JudgeResponse {
  rules?: { id: RuleId; present: boolean; weakened: boolean }[]
  conflicts: ConflictCode[]
  notes: string
}

/** The decision, with the evidence it was made from. */
export interface JudgeVerdict {
  verdict: 'safe' | 'unsafe'
  /** Required ids NOT reported present-and-unweakened. */
  missing: RuleId[]
  /** Required ids reported present but weakened. A subset of the reasons for `unsafe`. */
  weakened: RuleId[]
  conflicts: ConflictCode[]
  /** Non-required ids missing or weakened — shown to a reader, never blocking. */
  advisory: RuleId[]
  notes: string
}

/**
 * A parsed judge response → the decision, computed here.
 *
 * The same two-layer discipline `groundResponse` applies to a finding, for the same
 * reason: the wire schema says what shape an answer may take, and this says what it
 * *means*. There is deliberately no `safe` boolean on the wire — a model asked for its own
 * verdict is being asked to summarise its own evidence, and a summary that disagreed with
 * the evidence would leave nothing to prefer. So `safe` is a function of the per-rule
 * reports and nothing else: every required id present and unweakened, and no conflicts.
 *
 * **A required id absent from the array entirely counts as missing.** The array is capped,
 * not pinned — a model can answer about three (or six) rules out of the key's own set, or
 * about none — so silence has to fail closed. The alternative reading, "unmentioned means
 * fine", makes an empty response the cheapest way to pass.
 *
 * `key` selects which rule set governs — `RULE_IDS_FOR`/`REQUIRED_RULE_IDS_FOR` — not a
 * hard-coded narrative one, so this one function serves both prompts. `checkKind` selects
 * which question is even being asked: for `'addition'` there are no rules to fold at
 * all — the base is always sent in full — so the verdict is conflicts alone, with empty
 * `missing`/`weakened`/`advisory` (the `JudgeVerdict` shape is already a superset, so
 * every downstream reader — storage, the settings UI's `RuleList` — needs no change to
 * handle an addition verdict).
 */
export function decideJudgeVerdict(
  key: PromptKey,
  response: JudgeResponse,
  checkKind: CheckKind,
): JudgeVerdict {
  const conflicts = [...new Set(response.conflicts)]
  if (checkKind === 'addition') {
    return {
      verdict: conflicts.length === 0 ? 'safe' : 'unsafe',
      missing: [],
      weakened: [],
      conflicts,
      advisory: [],
      notes: response.notes.replace(/\s+/g, ' ').trim().slice(0, JUDGE_NOTES_MAX_CHARS),
    }
  }

  // Duplicate reports for one id fold **worst-wins**, not last-wins. The array is capped
  // rather than keyed, so a response may mention one id twice with different answers —
  // and last-wins would make the order of a model's own array decide a safety question,
  // which is the one fail-*open* this function could contain. Every other ambiguity here
  // resolves the same direction: an absent id counts as missing, an older rules version
  // retires a verdict, and `inheritableValidation`'s tie prefers `unsafe`.
  const reported = new Map<RuleId, { present: boolean; weakened: boolean }>()
  for (const rule of response.rules ?? []) {
    const seen = reported.get(rule.id)
    reported.set(
      rule.id,
      seen === undefined
        ? { present: rule.present, weakened: rule.weakened }
        : { present: seen.present && rule.present, weakened: seen.weakened || rule.weakened },
    )
  }

  const requiredIds = REQUIRED_RULE_IDS_FOR[key]
  const missing: RuleId[] = []
  const weakened: RuleId[] = []
  for (const id of requiredIds) {
    const rule = reported.get(id)
    if (rule === undefined || !rule.present) {
      missing.push(id)
      continue
    }
    if (rule.weakened) {
      // Both lists: `weakened` says *why* it does not count, `missing` is the set that
      // has to be empty for `safe`, and a rule that is present-but-cancelled is not
      // imposing anything.
      weakened.push(id)
      missing.push(id)
    }
  }

  const advisory = RULE_IDS_FOR[key].filter((id) => {
    if (requiredIds.includes(id)) return false
    const rule = reported.get(id)
    return rule === undefined || !rule.present || rule.weakened
  })

  return {
    verdict: missing.length === 0 && conflicts.length === 0 ? 'safe' : 'unsafe',
    missing,
    weakened,
    conflicts,
    advisory,
    notes: response.notes.replace(/\s+/g, ' ').trim().slice(0, JUDGE_NOTES_MAX_CHARS),
  }
}

/** Same two-layer contract as `nudgeJsonSchema` — see `analysisJsonSchema`'s own comment. */
export function judgeJsonSchema(key: PromptKey, checkKind: CheckKind): unknown {
  return z.toJSONSchema(judgeResponseSchemaFor(key, checkKind), { target: 'draft-7' })
}

/** Model text → a validated judge response, or an error. Same leniency as `parseNudgeResponse`. */
export function parseJudgeResponse(key: PromptKey, checkKind: CheckKind, text: string): JudgeResponse {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch (error) {
    throw new AiResponseError(
      `model response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
      text,
    )
  }

  const result = judgeResponseSchemaFor(key, checkKind).safeParse(raw)
  if (!result.success) {
    throw new AiResponseError(
      `model response did not match the prompt-judge schema:\n${z.prettifyError(result.error)}`,
      text,
    )
  }
  return result.data
}
