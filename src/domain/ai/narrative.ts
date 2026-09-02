/**
 * The monthly narrative: the one place in Balancr where the model writes prose.
 *
 * Everything else the AI layer produces is a code that renders into a translated
 * sentence, which is why a language switch is free. This is the exception, and it
 * costs the most per run — so it is cached per `(period, locale)`, and switching
 * language offers an explicit **translate** action instead of silently
 * regenerating. A toggle that quietly spends money on the deep model is a bug
 * dressed as a feature.
 *
 * Two properties are worth stating plainly, because both are easy to lose:
 *
 *  - **What is stored is what the model wrote.** Labels are left intact in
 *    `ai_narratives.body_md`; the real names are substituted at render time, on
 *    this machine. So the stored text is safe to send back to Google for a
 *    translation, and a sensitive category's name is still nowhere near the wire.
 *  - **Substitution happens in Markdown, before rendering.** The name then passes
 *    through the renderer's escaping like any other text, so a category called
 *    `<script>` is escaped rather than injected.
 *
 * The model may quote the figures it was given and may not do arithmetic on them
 * (`NARRATIVE_SYSTEM` says so in its first rule). There is no grounding step to
 * catch a violation the way `groundResponse` catches an invented finding — free
 * text cannot be checked against a signal table — which is why the narrative gets
 * the prompt's strongest wording and the smallest payload that still explains the
 * month.
 */
import { and, desc, eq } from 'drizzle-orm'
import { callGemini, GeminiError } from '../../adapters/gemini/client.ts'
import { costMicroEur, estimateCostMicroEur } from '../../adapters/gemini/pricing.ts'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { aiNarratives } from '../../db/schema.ts'
import { t } from '../../i18n/index.ts'
import { logger } from '../../logger.ts'
import { isBlankMarkdown, renderMarkdown } from '../../util/markdown.ts'
import { prepareMonth } from './analysis.ts'
import { checkBudget } from './budget.ts'
import { composeSystemPrompt, resolvePrompt } from './prompts.ts'
import type { RedactedPayload } from './redact.ts'
import { recordRun } from './runs.ts'

const log = logger.child({ module: 'ai.narrative' })

export type NarrativeRow = typeof aiNarratives.$inferSelect

/**
 * Six short paragraphs, with room to finish the last sentence.
 *
 * A ceiling rather than a target: a truncated narrative is worse than a short one,
 * and the prompt already asks for brevity, so this only stops a runaway.
 */
export const MAX_OUTPUT_TOKENS = 1_800

/**
 * What one narrative is assumed to cost in output tokens, for the guard.
 *
 * Higher than `MAX_OUTPUT_TOKENS` on purpose: the deep model thinks, thinking
 * tokens are billed as output, and they are not bounded by `maxOutputTokens`. The
 * estimate exists to keep a run from starting when it cannot be paid for, so
 * overstating it errs toward the banner rather than toward an overspend.
 */
export const EXPECTED_OUTPUT_TOKENS = 6_000

/**
 * Slightly above the default 0.2.
 *
 * Prose written at the temperature used for ranking reads mechanical, and unlike
 * the ranking pass there is no property here that two runs must agree on: the
 * figures are quoted from the payload either way, and the result is cached, so a
 * month is written once.
 */
const NARRATIVE_TEMPERATURE = 0.3

/** A translation is mechanical, so it is deterministic. */
const TRANSLATION_TEMPERATURE = 0

/**
 * The system prompt for a translation.
 *
 * Not a `prompts` table key: `PROMPT_KEYS` is a closed set of the prompts worth
 * tuning, and this is not one — it is a mechanical operation whose only real rule
 * is "change the language and nothing else". A tunable translation prompt would be
 * one more place a figure could be edited into a different figure.
 */
const TRANSLATION_SYSTEM = `
You translate one already-written monthly financial review into another language.

Rules:

1. Translate. Do not summarise, expand, reorder, improve or comment.
2. Every figure, currency symbol, percentage, date and month name stays exactly as
   written. Never convert a currency, never re-format a number, never round.
3. Opaque labels such as c7 or a2 are identifiers, not words. Reproduce them
   character for character.
4. Keep the Markdown structure: the same paragraphs, the same emphasis, the same
   list items.
5. Output the translated review and nothing else — no preamble, no note about
   what you did.
`.trim()

/**
 * The instruction for a fresh narrative. Billed on every run, so it is short:
 * the rules live in the cached system prompt.
 */
