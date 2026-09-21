/**
 * The stored fixed-schedule loans (#441): the four row operations and the vocabulary's
 * derived figures.
 *
 * Unlike every settings singleton — `property/properties.ts`, `benchmark/household.ts` —
 * this is a real table, so the contract being pinned here is a different one. There is no
 * "reading degrades to the default" claim to make; what there is instead is that a create
 * assigns an id, an edit replaces exactly one row, a delete reports whether it found
 * anything, and every one of the four refuses to see another tenant's row (the isolation
 * case lives in `tenant-isolation.test.ts`, as for every other domain area).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import {
  createLoan,
  deleteLoan,
  effectiveMonthlyPaymentCents,
  listLoans,
  loadLoan,
  loanBalanceCents,
  loanPaidOffBp,
  loanPayoffDate,
  MAX_LOANS,
  TooManyLoansError,
  totalLoanBalanceCents,
  totalMonthlyPaymentCents,
  updateLoan,
  type Loan,
  type LoanInput,
} from '../../src/domain/loan/loans.ts'

/** A car loan with a zero rate, so every balance below is hand-checkable. */
const input = (overrides: Partial<LoanInput> = {}): LoanInput => ({
  kind: 'car',
  label: 'Car',
  openingDate: '2026-01-01',
  principalCents: 1_500_000,
  anchorDate: '2026-01-01',
  rateBp: 0,
  monthlyPaymentCents: 100_000,
  remainingTermMonths: 60,
  originalPrincipalCents: null,
  extraMonthlyPaymentCents: null,
  ...overrides,
})

/** The same loan as a stored row, for the pure functions that take one. */
const loan = (overrides: Partial<Loan> = {}): Loan => ({
  id: 'loan-1',
  kind: 'car',
  label: 'Car',
  openingDate: '2026-01-01',
  principalCents: 1_500_000,
  anchorDate: '2026-01-01',
  rateBp: 0,
  monthlyPaymentCents: 100_000,
  remainingTermMonths: 60,
  originalPrincipalCents: null,
  extraMonthlyPaymentCents: null,
  ...overrides,
})

