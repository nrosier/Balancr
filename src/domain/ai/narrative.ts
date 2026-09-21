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
 *
 * **That missing grounding step is why this file holds the enforcement boundary for #452.**
 * `narrative.system` is editable, and an edit can remove the very rules above. Since #455
 * `runNarrative` refuses outright when the active body has no safe verdict, and it **never
 * substitutes `DEFAULT_PROMPTS` for it**. A silent substitution would be the worst possible
 * bug in this module: the household would read prose written under rules they did not write
 * while believing it came from the text in their editor, and the unchecked body would sit
 * there indefinitely with nothing ever forcing the question. Refusing is loud, free, and has
 * one fix.
 */
import { and, desc, eq } from 'drizzle-orm'
import { callAi } from '../../adapters/ai/client.ts'
import {
  costMicroEur,
  estimateCostMicroEur,
} from '../../adapters/ai/pricing.ts'
import { addUsage, AiError, type AiCall, type AiResult, type TokenUsage } from '../../adapters/ai/types.ts'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { aiNarratives } from '../../db/schema.ts'
import { resolvedIntegrations } from '../../db/tenant-integrations.ts'
import { t } from '../../i18n/index.ts'
import { logger } from '../../logger.ts'
import { isBlankMarkdown, renderMarkdown } from '../../util/markdown.ts'
import { prepareMonth, type AnalysisEstimate } from './analysis.ts'
import { checkBudget, spendMonthOf } from './budget.ts'
import { hashPayload } from './payload-hash.ts'
import { loadMonthNote } from './month-note.ts'
import {
  composeNarrativeSystemPrompt,
  composeSystemPrompt,
  isBuiltInBody,
  loadPrompt,
  resolvePrompt,
} from './prompts.ts'
import type { RedactedPayload } from './redact.ts'
import { loadRun, loadRunPayload, recordRun } from './runs.ts'

const log = logger.child({ module: 'ai.narrative' })

export type NarrativeRow = typeof aiNarratives.$inferSelect

/**
 * Room for six short paragraphs *and* for the thinking that precedes them.
 *
 * A ceiling rather than a target: a truncated narrative is worse than a short one,
 * and the prompt already asks for brevity, so this only stops a runaway.
 *
 * It has to be sized for both halves of the response, because a thinking model's
 * thoughts are billed against this same ceiling and are consumed *before* the first
 * word of prose (#221). Sized for the prose alone it becomes a ceiling the model can
 * exhaust without answering at all, which is what 1,800 did on `gemini-3.1-pro-preview`
 * — a warn line and a wasted, billed call on essentially every run, with
 * `MAX_OUTPUT_TOKENS_RETRY` doing the actual work (#282). The escalation below is meant
 * to be the rare case, not the code path, so the base is now well clear of what
 * thinking has been observed to need.
 */
export const MAX_OUTPUT_TOKENS = 8_000

/**
 * What one narrative is assumed to cost in output tokens, for the guard.
 *
 * The ceiling itself, because that is the most a single call can bill and one call is
 * what the common path now is. It used to sit *above* the ceiling on the belief that
 * thinking was unbounded by `maxOutputTokens`; the truncations that belief was written
 * to explain are the proof it is not — an unbounded thought could not have ended the
 * call at `MAX_TOKENS`.
 *
 * A run that escalates bills more than this. That is accepted rather than priced in:
 * the guard exists to stop a run that cannot be paid for, and inflating every estimate
 * to cover the rare second call would cap runs that were affordable. What was actually
 * spent is recorded from `usageMetadata` either way, so the monthly total stays honest.
 */
export const EXPECTED_OUTPUT_TOKENS = MAX_OUTPUT_TOKENS

/**
 * One escalation, not open-ended retrying, for a call that hit `MAX_OUTPUT_TOKENS`.
 *
 * A multiple of the base rather than its own figure, so the two cannot drift apart the
 * way they did in #248 — where a retry ceiling pinned to the cost estimate quietly
 * became the ceiling that every run relied on. Doubling is enough: a month whose
 * thinking overruns 8,000 tokens is a month where the payload, not the ceiling, is the
 * thing to look at.
 */