export function narrativeInstruction(payload: RedactedPayload): string {
  return [
    `Write the monthly review for ${payload.month}.`,
    'Use only the figures in the data block, quoted exactly as they are written.',
    'Anything the data gives no name for carries an opaque label such as c7 or a2:',
    'write that label exactly as given — the real name is filled in locally before',
    'anyone reads this, so a guess at what it might be would be overwritten by the',
    'truth or, worse, kept.',
  ].join(' ')
}

const translationInstruction = (from: string, to: string): string =>
  `Translate the review in the data block from ${from} to ${to}. Keep every figure and every label unchanged.`

// ---------------------------------------------------------------------------
//  Store
// ---------------------------------------------------------------------------

export function loadNarrative(db: Db, period: string, locale: string): NarrativeRow | null {
  return (
    db
      .select()
      .from(aiNarratives)
      .where(and(eq(aiNarratives.period, period), eq(aiNarratives.locale, locale)))
      .get() ?? null
  )
}

/**
 * The languages this period has been written in.
 *
 * What the translate control is built from: offering "write this in Dutch" for a
 * month that already has a Dutch version would charge for a click that changes
 * nothing.
 */
export function narrativeLocales(db: Db, period: string): string[] {
  return db
    .select({ locale: aiNarratives.locale })
    .from(aiNarratives)
    .where(eq(aiNarratives.period, period))
    .all()
    .map((row) => row.locale)
    .sort()
}

/**
 * The newest narrative in one language, whatever period it covers.
 *
 * This is the degraded view's material: over budget or after a failed call, the
 * page shows the last narrative there is with a banner saying how old it is,
 * rather than an error. Deliberately *not* returned by `runNarrative` — a runner
 * that silently answered about a different month would make the banner optional,
 * and the banner is the honest part.
 */
export function latestNarrative(db: Db, locale: string): NarrativeRow | null {
  return (
    db
      .select()
      .from(aiNarratives)
      .where(eq(aiNarratives.locale, locale))
      .orderBy(desc(aiNarratives.period))
      .limit(1)
      .get() ?? null
  )
}

/**
 * Writes the narrative for a `(period, locale)`, replacing any earlier one.
 *
 * Upsert rather than insert: `ai_narratives_period_locale_uq` means a second run
 * of the same month in the same language is a replacement, and regenerating is a
 * deliberate act (`force`) whose result should be what the page shows.
 */
export function storeNarrative(
  db: Db,
  input: { runId: string; period: string; locale: string; bodyMd: string },
): NarrativeRow {
  const rows = db
    .insert(aiNarratives)
    .values({
      runId: input.runId,
      period: input.period,
      locale: input.locale,
      bodyMd: input.bodyMd,
    })
    .onConflictDoUpdate({
      target: [aiNarratives.period, aiNarratives.locale],
      set: { runId: input.runId, bodyMd: input.bodyMd, createdAt: new Date() },
    })
    .returning()
    .all()
  const row = rows[0]
  if (row === undefined) throw new Error(`failed to store the narrative for ${input.period}`)
  return row
}

// ---------------------------------------------------------------------------
//  Rendering
// ---------------------------------------------------------------------------

/**
 * A payload label, as the model was given it: `c` or `a` and a small number.
 *
 * Anchored on word boundaries. A false positive would need a narrative to contain
 * a standalone token of exactly this shape meaning something else, which this text
 * has no reason to; the cost of one would be cosmetic, and the cost of *not*
 * substituting is a bare `c7` on the page where a name belongs.
 */
const LABEL = /\b([ca])(\d{1,4})\b/g

/**
 * Labels → the household's own names.
 *
 * A label with no name is a category or account that has since disappeared from
 * the month's facts — a narrative outlives the bundle it was written from — so it
 * renders as "an unnamed category" rather than as an identifier. Single pass, so a
 * substituted name is never rescanned for labels.
 */
export function substituteLabels(
  bodyMd: string,
  nameForLabel: ReadonlyMap<string, string>,
  locale: string,
): string {
  return bodyMd.replace(LABEL, (match, kind: string) => {
    const name = nameForLabel.get(match)
    if (name !== undefined) return name
    return kind === 'a'
      ? t(locale, 'ai:narrative.unnamedAccount')
      : t(locale, 'ai:narrative.unnamedCategory')
  })
}

/**
 * A stored narrative → HTML ready to put on the page.
 *
 * Re-collects the month to learn the label→name mapping. That is a handful of
 * indexed reads and it is what keeps the names out of the stored text: the
 * alternative, storing the substituted version, would put a sensitive category's
 * name into a row that is then sent back to Google by the translate action.
 */
export function renderNarrative(db: Db, row: NarrativeRow): string {
  const prepared = prepareMonth(db, row.period, row.locale)
  const names = prepared?.nameForLabel ?? new Map<string, string>()
  return renderMarkdown(substituteLabels(row.bodyMd, names, row.locale))
}

