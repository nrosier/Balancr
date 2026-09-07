/**
 * The impure half of #45's deterministic generators — wiring the pure rules in
 * `domain/aggregate/proposal-rules.ts` to a real (test) DB and a mocked Actual
 * adapter. What's under test is the wiring: a confident payee match becomes a
 * pending proposal, a category signal's baseline becomes another, and both
 * skip cleanly (rather than throwing) on the no-op cases `createProposal`
 * itself refuses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import type { BaselineResult } from '../../src/domain/aggregate/baseline.ts'
import type { Signal } from '../../src/domain/aggregate/overspend.ts'
import { monthsBefore } from '../../src/util/month.ts'
import { fact, seedMonth } from '../fixtures/month.ts'
import {
  generateBudgetProposals,
  generateCategoryProposals,
} from '../../src/domain/ai/proposal-generators.ts'
import { decodeBudgetTarget, pendingProposals, storedWhy } from '../../src/domain/ai/proposals.ts'
import { loadCategoryGuessCandidates } from '../../src/domain/aggregate/signals-store.ts'

vi.mock('../../src/adapters/actual/queries.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/actual/queries.ts')>()),
  fetchTransaction: vi.fn(),
  fetchUncategorisedTransactions: vi.fn(),
  fetchPayeeCategoryHistory: vi.fn(),
}))

import {
  fetchPayeeCategoryHistory,
  fetchTransaction,
  fetchUncategorisedTransactions,
} from '../../src/adapters/actual/queries.ts'

const MONTH = '2026-03'

let ctx: ReturnType<typeof createTestDb>
let db: Db

beforeEach(() => {
  vi.mocked(fetchTransaction).mockReset()
  vi.mocked(fetchUncategorisedTransactions).mockReset()
  vi.mocked(fetchPayeeCategoryHistory).mockReset()

  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
})

function baseline(baselineCents: number): BaselineResult {
  return {
    baselineCents,
    currentCents: 0,
    deltaBp: null,
    monthsUsed: 12,
    windowMonths: 1,
    winsorEffectBp: 0,
  }
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    code: 'over_available',
    categoryId: 'food',
    categoryName: 'Groceries',
    severity: 'alert',
    metrics: {},
    ...overrides,
  }
}

/**
 * The 12 *finished* months before `MONTH` — never `MONTH` itself (#251) — seeded
 * thinly (one category, unjudged) so `loadCategoryTrends`'s window, anchored one
 * month back, has a real trailing history for #220's weighted average to chew on:
 * the oldest 9 at `olderCents`, the most recent 3 at `recentCents`.
 */
function seedTrailingSpend(categoryId: string, recentCents: number, olderCents: number): void {
  const priorMonths = monthsBefore(MONTH, 12)
  priorMonths.forEach((month, at) => {
    const spentCents = at >= priorMonths.length - 3 ? recentCents : olderCents
    seedMonth(db, month, {
      facts: [fact(month, categoryId, { spentCents, budgetedCents: spentCents + 1_000 })],
      judged: false,
    })
  })
}

