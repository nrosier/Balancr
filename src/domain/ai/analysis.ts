/**
 * The analysis pass: facts in, a ranked list of findings out.
 *
 * Everything upstream of this file produces one piece — the bundle, the ranking,
 * the redaction, the prompt, the wire call, the schema, the grounding, the ledger
 * — and this is where they are wired together in the one order that keeps the
 * guarantees: rank *before* redacting (so the model is charged for two dozen
 * findings rather than two hundred), check the budget *before* calling, and
 * render sentences *after* grounding, from the deterministic signal rather than
 * from anything the model returned.
 *
 * The model's entire contribution is the order of the list and one severity it may
 * lower. The sentence a person reads is rendered locally from the numbers the
 * aggregation layer computed, which is why a hallucinated finding cannot become a
 * sentence: there is no code path from the model's response to a rendered figure.
 *
 * Every ending is a recorded run except one. A month with no facts records
 * nothing — nothing was attempted, and an `error` row for a month that has simply
 * not been aggregated yet would put a permanent failure in the ledger. Everything
 * else (over budget, transport failure, unparseable answer) writes its row and
 * returns the deterministic list, so the page degrades to real findings in a
 * defensible order instead of showing an error.
 */
import { callGemini, GeminiError } from '../../adapters/gemini/client.ts'
import { costMicroEur, estimateCostMicroEur } from '../../adapters/gemini/pricing.ts'
import {
  analysisJsonSchema,
  RESPONSE_LIMITS,
  groundResponse,
  HOUSEHOLD_LABEL,
  parseAnalysisResponse,
  type DroppedItem,
  type GroundedClarification,
  type GroundedFinding,
} from '../../adapters/gemini/schemas.ts'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { aiFindings } from '../../db/schema.ts'
import { logger } from '../../logger.ts'
import type { Signal } from '../aggregate/overspend.ts'
import { checkBudget } from './budget.ts'
import type { ClarificationCode } from './codes.ts'
import { collectBundle } from './bundle.ts'
import { enqueueClarifications } from './clarify.ts'
import { DEFAULT_CAPS, rankSignals, type RankCaps } from './findings.ts'
import { composeSystemPrompt, loadPrompt, resolvePrompt, type ResolvedPrompt } from './prompts.ts'
import { redact, type AnalysisBundle, type RedactedPayload } from './redact.ts'
import { renderSignals, type RenderedFinding } from './render.ts'
import { recordRun } from './runs.ts'

const log = logger.child({ module: 'ai.analysis' })

/**
 * What the ranking response is expected to cost in output tokens.
 *
 * Deliberately generous: the estimate exists to keep a run from starting when it
 * cannot be paid for, so overstating it errs toward the banner rather than toward
 * an overspend. A full response — 48 findings and 12 clarifications — is well
 * under this.
 */
export const EXPECTED_OUTPUT_TOKENS = 1_500

export interface AnalysisFinding extends RenderedFinding {
  /**
   * How sure the model was that this deserves attention, 0–100. Null on a
   * degraded run, where the order is the deterministic one and nothing judged it.
   */
  confidence: number | null
}

export interface AnalysisClarification {
  code: ClarificationCode
  categoryId: string
  /**
   * The real name, resolved locally. A sensitive category reached the model as a
   * bare label, and the person answering the question owns the name.
   */
  categoryName: string
  /** The model's proposed answer, for a card that confirms rather than asks. */
  guess: string
}

export type AnalysisStatus = 'ok' | 'capped' | 'error' | 'skipped'

export type AnalysisReason =
  | 'ok'
  | 'no_facts'
  | 'month_budget_exceeded'
  | 'estimate_exceeds_remaining'
  | 'call_failed'
  | 'bad_response'

