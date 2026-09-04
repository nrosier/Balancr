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
 *  - **The two Actual-writing handlers (#45) never touch local state on their
 *    own.** `fetchTransaction`, `updateTransactionCategory` and
 *    `setCategoryBudgetAmount` are mocked here rather than talking to a real
 *    Actual instance — what's under test is the proposal lifecycle around
 *    them, not the adapter.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { categoryMeta, monthlyCategoryFacts, proposals, users } from '../../src/db/schema.ts'
import { loadAuditTrail } from '../../src/domain/audit.ts'
import { recordRun } from '../../src/domain/ai/runs.ts'
import {
  applyProposal,
  createProposal,
  decodeBudgetTarget,
  encodeBudgetTarget,
  expireProposals,
  loadProposal,
  pendingBudgetProposals,
  pendingProposals,
  proposalHistory,
  ProposalError,
  PROPOSAL_TTL_DAYS,
  rejectProposal,
  renderProposal,
  storedDiff,
  type ProposalRow,
} from '../../src/domain/ai/proposals.ts'
import { formatMoney } from '../../src/i18n/format.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { fact, seedMonth } from '../fixtures/month.ts'

vi.mock('../../src/adapters/actual/queries.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/actual/queries.ts')>()),
  fetchTransaction: vi.fn(),
  updateTransactionCategory: vi.fn(),
  setCategoryBudgetAmount: vi.fn(),
}))

import {
  fetchTransaction,
  setCategoryBudgetAmount,
  updateTransactionCategory,
} from '../../src/adapters/actual/queries.ts'

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
  vi.mocked(fetchTransaction).mockReset()
  vi.mocked(updateTransactionCategory).mockReset()
  vi.mocked(setCategoryBudgetAmount).mockReset()

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
): Promise<ProposalRow> =>
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

const budgetedCentsOf = (categoryId: string, month: string): number | null => {
  const row = db
    .select({ budgetedCents: monthlyCategoryFacts.budgetedCents })
    .from(monthlyCategoryFacts)
    .where(and(eq(monthlyCategoryFacts.categoryId, categoryId), eq(monthlyCategoryFacts.month, month)))
    .get()
  return row?.budgetedCents ?? null
}

describe('createProposal', () => {
  it('stores a pending proposal with the diff against the row as it stands', async () => {
    const row = await propose({ nature: 'variable', userDescription: 'Weekly supermarket run' })

    expect(row.status).toBe('pending')
    expect(row.runId).toBe(runId)
    expect(storedDiff(row)?.fields).toEqual([
      { field: 'userDescription', before: null, after: 'Weekly supermarket run' },
      { field: 'nature', before: null, after: 'variable' },
    ])
  })

  it('changes nothing by itself', async () => {
    await propose({ nature: 'variable' })
    expect(metaOf('food').nature).toBeNull()
  })

  it('expires by default, so a stale suggestion stops being offered', async () => {
    const row = await propose({ nature: 'variable' })
    const days = ((row.expiresAt as Date).getTime() - NOW.getTime()) / (24 * 60 * 60 * 1_000)
    expect(days).toBe(PROPOSAL_TTL_DAYS)
  })

  it('refuses a payload that would change nothing', async () => {
    db.update(categoryMeta)
      .set({ nature: 'variable' })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()

    await expect(propose({ nature: 'variable' })).rejects.toThrow(/would change nothing/)
  })

  it('refuses an empty payload', async () => {
    await expect(propose({})).rejects.toThrow(ProposalError)
  })

  it('refuses a field it does not know', async () => {
    // An unknown key means the schema has moved on; half-applying it is worse
    // than refusing the row.
    await expect(propose({ nature: 'variable', priority: 'high' })).rejects.toThrow(/invalid/)
  })

  it('refuses a value outside the column vocabulary', async () => {
    await expect(propose({ nature: 'sort of fixed' })).rejects.toThrow(/invalid/)
  })

  it('refuses something that is not a COICOP code', async () => {
    await expect(propose({ coicopCode: 'groceries' })).rejects.toThrow(/COICOP/)
  })

  it('normalises the description the model guessed', async () => {
    const row = await propose({ userDescription: '  Weekly   supermarket run ' })
    expect(storedDiff(row)?.fields[0]?.after).toBe('Weekly supermarket run')
  })

  it('warns when applying would send the category name to the AI', async () => {
    db.update(categoryMeta)
      .set({ sensitive: true })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()

    const row = await propose({ sensitive: false })
    expect(storedDiff(row)?.fields).toEqual([
      { field: 'sensitive', before: true, after: false, warn: 'privacy' },
    ])
  })

  it('does not warn when applying adds protection', async () => {
    const row = await propose({ sensitive: true })
    expect(storedDiff(row)?.fields[0]?.warn).toBeUndefined()
  })

  it('supersedes the pending proposal for the same target rather than duplicating it', async () => {
    // `proposals_pending_uq` would reject the insert; the newer suggestion is the
    // one computed from newer data, so it wins.
    const first = await propose({ nature: 'variable' })
    const second = await propose({ nature: 'fixed' })

    expect(loadProposal(db, first.id)?.status).toBe('expired')
    expect(pendingProposals(db).map((row) => row.id)).toEqual([second.id])
  })

  it('refuses a type with no handler', async () => {
    await expect(
      createProposal(db, {
        type: 'actual.category.rename' as 'category_meta.set',
        targetRef: 'food',
        payload: {},
      }),
    ).rejects.toThrow(/no handler/)
  })

  it('refuses a target with no metadata row', async () => {
    await expect(propose({ nature: 'variable' }, { targetRef: 'ghost' })).rejects.toThrow(/no metadata/)
  })
})

