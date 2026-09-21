/**
 * The amortization core, now shared by every fixed-schedule loan (#441).
 *
 * Extracted from `domain/property/vocabulary.ts`, where the same loop was typed against
 * `Mortgage`. `property-properties.test.ts` still exercises it through the mortgage
 * functions — deliberately unchanged, since "the property behaviour is identical after the
 * extraction" is exactly what that file is now also asserting. What is here is the two
 * things that file cannot say: that the functions work against the generic shape at all,
 * and the payoff projection #441 added, which has no mortgage caller yet.
 */
import { describe, expect, it } from 'vitest'
import {
  addMonths,
  amortizedBalanceCents,
  earliestAnchorDate,
  monthsBetween,
  monthsToPayoff,
  outstandingBalanceCents,
  paidOffBp,
  projectedPayoffDate,
  standardMonthlyPaymentCents,
  type AmortizedLoan,
} from '../../src/domain/loan/amortization.ts'
import type { Mortgage } from '../../src/domain/property/vocabulary.ts'

const loan = (overrides: Partial<AmortizedLoan> = {}): AmortizedLoan => ({
  principalCents: 1_500_000,
  anchorDate: '2026-01-01',
  rateBp: 0,
  monthlyPaymentCents: 100_000,
  remainingTermMonths: 15,
  originalPrincipalCents: null,
  ...overrides,
})

describe('the shared shape', () => {
  it('is what a mortgage is, so the property domain needs no adapter', () => {
    // A compile-time claim as much as a runtime one: `Mortgage` is `AmortizedLoan`, so
    // this assignment is what would break if either declaration drifted.
    const mortgage: Mortgage = loan()
    const asLoan: AmortizedLoan = mortgage
    expect(outstandingBalanceCents([asLoan], '2026-01-01')).toBe(1_500_000)
  })
})

describe('amortizedBalanceCents', () => {
  it('is the principal at the anchor itself', () => {
    expect(amortizedBalanceCents(loan(), '2026-01-01')).toBe(1_500_000)
  })

  it('pays down linearly at a zero rate', () => {
    expect(amortizedBalanceCents(loan(), '2026-04-01')).toBe(1_200_000)
  })

  it('accrues interest before the payment each month', () => {
    // 1200bp = 1%/month exactly, so the arithmetic is easy to hand-check.
    const m = loan({ principalCents: 100_000, rateBp: 1_200, monthlyPaymentCents: 5_000 })
    expect(amortizedBalanceCents(m, '2026-02-01')).toBe(96_000)
    expect(amortizedBalanceCents(m, '2026-03-01')).toBe(91_960)
  })

  it('never goes below zero, however long ago the term ended', () => {
    expect(amortizedBalanceCents(loan(), '2030-01-01')).toBe(0)
  })

  it('treats a date before the anchor as the anchor', () => {
    expect(amortizedBalanceCents(loan(), '2025-01-01')).toBe(1_500_000)
  })
})

describe('outstandingBalanceCents', () => {
  it('is zero for an empty list', () => {
    expect(outstandingBalanceCents([], '2026-06-01')).toBe(0)
  })

  it('sums across loans of different schedules', () => {
    const car = loan({ principalCents: 1_500_000, monthlyPaymentCents: 100_000 })
    const personal = loan({ principalCents: 500_000, monthlyPaymentCents: 50_000 })
    // After three months: 1 200 000 + 350 000.
    expect(outstandingBalanceCents([car, personal], '2026-04-01')).toBe(1_550_000)
  })
})

describe('standardMonthlyPaymentCents', () => {
  it('divides evenly at a zero rate', () => {
    expect(standardMonthlyPaymentCents(120_000, 0, 12)).toBe(10_000)
  })

  it('matches the standard annuity formula at a nonzero rate', () => {
    // 15 000,00 EUR at 5% APR over 48 months, cross-checked against the closed-form
    // annuity formula computed independently — a car loan rather than a mortgage, since
    // that is what this module is shared with now.
    expect(standardMonthlyPaymentCents(1_500_000, 500, 48)).toBe(34_544)
  })

  it('is zero over no term', () => {
    expect(standardMonthlyPaymentCents(1_500_000, 500, 0)).toBe(0)
  })
})