export interface AnalysisOutcome {
  status: AnalysisStatus
  reason: AnalysisReason
  /** Null only when nothing was recorded, i.e. the month has no facts. */
  runId: string | null
  month: string
  locale: string
  /**
   * True when `findings` is the deterministic ranking rather than the model's.
   * The UI says so: an unranked list of real findings is useful, and pretending
   * it was reviewed is not.
   */
  degraded: boolean
  findings: AnalysisFinding[]
  clarifications: AnalysisClarification[]
  /**
   * How many of those questions the queue accepted. Lower than
   * `clarifications.length` whenever one was immaterial, already answered, or hit
   * the queue cap — see `clarify.ts`.
   */
  queued: number
  /** What the model returned and grounding threw away. Recorded, not hidden. */
  dropped: DroppedItem[]
  costMicroEur: number
}

export interface AnalysisOptions {
  month: string
  locale?: string
  /** Defaults to `GEMINI_MODEL_FAST`: this pass is cheap and runs nightly. */
  model?: string
  caps?: RankCaps
  now?: Date
  signal?: AbortSignal
  /** Who asked, for the ledger. Null for the nightly job. */
  userId?: string | null
  /**
   * A specific prompt version instead of whichever one is active.
   *
   * The prompt editor's dry run: the whole question being asked is what an
   * unactivated version would do, and answering it with the active prompt would
   * make the button a lie. An unknown id throws rather than falling back — a dry
   * run that silently tested something else is worse than an error message.
   */
  promptId?: string
  /**
   * `false` runs everything and stores nothing but the ledger row.
   *
   * The dry run has to be the real code path or it does not answer the question,
   * so this is a flag inside the one implementation rather than a second one that
   * drifts from it. What it skips is exactly what would outlive the request:
   * findings on the insights page, and clarifications in the queue. The `ai_runs`
   * row is still written, and still billed — a dry run spends real money, and the
   * cost guard has to see it or the editor becomes a way around the budget.
   */
  persist?: boolean
}

/**
 * The per-run instruction, composed in code.
 *
 * Short on purpose: it sits outside the cached system prompt, so every word is
 * billed on every run. It says what to do with this month's data and nothing
 * about how to behave — that belongs in the prompt the user can edit.
 */
export function analysisInstruction(payload: RedactedPayload): string {
  return [
    `Prioritise the findings for ${payload.month}.`,
    `The signals array holds ${payload.signals.length} findings that have already`,
    'been computed. Return the ones a person should read first, in that order, using',
    'only code and label pairs that appear in that array. Ask for a clarification',
    'only where a category’s purpose cannot be inferred, and propose a guess.',
    // Said in words because it cannot be said in the schema: Gemini refuses the
    // request outright when an array bound is large enough to matter (#96).
    `Return at most ${RESPONSE_LIMITS.findings} findings and`,
    `${RESPONSE_LIMITS.clarifications} clarifications.`,
  ].join(' ')
}

const signalKey = (code: string, label: string | null): string => `${code} ${label ?? HOUSEHOLD_LABEL}`

/**
 * The deterministic signal behind each `(code, label)` pair that was sent.
 *
 * This is what makes the model unable to invent a figure: a grounded finding is
 * resolved back to the signal a producer emitted, and the sentence is rendered
 * from *that* signal's metrics and category name. The model's answer contributes
 * the position in the list and a severity it was allowed to lower.
 */
function sourceIndex(
  signals: readonly Signal[],
  labelFor: ReadonlyMap<string, string>,
): Map<string, Signal> {
  const index = new Map<string, Signal>()
  for (const signal of signals) {
    const label = signal.categoryId === null ? null : (labelFor.get(signal.categoryId) ?? null)
    index.set(signalKey(signal.code, label), signal)
  }
  return index
}

/**
 * Everything a run needs about one month, gathered once.
 *
 * Shared by the findings pass and the narrative so that both send the same
 * payload for the same month — two collectors would drift, and the second one to
 * drift would be the one nobody reads the output of closely.
 */
export interface PreparedMonth {
  bundle: AnalysisBundle
  /** The full local list, in reading order. Shown when the model does not rank. */
  ranked: Signal[]
  /** The subset that was sent: everything in `ranked` the payload can explain. */
  sendable: Signal[]
  payload: RedactedPayload
  /** `(code, label)` → the signal a producer emitted. The source of every figure. */
  sources: Map<string, Signal>
  categoryIdFor: ReadonlyMap<string, string>
  /** categoryId → the real name. Local only; never part of a payload. */
  nameFor: Map<string, string>
  /**
   * Label → the real name, categories and accounts alike.
   *
   * The narrative is written in terms of labels for anything the model has no name
   * for, and this is what turns `c7` back into the user's own category name on
   * their own screen. The name never crossed the boundary; the substitution
   * happens here.
   */
  nameForLabel: Map<string, string>
}