describe('the stored loans', () => {
  let ctx: ReturnType<typeof createTestDb>
  let TENANT_ID: string

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
    TENANT_ID = getSoleTenantId(ctx.db)
  })

  it('is an empty list until somebody creates one', () => {
    expect(listLoans(ctx.db, TENANT_ID)).toEqual([])
  })

  it('assigns the id itself and round-trips every field', () => {
    const created = createLoan(ctx.db, TENANT_ID, input({ originalPrincipalCents: 3_000_000 }))

    expect(created.id).not.toBe('')
    expect(loadLoan(ctx.db, TENANT_ID, created.id)).toEqual(created)
    expect(listLoans(ctx.db, TENANT_ID)).toEqual([created])
    expect(created.originalPrincipalCents).toBe(3_000_000)
    expect(created.extraMonthlyPaymentCents).toBeNull()
  })

  it('defaults the two optional amounts to null rather than zero', () => {
    const created = createLoan(ctx.db, TENANT_ID, {
      openingDate: '2026-01-01',
      principalCents: 500_000,
      anchorDate: '2026-01-01',
      rateBp: 0,
      monthlyPaymentCents: 50_000,
      remainingTermMonths: 12,
    })

    expect(created.originalPrincipalCents).toBeNull()
    expect(created.extraMonthlyPaymentCents).toBeNull()
    // And the two defaulted descriptors, so a bare create is still a usable row.
    expect(created.kind).toBe('personal')
    expect(created.label).toBe('')
  })

  it('lists most recently taken out first', () => {
    const older = createLoan(ctx.db, TENANT_ID, input({ openingDate: '2024-05-01' }))
    const newer = createLoan(ctx.db, TENANT_ID, input({ openingDate: '2026-02-01' }))

    expect(listLoans(ctx.db, TENANT_ID).map((row) => row.id)).toEqual([newer.id, older.id])
  })

  it('replaces exactly one loan and leaves the other alone', () => {
    const car = createLoan(ctx.db, TENANT_ID, input())
    const personal = createLoan(ctx.db, TENANT_ID, input({ kind: 'personal', label: 'Kitchen' }))

    const updated = updateLoan(ctx.db, TENANT_ID, car.id, input({ principalCents: 900_000 }))

    expect(updated?.principalCents).toBe(900_000)
    expect(loadLoan(ctx.db, TENANT_ID, personal.id)?.principalCents).toBe(1_500_000)
  })

  it('re-anchors in place rather than keeping a history', () => {
    const created = createLoan(ctx.db, TENANT_ID, input())
    updateLoan(
      ctx.db,
      TENANT_ID,
      created.id,
      input({ principalCents: 700_000, anchorDate: '2026-09-01', remainingTermMonths: 7 }),
    )

    const rows = listLoans(ctx.db, TENANT_ID)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.anchorDate).toBe('2026-09-01')
    expect(rows[0]?.principalCents).toBe(700_000)
  })

  it('answers null when there is no such loan to update', () => {
    expect(updateLoan(ctx.db, TENANT_ID, 'nope', input())).toBeNull()
  })

  it('reports whether a delete found anything', () => {
    const created = createLoan(ctx.db, TENANT_ID, input())

    expect(deleteLoan(ctx.db, TENANT_ID, created.id)).toBe(true)
    expect(deleteLoan(ctx.db, TENANT_ID, created.id)).toBe(false)
    expect(listLoans(ctx.db, TENANT_ID)).toEqual([])
  })

  it('refuses an out-of-range rate or term', () => {
    expect(() => createLoan(ctx.db, TENANT_ID, input({ rateBp: 5_001 }))).toThrow()
    expect(() => createLoan(ctx.db, TENANT_ID, input({ remainingTermMonths: 601 }))).toThrow()
    expect(() => createLoan(ctx.db, TENANT_ID, input({ principalCents: -1 }))).toThrow()
  })

  it('refuses a date that is not a date, and a kind that is not a kind', () => {
    expect(() => createLoan(ctx.db, TENANT_ID, input({ openingDate: 'someday' }))).toThrow()
    expect(() => createLoan(ctx.db, TENANT_ID, input({ anchorDate: '01/01/2026' }))).toThrow()
    expect(() =>
      createLoan(ctx.db, TENANT_ID, input({ kind: 'mortgage' as never })),
    ).toThrow()
  })

  it('refuses an unknown field rather than dropping it', () => {
    expect(() =>
      createLoan(ctx.db, TENANT_ID, { ...input(), balloonCents: 1_000 } as never),
    ).toThrow()
    const created = createLoan(ctx.db, TENANT_ID, input())
    expect(() =>
      updateLoan(ctx.db, TENANT_ID, created.id, { ...input(), balloonCents: 1_000 } as never),
    ).toThrow()
  })

  it('refuses more than the cap, and says so with its own error', () => {
    for (let i = 0; i < MAX_LOANS; i++) {
      createLoan(ctx.db, TENANT_ID, input({ label: `Loan ${String(i)}` }))
    }

    expect(() => createLoan(ctx.db, TENANT_ID, input())).toThrow(TooManyLoansError)
    expect(listLoans(ctx.db, TENANT_ID)).toHaveLength(MAX_LOANS)
  })
})

describe('the derived figures', () => {
  it('amortizes one loan as of a date', () => {
    expect(loanBalanceCents(loan(), '2026-01-01')).toBe(1_500_000)
    expect(loanBalanceCents(loan(), '2026-04-01')).toBe(1_200_000)
  })

  it('counts a voluntary extra payment toward the balance', () => {
    const extra = loan({ extraMonthlyPaymentCents: 200_000 })
    // 300 000 a month rather than 100 000: three months in, 600 000 rather than 1 200 000.
    expect(loanBalanceCents(extra, '2026-04-01')).toBe(600_000)
    expect(effectiveMonthlyPaymentCents(extra)).toBe(300_000)
  })

  it('brings the payoff date forward by the extra payment', () => {
    expect(loanPayoffDate(loan())).toBe('2027-04-01')
    expect(loanPayoffDate(loan({ extraMonthlyPaymentCents: 200_000 }))).toBe('2026-06-01')
  })

  it('is null for a payoff date the schedule never reaches', () => {
    expect(loanPayoffDate(loan({ monthlyPaymentCents: 0 }))).toBeNull()
  })

  it('is null for a paid-off share with no original amount on file', () => {
    expect(loanPaidOffBp(loan(), '2026-01-01')).toBeNull()
    expect(loanPaidOffBp(loan({ originalPrincipalCents: 3_000_000 }), '2026-01-01')).toBe(5_000)
  })

  it('sums balances and monthly payments across every loan', () => {
    const car = loan()
    const personal = loan({ id: 'loan-2', principalCents: 500_000, monthlyPaymentCents: 50_000 })

    expect(totalLoanBalanceCents([car, personal], '2026-04-01')).toBe(1_550_000)
    expect(totalLoanBalanceCents([], '2026-04-01')).toBe(0)
    expect(totalMonthlyPaymentCents([car, personal])).toBe(150_000)
  })
})
