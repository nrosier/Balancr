/**
 * The locale value that means "every language".
 *
 * A prompt is addressed to the model, not to the reader: the output language is a
 * separate directive appended per run (`composeSystemPrompt`), so one canonical
 * English text serves every UI language. Storing a copy per locale bought a
 * divergence nobody asked for at the cost of a shared edit nobody could make —
 * improving the instructions in English left the Dutch run on the untouched
 * built-in text, silently.
 *
 * So `prompts.locale` holds this sentinel for the shared text, and a real locale
 * code only when someone has deliberately written an override for that language.
 * A sentinel rather than `NULL` because both unique indexes on the table include
 * `locale`, and SQLite treats `NULL`s as distinct in a unique index — "at most one
 * active version" would have stopped being enforced by the database for exactly the
 * rows that matter most. `*` cannot collide with a language tag; BCP 47 has no
 * such character.
 *
 * Its own module because `web/` needs it too — the editor has to know which entry
 * is the shared one — and `prompts.ts` reads `config`, which the browser cannot.
 */
export const SHARED_LOCALE = '*'

/** Whether a stored prompt row is the shared text rather than an override. */
export function isSharedLocale(locale: string): boolean {
  return locale === SHARED_LOCALE
}