describe('renderProposal', () => {
  it('names the fields and values in the reader language', async () => {
    const row = await propose({ nature: 'variable' })
    const card = renderProposal(db, row, 'nl')

    expect(card.targetName).toBe('Groceries')
    expect(card.fields[0]).toEqual({
      field: 'nature',
      label: 'Soort kost',
      before: 'niet ingesteld',
      after: 'Variabele kost',
      warn: null,
    })
  })

  it('reads the same change back in the other language', async () => {
    // Why the diff stores values: this row was written once, in one session.
    const row = await propose({ custodyShared: true })
    expect(renderProposal(db, row, 'en').fields[0]?.after).toBe('Yes')
    expect(renderProposal(db, row, 'nl').fields[0]?.after).toBe('Ja')
  })

  it('translates the privacy warning', async () => {
    db.update(categoryMeta)
      .set({ sensitive: true })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()

    const row = await propose({ sensitive: false })
    expect(renderProposal(db, row, 'en').fields[0]?.warn).toMatch(/category name/)
  })

  it('shows free text as it was written', async () => {
    const row = await propose({ userDescription: 'Weekly supermarket run' })
    const card = renderProposal(db, row, 'en')
    expect(card.fields[0]?.after).toBe('Weekly supermarket run')
  })

  it('falls back to the id when the category is gone', async () => {
    const row = await propose({ nature: 'variable' })
    ctx.sqlite.prepare('delete from category_meta where category_id = ?').run('food')

    expect(renderProposal(db, row, 'en').targetName).toBe('food')
  })

  it('renders an unreadable diff as no fields rather than throwing', async () => {
    const row = await propose({ nature: 'variable' })
    ctx.sqlite.prepare('update proposals set rendered_diff_json = ?').run('{not json')

    expect(renderProposal(db, loadProposal(db, row.id) as ProposalRow, 'en').fields).toEqual([])
  })
})

