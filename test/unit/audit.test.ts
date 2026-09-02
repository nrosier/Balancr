/**
 * The audit trail.
 *
 * Small module, three claims worth pinning: it only ever appends, an entry
 * outlives everything it points at, and what it stores are values rather than
 * sentences — a change approved in a Dutch session has to read correctly in
 * English a year later.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { auditLog } from '../../src/db/schema.ts'
import * as audit from '../../src/domain/audit.ts'
import { auditValues, loadAuditTrail, recordAudit } from '../../src/domain/audit.ts'

let ctx: ReturnType<typeof createTestDb>
let db: Db

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
})

const entry = (overrides: Partial<audit.AuditEntry> = {}): audit.AuditEntry => ({
  action: 'clarification.answer',
  entity: 'category_meta',
  entityRef: 'food',
  ...overrides,
})

describe('recordAudit', () => {
  it('stores the entry and returns its id', () => {
    const id = recordAudit(db, entry({ actorId: 'u1', runId: 'run-1' }))

    const rows = db.select().from(auditLog).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(id)
    expect(rows[0]?.action).toBe('clarification.answer')
    expect(rows[0]?.actorId).toBe('u1')
    expect(rows[0]?.runId).toBe('run-1')
  })

  it('records the fields that changed, as values', () => {
    // Not "Nick set the nature of Groceries to variable" — that sentence exists in
    // one language, and the trail has to survive a language switch.
    const id = recordAudit(
      db,
      entry({ before: { nature: null }, after: { nature: 'variable' } }),
    )
    const row = loadAuditTrail(db).find((one) => one.id === id)

    expect(row).toBeDefined()
    expect(auditValues(row as audit.AuditRow)).toEqual({
      before: { nature: null },
      after: { nature: 'variable' },
    })
  })

  it('leaves both sides null for a decision that changed nothing', () => {
    // A dismissal: nothing changed, but the decision is still on record.
    const id = recordAudit(db, entry({ action: 'clarification.dismiss' }))
    const row = db.select().from(auditLog).all().find((one) => one.id === id)

    expect(row?.beforeJson).toBeNull()
    expect(row?.afterJson).toBeNull()
  })

  it('exposes nothing that could change an entry after the fact', () => {
    // Append-only is not enforceable in SQLite without triggers, so the guarantee
    // is the shape of this module: there is no function here that writes twice.
    const mutators = Object.keys(audit).filter((name) => /^(update|delete|clear|prune)/.test(name))
    expect(mutators).toEqual([])
  })
})

describe('loadAuditTrail', () => {
  /** Explicit times: two rows written in the same millisecond tie on `at`. */
  const at = (minute: number): Date => new Date(Date.UTC(2026, 2, 1, 12, minute))

  beforeEach(() => {
    recordAudit(db, entry({ entityRef: 'food', at: at(1) }))
    recordAudit(db, entry({ entityRef: 'rent', action: 'proposal.apply', at: at(2) }))
    recordAudit(db, entry({ entityRef: 'food', action: 'proposal.reject', at: at(3) }))
  })

  it('returns the newest first', () => {
    expect(loadAuditTrail(db).map((row) => row.action)).toEqual([
      'proposal.reject',
      'proposal.apply',
      'clarification.answer',
    ])
  })

  it('filters by the row a caller is looking at', () => {
    expect(loadAuditTrail(db, { entity: 'category_meta', entityRef: 'food' })).toHaveLength(2)
  })

  it('filters by action', () => {
    expect(loadAuditTrail(db, { action: 'proposal.apply' }).map((row) => row.entityRef)).toEqual([
      'rent',
    ])
  })

  it('honours a limit', () => {
    expect(loadAuditTrail(db, { limit: 1 })).toHaveLength(1)
  })
})

describe('auditValues', () => {
  it('reads unreadable json as absent rather than throwing', () => {
    // A hand-edited database, or a column written by an older version. An audit
    // view that crashes on one bad row hides every good one below it.
    recordAudit(db, entry())
    ctx.sqlite.prepare('update audit_log set before_json = ?').run('{not json')

    const row = loadAuditTrail(db)[0] as audit.AuditRow
    expect(auditValues(row).before).toBeNull()
  })

  it('reads a json array as absent, because a pair is an object', () => {
    recordAudit(db, entry())
    ctx.sqlite.prepare('update audit_log set after_json = ?').run('[1,2]')

    const row = loadAuditTrail(db)[0] as audit.AuditRow
    expect(auditValues(row).after).toBeNull()
  })
})
