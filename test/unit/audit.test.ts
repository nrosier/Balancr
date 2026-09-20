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
import { aiRuns, auditLog, proposals, tenantInvites, users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import * as audit from '../../src/domain/audit.ts'
import { auditValues, loadAuditTrail, recordAudit } from '../../src/domain/audit.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'
import { seedPreMigrationDb } from '../helpers/pre-migration-db.ts'

let ctx: ReturnType<typeof createTestDb>
let db: Db
let tenantId: string

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
  tenantId = getSoleTenantId(db)
})

const entry = (overrides: Partial<audit.AuditEntry> = {}): audit.AuditEntry => ({
  tenantId,
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
    expect(rows[0]?.tenantId).toBe(tenantId)
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
    const row = loadAuditTrail(db, tenantId).find((one) => one.id === id)

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
    expect(loadAuditTrail(db, tenantId).map((row) => row.action)).toEqual([
      'proposal.reject',
      'proposal.apply',
      'clarification.answer',
    ])
  })

  it('filters by the row a caller is looking at', () => {
    expect(
      loadAuditTrail(db, tenantId, { entity: 'category_meta', entityRef: 'food' }),
    ).toHaveLength(2)
  })

  it('filters by action', () => {
    expect(
      loadAuditTrail(db, tenantId, { action: 'proposal.apply' }).map((row) => row.entityRef),
    ).toEqual(['rent'])
  })

  it('honours a limit', () => {
    expect(loadAuditTrail(db, tenantId, { limit: 1 })).toHaveLength(1)
  })

  it("never returns another tenant's entries", () => {
    const otherTenantId = createSecondTenant(db)
    recordAudit(db, entry({ tenantId: otherTenantId, entityRef: 'other-household' }))

    expect(loadAuditTrail(db, tenantId).map((row) => row.entityRef)).not.toContain(
      'other-household',
    )
    expect(loadAuditTrail(db, otherTenantId).map((row) => row.entityRef)).toEqual([
      'other-household',
    ])
  })
})

describe('auditValues', () => {
  it('reads unreadable json as absent rather than throwing', () => {
    // A hand-edited database, or a column written by an older version. An audit
    // view that crashes on one bad row hides every good one below it.
    recordAudit(db, entry())
    ctx.sqlite.prepare('update audit_log set before_json = ?').run('{not json')

    const row = loadAuditTrail(db, tenantId)[0] as audit.AuditRow
    expect(auditValues(row).before).toBeNull()
  })

  it('reads a json array as absent, because a pair is an object', () => {
    recordAudit(db, entry())
    ctx.sqlite.prepare('update audit_log set after_json = ?').run('[1,2]')

    const row = loadAuditTrail(db, tenantId)[0] as audit.AuditRow
    expect(auditValues(row).after).toBeNull()
  })
})

describe('legacy audit tenant migration (#414)', () => {
  it('attributes every null row to one deliberate tenant and makes the column required', () => {
    const legacy = createTestDb()
    seedPreMigrationDb(legacy.sqlite, '0029_overrated_slyde')
    const bootstrapTenantId = getSoleTenantId(legacy.db)
    const otherTenantId = createSecondTenant(legacy.db)

    legacy.db
      .insert(users)
      .values({ id: 'user-b', tenantId: otherTenantId, locale: 'en' })
      .run()
    legacy.db
      .insert(aiRuns)
      .values({
        id: 'run-b',
        tenantId: otherTenantId,
        kind: 'findings',
        model: 'gemini-3.7-flash',
        locale: 'en',
        payloadJson: '{}',
        status: 'ok',
      })
      .run()
    legacy.db
      .insert(proposals)
      .values({
        id: 'proposal-b',
        tenantId: otherTenantId,
        type: 'category_meta.set',
        targetRef: 'food',
        payloadJson: '{}',
      })
      .run()
    legacy.db
      .insert(tenantInvites)
      .values({
        id: 'invite-b',
        tenantId: otherTenantId,
        codeHash: 'legacy-invite-hash',
        createdBy: 'user-b',
        expiresAt: new Date('2026-10-01T00:00:00Z'),
      })
      .run()

    const insertLegacy = (input: {
      id: string
      action: string
      entity: string
      entityRef: string
      actorId?: string
      runId?: string
      proposalId?: string
      tenantId?: string
    }): void => {
      legacy.sqlite
        .prepare(
          `insert into audit_log
            (id, at, action, actor_id, tenant_id, entity, entity_ref, run_id, proposal_id)
           values (?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.action,
          input.actorId ?? null,
          input.tenantId ?? null,
          input.entity,
          input.entityRef,
          input.runId ?? null,
          input.proposalId ?? null,
        )
    }

    insertLegacy({
      id: 'by-actor',
      action: 'settings.locale',
      entity: 'users',
      entityRef: 'user-b',
      actorId: 'user-b',
    })
    insertLegacy({
      id: 'by-run',
      action: 'clarification.answer',
      entity: 'category_meta',
      entityRef: 'food',
      runId: 'run-b',
    })
    insertLegacy({
      id: 'by-proposal',
      action: 'proposal.apply',
      entity: 'category_meta',
      entityRef: 'food',
      proposalId: 'proposal-b',
    })
    insertLegacy({
      id: 'by-invite',
      action: 'tenant.invite.revoke',
      entity: 'tenant_invites',
      entityRef: 'invite-b',
    })
    insertLegacy({
      id: 'by-tenant',
      action: 'tenant.create',
      entity: 'tenants',
      entityRef: otherTenantId,
    })
    insertLegacy({
      id: 'unattributed',
      action: 'settings.params',
      entity: 'settings',
      entityRef: 'aggregate.params',
    })
    insertLegacy({
      id: 'already-scoped',
      action: 'jobs.refresh',
      entity: 'jobs',
      entityRef: 'sync',
      tenantId: otherTenantId,
    })

    applyMigrations(legacy.db as never)

    const tenantById = new Map(
      legacy.db.select({ id: auditLog.id, tenantId: auditLog.tenantId }).from(auditLog).all().map(
        (row) => [row.id, row.tenantId],
      ),
    )
    const attributed = [
      'by-actor',
      'by-run',
      'by-proposal',
      'by-invite',
      'by-tenant',
      'already-scoped',
    ]
    for (const id of attributed) {
      expect(tenantById.get(id), id).toBe(otherTenantId)
    }
    expect(tenantById.get('unattributed')).toBe(bootstrapTenantId)

    const tenantColumn = legacy.sqlite
      .prepare("pragma table_info('audit_log')")
      .all()
      .find((column) => (column as { name?: unknown }).name === 'tenant_id') as
      | { notnull: number }
      | undefined
    expect(tenantColumn?.notnull).toBe(1)
  })
})