describe('generateCategoryProposals', () => {
  it('proposes the majority category for a confident payee match', async () => {
    vi.mocked(fetchUncategorisedTransactions).mockResolvedValue([
      { id: 'txn-1', payeeId: 'payee-1', payeeName: 'Colruyt', amountCents: -4200, date: '2026-03-05' },
    ])
    vi.mocked(fetchPayeeCategoryHistory).mockResolvedValue([
      { categoryId: 'food' },
      { categoryId: 'food' },
      { categoryId: 'food' },
      { categoryId: 'food' },
      { categoryId: 'other' },
    ])
    vi.mocked(fetchTransaction).mockResolvedValue({
      id: 'txn-1',
      categoryId: null,
      payeeId: 'payee-1',
    })

    const created = await generateCategoryProposals(db, MONTH)

    expect(created).toBe(1)
    const rows = pendingProposals(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'transaction_category.set', targetRef: 'txn-1' })
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({ categoryId: 'food', payeeName: 'Colruyt' })
  })

  it('skips a payee match below the confidence bar rather than guessing', async () => {
    vi.mocked(fetchUncategorisedTransactions).mockResolvedValue([
      { id: 'txn-1', payeeId: 'payee-1', payeeName: 'Colruyt', amountCents: -4200, date: '2026-03-05' },
    ])
    vi.mocked(fetchPayeeCategoryHistory).mockResolvedValue([
      { categoryId: 'food' },
      { categoryId: 'other' },
    ])

    const created = await generateCategoryProposals(db, MONTH)

    expect(created).toBe(0)
    expect(pendingProposals(db)).toHaveLength(0)
    expect(fetchTransaction).not.toHaveBeenCalled()
  })

  it('caches a below-threshold match as a #216 candidate instead of dropping it', async () => {
    vi.mocked(fetchUncategorisedTransactions).mockResolvedValue([
      { id: 'txn-1', payeeId: 'payee-1', payeeName: 'Colruyt', amountCents: -4200, date: '2026-03-05' },
    ])
    vi.mocked(fetchPayeeCategoryHistory).mockResolvedValue([
      { categoryId: 'food' },
      { categoryId: 'other' },
    ])

    await generateCategoryProposals(db, MONTH)

    const candidates = loadCategoryGuessCandidates(db, MONTH)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      transactionId: 'txn-1',
      payeeId: 'payee-1',
      payeeName: 'Colruyt',
      amountCents: -4200,
      date: '2026-03-05',
    })
    expect(candidates[0]!.history).toEqual(
      expect.arrayContaining([
        { categoryId: 'food', count: 1 },
        { categoryId: 'other', count: 1 },
      ]),
    )
  })

  it('does not cache a candidate for a payee with no categorised history at all', async () => {
    vi.mocked(fetchUncategorisedTransactions).mockResolvedValue([
      { id: 'txn-1', payeeId: 'payee-1', payeeName: 'Colruyt', amountCents: -4200, date: '2026-03-05' },
    ])
    vi.mocked(fetchPayeeCategoryHistory).mockResolvedValue([{ categoryId: null }])

    await generateCategoryProposals(db, MONTH)

    expect(loadCategoryGuessCandidates(db, MONTH)).toHaveLength(0)
  })

  it("re-running for one month leaves another month's cached candidates alone", async () => {
    vi.mocked(fetchUncategorisedTransactions).mockResolvedValueOnce([
      { id: 'txn-old', payeeId: 'payee-1', payeeName: 'Colruyt', amountCents: -4200, date: '2026-02-05' },
    ])
    vi.mocked(fetchPayeeCategoryHistory).mockResolvedValue([
      { categoryId: 'food' },
      { categoryId: 'other' },
    ])
    await generateCategoryProposals(db, '2026-02')

    vi.mocked(fetchUncategorisedTransactions).mockResolvedValueOnce([
      { id: 'txn-new', payeeId: 'payee-2', payeeName: 'Delhaize', amountCents: -1500, date: '2026-03-05' },
    ])
    await generateCategoryProposals(db, MONTH)

    expect(loadCategoryGuessCandidates(db, '2026-02')).toHaveLength(1)
    expect(loadCategoryGuessCandidates(db, MONTH)).toHaveLength(1)
  })

  it('skips a transaction already carrying the suggested category', async () => {
    // Confident history, but the transaction turns out already set — the
    // no-op diff `createProposal` refuses, not a bug in the generator.
    vi.mocked(fetchUncategorisedTransactions).mockResolvedValue([
      { id: 'txn-1', payeeId: 'payee-1', payeeName: 'Colruyt', amountCents: -4200, date: '2026-03-05' },
    ])
    vi.mocked(fetchPayeeCategoryHistory).mockResolvedValue([
      { categoryId: 'food' },
      { categoryId: 'food' },
    ])
    vi.mocked(fetchTransaction).mockResolvedValue({
      id: 'txn-1',
      categoryId: 'food',
      payeeId: 'payee-1',
    })

    const created = await generateCategoryProposals(db, MONTH)

    expect(created).toBe(0)
    expect(pendingProposals(db)).toHaveLength(0)
  })

  it('skips a transaction with no payee to match against', async () => {
    vi.mocked(fetchUncategorisedTransactions).mockResolvedValue([
      { id: 'txn-1', payeeId: null, payeeName: null, amountCents: -4200, date: '2026-03-05' },
    ])

    const created = await generateCategoryProposals(db, MONTH)

    expect(created).toBe(0)
    expect(fetchPayeeCategoryHistory).not.toHaveBeenCalled()
  })
})

describe('generateBudgetProposals', () => {
  it('proposes the weighted trailing average for a category with a triggered signal', async () => {
    seedTrailingSpend('food', 20_000, 10_000)
    const facts = [fact(MONTH, 'food', { spentCents: 20_000, budgetedCents: 12_000, baseline: baseline(15_070) })]
    seedMonth(db, MONTH, { facts })

    const created = await generateBudgetProposals(db, MONTH, [signal()], facts)

    expect(created).toBe(1)
    const rows = pendingProposals(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'budget_amount.set' })
    expect(decodeBudgetTarget(rows[0]!.targetRef)).toEqual({ categoryId: 'food', month: MONTH })
    // Finished months only (#251): recent 3 average 20_000, older 9 average 10_000,
    // MONTH's own (in-progress) 20_000 plays no part: 20_000*0.6 + 10_000*0.4
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({ amountCents: 16_000 })
    // The reason travels with it (#273), as values rather than a sentence, so the
    // card reads correctly in whichever language it is eventually reviewed in.
    expect(storedWhy(rows[0]!)).toEqual({
      source: 'rule',
      code: 'overspent_trailing',
      params: { months: 12 },
    })
  })

  it("does not let MONTH's own, still-accumulating spend skew the average (#251)", async () => {
    // Same finished history as the first test, but MONTH itself — early in the
    // month, its `spentCents` a small fraction of what it will end up at — spent
    // almost nothing. Before #251 that tiny figure sat in the 60%-weighted
    // "recent" bucket and dragged the suggestion down; now it is not part of the
    // window at all, so the suggested amount is unchanged from the first test.
    seedTrailingSpend('food', 20_000, 10_000)
    const facts = [fact(MONTH, 'food', { spentCents: 800, budgetedCents: 12_000, baseline: baseline(15_070) })]
    seedMonth(db, MONTH, { facts })

    const created = await generateBudgetProposals(db, MONTH, [signal()], facts)

    expect(created).toBe(1)
    const rows = pendingProposals(db)
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({ amountCents: 16_000 })
  })

  it('skips a category already at the weighted trailing average', async () => {
    seedTrailingSpend('food', 15_000, 15_000)
    const facts = [fact(MONTH, 'food', { spentCents: 15_000, budgetedCents: 15_000, baseline: baseline(15_070) })]
    seedMonth(db, MONTH, { facts })

    const created = await generateBudgetProposals(db, MONTH, [signal()], facts)

    expect(created).toBe(0)
    expect(pendingProposals(db)).toHaveLength(0)
  })

  it('skips a category with no baseline yet', async () => {
    const facts = [fact(MONTH, 'food', { budgetedCents: 12_000, baseline: null })]
    seedMonth(db, MONTH, { facts })

    const created = await generateBudgetProposals(db, MONTH, [signal()], facts)

    expect(created).toBe(0)
  })
})