export const MAX_OUTPUT_TOKENS_RETRY = MAX_OUTPUT_TOKENS * 2

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

export function loadNarrative(
  db: Db,
  tenantId: string,
  period: string,
  locale: string,
): NarrativeRow | null {
  return (
    db
      .select()
      .from(aiNarratives)
      .where(
        and(
          eq(aiNarratives.period, period),
          eq(aiNarratives.locale, locale),
          eq(aiNarratives.tenantId, tenantId),
        ),
      )
      .get() ?? null
  )
}

/**
 * True when the month's note has been edited since this review was written (#298).
 *
 * The reader's own flow is what makes this necessary: they read a review that calls a
 * movement unexplained drift, write the note that explains it, and — because a narrative
 * is cached per period and locale — see the same paragraph again. So the note now has to
 * do to a review what an edited fact already does: mark it as describing something that
 * has moved.
 *
 * Compared by content rather than by a timestamp, and the payload is where the comparison
 * comes from: since #298 a narrative run stores the note it was written with, so this asks
 * the only question that matters — is the text this review saw the text there is now? A
 * `noteUpdatedAt` beside the note would have been a second authority for the same fact, and
 * would call a review stale for an edit that changed a comma.
 *
 * False, not true, for a review written before #298: its payload has no `note` key at all,
 * so there is nothing to compare and "we cannot tell" must not read as "it is wrong". Those
 * reviews are already offered the plain rewrite control.
 */
export function noteChangedSince(db: Db, tenantId: string, narrative: NarrativeRow): boolean {
  const payload = loadRunPayload(db, tenantId, narrative.runId)
  if (payload === null || typeof payload !== 'object') return false
  if (!('note' in payload)) return false

  const written = (payload as { note: unknown }).note
  if (written !== null && typeof written !== 'string') return false

  const current = loadMonthNote(db, tenantId, narrative.period).trim()
  return (current === '' ? null : current) !== written
}

/**
 * True when *this* review was written from instructions the household had edited (#455,
 * Q3 of #452).
 *
 * The disclosure every reader gets, owner and viewer alike: prose produced under rules
 * somebody rewrote is not the same artefact as prose produced under Balancr's own, and a
 * reader who cannot tell the two apart has no way to weigh what they are reading.
 *
 * **Read from the run's own prompt row, never from `resolvePrompt`.** `ai_narratives.runId`
 * → `ai_runs.promptId` → the `prompts` row that was actually used, which is immutable by
 * design (an edit is a new row, see `prompts.ts`). Asking what is active *now* would get
 * both directions wrong: a prompt rolled back after this review was written would un-flag
 * it, and an edit made this morning would retroactively flag every review ever produced
 * from the built-in text. The row that produced the words is the only thing that can answer
 * the question about those words.
 *
 * Compared with `isBuiltInBody`, so the four states collapse to the one a reader cares
 * about — was this Balancr's text or somebody's own — and a `safe` verdict does not make an
 * edited prompt read as unedited. Note that `isBuiltInBody` matches the *current* default
 * only, so a review written from an older built-in reads as edited. That is the honest
 * answer to "was this written from the instructions this build ships", and it is the same
 * comparison the gate itself uses; see `isBuiltInBody`'s own comment for why the historical
 * bodies get no free pass.
 *
 * **A translation is followed back to the review it translated.** `translateNarrative` sends
 * the code-owned `TRANSLATION_SYSTEM` and therefore records no `promptId` of its own — but
 * the *prose* is the source review's, edited instructions and all, so a Dutch reader of a
 * translated review has exactly the same reason to be told as the English reader who has the
 * original in front of them. Dropping the disclosure at the language switch would be a hole
 * in the promise this field makes to "every reader". The walk is bounded by the locales it
 * has already visited, because a pair of reviews each translated from the other is reachable
 * (translate `en`→`nl`, later rewrite `en` by translating `nl` back) and would otherwise
 * loop.
 *
 * One imprecision worth naming: the source is found by `(period, locale)`, and a narrative is
 * stored one row per pair — so if the English review is *rewritten* after the Dutch
 * translation was made, the Dutch disclosure follows the new English text rather than the
 * text that was actually translated. Recording the source run on the translation row would
 * fix it; carrying a `promptId` the translation call did not use would not, because it would
 * make the ledger claim a prompt version was sent when it was not.
 *
 * False for a run with no `promptId` and no translation source — a narrative written before
 * the ledger recorded one, or one produced from the built-in fallback, which has no row. "We
 * cannot tell" must not print as "somebody edited this", the same way `noteChangedSince`
 * refuses to call a pre-#298 review stale.
 */
