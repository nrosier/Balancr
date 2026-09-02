/**
 * These tests assert the guarantees the schema is *relied upon* to provide.
 * Each one would otherwise be "something the application layer must remember",
 * which is exactly the kind of rule that quietly stops holding.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../../src/db/index.ts'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import {
  accountMap,
  aiRuns,
  auditLog,
  clarificationQueue,
  prompts,
  proposals,
  sessions,
  users,
} from '../../src/db/schema.ts'

let ctx: ReturnType<typeof createTestDb>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
})

describe('foreign keys', () => {
  it('are enforced (SQLite defaults them OFF, so this must be pragma-set)', () => {
    expect(() =>
      ctx.db
        .insert(sessions)
        .values({
          id: 'sess-1',
          userId: 'does-not-exist',
          method: 'oidc',
          expiresAt: new Date(Date.now() + 60_000),
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i)
  })

  it('cascade a user delete to their sessions', () => {
    ctx.db.insert(users).values({ id: 'u1', locale: 'en' }).run()
    ctx.db
      .insert(sessions)
      .values({
        id: 'sess-1',
        userId: 'u1',
        method: 'oidc',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .run()

    ctx.sqlite.prepare('delete from users where id = ?').run('u1')
    expect(ctx.db.select().from(sessions).all()).toHaveLength(0)
  })
})

describe('prompts: at most one active version per (key, locale)', () => {
  const base = { key: 'analysis.system', locale: 'en', body: 'text' }

  it('allows many inactive versions alongside one active', () => {
    ctx.db.insert(prompts).values({ ...base, version: 1, active: false }).run()
    ctx.db.insert(prompts).values({ ...base, version: 2, active: false }).run()
    ctx.db.insert(prompts).values({ ...base, version: 3, active: true }).run()
    expect(ctx.db.select().from(prompts).all()).toHaveLength(3)
  })

  it('rejects a second active version, so rollback cannot leave two live', () => {
    ctx.db.insert(prompts).values({ ...base, version: 1, active: true }).run()
    expect(() =>
      ctx.db.insert(prompts).values({ ...base, version: 2, active: true }).run(),
    ).toThrow(/UNIQUE/i)
  })

  it('scopes the constraint per locale', () => {
    ctx.db.insert(prompts).values({ ...base, version: 1, active: true }).run()
    ctx.db
      .insert(prompts)
      .values({ ...base, locale: 'nl', version: 1, active: true })
      .run()
    expect(ctx.db.select().from(prompts).all()).toHaveLength(2)
  })
})

describe('proposals: no duplicate pending proposal for the same target', () => {
  const base = {
    type: 'category_meta.set',
    targetRef: 'cat-42',
    payloadJson: '{}',
  }

  it('rejects a second pending proposal', () => {
    ctx.db.insert(proposals).values({ ...base, status: 'pending' }).run()
    expect(() =>
      ctx.db.insert(proposals).values({ ...base, status: 'pending' }).run(),
    ).toThrow(/UNIQUE/i)
  })

  it('permits a new pending proposal once the previous one is resolved', () => {
    ctx.db.insert(proposals).values({ ...base, status: 'applied' }).run()
    ctx.db.insert(proposals).values({ ...base, status: 'rejected' }).run()
    ctx.db.insert(proposals).values({ ...base, status: 'pending' }).run()
    expect(ctx.db.select().from(proposals).all()).toHaveLength(3)
  })
})

describe('clarification queue: one open question per (category, question)', () => {
  it('does not re-ask a question that is already open', () => {
    const q = { categoryId: 'cat-1', questionCode: 'purpose', status: 'open' as const }
    ctx.db.insert(clarificationQueue).values(q).run()
    expect(() => ctx.db.insert(clarificationQueue).values(q).run()).toThrow(/UNIQUE/i)
  })

  it('allows re-asking after the earlier one was answered', () => {
    ctx.db
      .insert(clarificationQueue)
      .values({ categoryId: 'cat-1', questionCode: 'purpose', status: 'answered' })
      .run()
    ctx.db
      .insert(clarificationQueue)
      .values({ categoryId: 'cat-1', questionCode: 'purpose', status: 'open' })
      .run()
    expect(ctx.db.select().from(clarificationQueue).all()).toHaveLength(2)
  })
})

describe('account map', () => {
  it('rejects the same external account twice per source', () => {
    const row = { source: 'actual' as const, externalId: 'acc-1', name: 'Checking' }
    ctx.db.insert(accountMap).values(row).run()
    expect(() => ctx.db.insert(accountMap).values(row).run()).toThrow(/UNIQUE/i)
  })

  it('lets the same logical account exist in both sources for dedupe', () => {
    ctx.db
      .insert(accountMap)
      .values({
        source: 'actual',
        externalId: 'acc-1',
        name: 'Investments',
        kind: 'investment',
        dedupeGroup: 'broker-main',
        isSourceOfTruth: false,
      })
      .run()
    ctx.db
      .insert(accountMap)
      .values({
        source: 'ghostfolio',
        externalId: 'gf-1',
        name: 'Investments',
        kind: 'investment',
        dedupeGroup: 'broker-main',
        isSourceOfTruth: true,
      })
      .run()

    const group = ctx.db.select().from(accountMap).all()
    expect(group).toHaveLength(2)
    // Net worth must sum only the source-of-truth row, never both.
    expect(group.filter((r) => r.isSourceOfTruth)).toHaveLength(1)
  })
})

describe('ai_runs', () => {
  it('always records the exact payload that left the machine', () => {
    ctx.db
      .insert(aiRuns)
      .values({
        kind: 'findings',
        model: 'gemini-3.7-flash',
        locale: 'en',
        payloadJson: '{"categories":[]}',
        status: 'ok',
      })
      .run()
    const [run] = ctx.db.select().from(aiRuns).all()
    expect(run?.payloadJson).toBe('{"categories":[]}')
    expect(run?.costMicroEur).toBe(0)
  })
})

describe('audit_log survives everything it refers to', () => {
  /** One entry with every reference populated, plus the rows it points at. */
  function seedApprovedChange(): void {
    ctx.db.insert(users).values({ id: 'u1', locale: 'en' }).run()
    ctx.db
      .insert(aiRuns)
      .values({
        id: 'run-1',
        kind: 'findings',
        model: 'gemini-3.7-flash',
        locale: 'en',
        payloadJson: '{}',
        status: 'ok',
      })
      .run()
    ctx.db
      .insert(proposals)
      .values({
        id: 'prop-1',
        runId: 'run-1',
        type: 'category_meta.set',
        targetRef: 'cat-1',
        payloadJson: '{"nature":"variable"}',
        status: 'applied',
      })
      .run()
    ctx.db
      .insert(auditLog)
      .values({
        action: 'proposal.apply',
        actorId: 'u1',
        entity: 'category_meta',
        entityRef: 'cat-1',
        runId: 'run-1',
        proposalId: 'prop-1',
        beforeJson: '{"nature":null}',
        afterJson: '{"nature":"variable"}',
      })
      .run()
  }

  it('accepts references to rows that no longer exist', () => {
    // No foreign keys at all, on purpose: an entry that can only be written while
    // its run is still around is not an audit trail.
    ctx.db
      .insert(auditLog)
      .values({
        action: 'proposal.apply',
        actorId: 'deleted-user',
        entity: 'category_meta',
        entityRef: 'cat-1',
        runId: 'pruned-run',
        proposalId: 'pruned-proposal',
      })
      .run()

    expect(ctx.db.select().from(auditLog).all()).toHaveLength(1)
  })

  it('keeps the run id after the run has been pruned', () => {
    seedApprovedChange()
    ctx.sqlite.prepare('delete from ai_runs where id = ?').run('run-1')

    const [entry] = ctx.db.select().from(auditLog).all()
    // `proposals.run_id` is nulled by its cascade; the trail is not.
    expect(ctx.db.select().from(proposals).all()[0]?.runId).toBeNull()
    expect(entry?.runId).toBe('run-1')
  })

  it('keeps the change after the proposal it came from is gone', () => {
    seedApprovedChange()
    ctx.sqlite.prepare('delete from proposals where id = ?').run('prop-1')

    const [entry] = ctx.db.select().from(auditLog).all()
    expect(entry?.proposalId).toBe('prop-1')
    expect(entry?.afterJson).toBe('{"nature":"variable"}')
  })

  it('keeps who approved it after the account is deleted', () => {
    seedApprovedChange()
    ctx.sqlite.prepare('delete from users where id = ?').run('u1')

    expect(ctx.db.select().from(auditLog).all()[0]?.actorId).toBe('u1')
  })
})

describe('clarification_queue.run_id', () => {
  it('outlives the run that asked the question', () => {
    // Also unconstrained: the queue is the record of what was asked, and a run
    // pruned by the cost view must not blank it.
    ctx.db
      .insert(aiRuns)
      .values({
        id: 'run-1',
        kind: 'findings',
        model: 'gemini-3.7-flash',
        locale: 'en',
        payloadJson: '{}',
        status: 'ok',
      })
      .run()
    ctx.db
      .insert(clarificationQueue)
      .values({ categoryId: 'cat-1', questionCode: 'purpose_unknown', runId: 'run-1' })
      .run()

    ctx.sqlite.prepare('delete from ai_runs where id = ?').run('run-1')
    expect(ctx.db.select().from(clarificationQueue).all()[0]?.runId).toBe('run-1')
  })
})