describe('applyProposal', () => {
  it('writes only the fields the payload names', async () => {
    db.update(categoryMeta)
      .set({ expectedFrequency: 'annual' })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()
    const row = await propose({ nature: 'variable' })

    await applyProposal(db, { id: row.id, userId: 'u1', now: NOW })

    const meta = metaOf('food')
    expect(meta.nature).toBe('variable')
    // Set by hand last week; a description proposal must not reset it.
    expect(meta.expectedFrequency).toBe('annual')
  })

  it('marks it applied, with who and when', async () => {
    const row = await propose({ nature: 'variable' })
    await applyProposal(db, { id: row.id, userId: 'u1', now: NOW })

    const applied = loadProposal(db, row.id)
    expect(applied?.status).toBe('applied')
    expect(applied?.appliedBy).toBe('u1')
    expect(applied?.appliedAt?.getTime()).toBe(NOW.getTime())
  })

  it('records what it changed, the run behind it and the proposal itself', async () => {
    const row = await propose({ nature: 'variable' })
    const result = await applyProposal(db, { id: row.id, userId: 'u1', now: NOW })

    const entry = loadAuditTrail(db, { entityRef: 'food' })[0]
    expect(entry?.id).toBe(result.auditId)
    expect(entry?.action).toBe('proposal.apply')
    expect(entry?.actorId).toBe('u1')
    expect(entry?.runId).toBe(runId)
    expect(entry?.proposalId).toBe(row.id)
    expect(JSON.parse(entry?.beforeJson ?? '{}')).toEqual({ nature: null })
    expect(JSON.parse(entry?.afterJson ?? '{}')).toEqual({ nature: 'variable' })
  })

  it('audits what the write did, not what the card predicted', async () => {
    // Someone set the value by hand in between. The card said null → variable; the
    // trail has to say the truth, which is that this write changed nothing.
    const row = await propose({ nature: 'variable' })
    db.update(categoryMeta)
      .set({ nature: 'variable' })
      .where(eq(categoryMeta.categoryId, 'food'))
      .run()

    const result = await applyProposal(db, { id: row.id, now: NOW })

    expect(result.fields).toEqual([])
    expect(loadProposal(db, row.id)?.status).toBe('applied')
    expect(JSON.parse(loadAuditTrail(db)[0]?.afterJson ?? 'null')).toEqual({})
  })

  it('refuses one that was already decided', async () => {
    const row = await propose({ nature: 'variable' })
    await applyProposal(db, { id: row.id, now: NOW })

    await expect(applyProposal(db, { id: row.id, now: NOW })).rejects.toThrow(/already applied/)
  })

  it('refuses one that has expired', async () => {
    const row = await propose({ nature: 'variable' })
    const later = new Date((row.expiresAt as Date).getTime() + 1_000)

    await expect(applyProposal(db, { id: row.id, now: later })).rejects.toThrow(/expired/)
    expect(metaOf('food').nature).toBeNull()
  })

  it('refuses a stored payload that no longer validates', async () => {
    // What a schema change looks like from here. Better a visible refusal than a
    // partial write from a payload nothing understands any more.
    const row = await propose({ nature: 'variable' })
    ctx.sqlite
      .prepare('update proposals set payload_json = ? where id = ?')
      .run('{"nature":"whatever"}', row.id)

    await expect(applyProposal(db, { id: row.id, now: NOW })).rejects.toThrow(/can no longer be applied/)
    expect(metaOf('food').nature).toBeNull()
    expect(loadProposal(db, row.id)?.status).toBe('pending')
  })

  it('leaves the row pending and the trail empty when the target is gone', async () => {
    const row = await propose({ nature: 'variable' })
    ctx.sqlite.prepare('delete from category_meta where category_id = ?').run('food')

    await expect(applyProposal(db, { id: row.id, now: NOW })).rejects.toThrow(/no metadata/)
    expect(loadProposal(db, row.id)?.status).toBe('pending')
    expect(loadAuditTrail(db)).toHaveLength(0)
  })

  it('does not touch confidence, which measures what the user stated themselves', async () => {
    const row = await propose({ nature: 'variable' })
    await applyProposal(db, { id: row.id, userId: 'u1', now: NOW })

    expect(metaOf('food').confidence).toBe(0)
  })
})