export function usedEditedPrompt(db: Db, tenantId: string, narrative: NarrativeRow): boolean {
  const visited = new Set<string>()
  let row: NarrativeRow | null = narrative

  while (row !== null && !visited.has(row.locale)) {
    visited.add(row.locale)
    const run = loadRun(db, tenantId, row.runId)
    if (run === null) return false

    if (run.promptId !== null) {
      const prompt = loadPrompt(db, tenantId, run.promptId)
      if (prompt === null) return false
      // `narrative.system` by construction: this is the only key `runNarrative` resolves, and
      // it is the key whose text the disclosure is about.
      return !isBuiltInBody('narrative.system', prompt.body)
    }

    row = translationSource(db, tenantId, row, run.id)
  }
  return false
}

/**
 * The review a translation was made from, or null when this run is not a translation.
 *
 * Read out of the stored payload rather than from a column, because the payload is where
 * `translateNarrative` already records the source language — `{ period, from, to, bodyMd }`.
 * Null for anything that does not carry a usable `from`, which covers every non-translation
 * run and every payload that will not parse.
 */
function translationSource(
  db: Db,
  tenantId: string,
  narrative: NarrativeRow,
  runId: string,
): NarrativeRow | null {
  const payload = loadRunPayload(db, tenantId, runId)
  if (payload === null || typeof payload !== 'object') return null
  const from = (payload as { from?: unknown }).from
  if (typeof from !== 'string' || from === narrative.locale) return null

  return loadNarrative(db, tenantId, narrative.period, from)
}

/**
 * The languages this period has been written in.
 *
 * What the translate control is built from: offering "write this in Dutch" for a
 * month that already has a Dutch version would charge for a click that changes
 * nothing.
 */
