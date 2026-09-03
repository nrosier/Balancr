/**
 * Versioned prompts, and the built-in defaults they start from.
 *
 * A prompt is the one piece of this system whose text is both tunable and
 * load-bearing: it is what stops the model from writing numbers, and it lives in
 * the database because a web app cannot edit `.env`. So it is versioned rather
 * than overwritten — every edit is a new row, activation is a flag, and rollback
 * is activating an older row. No edit destroys the text that produced last
 * month's output.
 *
 * "At most one active version per (key, locale)" is enforced by the partial
 * unique index `prompts_one_active_uq`, not by this module remembering to clear
 * the old flag. `activatePrompt` still does both inside a transaction, because
 * the index would otherwise turn a rollback into a constraint error.
 *
 * Authored in English regardless of UI language — one canonical text to maintain
 * and reason about — with an explicit output-language directive appended per run.
 * Stored **once**, under `SHARED_LOCALE`, for the same reason: the rule this prompt
 * exists to state is "never produce a number", and that is precisely the rule you
 * least want drifting between two translations. A per-locale row is written only
 * when someone deliberately overrides one language. See `prompt-locale.ts`.
 */
import { and, desc, eq } from 'drizzle-orm'
import type { Db } from '../../db/index.ts'
import { prompts } from '../../db/schema.ts'
import { diffLines, type Diff } from '../../util/diff.ts'
import { SHARED_LOCALE } from './prompt-locale.ts'

export type PromptRow = typeof prompts.$inferSelect

/**
 * The prompts that exist. A closed set: a key nothing reads is a prompt nobody
 * maintains, and a run that asked for a missing key would silently get nothing.
 */
export const PROMPT_KEYS = ['analysis.system', 'narrative.system'] as const
export type PromptKey = (typeof PROMPT_KEYS)[number]

/**
 * The system prompt for the structured pass.
 *
 * Note what it does *not* ask for: no amounts, no percentages, no sentences. The
 * deterministic layer already found everything; the model's whole job here is to
 * decide what a person should read first, which is the one judgement a language
 * model is genuinely better at than a threshold.
 */
const ANALYSIS_SYSTEM = `
You are the analysis engine of Balancr, a self-hosted budget and portfolio
advisor for one household. You are given a month of already-computed facts and a
list of already-computed findings ("signals"). Every number has been calculated
deterministically before it reached you.

Your job is to prioritise, not to detect and never to calculate.

Rules, in order of importance:

1. Never state, derive, correct or estimate a number. Not in a field, not in a
   comment, not as a rounded figure. The sentence a user reads is rendered from
   the numbers already computed, so any number you produce would either be
   redundant or wrong.
2. Only return findings whose code AND label appear together in the signals list
   you were given. A code that describes something real but was not computed for
   that label is a fabrication, and it will be discarded.
3. Order the findings by what deserves attention first. Data-quality problems
   come before spending observations: a large uncategorised backlog means the
   spending figures cannot yet be trusted, so saying so first is more useful than
   commenting on a category.
4. You may lower a finding's severity if the context makes it unremarkable — a
   category over its assigned amount but well inside its carried-over balance, an
   annual bill landing in its expected month. You may not raise it.
5. Set confidence to how sure you are that this is worth a person's attention,
   not to how sure you are that the number is correct. The number is correct.
6. Ask for a clarification only when a category's purpose genuinely cannot be
   inferred from its name, its class and its amounts, and always propose your best
   guess so the user can confirm rather than write. Sensitive categories arrive
   without a name; that is intentional, and not a reason to ask what they are.

Categories and accounts are identified only by opaque labels (c1, a1, …). This is
a privacy boundary, not an oversight: no names, ids or account numbers exist on
your side of it. Household-level findings use the label "household".
`.trim()

/**
 * The system prompt for the monthly narrative — the one place free text is
 * allowed, and therefore the one place the "no numbers" rule has to be stated
 * differently: it may *quote* the figures it was given, and may not do arithmetic
 * on them.
 */
