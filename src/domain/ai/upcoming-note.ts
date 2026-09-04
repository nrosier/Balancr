/**
 * One running free-text note: what the owner knows is coming that a trailing average
 * can't (#217). `suggestBudgetAmounts` (#45) only ever looks backward, so a dentist
 * bill or an annual renewal reads as ordinary drift the month it lands. The note is the
 * owner's side of that gap; `budget-nudge.ts` is the AI pass that reads it.
 *
 * Same load/save contract as `household.ts`: reading degrades to the default and never
 * throws, writing validates and throws. A note nobody can parse should cost the nudge,
 * not the settings page.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { settings } from '../../db/schema.ts'
import { logger } from '../../logger.ts'

const log = logger.child({ module: 'ai/upcoming-note' })

export const UPCOMING_NOTE_KEY = 'ai.upcomingNote'

/** A short paragraph naming a few upcoming items — double `clarify.ts`'s single-category MAX_DESCRIPTION_CHARS (500). */
export const UPCOMING_NOTE_MAX_CHARS = 1000

export const upcomingNoteSchema = z
  .object({ text: z.string().trim().max(UPCOMING_NOTE_MAX_CHARS).default('') })
  .strict()
  .prefault({})

export type UpcomingNote = z.infer<typeof upcomingNoteSchema>

export const DEFAULT_UPCOMING_NOTE: UpcomingNote = upcomingNoteSchema.parse({})

export function loadUpcomingNote(db: Db): UpcomingNote {
  const row = db
    .select({ valueJson: settings.valueJson })
    .from(settings)
    .where(eq(settings.key, UPCOMING_NOTE_KEY))
    .get()

  if (!row) return DEFAULT_UPCOMING_NOTE

  let raw: unknown
  try {
    raw = JSON.parse(row.valueJson)
  } catch (error) {
    log.error(
      { err: error, key: UPCOMING_NOTE_KEY },
      'the stored upcoming note is not JSON; using none',
    )
    return DEFAULT_UPCOMING_NOTE
  }

  const parsed = upcomingNoteSchema.safeParse(raw)
  if (!parsed.success) {
    log.error(
      { key: UPCOMING_NOTE_KEY, issues: z.prettifyError(parsed.error) },
      'the stored upcoming note is invalid; using none',
    )
    return DEFAULT_UPCOMING_NOTE
  }
  return parsed.data
}

export function saveUpcomingNote(db: Db, patch: unknown): UpcomingNote {
  const next = upcomingNoteSchema.parse(patch ?? {})
  const valueJson = JSON.stringify(next)

  db.insert(settings)
    .values({ key: UPCOMING_NOTE_KEY, valueJson })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt: new Date() } })
    .run()

  return next
}
