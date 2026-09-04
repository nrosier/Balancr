/**
 * Propose-and-apply.
 *
 * The whole point of the table is that the model's suggestions do not take
 * effect, so the tests are about the boundary rather than the write:
 *
 *  - **Nothing changes until someone applies it.** A pending proposal leaves
 *    `category_meta` exactly as it was.
 *  - **The payload is validated again at apply time**, because the gap between
 *    creating a proposal and approving it can be a version upgrade.
 *  - **The audit trail records what the write did**, not what the card predicted
 *    weeks earlier — and stores values rather than sentences, so a change approved
 *    in Dutch reads correctly in English.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { categoryMeta, proposals, users } from '../../src/db/schema.ts'
import { loadAuditTrail } from '../../src/domain/audit.ts'
import { recordRun } from '../../src/domain/ai/runs.ts'
import {
  applyProposal,
  createProposal,
  expireProposals,
  loadProposal,
  pendingProposals,
  proposalHistory,
  ProposalError,
  PROPOSAL_TTL_DAYS,
  rejectProposal,
  renderProposal,
  storedDiff,
  type ProposalRow,
} from '../../src/domain/ai/proposals.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { fact, seedMonth } from '../fixtures/month.ts'

const MONTH = '2026-03'
const NOW = new Date('2026-03-20T09:00:00Z')

let ctx: ReturnType<typeof createTestDb>
let db: Db
/** A real run row: `proposals.run_id` is a foreign key. */
let runId: string

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
  // `proposals.applied_by` is a foreign key; the audit trail's actor is not.
  db.insert(users).values({ id: 'u1', locale: 'en' }).run()
  runId = recordRun(db, {
    kind: 'findings',
    model: 'gemini-3.7-flash',
    locale: 'en',
    payload: {},
    payloadHash: 'unrelated-hash',
    status: 'ok',
  })
  seedMonth(db, MONTH, {
    facts: [
      fact(MONTH, 'food', { categoryName: 'Groceries' }),
      fact(MONTH, 'rent', { categoryName: 'Rent' }),
    ],
  })
})

const propose = (
  payload: Record<string, unknown>,
  overrides: Partial<Parameters<typeof createProposal>[1]> = {},
): ProposalRow =>
  createProposal(db, {
    type: 'category_meta.set',
    targetRef: 'food',
    payload,
    runId,
    now: NOW,
    ...overrides,
  })

const metaOf = (categoryId: string): typeof categoryMeta.$inferSelect => {
  const row = db.select().from(categoryMeta).where(eq(categoryMeta.categoryId, categoryId)).get()
  if (row === undefined) throw new Error(`no metadata for ${categoryId}`)
  return row
}

describe('createProposal', () => {
  it('stores a pending proposal with the diff against the row as it stands', () => {
    const row = propose({ nature: 'variable', userDescription: 'Weekly supermarket run' })

    expect(row.status).toBe('pending')
    expect(row.runId).toBe(runId)
    expect(storedDiff(row)?.fields).toEqual([
      { field: 'userDescription', before: null, after: 'Weekly supermarket run' },
      { field: 'nature', before: null, after: 'variable' },
    ])
  })

  it('changes nothing by itself', () => {
    propose({ nature: 'variable' })
    expect(metaOf('food').nature).toBeNull()
  })

  it('expires by default, so a stale suggestion stops being offered', () => {
    const row = propose({ nature: 'variable' })
    const days = ((row.expiresAt as Date).getTime() - NOW.getTime()) / (24 * 60 * 60 * 1_000)
    expect(days).toBe(PROPOSAL_TTL_DAYS)
  })

  it('refuses a payload that would change nothing', () => {
    db.update(categoryMeta)
      .set({ nature: 'variable' })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()

    expect(() => propose({ nature: 'variable' })).toThrow(/would change nothing/)
  })

  it('refuses an empty payload', () => {
    expect(() => propose({})).toThrow(ProposalError)
  })

  it('refuses a field it does not know', () => {
    // An unknown key means the schema has moved on; half-applying it is worse
    // than refusing the row.
    expect(() => propose({ nature: 'variable', priority: 'high' })).toThrow(/invalid/)
  })

  it('refuses a value outside the column vocabulary', () => {
    expect(() => propose({ nature: 'sort of fixed' })).toThrow(/invalid/)
  })

  it('refuses something that is not a COICOP code', () => {
    expect(() => propose({ coicopCode: 'groceries' })).toThrow(/COICOP/)
  })

  it('normalises the description the model guessed', () => {
    const row = propose({ userDescription: '  Weekly   supermarket run ' })
    expect(storedDiff(row)?.fields[0]?.after).toBe('Weekly supermarket run')
  })

  it('warns when applying would send the category name to the AI', () => {
    db.update(categoryMeta)
      .set({ sensitive: true })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()

    expect(storedDiff(propose({ sensitive: false }))?.fields).toEqual([
      { field: 'sensitive', before: true, after: false, warn: 'privacy' },
    ])
  })

  it('does not warn when applying adds protection', () => {
    expect(storedDiff(propose({ sensitive: true }))?.fields[0]?.warn).toBeUndefined()
  })

  it('supersedes the pending proposal for the same target rather than duplicating it', () => {
    // `proposals_pending_uq` would reject the insert; the newer suggestion is the
    // one computed from newer data, so it wins.
    const first = propose({ nature: 'variable' })
    const second = propose({ nature: 'fixed' })

    expect(loadProposal(db, first.id)?.status).toBe('expired')
    expect(pendingProposals(db).map((row) => row.id)).toEqual([second.id])
  })

  it('refuses a type with no handler', () => {
    expect(() =>
      createProposal(db, {
        type: 'actual.category.rename' as 'category_meta.set',
        targetRef: 'food',
        payload: {},
      }),
    ).toThrow(/no handler/)
  })

  it('refuses a target with no metadata row', () => {
    expect(() => propose({ nature: 'variable' }, { targetRef: 'ghost' })).toThrow(/no metadata/)
  })
})