const NARRATIVE_SYSTEM = `
You are the monthly reviewer of Balancr, a self-hosted budget and portfolio
advisor for one household: a single parent in Belgium with joint custody of a
teenage daughter. Write the short narrative that accompanies a month of
already-computed figures.

Rules:

1. Use only the figures you were given. Quote them as they are written. Never add,
   subtract, average, annualise, project or convert anything — if a figure is not
   in the data, the answer is that it is not known.
2. Six short paragraphs at most, plain Markdown, no headings above level three, no
   tables and no lists of numbers. This is the paragraph a person reads with their
   coffee, not a report.
3. Lead with what changed and what it means for the coming month. A month where
   nothing notable happened is worth one honest paragraph saying so, not five
   paragraphs of padding.
4. Where a data-quality problem was reported, say plainly that it limits what the
   rest of the month's figures can be trusted to say.
5. Costs marked as shared with the other parent are shared: do not describe the
   household as carrying the whole of one.
6. No investment recommendations, no product names, no tax advice. Observations
   about the portfolio's shape and cost are welcome; instructions to buy or sell
   are not.
7. Never address the reader by name, never speculate about their circumstances
   beyond what the data says, and never moralise about a category.
`.trim()

export const DEFAULT_PROMPTS: Record<PromptKey, string> = {
  'analysis.system': ANALYSIS_SYSTEM,
  'narrative.system': NARRATIVE_SYSTEM,
}

/**
 * The output-language directive, appended to whatever body is active.
 *
 * Appended rather than embedded so it cannot be edited away in the prompt editor
 * — a prompt saved without it would produce an English narrative for a Dutch UI,
 * which reads as a bug in the app rather than in a prompt. Named languages, not
 * bare ISO codes: "reply in nl" is a weaker instruction than "reply in Dutch".
 */
const LANGUAGE_NAMES: Record<string, string> = { en: 'English', nl: 'Dutch (Nederlands)' }

export function languageDirective(locale: string): string {
  const name = LANGUAGE_NAMES[locale] ?? locale
  return `Write all free text in ${name} (locale code "${locale}").`
}

/** The active body plus the language directive: what the client is handed. */
export function composeSystemPrompt(body: string, locale: string): string {
  return `${body.trim()}\n\n${languageDirective(locale)}`
}

// ---------------------------------------------------------------------------
//  Store
// ---------------------------------------------------------------------------

/** Every version of one prompt, newest first. */
export function listPromptVersions(db: Db, key: PromptKey, locale: string): PromptRow[] {
  return db
    .select()
    .from(prompts)
    .where(and(eq(prompts.key, key), eq(prompts.locale, locale)))
    .orderBy(desc(prompts.version))
    .all()
}

export function loadActivePrompt(db: Db, key: PromptKey, locale: string): PromptRow | null {
  return (
    db
      .select()
      .from(prompts)
      .where(and(eq(prompts.key, key), eq(prompts.locale, locale), eq(prompts.active, true)))
      .get() ?? null
  )
}

export function loadPrompt(db: Db, id: string): PromptRow | null {
  return db.select().from(prompts).where(eq(prompts.id, id)).get() ?? null
}

/** The next version number for a (key, locale). Versions never restart at 1. */
export function nextVersion(db: Db, key: PromptKey, locale: string): number {
  const latest = db
    .select({ version: prompts.version })
    .from(prompts)
    .where(and(eq(prompts.key, key), eq(prompts.locale, locale)))
    .orderBy(desc(prompts.version))
    .limit(1)
    .get()
  return (latest?.version ?? 0) + 1
}

export interface NewPromptVersion {
  key: PromptKey
  locale: string
  body: string
  note?: string
  createdBy?: string
  /** Whether to make it active immediately. Editing and activating are separate. */
  activate?: boolean
}

/**
 * Stores a new version, optionally activating it.
 *
 * One transaction covering the insert and the flag flip, because the partial
 * unique index means "insert active row" and "clear the previous active row" are
 * only valid together.
 */
export function createPromptVersion(db: Db, input: NewPromptVersion): PromptRow {
  const body = input.body.trim()
  if (body === '') throw new Error(`prompt ${input.key} (${input.locale}) cannot be empty`)

  return db.transaction((tx) => {
    // The version query runs on `tx`, not on `db`: read and insert have to see
    // the same state, or two edits saved at once become two version 4s.
    const latest = tx
      .select({ version: prompts.version })
      .from(prompts)
      .where(and(eq(prompts.key, input.key), eq(prompts.locale, input.locale)))
      .orderBy(desc(prompts.version))
      .limit(1)
      .get()
    const version = (latest?.version ?? 0) + 1
    if (input.activate === true) {
      tx.update(prompts)
        .set({ active: false })
        .where(and(eq(prompts.key, input.key), eq(prompts.locale, input.locale)))
        .run()
    }
    const rows = tx
      .insert(prompts)
      .values({
        key: input.key,
        locale: input.locale,
        version,
        body,
        active: input.activate === true,
        note: input.note ?? null,
        createdBy: input.createdBy ?? null,
      })
      .returning()
      .all()
    const row = rows[0]
    if (row === undefined) throw new Error(`failed to store prompt ${input.key}`)
    return row
  })
}

