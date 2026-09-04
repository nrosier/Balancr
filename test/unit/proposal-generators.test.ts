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
import { fact, seedMonth } from '../fixtures/month.ts'
import {
  generateBudgetProposals,
  generateCategoryProposals,
} from '../../src/domain/ai/proposal-generators.ts'
import { decodeBudgetTarget, pendingProposals } from '../../src/domain/ai/proposals.ts'

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

describe('generateCategoryProposals', () => {
  it('proposes the majority category for a confident payee match', async () => {
    vi.mocked(fetchUncategorisedTransactions).mockResolvedValue([
      { id: 'txn-1', payeeId: 'payee-1', payeeName: 'Colruyt' },
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
      { id: 'txn-1', payeeId: 'payee-1', payeeName: 'Colruyt' },
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

  it('skips a transaction already carrying the suggested category', async () => {
    // Confident history, but the transaction turns out already set — the
    // no-op diff `createProposal` refuses, not a bug in the generator.
    vi.mocked(fetchUncategorisedTransactions).mockResolvedValue([
      { id: 'txn-1', payeeId: 'payee-1', payeeName: 'Colruyt' },
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
      { id: 'txn-1', payeeId: null, payeeName: null },
    ])

    const created = await generateCategoryProposals(db, MONTH)

    expect(created).toBe(0)
    expect(fetchPayeeCategoryHistory).not.toHaveBeenCalled()
  })
})

describe('generateBudgetProposals', () => {
  it('proposes the rounded baseline for a category with a triggered signal', async () => {
    const facts = [fact(MONTH, 'food', { budgetedCents: 12_000, baseline: baseline(15_070) })]
    seedMonth(db, MONTH, { facts })

    const created = await generateBudgetProposals(db, MONTH, [signal()], facts)

    expect(created).toBe(1)
    const rows = pendingProposals(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'budget_amount.set' })
    expect(decodeBudgetTarget(rows[0]!.targetRef)).toEqual({ categoryId: 'food', month: MONTH })
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({ amountCents: 15_100 })
  })

  it('skips a category already at the rounded baseline', async () => {
    const facts = [fact(MONTH, 'food', { budgetedCents: 15_100, baseline: baseline(15_070) })]
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