export function narrativeLocales(db: Db, tenantId: string, period: string): string[] {
  return db
    .select({ locale: aiNarratives.locale })
    .from(aiNarratives)
    .where(and(eq(aiNarratives.period, period), eq(aiNarratives.tenantId, tenantId)))
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
export function latestNarrative(db: Db, tenantId: string, locale: string): NarrativeRow | null {
  return (
    db
      .select()
      .from(aiNarratives)
      .where(and(eq(aiNarratives.locale, locale), eq(aiNarratives.tenantId, tenantId)))
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
  tenantId: string,
  input: { runId: string; period: string; locale: string; bodyMd: string },
): NarrativeRow {
  const rows = db
    .insert(aiNarratives)
    .values({
      tenantId,
      runId: input.runId,
      period: input.period,
      locale: input.locale,
      bodyMd: input.bodyMd,
    })
    .onConflictDoUpdate({
      target: [aiNarratives.tenantId, aiNarratives.period, aiNarratives.locale],
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
export function renderNarrative(db: Db, tenantId: string, row: NarrativeRow): string {
  const prepared = prepareMonth(db, tenantId, row.period, row.locale)
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
  | 'truncated'
  /**
   * The active `narrative.system` body has no safe verdict, so no narrative was written
   * (#455, part of #452). A configuration refusal, not a fault: nothing was called,
   * nothing was billed, and a retry cannot fix it — somebody has to check the text or
   * roll back to one that passed. See the refusal in `runNarrative`.
   */
  | 'prompt_unvalidated'

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

const fromRow = (
  row: NarrativeRow,
  db: Db,
  tenantId: string,
  status: NarrativeStatus,
): NarrativeOutcome => ({
  status,
  reason: status === 'ok' ? 'ok' : 'cached',
  runId: row.runId,
  period: row.period,
  locale: row.locale,
  bodyMd: row.bodyMd,
  html: renderNarrative(db, tenantId, row),
  createdAt: row.createdAt,
  degraded: false,
  costMicroEur: 0,
})

/**
 * True once `period` is over.
 *
 * Judged against `spendMonthOf`, which is the clock the cost guard already runs on, so
 * the server and the browser agree about which months are finished — the insights page
 * decides whether to show the offer by comparing the selected month to `spend.month`,
 * and that is the same figure.
 *
 * Load-bearing for the manual narrative (#158). `runNarrative` caches per
 * `(period, locale)` and regenerating costs the deep model again, so a narrative written
 * on the 4th of the month would be a permanent review of a month from a tenth of its
 * facts — with nothing on screen to say the figures behind it were not in yet. The
 * nightly job avoids this by only ever asking for the previous month; a button has to be
 * told.
 */
export function monthHasEnded(period: string, now = new Date()): boolean {
  return period < spendMonthOf(now)
}

/**
 * What a narrative for this month would cost, without writing one.
 *
 * The estimate for the deep model, and the same contract as `estimateAnalysis`: the
 * price is what a button must show before it is pressed, because the key is pre-paid and
 * a click is the only thing in this application that spends money.
 *
 * Four of the five refusals cost nothing to discover and are worth saying rather than
 * pricing:
 *
 *  - `month_not_ended` — see `monthHasEnded`. Not a budget decision, so it is answered
 *    before the guard is consulted.
 *  - `cached` — a narrative already exists in this language, and `runNarrative` would
 *    return it for free. Offering a price beside a review that is already on the page
 *    would be charging for the scroll.
 *  - `no_facts` — nothing was aggregated for the month, which is also when a run would
 *    have nothing to describe.
 *  - `prompt_unvalidated` — the active instructions have no safe verdict, so `runNarrative`
 *    will refuse (#455). This is the mirror of that refusal and the reason it is here: the
 *    estimate is what a button shows before it is pressed, and quoting a price for a run
 *    that is going to refuse is the same mistake `requireAiAvailable` refuses to make on
 *    the endpoint next door.
 *
 * `allowed: false` for all four, because in none of them would pressing the button
 * produce a new narrative. Only the fifth (over budget) carries a real estimate, and
 * only that one is a judgement the guard makes.
 */
export function estimateNarrative(
  db: Db,
  tenantId: string,
  options: { period: string; locale?: string; model?: string; now?: Date },
): AnalysisEstimate {
  const locale = options.locale ?? config.DEFAULT_LOCALE
  const ai = resolvedIntegrations(db, tenantId).ai
  const model = options.model ?? ai.modelDeep
  const now = options.now ?? new Date()
  const refused = (reason: string): AnalysisEstimate => ({
    month: options.period,
    model,
    payloadChars: null,
    estimateMicroEur: 0,
    allowed: false,
    reason,
  })

  if (!monthHasEnded(options.period, now)) return refused('month_not_ended')
  if (loadNarrative(db, tenantId, options.period, locale) !== null) return refused('cached')

  const prepared = prepareMonth(db, tenantId, options.period, locale)
  if (prepared === null) return refused('no_facts')

  // After the free checks and before anything is priced, mirroring `runNarrative` (#455).
  // Resolving costs one indexed read, and pricing a run whose prompt cannot be used would
  // put a figure in front of somebody for a button that is going to refuse.
  const prompt = resolvePrompt(db, tenantId, 'narrative.system', locale)
  if (prompt.gate === 'unvalidated' || prompt.gate === 'unsafe') {
    return refused('prompt_unvalidated')
  }

  const payloadChars = JSON.stringify(prepared.narrativePayload).length
  const estimateMicroEur = estimateCostMicroEur(ai.provider, model, payloadChars, EXPECTED_OUTPUT_TOKENS, ai.modelPrices)
  const decision = checkBudget(db, tenantId, estimateMicroEur, now)

  return {
    month: options.period,
    model,
    payloadChars,
    estimateMicroEur,
    allowed: decision.allowed,
    reason: decision.allowed ? null : decision.reason,
  }
}

interface NarrativeCall {
  result: AiResult
  usage: TokenUsage
  /** True only when the retry also hit `MAX_TOKENS` — the answer is unusable. */
  truncated: boolean
}

/**
 * One narrative call, retried once at `MAX_OUTPUT_TOKENS_RETRY` if the model ran
 * out of room. Both attempts are billed, so the returned `usage` is their sum, not
 * just the one that's kept.
 */
async function callNarrativeModel(
  db: Db,
  tenantId: string,
  call: Omit<AiCall, 'maxOutputTokens'>,
): Promise<NarrativeCall> {
  const first = await callAi(db, tenantId, { ...call, maxOutputTokens: MAX_OUTPUT_TOKENS })
  if (first.finishReason !== 'MAX_TOKENS') {
    return { result: first, usage: first.usage, truncated: false }
  }
  log.warn({ model: call.model }, 'narrative call hit MAX_TOKENS; retrying once at a higher ceiling')
  const retry = await callAi(db, tenantId, { ...call, maxOutputTokens: MAX_OUTPUT_TOKENS_RETRY })
  return {
    result: retry,
    usage: addUsage(first.usage, retry.usage),
    truncated: retry.finishReason === 'MAX_TOKENS',
  }
}

/**
 * Writes the narrative for one month, or explains why it did not.
 *
 * Returns the cached one unless `force` — the expensive model runs once per month
 * per language, and everything that reads a narrative goes through here, so the
 * cache is not something a caller can forget to check.
 *
 * Never throws for a provider failure, for the same reason as `runAnalysis`: the
 * nightly job's only trace of having tried is the run row.
 */
export async function runNarrative(
  db: Db,
  tenantId: string,
  options: NarrativeOptions,
): Promise<NarrativeOutcome> {
  const locale = options.locale ?? config.DEFAULT_LOCALE
  const ai = resolvedIntegrations(db, tenantId).ai
  const model = options.model ?? ai.modelDeep
  const now = options.now ?? new Date()
  const period = options.period

  if (options.force !== true) {
    const cached = loadNarrative(db, tenantId, period, locale)
    if (cached !== null) return fromRow(cached, db, tenantId, 'cached')
  }

  const prepared = prepareMonth(db, tenantId, period, locale)
  if (prepared === null) {
    log.info({ period }, 'no facts for the month; narrative skipped')
    return failed(period, locale, 'skipped', 'no_facts')
  }
  // `narrativePayload`, not `payload`: the note is read by this pass and no other (#298).
  const { narrativePayload: payload, nameForLabel } = prepared
  const payloadHash = hashPayload(payload)

  // ---------------------------------------------------------------------------
  //  The enforcement boundary (#455, part of #452)
  // ---------------------------------------------------------------------------
  //
  // Resolved *before* the budget guard, which is a reorder rather than a coincidence: a run
  // that cannot use its own instructions must refuse for free, and reporting `capped` for
  // it would name the wrong problem and hide this one behind whichever came first in the
  // month. Refusing is also the cheaper answer, so there is no reason to buy the budget
  // decision first.
  //
  // **Never substitute `DEFAULT_PROMPTS` here.** Falling back to Balancr's own text would
  // look like the forgiving choice and would be the worst bug in this file: the household
  // would read a review written under rules they did not write, believing it came from the
  // instructions they can see in the editor, and the edited body would sit there
  // permanently unchecked with nothing ever forcing the question. Refusing is loud, costs
  // nothing, and has exactly one fix — check the text, or activate a version that passed.
  //
  // `blocked` rather than `capped` or `error`: nothing was called and nothing was billed,
  // so a cost-shaped status would be a lie, and `error` is what a retry can fix. The
  // prepared payload goes on the row anyway, because "what would have been sent" is the
  // audit question this ledger exists to answer.
  const prompt = resolvePrompt(db, tenantId, 'narrative.system', locale)
  if (prompt.gate === 'unvalidated' || prompt.gate === 'unsafe') {
    const runId = recordRun(db, tenantId, {
      kind: 'narrative',
      provider: ai.provider,
      model,
      locale,
      period,
      payload,
      payloadHash,
      status: 'blocked',
      promptId: prompt.id,
      error: 'prompt_unvalidated',
      userId: options.userId ?? null,
    })
    log.warn({ period, gate: prompt.gate }, 'narrative prompt has no safe verdict; refusing to run')
    return failed(period, locale, 'skipped', 'prompt_unvalidated', runId)
  }

  const estimate = estimateCostMicroEur(
    ai.provider,
    model,
    JSON.stringify(payload).length,
    EXPECTED_OUTPUT_TOKENS,
    ai.modelPrices,
  )
  const decision = checkBudget(db, tenantId, estimate, now)
  if (!decision.allowed) {
    const runId = recordRun(db, tenantId, {
      kind: 'narrative',
      provider: ai.provider,
      model,
      locale,
      period,
      payload,
      payloadHash,
      status: 'capped',
      error: decision.reason,
      userId: options.userId ?? null,
    })
    log.warn({ period, reason: decision.reason }, 'narrative capped by the monthly AI budget')
    return failed(period, locale, 'capped', decision.reason, runId)
  }

  let call: NarrativeCall
  try {
    call = await callNarrativeModel(db, tenantId, {
      model,
      // The one call site that hands an editable prompt body to a model: the code-owned
      // backstop (#453) is appended after the language directive, unconditionally, so an
      // edited (or maliciously "disclaimed") body never gets the last word. Every other
      // caller of `composeSystemPrompt` in this file passes a code-owned constant instead.
      systemPrompt: composeNarrativeSystemPrompt(prompt.body, locale),
      instruction: narrativeInstruction(payload),
      payload,
      temperature: NARRATIVE_TEMPERATURE,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    const message = error instanceof AiError ? error.message : String(error)
    const runId = recordRun(db, tenantId, {
      kind: 'narrative',
      provider: error instanceof AiError ? error.provider : ai.provider,
      model,
      locale,
      period,
      payload,
      payloadHash,
      status: 'error',
      promptId: prompt.id,
      error: message,
      userId: options.userId ?? null,
    })
    log.error({ period, err: message }, 'narrative call failed')
    return failed(period, locale, 'error', 'call_failed', runId)
  }

  const { result, usage, truncated } = call
  const cost = costMicroEur(result.provider, result.model, usage, ai.modelPrices)
  const bodyMd = result.text.trim()

  if (truncated) {
    // Cut off even after retrying at a higher ceiling — not a narrative, but the
    // tokens were still spent, so the run is still billed for them.
    const runId = recordRun(db, tenantId, {
      kind: 'narrative',
      provider: result.provider,
      model: result.model,
      locale,
      period,
      payload,
      payloadHash,
      status: 'error',
      promptId: prompt.id,
      usage,
      costMicroEurOverride: cost,
      durationMs: result.durationMs,
      error: 'model output still truncated after retrying at a higher token ceiling',
      userId: options.userId ?? null,
    })
    log.error({ period }, 'narrative response was truncated twice; not stored')
    return failed(period, locale, 'error', 'truncated', runId, cost)
  }

  if (isBlankMarkdown(bodyMd)) {
    // Text that renders to nothing is not a narrative. Recorded as an error with
    // its tokens, because they were spent and the guard has to see them.
    const runId = recordRun(db, tenantId, {
      kind: 'narrative',
      provider: result.provider,
      model: result.model,
      locale,
      period,
      payload,
      payloadHash,
      status: 'error',
      promptId: prompt.id,
      usage,
      costMicroEurOverride: cost,
      durationMs: result.durationMs,
      error: 'model returned no renderable text',
      userId: options.userId ?? null,
    })
    log.error({ period }, 'narrative response held no renderable text')
    return failed(period, locale, 'error', 'empty_response', runId, cost)
  }

  const runId = recordRun(db, tenantId, {
    kind: 'narrative',
    provider: result.provider,
    model: result.model,
    locale,
    period,
    payload,
    payloadHash,
    status: 'ok',
    promptId: prompt.id,
    usage,
    costMicroEurOverride: cost,
    durationMs: result.durationMs,
    userId: options.userId ?? null,
  })
  const row = storeNarrative(db, tenantId, { runId, period, locale, bodyMd })

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
  tenantId: string,
  options: TranslateOptions,
): Promise<NarrativeOutcome> {
  const { period, from, to } = options
  const ai = resolvedIntegrations(db, tenantId).ai
  const model = options.model ?? ai.modelFast
  const now = options.now ?? new Date()

  if (from === to) return failed(period, to, 'skipped', 'same_locale')

  const source = loadNarrative(db, tenantId, period, from)
  if (source === null) {
    log.info({ period, from }, 'nothing to translate')
    return failed(period, to, 'skipped', 'no_source')
  }

  if (options.force !== true) {
    const existing = loadNarrative(db, tenantId, period, to)
    if (existing !== null) return fromRow(existing, db, tenantId, 'cached')
  }

  const payload = { period, from, to, bodyMd: source.bodyMd }
  const payloadHash = hashPayload(payload)
  const estimate = estimateCostMicroEur(
    ai.provider,
    model,
    JSON.stringify(payload).length,
    MAX_OUTPUT_TOKENS,
    ai.modelPrices,
  )
  const decision = checkBudget(db, tenantId, estimate, now)
  if (!decision.allowed) {
    const runId = recordRun(db, tenantId, {
      kind: 'narrative',
      provider: ai.provider,
      model,
      locale: to,
      period,
      payload,
      payloadHash,
      status: 'capped',
      error: decision.reason,
      userId: options.userId ?? null,
    })
    log.warn({ period, to, reason: decision.reason }, 'translation capped by the monthly AI budget')
    return failed(period, to, 'capped', decision.reason, runId)
  }

  let call: NarrativeCall
  try {
    call = await callNarrativeModel(db, tenantId, {
      model,
      // No gate check here, and none is missing (#455): `TRANSLATION_SYSTEM` is a code-owned
      // constant that was never a `PROMPT_KEYS` entry, so there is no editable body to check
      // and nothing an owner could have edited away.
      systemPrompt: composeSystemPrompt(TRANSLATION_SYSTEM, to),
      instruction: translationInstruction(from, to),
      payload,
      temperature: TRANSLATION_TEMPERATURE,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (error) {
    const message = error instanceof AiError ? error.message : String(error)
    const runId = recordRun(db, tenantId, {
      kind: 'narrative',
      provider: error instanceof AiError ? error.provider : ai.provider,
      model,
      locale: to,
      period,
      payload,
      payloadHash,
      status: 'error',
      error: message,
      userId: options.userId ?? null,
    })
    log.error({ period, to, err: message }, 'translation call failed')
    return failed(period, to, 'error', 'call_failed', runId)
  }

  const { result, usage, truncated } = call
  const cost = costMicroEur(result.provider, result.model, usage, ai.modelPrices)
  const bodyMd = result.text.trim()

  if (truncated) {
    const runId = recordRun(db, tenantId, {
      kind: 'narrative',
      provider: result.provider,
      model: result.model,
      locale: to,
      period,
      payload,
      payloadHash,
      status: 'error',
      usage,
      costMicroEurOverride: cost,
      durationMs: result.durationMs,
      error: 'model output still truncated after retrying at a higher token ceiling',
      userId: options.userId ?? null,
    })
    log.error({ period, to }, 'translation was truncated twice; not stored')
    return failed(period, to, 'error', 'truncated', runId, cost)
  }

  if (isBlankMarkdown(bodyMd)) {
    const runId = recordRun(db, tenantId, {
      kind: 'narrative',
      provider: result.provider,
      model: result.model,
      locale: to,
      period,
      payload,
      payloadHash,
      status: 'error',
      usage,
      costMicroEurOverride: cost,
      durationMs: result.durationMs,
      error: 'model returned no renderable text',
      userId: options.userId ?? null,
    })
    return failed(period, to, 'error', 'empty_response', runId, cost)
  }

  const runId = recordRun(db, tenantId, {
    kind: 'narrative',
    provider: result.provider,
    model: result.model,
    locale: to,
    period,
    payload,
    payloadHash,
    status: 'ok',
    usage,
    costMicroEurOverride: cost,
    durationMs: result.durationMs,
    userId: options.userId ?? null,
  })
  const row = storeNarrative(db, tenantId, { runId, period, locale: to, bodyMd })

  return { ...fromRow(row, db, tenantId, 'ok'), costMicroEur: cost }
}