// ---------------------------------------------------------------------------
//  Runs
// ---------------------------------------------------------------------------

export type NarrativeStatus = 'ok' | 'cached' | 'capped' | 'error' | 'skipped'

export type NarrativeReason =
  | 'ok'
  | 'cached'
  | 'no_facts'
  | 'no_source'
  | 'same_locale'
  | 'month_budget_exceeded'
  | 'estimate_exceeds_remaining'
  | 'call_failed'
  | 'empty_response'

export interface NarrativeOutcome {
  status: NarrativeStatus
  reason: NarrativeReason
  runId: string | null
  period: string
  locale: string
  /** As the model wrote it: labels intact. Null when nothing was produced. */
  bodyMd: string | null
  /** Names substituted, Markdown rendered. What the page shows. */
  html: string | null
  createdAt: Date | null
  /** True when the caller should show a banner rather than a fresh narrative. */
  degraded: boolean
  costMicroEur: number
}

export interface NarrativeOptions {
  /** The month described, `YYYY-MM`. */
  period: string
  locale?: string
  model?: string
  /** Rewrite a month that already has a narrative. The only way to pay twice. */
  force?: boolean
  now?: Date
  signal?: AbortSignal
  userId?: string | null
}

const failed = (
  period: string,
  locale: string,
  status: NarrativeStatus,
  reason: NarrativeReason,
  runId: string | null = null,
  costMicroEur = 0,
): NarrativeOutcome => ({
  status,
  reason,
  runId,
  period,
  locale,
  bodyMd: null,
  html: null,
  createdAt: null,
  degraded: true,
  costMicroEur,
})

const fromRow = (row: NarrativeRow, db: Db, status: NarrativeStatus): NarrativeOutcome => ({
  status,
  reason: status === 'ok' ? 'ok' : 'cached',
  runId: row.runId,
  period: row.period,
  locale: row.locale,
  bodyMd: row.bodyMd,
  html: renderNarrative(db, row),
  createdAt: row.createdAt,
  degraded: false,
  costMicroEur: 0,
})

/**
 * Writes the narrative for one month, or explains why it did not.
 *
 * Returns the cached one unless `force` — the expensive model runs once per month
 * per language, and everything that reads a narrative goes through here, so the
 * cache is not something a caller can forget to check.
 *
 * Never throws for a Gemini failure, for the same reason as `runAnalysis`: the
 * nightly job's only trace of having tried is the run row.
 */