describe('renderProposal', () => {
  it('names the fields and values in the reader language', () => {
    const card = renderProposal(db, propose({ nature: 'variable' }), 'nl')

    expect(card.targetName).toBe('Groceries')
    expect(card.fields[0]).toEqual({
      field: 'nature',
      label: 'Soort kost',
      before: 'niet ingesteld',
      after: 'Variabele kost',
      warn: null,
    })
  })

  it('reads the same change back in the other language', () => {
    // Why the diff stores values: this row was written once, in one session.
    const row = propose({ custodyShared: true })
    expect(renderProposal(db, row, 'en').fields[0]?.after).toBe('Yes')
    expect(renderProposal(db, row, 'nl').fields[0]?.after).toBe('Ja')
  })

  it('translates the privacy warning', () => {
    db.update(categoryMeta)
      .set({ sensitive: true })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()

    expect(renderProposal(db, propose({ sensitive: false }), 'en').fields[0]?.warn).toMatch(
      /category name/,
    )
  })

  it('shows free text as it was written', () => {
    const card = renderProposal(db, propose({ userDescription: 'Weekly supermarket run' }), 'en')
    expect(card.fields[0]?.after).toBe('Weekly supermarket run')
  })

  it('falls back to the id when the category is gone', () => {
    const row = propose({ nature: 'variable' })
    ctx.sqlite.prepare('delete from category_meta where category_id = ?').run('food')

    expect(renderProposal(db, row, 'en').targetName).toBe('food')
  })

  it('renders an unreadable diff as no fields rather than throwing', () => {
    const row = propose({ nature: 'variable' })
    ctx.sqlite.prepare('update proposals set rendered_diff_json = ?').run('{not json')

    expect(renderProposal(db, loadProposal(db, row.id) as ProposalRow, 'en').fields).toEqual([])
  })
})