describe('transaction_category.set', () => {
  const proposeCategoryChange = (
    payload: Record<string, unknown> = { categoryId: 'food', payeeName: 'Albert Heijn' },
    overrides: Partial<Parameters<typeof createProposal>[1]> = {},
  ): Promise<ProposalRow> =>
    propose(payload, { type: 'transaction_category.set', targetRef: 'txn1', ...overrides })

  it('diffs against what Actual has for the transaction right now, by name', async () => {
    vi.mocked(fetchTransaction).mockResolvedValue({ id: 'txn1', categoryId: 'rent', payeeId: 'p1' })

    const row = await proposeCategoryChange()

    expect(storedDiff(row)?.fields).toEqual([{ field: 'category', before: 'Rent', after: 'Groceries' }])
  })

  it('falls back to the raw id when the current category has no local metadata', async () => {
    vi.mocked(fetchTransaction).mockResolvedValue({ id: 'txn1', categoryId: 'ghost', payeeId: 'p1' })

    const row = await proposeCategoryChange()
    expect(storedDiff(row)?.fields[0]?.before).toBe('ghost')
  })

  it('refuses a transaction that no longer exists', async () => {
    vi.mocked(fetchTransaction).mockResolvedValue(null)

    await expect(proposeCategoryChange()).rejects.toThrow(/no longer exists/)
  })

  it('refuses a category the transaction is already in', async () => {
    vi.mocked(fetchTransaction).mockResolvedValue({ id: 'txn1', categoryId: 'food', payeeId: 'p1' })

    await expect(proposeCategoryChange()).rejects.toThrow(/would change nothing/)
  })

  it('names the target from the payee snapshotted at generation time', async () => {
    vi.mocked(fetchTransaction).mockResolvedValue({ id: 'txn1', categoryId: 'rent', payeeId: 'p1' })

    const row = await proposeCategoryChange()
    expect(renderProposal(db, row, 'en').targetName).toBe('Albert Heijn')
  })

  it('applies by writing the category to Actual, with no local mirror to update', async () => {
    vi.mocked(fetchTransaction).mockResolvedValue({ id: 'txn1', categoryId: 'rent', payeeId: 'p1' })
    vi.mocked(updateTransactionCategory).mockResolvedValue(undefined)
    const row = await proposeCategoryChange()

    const result = await applyProposal(db, { id: row.id, userId: 'u1', now: NOW })

    expect(updateTransactionCategory).toHaveBeenCalledWith('txn1', 'food')
    expect(result.fields).toEqual([{ field: 'category', before: 'Rent', after: 'Groceries' }])
    expect(loadProposal(db, row.id)?.status).toBe('applied')
    expect(loadAuditTrail(db, { entityRef: 'txn1' })[0]?.action).toBe('proposal.apply')
  })

  it('leaves the proposal pending and the trail empty when the Actual write fails', async () => {
    vi.mocked(fetchTransaction).mockResolvedValue({ id: 'txn1', categoryId: 'rent', payeeId: 'p1' })
    vi.mocked(updateTransactionCategory).mockRejectedValue(new Error('Actual is down'))
    const row = await proposeCategoryChange()

    await expect(applyProposal(db, { id: row.id, now: NOW })).rejects.toThrow(/Actual is down/)

    expect(loadProposal(db, row.id)?.status).toBe('pending')
    expect(loadAuditTrail(db)).toHaveLength(0)
  })

  it('refuses to commit locally when the proposal was decided while the Actual write was in flight', async () => {
    vi.mocked(fetchTransaction).mockResolvedValue({ id: 'txn1', categoryId: 'rent', payeeId: 'p1' })
    const row = await proposeCategoryChange()
    // Simulates a second session rejecting the same proposal during the
    // window `applyRemote` is awaited in — the exact race `applyProposal`'s
    // re-check inside its transaction guards against.
    vi.mocked(updateTransactionCategory).mockImplementation(async () => {
      rejectProposal(db, { id: row.id, now: NOW })
    })

    await expect(applyProposal(db, { id: row.id, now: NOW })).rejects.toThrow(/already rejected/)

    expect(updateTransactionCategory).toHaveBeenCalledTimes(1)
    expect(loadProposal(db, row.id)?.status).toBe('rejected')
    // Only the reject's audit entry — the apply never committed.
    expect(loadAuditTrail(db)).toHaveLength(1)
    expect(loadAuditTrail(db)[0]?.action).toBe('proposal.reject')
  })
})

