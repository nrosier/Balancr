/**
 * One free-text note per month: context the owner has that a trailing average
 * can't — "the dishwasher broke, that's why household appliances is high this month"
 * as much as a heads-up about next month. `suggestBudgetAmounts` (#45) only ever
 * looks backward, so an irregular cost reads as ordinary drift the month it lands.
 * The note is the owner's side of that gap. Two AI passes read it: `budget-nudge.ts`,
 * which the note was collected for, and since #298 the monthly narrative — which was
 * describing the movement the note already explained. It is deliberately *not* sent to
 * the findings pass; `RedactedPayload.note` has the argument.
 *
 * Whoever adds a third reader should widen `settings.monthNote.hint` in the same commit:
 * somebody writing in that box is entitled to know where the sentence ends up.
 *
 * Storage is one row in the generic `settings` key/value table (`household.ts`'s own
 * division), holding a map of month to note text rather than a single string, so
 * each month's context is independent.
 *
 * Same load/save contract as `household.ts`: reading degrades to "no note" and never
 * throws, writing validates and throws. A note nobody can parse should cost the
 * nudge, not the budget page.
 */
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/index.ts'
import { settings } from '../../db/schema.ts'
import { logger } from '../../logger.ts'
import { assertMonth } from '../../util/month.ts'

const log = logger.child({ module: 'ai/month-note' })

export const MONTH_NOTE_KEY = 'ai.monthNotes'

/** A short paragraph — double `clarify.ts`'s single-category MAX_DESCRIPTION_CHARS (500). */
export const MONTH_NOTE_MAX_CHARS = 1000

const monthNoteTextSchema = z.string().max(MONTH_NOTE_MAX_CHARS)
const monthNotesSchema = z.record(z.string(), monthNoteTextSchema).prefault({})

type MonthNotes = z.infer<typeof monthNotesSchema>

function loadAll(db: Db): MonthNotes {
  const row = db
    .select({ valueJson: settings.valueJson })
    .from(settings)
    .where(eq(settings.key, MONTH_NOTE_KEY))
    .get()

  if (!row) return {}

  let raw: unknown
  try {
    raw = JSON.parse(row.valueJson)
  } catch (error) {
    log.error({ err: error, key: MONTH_NOTE_KEY }, 'the stored month notes are not JSON; using none')
    return {}
  }

  const parsed = monthNotesSchema.safeParse(raw)
  if (!parsed.success) {
    log.error(
      { key: MONTH_NOTE_KEY, issues: z.prettifyError(parsed.error) },
      'the stored month notes are invalid; using none',
    )
    return {}
  }
  return parsed.data
}

export function loadMonthNote(db: Db, month: string): string {
  assertMonth(month)
  return loadAll(db)[month] ?? ''
}

export function saveMonthNote(db: Db, month: string, text: string): string {
  assertMonth(month)
  const trimmed = monthNoteTextSchema.parse(text.trim())

  const all = loadAll(db)
  if (trimmed === '') delete all[month]
  else all[month] = trimmed

  const valueJson = JSON.stringify(all)
  db.insert(settings)
    .values({ key: MONTH_NOTE_KEY, valueJson })
    .onConflictDoUpdate({ target: settings.key, set: { valueJson, updatedAt: new Date() } })
    .run()

  return trimmed
}