describe('applyProposal', () => {
  it('writes only the fields the payload names', () => {
    db.update(categoryMeta)
      .set({ expectedFrequency: 'annual' })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()
    const row = propose({ nature: 'variable' })

    applyProposal(db, { id: row.id, userId: 'u1', now: NOW })

    const meta = metaOf('food')
    expect(meta.nature).toBe('variable')
    // Set by hand last week; a description proposal must not reset it.
    expect(meta.expectedFrequency).toBe('annual')
  })

  it('marks it applied, with who and when', () => {
    const row = propose({ nature: 'variable' })
    applyProposal(db, { id: row.id, userId: 'u1', now: NOW })

    const applied = loadProposal(db, row.id)
    expect(applied?.status).toBe('applied')
    expect(applied?.appliedBy).toBe('u1')
    expect(applied?.appliedAt?.getTime()).toBe(NOW.getTime())
  })

  it('records what it changed, the run behind it and the proposal itself', () => {
    const row = propose({ nature: 'variable' })
    const result = applyProposal(db, { id: row.id, userId: 'u1', now: NOW })

    const entry = loadAuditTrail(db, { entityRef: 'food' })[0]
    expect(entry?.id).toBe(result.auditId)
    expect(entry?.action).toBe('proposal.apply')
    expect(entry?.actorId).toBe('u1')
    expect(entry?.runId).toBe(runId)
    expect(entry?.proposalId).toBe(row.id)
    expect(JSON.parse(entry?.beforeJson ?? '{}')).toEqual({ nature: null })
    expect(JSON.parse(entry?.afterJson ?? '{}')).toEqual({ nature: 'variable' })
  })

  it('audits what the write did, not what the card predicted', () => {
    // Someone set the value by hand in between. The card said null → variable; the
    // trail has to say the truth, which is that this write changed nothing.
    const row = propose({ nature: 'variable' })
    db.update(categoryMeta)
      .set({ nature: 'variable' })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()

    const result = applyProposal(db, { id: row.id, now: NOW })

    expect(result.fields).toEqual([])
    expect(loadProposal(db, row.id)?.status).toBe('applied')
    expect(JSON.parse(loadAuditTrail(db)[0]?.afterJson ?? 'null')).toEqual({})
  })

  it('refuses one that was already decided', () => {
    const row = propose({ nature: 'variable' })
    applyProposal(db, { id: row.id, now: NOW })

    expect(() => applyProposal(db, { id: row.id, now: NOW })).toThrow(/already applied/)
  })

  it('refuses one that has expired', () => {
    const row = propose({ nature: 'variable' })
    const later = new Date((row.expiresAt as Date).getTime() + 1_000)

    expect(() => applyProposal(db, { id: row.id, now: later })).toThrow(/expired/)
    expect(metaOf('food').nature).toBeNull()
  })

  it('refuses a stored payload that no longer validates', () => {
    // What a schema change looks like from here. Better a visible refusal than a
    // partial write from a payload nothing understands any more.
    const row = propose({ nature: 'variable' })
    ctx.sqlite
      .prepare('update proposals set payload_json = ? where id = ?')
      .run('{"nature":"whatever"}', row.id)

    expect(() => applyProposal(db, { id: row.id, now: NOW })).toThrow(/can no longer be applied/)
    expect(metaOf('food').nature).toBeNull()
    expect(loadProposal(db, row.id)?.status).toBe('pending')
  })

  it('leaves the row pending and the trail empty when the target is gone', () => {
    const row = propose({ nature: 'variable' })
    ctx.sqlite.prepare('delete from category_meta where category_id = ?').run('food')

    expect(() => applyProposal(db, { id: row.id, now: NOW })).toThrow(/no metadata/)
    expect(loadProposal(db, row.id)?.status).toBe('pending')
    expect(loadAuditTrail(db)).toHaveLength(0)
  })

  it('does not touch confidence, which measures what the user stated themselves', () => {
    const row = propose({ nature: 'variable' })
    applyProposal(db, { id: row.id, userId: 'u1', now: NOW })

    expect(metaOf('food').confidence).toBe(0)
  })
})

describe('rejectProposal', () => {
  it('records the decision without changing anything', () => {
    const row = propose({ nature: 'variable' })
    const rejected = rejectProposal(db, { id: row.id, userId: 'u1', now: NOW })

    expect(rejected.status).toBe('rejected')
    expect(loadProposal(db, row.id)?.status).toBe('rejected')
    expect(metaOf('food').nature).toBeNull()

    const entry = loadAuditTrail(db)[0]
    expect(entry?.action).toBe('proposal.reject')
    expect(entry?.beforeJson).toBeNull()
    expect(entry?.afterJson).toBeNull()
  })

  it('refuses one that was already decided', () => {
    const row = propose({ nature: 'variable' })
    rejectProposal(db, { id: row.id, now: NOW })

    expect(() => rejectProposal(db, { id: row.id, now: NOW })).toThrow(/already rejected/)
  })

  it('frees the target for a fresh proposal next month', () => {
    const first = propose({ nature: 'variable' })
    rejectProposal(db, { id: first.id, now: NOW })

    const second = propose({ nature: 'fixed' })
    expect(pendingProposals(db).map((row) => row.id)).toEqual([second.id])
    expect(proposalHistory(db, 'food')).toHaveLength(2)
  })
})

describe('expireProposals', () => {
  it('retires what nobody decided on, without an audit entry', () => {
    // Nobody decided anything, so there is nothing to attribute.
    const row = propose({ nature: 'variable' })
    const later = new Date((row.expiresAt as Date).getTime() + 1_000)

    expect(expireProposals(db, later)).toBe(1)
    expect(loadProposal(db, row.id)?.status).toBe('expired')
    expect(loadAuditTrail(db)).toHaveLength(0)
  })

  it('leaves a proposal that is still current alone', () => {
    propose({ nature: 'variable' })
    expect(expireProposals(db, NOW)).toBe(0)
  })

  it('is safe to run twice', () => {
    const row = propose({ nature: 'variable' })
    const later = new Date((row.expiresAt as Date).getTime() + 1_000)

    expireProposals(db, later)
    expect(expireProposals(db, later)).toBe(0)
  })

  it('ignores one that was already applied', () => {
    const row = propose({ nature: 'variable' })
    applyProposal(db, { id: row.id, now: NOW })
    const later = new Date((row.expiresAt as Date).getTime() + 1_000)

    expireProposals(db, later)
    expect(loadProposal(db, row.id)?.status).toBe('applied')
  })

  it('never expires a proposal without a deadline', () => {
    const row = propose({ nature: 'variable' })
    ctx.sqlite.prepare('update proposals set expires_at = null where id = ?').run(row.id)

    expect(expireProposals(db, new Date('2030-01-01'))).toBe(0)
    expect(db.select().from(proposals).all()[0]?.status).toBe('pending')
  })
})