describe('budget_amount.set', () => {
  const target = encodeBudgetTarget('food', MONTH)

  const proposeBudgetChange = (
    amountCents: number,
    overrides: Partial<Parameters<typeof createProposal>[1]> = {},
  ): Promise<ProposalRow> =>
    propose({ amountCents }, { type: 'budget_amount.set', targetRef: target, ...overrides })

  it('encodes and decodes the category:month target ref', () => {
    expect(decodeBudgetTarget(target)).toEqual({ categoryId: 'food', month: MONTH })
  })

  it('diffs against the amount the sync job already mirrored locally', async () => {
    const row = await proposeBudgetChange(15_000)

    expect(storedDiff(row)?.fields).toEqual([
      { field: 'amount', before: formatMoney(12_000), after: formatMoney(15_000) },
    ])
  })

  it('refuses a target with no budget facts for that month', async () => {
    await expect(
      propose(
        { amountCents: 15_000 },
        { type: 'budget_amount.set', targetRef: encodeBudgetTarget('food', '2020-01') },
      ),
    ).rejects.toThrow(/no budget facts/)
  })

  it('refuses an amount equal to what is already budgeted', async () => {
    await expect(proposeBudgetChange(12_000)).rejects.toThrow(/would change nothing/)
  })

  it('names the target with the category and the month', async () => {
    const row = await proposeBudgetChange(15_000)
    expect(renderProposal(db, row, 'en').targetName).toBe('Groceries (2026-03)')
  })

  it('applies by writing the amount to Actual, without patching the local mirror', async () => {
    vi.mocked(setCategoryBudgetAmount).mockResolvedValue(undefined)
    const row = await proposeBudgetChange(15_000)

    const result = await applyProposal(db, { id: row.id, userId: 'u1', now: NOW })

    expect(setCategoryBudgetAmount).toHaveBeenCalledWith(MONTH, 'food', 15_000)
    expect(result.fields).toEqual([
      { field: 'amount', before: formatMoney(12_000), after: formatMoney(15_000) },
    ])
    // The next sync refreshes this; patching it here would be a second source
    // of truth for the same number.
    expect(budgetedCentsOf('food', MONTH)).toBe(12_000)
  })

  it('pendingBudgetProposals lists only that month\'s pending budget_amount.set rows, oldest first', async () => {
    const other = await createProposal(db, {
      type: 'budget_amount.set',
      targetRef: encodeBudgetTarget('rent', MONTH),
      payload: { amountCents: 15_000 },
      runId,
      now: new Date('2026-03-10T09:00:00Z'),
    })
    const first = await proposeBudgetChange(15_000, { now: new Date('2026-03-11T09:00:00Z') })
    // A different month, and a different proposal type, must both be excluded.
    seedMonth(db, '2026-04', { facts: [fact('2026-04', 'food')] })
    await createProposal(db, {
      type: 'budget_amount.set',
      targetRef: encodeBudgetTarget('food', '2026-04'),
      payload: { amountCents: 16_000 },
      runId,
    })
    await propose({ nature: 'variable' })

    const rows = pendingBudgetProposals(db, MONTH)

    expect(rows.map((row) => row.id)).toEqual([other.id, first.id])
  })
})

describe('rejectProposal', () => {
  it('records the decision without changing anything', async () => {
    const row = await propose({ nature: 'variable' })
    const rejected = rejectProposal(db, { id: row.id, userId: 'u1', now: NOW })

    expect(rejected.status).toBe('rejected')
    expect(loadProposal(db, row.id)?.status).toBe('rejected')
    expect(metaOf('food').nature).toBeNull()

    const entry = loadAuditTrail(db)[0]
    expect(entry?.action).toBe('proposal.reject')
    expect(entry?.beforeJson).toBeNull()
    expect(entry?.afterJson).toBeNull()
  })

  it('refuses one that was already decided', async () => {
    const row = await propose({ nature: 'variable' })
    rejectProposal(db, { id: row.id, now: NOW })

    expect(() => rejectProposal(db, { id: row.id, now: NOW })).toThrow(/already rejected/)
  })

  it('frees the target for a fresh proposal next month', async () => {
    const first = await propose({ nature: 'variable' })
    rejectProposal(db, { id: first.id, now: NOW })

    const second = await propose({ nature: 'fixed' })
    expect(pendingProposals(db).map((row) => row.id)).toEqual([second.id])
    expect(proposalHistory(db, 'food')).toHaveLength(2)
  })
})

describe('expireProposals', () => {
  it('retires what nobody decided on, without an audit entry', async () => {
    // Nobody decided anything, so there is nothing to attribute.
    const row = await propose({ nature: 'variable' })
    const later = new Date((row.expiresAt as Date).getTime() + 1_000)

    expect(expireProposals(db, later)).toBe(1)
    expect(loadProposal(db, row.id)?.status).toBe('expired')
    expect(loadAuditTrail(db)).toHaveLength(0)
  })

  it('leaves a proposal that is still current alone', async () => {
    await propose({ nature: 'variable' })
    expect(expireProposals(db, NOW)).toBe(0)
  })

  it('is safe to run twice', async () => {
    const row = await propose({ nature: 'variable' })
    const later = new Date((row.expiresAt as Date).getTime() + 1_000)

    expireProposals(db, later)
    expect(expireProposals(db, later)).toBe(0)
  })

  it('ignores one that was already applied', async () => {
    const row = await propose({ nature: 'variable' })
    await applyProposal(db, { id: row.id, now: NOW })
    const later = new Date((row.expiresAt as Date).getTime() + 1_000)

    expireProposals(db, later)
    expect(loadProposal(db, row.id)?.status).toBe('applied')
  })

  it('never expires a proposal without a deadline', async () => {
    const row = await propose({ nature: 'variable' })
    ctx.sqlite.prepare('update proposals set expires_at = null where id = ?').run(row.id)

    expect(expireProposals(db, new Date('2030-01-01'))).toBe(0)
    expect(db.select().from(proposals).all()[0]?.status).toBe('pending')
  })
})