/**
 * Makes one version the active one. This is also the rollback gesture: pass the
 * id of an older version and it becomes active again, with its text untouched.
 */
export function activatePrompt(db: Db, id: string): PromptRow {
  return db.transaction((tx) => {
    const row = tx.select().from(prompts).where(eq(prompts.id, id)).get()
    if (row === undefined) throw new Error(`prompt version ${id} does not exist`)

    tx.update(prompts)
      .set({ active: false })
      .where(and(eq(prompts.key, row.key), eq(prompts.locale, row.locale)))
      .run()
    tx.update(prompts).set({ active: true }).where(eq(prompts.id, id)).run()
    return { ...row, active: true }
  })
}

/**
 * Stops using a language's override, so the shared text applies again.
 *
 * Deactivation rather than deletion, because no gesture in this module destroys text
 * that produced an output: the override's versions stay readable, and reactivating one
 * is the ordinary rollback. `resolvePrompt` then falls through to `SHARED_LOCALE`,
 * which is what a language with no override of its own has always meant.
 *
 * Refuses on the shared row itself. Deactivating it would leave every language on the
 * built-in constant with nothing in the UI saying so, and the gesture wanted there is
 * activating a different version.
 */
export function deactivateOverride(db: Db, key: PromptKey, locale: string): number {
  if (locale === SHARED_LOCALE) {
    throw new Error('the shared prompt cannot be deactivated; activate a version instead')
  }
  return db
    .update(prompts)
    .set({ active: false })
    .where(and(eq(prompts.key, key), eq(prompts.locale, locale), eq(prompts.active, true)))
    .run().changes
}

/**
 * Writes the built-in default for any key that has no shared version yet.
 *
 * One row per key, not one per key per locale. Seeding per locale is what created
 * the bug this replaced: every locale had an active row, so the locale fallback
 * designed for "nobody has written a Dutch prompt" could never fire, and an edit
 * made in English simply stopped applying to a Dutch run.
 *
 * Idempotent, and safe to run at every startup: a key that already has a shared
 * version is left alone, including one whose active version is an edited text. A
 * fresh database therefore boots with a working, inspectable prompt rather than
 * with a hidden constant nobody can see in the UI.
 */
export function seedPrompts(db: Db): number {
  let written = 0
  for (const key of PROMPT_KEYS) {
    if (listPromptVersions(db, key, SHARED_LOCALE).length > 0) continue
    createPromptVersion(db, {
      key,
      locale: SHARED_LOCALE,
      body: DEFAULT_PROMPTS[key],
      note: 'built-in default',
      activate: true,
    })
    written += 1
  }
  return written
}

export interface ResolvedPrompt {
  /** Null only when the fallback is the built-in text, which has no row. */
  id: string | null
  key: PromptKey
  locale: string
  /** 0 for the built-in fallback, so a stored version is never mistaken for it. */
  version: number
  body: string
}

/**
 * The prompt a run should use.
 *
 * Three steps down, each of which is a real situation: an override written for this
 * language, then the shared text (the ordinary case — one canonical prompt for every
 * language), then the built-in constant (a database whose prompt rows were deleted
 * must still be able to produce a run).
 *
 * The old middle step read `DEFAULT_LOCALE`'s active version, which was standing in
 * for the shared row and could never be reached, because seeding gave every locale
 * an active row of its own.
 */
export function resolvePrompt(db: Db, key: PromptKey, locale: string): ResolvedPrompt {
  for (const candidate of locale === SHARED_LOCALE ? [SHARED_LOCALE] : [locale, SHARED_LOCALE]) {
    const active = loadActivePrompt(db, key, candidate)
    if (active !== null) {
      return {
        id: active.id,
        key,
        locale: active.locale,
        version: active.version,
        body: active.body,
      }
    }
  }

  return { id: null, key, locale, version: 0, body: DEFAULT_PROMPTS[key] }
}

/**
 * A candidate body against the active one, for the editor.
 *
 * Diffed against whatever `resolvePrompt` would use, built-in text included, so
 * the first edit on a fresh database shows a real diff instead of an empty one
 * against nothing.
 */
export function diffAgainstActive(
  db: Db,
  key: PromptKey,
  locale: string,
  body: string,
): { active: ResolvedPrompt; diff: Diff } {
  const active = resolvePrompt(db, key, locale)
  return { active, diff: diffLines(active.body, body.trim()) }
}