describe('paidOffBp', () => {
  it('is null with nothing to compare against', () => {
    expect(paidOffBp([], '2026-06-01')).toBeNull()
    expect(paidOffBp([loan({ originalPrincipalCents: null })], '2026-06-01')).toBeNull()
    expect(paidOffBp([loan({ originalPrincipalCents: 0 })], '2026-06-01')).toBeNull()
  })

  it('is the share of the original amount no longer owed', () => {
    const m = loan({ originalPrincipalCents: 3_000_000 })
    expect(paidOffBp([m], '2026-01-01')).toBe(5_000)
    expect(paidOffBp([m], '2026-04-01')).toBe(6_000)
  })
})

describe('earliestAnchorDate', () => {
  it('is null for an empty list, and the earliest otherwise', () => {
    expect(earliestAnchorDate([])).toBeNull()
    expect(
      earliestAnchorDate([loan({ anchorDate: '2026-03-01' }), loan({ anchorDate: '2026-01-15' })]),
    ).toBe('2026-01-15')
  })
})

describe('monthsToPayoff (#441)', () => {
  it('counts the months the schedule needs, not the term it was given', () => {
    // 1 500 000 at 100 000 a month with no interest: fifteen payments, over a 60-month term.
    expect(monthsToPayoff(loan({ remainingTermMonths: 60 }))).toBe(15)
  })

  it('is zero for a loan that is already clear', () => {
    expect(monthsToPayoff(loan({ principalCents: 0 }))).toBe(0)
  })

  it('is null when the payment never clears the balance within the term', () => {
    // A payment below the monthly interest: the balance grows every month.
    expect(
      monthsToPayoff(loan({ rateBp: 1_200, monthlyPaymentCents: 1, remainingTermMonths: 60 })),
    ).toBeNull()
    // And a term that simply runs out with something still owed.
    expect(monthsToPayoff(loan({ remainingTermMonths: 10 }))).toBeNull()
  })

  it('counts fewer months once interest stops being charged', () => {
    const withInterest = monthsToPayoff(loan({ rateBp: 1_200, remainingTermMonths: 60 }))
    const without = monthsToPayoff(loan({ remainingTermMonths: 60 }))
    // 1%/month on a balance that starts at fifteen payments' worth costs two extra ones.
    expect(withInterest).toBe(17)
    expect(without).toBe(15)
  })
})

describe('projectedPayoffDate (#441)', () => {
  it('is the anchor plus the months the schedule needs', () => {
    expect(projectedPayoffDate(loan({ remainingTermMonths: 60 }))).toBe('2027-04-01')
  })

  it('is null exactly when the schedule never clears the loan', () => {
    expect(projectedPayoffDate(loan({ remainingTermMonths: 10 }))).toBeNull()
  })

  it('keeps the day of the month, clamping to the last day of a shorter one', () => {
    // Anchored on the 31st, paid off one month later: the 28th of February, not the 3rd
    // of March, which is where a naive month addition would land it.
    const m = loan({ anchorDate: '2026-01-31', principalCents: 100_000, monthlyPaymentCents: 100_000 })
    expect(projectedPayoffDate(m)).toBe('2026-02-28')
  })
})

describe('addMonths', () => {
  it('adds whole calendar months', () => {
    expect(addMonths('2026-01-15', 0)).toBe('2026-01-15')
    expect(addMonths('2026-01-15', 13)).toBe('2027-02-15')
  })

  it('clamps rather than rolling into the next month', () => {
    expect(addMonths('2026-03-31', 1)).toBe('2026-04-30')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
  })
})

describe('monthsBetween', () => {
  it('counts only months that have fully elapsed', () => {
    expect(monthsBetween('2026-01-15', '2026-02-14')).toBe(0)
    expect(monthsBetween('2026-01-15', '2026-02-15')).toBe(1)
    expect(monthsBetween('2026-01-15', '2025-12-15')).toBe(-1)
  })
})
