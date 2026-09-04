/**
 * The stored note (#217). Same load/save contract as `benchmark/household.ts`:
 * reading degrades to the default and never throws, writing validates and throws.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { settings } from '../../src/db/schema.ts'
import {
  DEFAULT_UPCOMING_NOTE,
  loadUpcomingNote,
  saveUpcomingNote,
  UPCOMING_NOTE_KEY,
  UPCOMING_NOTE_MAX_CHARS,
} from '../../src/domain/ai/upcoming-note.ts'

describe('the stored upcoming note', () => {
  let ctx: ReturnType<typeof createTestDb>

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
  })

  const write = (valueJson: string): void => {
    ctx.db.insert(settings).values({ key: UPCOMING_NOTE_KEY, valueJson }).run()
  }

  it('is empty until somebody writes one', () => {
    expect(loadUpcomingNote(ctx.db)).toEqual(DEFAULT_UPCOMING_NOTE)
    expect(DEFAULT_UPCOMING_NOTE.text).toBe('')
  })

  it('round-trips the note, trimmed', () => {
    saveUpcomingNote(ctx.db, { text: '  Dentist bill in March.  ' })
    expect(loadUpcomingNote(ctx.db)).toEqual({ text: 'Dentist bill in March.' })
  })

  it('is replaced whole, so clearing it means writing an empty one', () => {
    saveUpcomingNote(ctx.db, { text: 'Dentist bill in March.' })
    saveUpcomingNote(ctx.db, { text: '' })
    expect(loadUpcomingNote(ctx.db).text).toBe('')
  })

  it('degrades to empty rather than throwing, for either kind of damage', () => {
    write('{ not json')
    expect(loadUpcomingNote(ctx.db)).toEqual(DEFAULT_UPCOMING_NOTE)

    ctx.db.delete(settings).run()
    write(JSON.stringify({ text: 12 }))
    expect(loadUpcomingNote(ctx.db)).toEqual(DEFAULT_UPCOMING_NOTE)
  })

  it('refuses to store more than UPCOMING_NOTE_MAX_CHARS', () => {
    expect(() => saveUpcomingNote(ctx.db, { text: 'x'.repeat(UPCOMING_NOTE_MAX_CHARS + 1) })).toThrow()
    expect(() => saveUpcomingNote(ctx.db, { text: 'x'.repeat(UPCOMING_NOTE_MAX_CHARS) })).not.toThrow()
  })

  it('refuses an unknown field', () => {
    expect(() => saveUpcomingNote(ctx.db, { text: 'fine', extra: true })).toThrow()
  })
})