/** Null when the month has no facts, exactly as `collectBundle` reports it. */
export function prepareMonth(
  db: Db,
  month: string,
  locale: string,
  caps: RankCaps = DEFAULT_CAPS,
): PreparedMonth | null {
  const bundle = collectBundle(db, month, locale)
  if (bundle === null) return null

  const ranked = rankSignals(bundle.signals, caps)
  // A signal about something the payload does not contain cannot be explained to
  // the model, and `redact` would send it with a null label — which is the
  // household sentinel, so a category's numbers would arrive as a household
  // finding. Dropped from what is sent, kept in `ranked` for the local list.
  const known = new Set<string>([
    ...bundle.categories.map((entry) => entry.fact.categoryId),
    ...bundle.accounts.map((row) => row.externalId),
  ])
  const sendable = ranked.filter(
    (signal) => signal.categoryId === null || known.has(signal.categoryId),
  )

  const { payload, labelFor, categoryIdFor } = redact({ ...bundle, signals: sendable })
  const nameFor = new Map(
    bundle.categories.map((entry) => [entry.fact.categoryId, entry.fact.categoryName]),
  )
  for (const row of bundle.accounts) nameFor.set(row.externalId, row.name)

  const nameForLabel = new Map<string, string>()
  for (const [sourceId, label] of labelFor) {
    const name = nameFor.get(sourceId)
    if (name !== undefined) nameForLabel.set(label, name)
  }

  return {
    bundle,
    ranked,
    sendable,
    payload,
    sources: sourceIndex(sendable, labelFor),
    categoryIdFor,
    nameFor,
    nameForLabel,
  }
}

/** Model order, local sentences. A finding whose signal is gone is skipped. */
function renderGrounded(
  findings: readonly GroundedFinding[],
  sources: ReadonlyMap<string, Signal>,
  locale: string,
): AnalysisFinding[] {
  const out: AnalysisFinding[] = []
  for (const finding of findings) {
    const source = sources.get(signalKey(finding.code, finding.label))
    if (source === undefined) continue
    // The model's severity, the producer's numbers: `groundResponse` has already
    // clamped the severity to what the code may carry.
    const [rendered] = renderSignals([{ ...source, severity: finding.severity }], locale)
    if (rendered === undefined) continue
    out.push({ ...rendered, confidence: finding.confidence })
  }
  return out
}

/** The deterministic list, for every path where the model did not rank one. */
const renderDeterministic = (signals: readonly Signal[], locale: string): AnalysisFinding[] =>
  renderSignals(signals, locale).map((finding) => ({ ...finding, confidence: null }))

/**
 * A model clarification → a question about a real category.
 *
 * `groundResponse` has already checked that the label is one of the payload's
 * categories, so a miss here means the maps disagree, which is a bug rather than a
 * hallucination — hence a skip rather than a `dropped` entry.
 */
function resolveClarifications(
  clarifications: readonly GroundedClarification[],
  categoryIdFor: ReadonlyMap<string, string>,
  nameFor: ReadonlyMap<string, string>,
): AnalysisClarification[] {
  const out: AnalysisClarification[] = []
  for (const clarification of clarifications) {
    const categoryId = categoryIdFor.get(clarification.label)
    if (categoryId === undefined) continue
    out.push({
      code: clarification.code,
      categoryId,
      categoryName: nameFor.get(categoryId) ?? clarification.label,
      guess: clarification.guess,
    })
  }
  return out
}

/**
 * Runs the pass for one month.
 *
 * Never throws for a Gemini failure — a nightly job that dies on a socket error
 * leaves no trace of having tried, and the run row is the trace. It does throw for
 * a database failure, which is a different kind of problem and should be loud.
 */
