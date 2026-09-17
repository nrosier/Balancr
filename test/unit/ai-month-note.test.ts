/**
 * The stored per-month notes (#217, redesigned per-month by #270). Same load/save
 * contract as `benchmark/household.ts`: reading degrades to "no note" and never
 * throws, writing validates and throws.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { settings } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { loadMonthNote, MONTH_NOTE_KEY, MONTH_NOTE_MAX_CHARS, saveMonthNote } from '../../src/domain/ai/month-note.ts'

const MONTH = '2026-03'
const OTHER_MONTH = '2026-04'

describe('the stored month notes', () => {
  let ctx: ReturnType<typeof createTestDb>
  let TENANT_ID: string

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
    TENANT_ID = getSoleTenantId(ctx.db)
  })

  const write = (valueJson: string): void => {
    ctx.db.insert(settings).values({ tenantId: TENANT_ID, key: MONTH_NOTE_KEY, valueJson }).run()
  }

  it('is empty until somebody writes one', () => {
    expect(loadMonthNote(ctx.db, TENANT_ID, MONTH)).toBe('')
  })

  it('round-trips the note, trimmed', () => {
    saveMonthNote(ctx.db, TENANT_ID, MONTH, '  Dentist bill in March.  ')
    expect(loadMonthNote(ctx.db, TENANT_ID, MONTH)).toBe('Dentist bill in March.')
  })

  it('keeps a second month untouched', () => {
    saveMonthNote(ctx.db, TENANT_ID, MONTH, 'Dentist bill in March.')
    expect(loadMonthNote(ctx.db, TENANT_ID, OTHER_MONTH)).toBe('')

    saveMonthNote(ctx.db, TENANT_ID, OTHER_MONTH, 'Car insurance renews.')
    expect(loadMonthNote(ctx.db, TENANT_ID, MONTH)).toBe('Dentist bill in March.')
    expect(loadMonthNote(ctx.db, TENANT_ID, OTHER_MONTH)).toBe('Car insurance renews.')
  })

  it("clearing a month's note deletes its key", () => {
    saveMonthNote(ctx.db, TENANT_ID, MONTH, 'Dentist bill in March.')
    saveMonthNote(ctx.db, TENANT_ID, MONTH, '')
    expect(loadMonthNote(ctx.db, TENANT_ID, MONTH)).toBe('')

    const row = ctx.db.select({ valueJson: settings.valueJson }).from(settings).get()
    expect(row).toBeDefined()
    expect(JSON.parse(row!.valueJson)).not.toHaveProperty(MONTH)
  })

  it('degrades to empty rather than throwing, for either kind of damage', () => {
    write('{ not json')
    expect(loadMonthNote(ctx.db, TENANT_ID, MONTH)).toBe('')

    ctx.db.delete(settings).run()
    write(JSON.stringify({ [MONTH]: 12 }))
    expect(loadMonthNote(ctx.db, TENANT_ID, MONTH)).toBe('')
  })

  it('refuses to store more than MONTH_NOTE_MAX_CHARS', () => {
    expect(() => saveMonthNote(ctx.db, TENANT_ID, MONTH, 'x'.repeat(MONTH_NOTE_MAX_CHARS + 1))).toThrow()
    expect(() => saveMonthNote(ctx.db, TENANT_ID, MONTH, 'x'.repeat(MONTH_NOTE_MAX_CHARS))).not.toThrow()
  })

  it('refuses an invalid month', () => {
    expect(() => saveMonthNote(ctx.db, TENANT_ID, 'not-a-month', 'fine')).toThrow()
    expect(() => loadMonthNote(ctx.db, TENANT_ID, 'not-a-month')).toThrow()
  })

  it('round-trips a whole-year note, independently of any month in that year (#345)', () => {
    saveMonthNote(ctx.db, TENANT_ID, '2026', 'Renovated the kitchen this year.')
    expect(loadMonthNote(ctx.db, TENANT_ID, '2026')).toBe('Renovated the kitchen this year.')
    expect(loadMonthNote(ctx.db, TENANT_ID, MONTH)).toBe('')

    saveMonthNote(ctx.db, TENANT_ID, MONTH, 'Dentist bill in March.')
    expect(loadMonthNote(ctx.db, TENANT_ID, '2026')).toBe('Renovated the kitchen this year.')
    expect(loadMonthNote(ctx.db, TENANT_ID, MONTH)).toBe('Dentist bill in March.')
  })
})
