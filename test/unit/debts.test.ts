/**
 * The stored revolving debts (#442): the four row operations and the vocabulary's one
 * derived figure.
 *
 * Mirrors `loans.test.ts`'s shape and reasoning — a real table, so what is pinned here is
 * "a create assigns an id, an edit replaces exactly one row, a delete reports whether it
 * found anything" rather than a settings-singleton's default-reading contract. The one
 * new thing to pin, absent from the loan module entirely, is that there is no schedule to
 * amortize — `estimatedMonthlyInterestCents` is a one-month snapshot, not a projection.
 * The isolation case lives in `tenant-isolation.test.ts`, as for every other domain area.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import {
  createDebt,
  deleteDebt,
  estimatedMonthlyInterestCents,
  listDebts,
  loadDebt,
  MAX_DEBTS,
  TooManyDebtsError,
  totalDebtBalanceCents,
  totalMinimumPaymentCents,
  updateDebt,
  type Debt,
  type DebtInput,
} from '../../src/domain/debt/debts.ts'

/** A credit card with a round balance, so every reading below is hand-checkable. */
const input = (overrides: Partial<DebtInput> = {}): DebtInput => ({
  kind: 'creditCard',
  label: 'Card',
  balanceCents: 200_000,
  minimumPaymentCents: 10_000,
  aprBp: 1_800,
  ...overrides,
})

/** The same debt as a stored row, for the pure functions that take one. */
const debt = (overrides: Partial<Debt> = {}): Debt => ({
  id: 'debt-1',
  kind: 'creditCard',
  label: 'Card',
  balanceCents: 200_000,
  minimumPaymentCents: 10_000,
  aprBp: 1_800,
  ...overrides,
})

describe('the stored debts', () => {
  let ctx: ReturnType<typeof createTestDb>
  let TENANT_ID: string

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
    TENANT_ID = getSoleTenantId(ctx.db)
  })

  it('is an empty list until somebody creates one', () => {
    expect(listDebts(ctx.db, TENANT_ID)).toEqual([])
  })

  it('assigns the id itself and round-trips every field', () => {
    const created = createDebt(ctx.db, TENANT_ID, input({ aprBp: 2_200 }))

    expect(created.id).not.toBe('')
    expect(loadDebt(ctx.db, TENANT_ID, created.id)).toEqual(created)
    expect(listDebts(ctx.db, TENANT_ID)).toEqual([created])
    expect(created.aprBp).toBe(2_200)
  })

  it('defaults the kind, label and apr rather than requiring them', () => {
    const created = createDebt(ctx.db, TENANT_ID, {
      balanceCents: 50_000,
      minimumPaymentCents: 2_500,
    })

    expect(created.kind).toBe('creditCard')
    expect(created.label).toBe('')
    expect(created.aprBp).toBeNull()
  })

  it('lists most recently added first', () => {
    const older = createDebt(ctx.db, TENANT_ID, input({ label: 'Older card' }))
    const newer = createDebt(ctx.db, TENANT_ID, input({ label: 'Newer card' }))

    expect(listDebts(ctx.db, TENANT_ID).map((row) => row.id)).toEqual([newer.id, older.id])
  })

  it('replaces exactly one debt and leaves the other alone', () => {
    const visa = createDebt(ctx.db, TENANT_ID, input())
    const store = createDebt(ctx.db, TENANT_ID, input({ kind: 'other', label: 'Store card' }))

    const updated = updateDebt(ctx.db, TENANT_ID, visa.id, input({ balanceCents: 150_000 }))

    expect(updated?.balanceCents).toBe(150_000)
    expect(loadDebt(ctx.db, TENANT_ID, store.id)?.balanceCents).toBe(200_000)
  })

  it('answers null when there is no such debt to update', () => {
    expect(updateDebt(ctx.db, TENANT_ID, 'nope', input())).toBeNull()
  })

  it('reports whether a delete found anything', () => {
    const created = createDebt(ctx.db, TENANT_ID, input())

    expect(deleteDebt(ctx.db, TENANT_ID, created.id)).toBe(true)
    expect(deleteDebt(ctx.db, TENANT_ID, created.id)).toBe(false)
    expect(listDebts(ctx.db, TENANT_ID)).toEqual([])
  })

  it('refuses an out-of-range apr or a negative amount', () => {
    expect(() => createDebt(ctx.db, TENANT_ID, input({ aprBp: 10_001 }))).toThrow()
    expect(() => createDebt(ctx.db, TENANT_ID, input({ balanceCents: -1 }))).toThrow()
    expect(() => createDebt(ctx.db, TENANT_ID, input({ minimumPaymentCents: -1 }))).toThrow()
  })

  it('refuses a kind that is not a kind', () => {
    expect(() => createDebt(ctx.db, TENANT_ID, input({ kind: 'mortgage' as never }))).toThrow()
  })

  it('refuses an unknown field rather than dropping it', () => {
    expect(() =>
      createDebt(ctx.db, TENANT_ID, { ...input(), cardNumber: '4111' } as never),
    ).toThrow()
    const created = createDebt(ctx.db, TENANT_ID, input())
    expect(() =>
      updateDebt(ctx.db, TENANT_ID, created.id, { ...input(), cardNumber: '4111' } as never),
    ).toThrow()
  })

  it('refuses more than the cap, and says so with its own error', () => {
    for (let i = 0; i < MAX_DEBTS; i++) {
      createDebt(ctx.db, TENANT_ID, input({ label: `Card ${String(i)}` }))
    }

    expect(() => createDebt(ctx.db, TENANT_ID, input())).toThrow(TooManyDebtsError)
    expect(listDebts(ctx.db, TENANT_ID)).toHaveLength(MAX_DEBTS)
  })
})

describe('the derived figures', () => {
  it('estimates one month of interest on the current balance', () => {
    // 200 000 at 18% APR: 200 000 * 0.18 / 12 = 3 000.
    expect(estimatedMonthlyInterestCents(debt())).toBe(3_000)
  })

  it('is null with no apr on file, never zero', () => {
    expect(estimatedMonthlyInterestCents(debt({ aprBp: null }))).toBeNull()
  })

  it('is never a projection — the same debt at a later date is not asked for', () => {
    // There is no date parameter at all: the estimate is a pure function of the row.
    expect(estimatedMonthlyInterestCents.length).toBe(1)
  })

  it('sums balances and minimum payments across every debt', () => {
    const visa = debt()
    const store = debt({ id: 'debt-2', balanceCents: 50_000, minimumPaymentCents: 2_500 })

    expect(totalDebtBalanceCents([visa, store])).toBe(250_000)
    expect(totalDebtBalanceCents([])).toBe(0)
    expect(totalMinimumPaymentCents([visa, store])).toBe(12_500)
  })
})