export async function runNarrative(db: Db, options: NarrativeOptions): Promise<NarrativeOutcome> {
  const locale = options.locale ?? config.DEFAULT_LOCALE
  const model = options.model ?? config.GEMINI_MODEL_DEEP
  const now = options.now ?? new Date()
  const period = options.period

  if (options.force !== true) {
    const cached = loadNarrative(db, period, locale)
    if (cached !== null) return fromRow(cached, db, 'cached')
  }

  const prepared = prepareMonth(db, period, locale)
  if (prepared === null) {
    log.info({ period }, 'no facts for the month; narrative skipped')
    return failed(period, locale, 'skipped', 'no_facts')
  }
  const { payload, nameForLabel } = prepared

  const estimate = estimateCostMicroEur(model, JSON.stringify(payload).length, EXPECTED_OUTPUT_TOKENS)
  const decision = checkBudget(db, estimate, now)
  if (!decision.allowed) {
    const runId = recordRun(db, {
      kind: 'narrative',
      model,
      locale,
      payload,
      status: 'capped',
      error: decision.reason,
      userId: options.userId ?? null,
    })
    log.warn({ period, reason: decision.reason }, 'narrative capped by the monthly AI budget')
    return failed(period, locale, 'capped', decision.reason, runId)
  }

  const prompt = resolvePrompt(db, 'narrative.system', locale)

  let result
  try {
    result = await callGemini({
      model,
      systemPrompt: composeSystemPrompt(prompt.body, locale),
      instruction: narrativeInstruction(payload),
      payload,
      temperature: NARRATIVE_TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    const message = error instanceof GeminiError ? error.message : String(error)
    const runId = recordRun(db, {
      kind: 'narrative',
      model,
      locale,
      payload,
      status: 'error',
      promptId: prompt.id,
      error: message,
      userId: options.userId ?? null,
    })
    log.error({ period, err: message }, 'narrative call failed')
    return failed(period, locale, 'error', 'call_failed', runId)
  }

  const cost = costMicroEur(result.model, result.usage)
  const bodyMd = result.text.trim()

  if (isBlankMarkdown(bodyMd)) {
    // Text that renders to nothing is not a narrative. Recorded as an error with
    // its tokens, because they were spent and the guard has to see them.
    const runId = recordRun(db, {
      kind: 'narrative',
      model: result.model,
      locale,
      payload,
      status: 'error',
      promptId: prompt.id,
      usage: result.usage,
      durationMs: result.durationMs,
      error: 'model returned no renderable text',
      userId: options.userId ?? null,
    })
    log.error({ period }, 'narrative response held no renderable text')
    return failed(period, locale, 'error', 'empty_response', runId, cost)
  }

  const runId = recordRun(db, {
    kind: 'narrative',
    model: result.model,
    locale,
    payload,
    status: 'ok',
    promptId: prompt.id,
    usage: result.usage,
    durationMs: result.durationMs,
    userId: options.userId ?? null,
  })
  const row = storeNarrative(db, { runId, period, locale, bodyMd })

  return {
    status: 'ok',
    reason: 'ok',
    runId,
    period,
    locale,
    bodyMd,
    html: renderMarkdown(substituteLabels(bodyMd, nameForLabel, locale)),
    createdAt: row.createdAt,
    degraded: false,
    costMicroEur: cost,
  }
}

export interface TranslateOptions {
  period: string
  /** The language to translate from. Must already have a narrative. */
  from: string
  to: string
  model?: string
  /** Replace an existing translation rather than returning it. */
  force?: boolean
  now?: Date
  signal?: AbortSignal
  userId?: string | null
}

/**
 * Translates an existing narrative into another language.
 *
 * The explicit alternative to regenerating: a translation sends a page of text to
 * the fast model, where a fresh narrative sends a month of facts to the deep one.
 * It is also the honest operation — the reader gets the same review in their own
 * language, not a second opinion about the same month that happens to differ.
 *
 * What goes out is the stored body, labels and all, which is why nothing is
 * substituted before this point.
 */
export async function translateNarrative(
  db: Db,
  options: TranslateOptions,
): Promise<NarrativeOutcome> {
  const { period, from, to } = options
  const model = options.model ?? config.GEMINI_MODEL_FAST
  const now = options.now ?? new Date()

  if (from === to) return failed(period, to, 'skipped', 'same_locale')

  const source = loadNarrative(db, period, from)
  if (source === null) {
    log.info({ period, from }, 'nothing to translate')
    return failed(period, to, 'skipped', 'no_source')
  }

  if (options.force !== true) {
    const existing = loadNarrative(db, period, to)
    if (existing !== null) return fromRow(existing, db, 'cached')
  }

  const payload = { period, from, to, bodyMd: source.bodyMd }
  const estimate = estimateCostMicroEur(model, JSON.stringify(payload).length, MAX_OUTPUT_TOKENS)
  const decision = checkBudget(db, estimate, now)
  if (!decision.allowed) {
    const runId = recordRun(db, {
      kind: 'narrative',
      model,
      locale: to,
      payload,
      status: 'capped',
      error: decision.reason,
      userId: options.userId ?? null,
    })
    log.warn({ period, to, reason: decision.reason }, 'translation capped by the monthly AI budget')
    return failed(period, to, 'capped', decision.reason, runId)
  }

  let result
  try {
    result = await callGemini({
      model,
      systemPrompt: composeSystemPrompt(TRANSLATION_SYSTEM, to),
      instruction: translationInstruction(from, to),
      payload,
      temperature: TRANSLATION_TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    const message = error instanceof GeminiError ? error.message : String(error)
    const runId = recordRun(db, {
      kind: 'narrative',
      model,
      locale: to,
      payload,
      status: 'error',
      error: message,
      userId: options.userId ?? null,
    })
    log.error({ period, to, err: message }, 'translation call failed')
    return failed(period, to, 'error', 'call_failed', runId)
  }

  const cost = costMicroEur(result.model, result.usage)
  const bodyMd = result.text.trim()

  if (isBlankMarkdown(bodyMd)) {
    const runId = recordRun(db, {
      kind: 'narrative',
      model: result.model,
      locale: to,
      payload,
      status: 'error',
      usage: result.usage,
      durationMs: result.durationMs,
      error: 'model returned no renderable text',
      userId: options.userId ?? null,
    })
    return failed(period, to, 'error', 'empty_response', runId, cost)
  }

  const runId = recordRun(db, {
    kind: 'narrative',
    model: result.model,
    locale: to,
    payload,
    status: 'ok',
    usage: result.usage,
    durationMs: result.durationMs,
    userId: options.userId ?? null,
  })
  const row = storeNarrative(db, { runId, period, locale: to, bodyMd })

  return { ...fromRow(row, db, 'ok'), costMicroEur: cost }
}