export interface AnalysisEstimate {
  month: string
  model: string
  /** Null when the month has no facts, which is also when a dry run is pointless. */
  payloadChars: number | null
  estimateMicroEur: number
  /** What the budget guard would answer right now, without spending anything. */
  allowed: boolean
  reason: string | null
}

/**
 * What a run on this month would cost, without making one.
 *
 * The prompt editor has to show this *before* the button is pressed — a dry run
 * against real data on a pre-paid key is the one action in this application that
 * spends money on a click, and an editor that hides the price is how a €15 budget
 * disappears in an afternoon of tuning.
 *
 * It is an estimate and says so: tokens come from character count, and the system
 * prompt's own length is deliberately not part of it — that text is cached at the
 * provider, so counting it in full would overstate every run after the first. The
 * payload is the part that changes.
 */
export function estimateAnalysis(
  db: Db,
  options: { month: string; locale?: string; model?: string; now?: Date },
): AnalysisEstimate {
  const locale = options.locale ?? config.DEFAULT_LOCALE
  const model = options.model ?? config.GEMINI_MODEL_FAST
  const prepared = prepareMonth(db, options.month, locale)

  if (prepared === null) {
    return {
      month: options.month,
      model,
      payloadChars: null,
      estimateMicroEur: 0,
      allowed: false,
      reason: 'no_facts',
    }
  }

  const payloadChars = JSON.stringify(prepared.payload).length
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
 * The prompt this run should use: a named version, or whichever is active.
 *
 * The `key` is fixed at `analysis.system` because that is the only prompt this
 * pass has; asking for a `narrative.system` version here would test a prompt
 * against a schema it was not written for, which is why the check exists rather
 * than trusting the caller's id.
 */
function resolvePromptFor(db: Db, locale: string, promptId: string | undefined): ResolvedPrompt {
  if (promptId === undefined) return resolvePrompt(db, 'analysis.system', locale)

  const row = loadPrompt(db, promptId)
  if (row === null) throw new Error(`no such prompt version: ${promptId}`)
  if (row.key !== 'analysis.system') {
    throw new Error(`prompt ${promptId} is a ${row.key}, not an analysis prompt`)
  }

  return {
    id: row.id,
    key: 'analysis.system',
    locale: row.locale,
    version: row.version,
    body: row.body,
  }
}

export async function runAnalysis(db: Db, options: AnalysisOptions): Promise<AnalysisOutcome> {
  const locale = options.locale ?? config.DEFAULT_LOCALE
  const model = options.model ?? config.GEMINI_MODEL_FAST
  const now = options.now ?? new Date()
  const month = options.month
  const persist = options.persist !== false
  // `dryrun` is a stored kind of its own so the spend page can say what the
  // editor cost, and so a query for what the insights page is showing does not
  // have to filter out runs whose findings were never kept.
  const kind = persist ? 'findings' : 'dryrun'

  const base = { month, locale, dropped: [] as DroppedItem[], clarifications: [], queued: 0 }

  const prepared = prepareMonth(db, month, locale, options.caps ?? DEFAULT_CAPS)
  if (prepared === null) {
    log.info({ month }, 'no facts for the month; analysis skipped')
    return {
      ...base,
      status: 'skipped',
      reason: 'no_facts',
      runId: null,
      degraded: true,
      findings: [],
      costMicroEur: 0,
    }
  }

  const { ranked, payload, sources, categoryIdFor, nameFor } = prepared

  const estimate = estimateCostMicroEur(model, JSON.stringify(payload).length, EXPECTED_OUTPUT_TOKENS)
  const decision = checkBudget(db, estimate, now)
  if (!decision.allowed) {
    // Recorded at zero cost: nothing was sent. The payload is stored anyway, so
    // the audit view shows what *would* have gone out.
    const runId = recordRun(db, {
      kind,
      model,
      locale,
      payload,
      status: 'capped',
      error: decision.reason,
      userId: options.userId ?? null,
    })
    log.warn({ month, reason: decision.reason }, 'analysis capped by the monthly AI budget')
    return {
      ...base,
      status: 'capped',
      reason: decision.reason,
      runId,
      degraded: true,
      findings: renderDeterministic(ranked, locale),
      costMicroEur: 0,
    }
  }

  const prompt = resolvePromptFor(db, locale, options.promptId)

  let result
  try {
    result = await callGemini({
      model,
      systemPrompt: composeSystemPrompt(prompt.body, locale),
      instruction: analysisInstruction(payload),
      payload,
      responseJsonSchema: analysisJsonSchema(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    const message = error instanceof GeminiError ? error.message : String(error)
    const runId = recordRun(db, {
      kind,
      model,
      locale,
      payload,
      status: 'error',
      promptId: prompt.id,
      error: message,
      userId: options.userId ?? null,
    })
    log.error({ month, err: message }, 'analysis call failed')
    return {
      ...base,
      status: 'error',
      reason: 'call_failed',
      runId,
      degraded: true,
      findings: renderDeterministic(ranked, locale),
      costMicroEur: 0,
    }
  }

  const cost = costMicroEur(result.model, result.usage)

  let grounded
  try {
    grounded = groundResponse(parseAnalysisResponse(result.text), payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const runId = recordRun(db, {
      kind,
      model: result.model,
      locale,
      payload,
      status: 'error',
      promptId: prompt.id,
      usage: result.usage,
      durationMs: result.durationMs,
      // The tokens were spent whether or not the answer parsed, so the row is
      // billed. That is the number the cost guard has to see.
      error: message,
      userId: options.userId ?? null,
    })
    log.error({ month, err: message }, 'analysis response rejected')
    return {
      ...base,
      status: 'error',
      reason: 'bad_response',
      runId,
      degraded: true,
      findings: renderDeterministic(ranked, locale),
      costMicroEur: cost,
    }
  }

  const findings = renderGrounded(grounded.findings, sources, locale)
  const runId = recordRun(db, {
    kind,
    model: result.model,
    locale,
    payload,
    status: 'ok',
    promptId: prompt.id,
    usage: result.usage,
    durationMs: result.durationMs,
    userId: options.userId ?? null,
  })
  if (persist) persistFindings(db, runId, month, grounded.findings, sources)

  if (grounded.dropped.length > 0) {
    // Worth a log line at warn: a model returning findings nothing computed is
    // either a prompt regression or a provider change, and both are silent.
    log.warn({ month, dropped: grounded.dropped }, 'grounding discarded model findings')
  }

  const clarifications = resolveClarifications(grounded.clarifications, categoryIdFor, nameFor)
  // Enqueued here rather than by the caller: the guesses exist only inside this
  // function, and the one output of a run that accumulates value across months is
  // exactly the one a caller could forget to persist.
  const queued = persist
    ? enqueueClarifications(db, {
        month,
        candidates: clarifications,
        runId,
        now,
      }).enqueued.length
    : 0

  return {
    month,
    locale,
    status: 'ok',
    reason: 'ok',
    runId,
    degraded: false,
    findings,
    clarifications,
    queued,
    dropped: grounded.dropped,
    costMicroEur: cost,
  }
}

/**
 * The findings of one run, stored.
 *
 * The row keeps the metrics rather than the sentence: a stored sentence would be
 * in one language, and re-rendering from the numbers is what makes a language
 * switch free. `metric` holds the headline metric name so a query can group by it
 * without parsing json.
 */
export function persistFindings(
  db: Db,
  runId: string,
  month: string,
  findings: readonly GroundedFinding[],
  sources: ReadonlyMap<string, Signal>,
): number {
  const rows = []
  for (const finding of findings) {
    const source = sources.get(signalKey(finding.code, finding.label))
    if (source === undefined) continue
    rows.push({
      runId,
      code: finding.code,
      categoryId: source.categoryId,
      month,
      metric: Object.keys(source.metrics)[0] ?? null,
      valueJson: JSON.stringify(source.metrics),
      severity: finding.severity,
      confidence: finding.confidence,
    })
  }
  if (rows.length === 0) return 0
  db.insert(aiFindings).values(rows).run()
  return rows.length
}
