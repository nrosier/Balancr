import { describe, expect, it } from 'vitest'
import type { MonthValue } from '../../src/domain/aggregate/baseline.ts'
import { householdSignals } from '../../src/domain/aggregate/household.ts'
import type { NetWorthResult } from '../../src/domain/aggregate/networth.ts'
import { DEFAULT_PARAMS } from '../../src/domain/aggregate/params.ts'
import type { Signal } from '../../src/domain/aggregate/overspend.ts'
import type { MonthTotals } from '../../src/domain/aggregate/spend.ts'
import { addMonths } from '../../src/util/month.ts'

const codes = (signals: Signal[]): string[] => signals.map((signal) => signal.code)
const find = (signals: Signal[], code: string): Signal | undefined =>
  signals.find((signal) => signal.code === code)

function totals(overrides: Partial<MonthTotals> = {}): MonthTotals {
  const incomeCents = overrides.incomeCents ?? 300_000
  const spentCents = overrides.spentCents ?? 240_000
  return {
    month: overrides.month ?? '2026-03',
    incomeCents,
    spentCents,
    budgetedCents: overrides.budgetedCents ?? spentCents,
    toBudgetCents: overrides.toBudgetCents ?? 0,
    fromLastMonthCents: overrides.fromLastMonthCents ?? 0,
    balanceCents: overrides.balanceCents ?? incomeCents - spentCents,
    savingsRateBp:
      overrides.savingsRateBp === undefined
        ? Math.round(((incomeCents - spentCents) / incomeCents) * 10_000)
        : overrides.savingsRateBp,
  }
}

/** `count` dense months ending at `last`, each worth `cents(index)`. */
function series(last: string, count: number, cents: (index: number) => number): MonthValue[] {
  return Array.from({ length: count }, (_, index) => ({
    month: addMonths(last, index - count + 1),
    cents: cents(index),
  }))
}

function netWorth(overrides: Partial<NetWorthResult> = {}): NetWorthResult {
  return {
    date: '2026-03-31',
    totalCents: 5_000_000,
    liquidCents: 900_000,
    investedCents: 4_100_000,
    debtCents: 0,
    contributions: [],
    excluded: [],
    unresolvedGroups: [],
    ...overrides,
  }
}

/** Flat, uninteresting inputs, so each test switches on the one thing it names. */
function input(overrides: Partial<Parameters<typeof householdSignals>[0]> = {}) {
  return {
    month: '2026-03',
    totals: totals(),
    incomeHistory: series('2026-03', 6, () => 300_000),
    spendHistory: series('2026-03', 6, () => 240_000),
    netWorth: null,
    netWorthHistory: [],
    params: DEFAULT_PARAMS,
    ...overrides,
  }
}

describe('savings rate', () => {
  it('reports a shortfall against the target', () => {
    // 300000 in, 285000 out: a 5% rate against a 15% target.
    const signals = householdSignals(
      input({ totals: totals({ incomeCents: 300_000, spentCents: 285_000 }) }),
    )
    expect(find(signals, 'savings_rate_low')?.metrics).toEqual({
      rateBp: 500,
      targetBp: 1_500,
      shortfallBp: 1_000,
      incomeCents: 300_000,
    })
  })

  it('says so when the target is met, the one bit of good news in the panel', () => {
    const signals = householdSignals(input())
    expect(find(signals, 'savings_rate_up')?.metrics).toEqual({
      rateBp: 2_000,
      targetBp: 1_500,
      deltaBp: 500,
      savedCents: 60_000,
    })
    expect(find(signals, 'savings_rate_up')?.severity).toBe('info')
  })

  it('is silent when there is no income to divide by', () => {
    // A salary that lands on the 1st of the next month is not a savings rate of
    // minus infinity, it is an absence of a denominator.
    const signals = householdSignals(
      input({ totals: totals({ incomeCents: 0, spentCents: 240_000, savingsRateBp: null }) }),
    )
    expect(codes(signals)).not.toContain('savings_rate_low')
    expect(codes(signals)).not.toContain('savings_rate_up')
  })
})

describe('income change', () => {
  it('flags a rise against the norm of the previous months', () => {
    const signals = householdSignals(
      input({
        totals: totals({ incomeCents: 400_000, spentCents: 240_000 }),
        // Five flat months, then the month being judged.
        incomeHistory: series('2026-03', 6, (index) => (index === 5 ? 400_000 : 300_000)),
      }),
    )
    expect(find(signals, 'income_change')?.metrics).toEqual({
      deltaBp: 3_333,
      baselineCents: 300_000,
      currentCents: 400_000,
      changeCents: 100_000,
    })
  })

  it('flags a drop just as loudly, because the threshold is symmetric', () => {
    // Whichever direction income moves by a fifth, it changes what every other
    // number on the page means.
    const signals = householdSignals(
      input({
        totals: totals({ incomeCents: 200_000, spentCents: 190_000 }),
        incomeHistory: series('2026-03', 6, (index) => (index === 5 ? 200_000 : 300_000)),
      }),
    )
    expect(find(signals, 'income_change')?.metrics.deltaBp).toBe(-3_333)
  })

  it('stays quiet for a small move and for too little history', () => {
    const small = householdSignals(
      input({
        totals: totals({ incomeCents: 315_000, spentCents: 240_000 }),
        incomeHistory: series('2026-03', 6, (index) => (index === 5 ? 315_000 : 300_000)),
      }),
    )
    expect(codes(small)).not.toContain('income_change')

    // Four observations, one of which is the month being judged, leaves three
    // for the baseline: below `baseline.minMonths`, so no norm exists yet.
    const short = householdSignals(
      input({
        totals: totals({ incomeCents: 400_000, spentCents: 240_000 }),
        incomeHistory: series('2026-03', 4, (index) => (index === 3 ? 400_000 : 300_000)),
      }),
    )
    expect(codes(short)).not.toContain('income_change')
  })

  it('refuses a series with a hole in it', () => {
    expect(() =>
      householdSignals(
        input({
          incomeHistory: [
            { month: '2026-01', cents: 300_000 },
            { month: '2026-03', cents: 300_000 },
          ],
        }),
      ),
    ).toThrow(/income history must be dense and ascending/)
  })
})

describe('emergency fund', () => {
  it('measures the cushion in months of typical spend', () => {
    // Flat 2400,00 a month and 1500,00 liquid: 1.5 months against a target of 3.
    const signals = householdSignals(
      input({
        spendHistory: series('2026-03', 6, () => 240_000),
        netWorth: netWorth({ liquidCents: 360_000 }),
      }),
    )
    expect(find(signals, 'emergency_fund_short')?.metrics).toEqual({
      monthsBp: 15_000,
      targetBp: 30_000,
      liquidCents: 360_000,
      typicalSpendCents: 240_000,
      shortfallCents: 360_000,
    })
    expect(find(signals, 'emergency_fund_short')?.severity).toBe('alert')
  })

  it('is not shortened by a month that happens to contain an annual premium', () => {
    // 1000,00 a month for a year, then a month with a 2000,00 insurance premium
    // in it. Judged against that month the cushion looks like 1.5 months and
    // fires; judged against typical spend it is over three months and does not.
    // The premium was always going to be paid.
    const signals = householdSignals(
      input({
        totals: totals({ incomeCents: 300_000, spentCents: 300_000, savingsRateBp: 0 }),
        incomeHistory: series('2026-03', 12, () => 300_000),
        spendHistory: series('2026-03', 12, (index) => (index === 11 ? 300_000 : 100_000)),
        netWorth: netWorth({ liquidCents: 450_000 }),
      }),
    )
    expect(codes(signals)).not.toContain('emergency_fund_short')
  })

  it('says nothing without a net worth figure or a spend history', () => {
    expect(codes(householdSignals(input({ netWorth: null })))).not.toContain('emergency_fund_short')
    // `ewma` of an empty series is an error, not a zero, and a cushion with no
    // denominator is not a finding either way.
    expect(
      codes(householdSignals(input({ spendHistory: [], netWorth: netWorth() }))),
    ).not.toContain('emergency_fund_short')
  })
})

describe('net worth high', () => {
  it('reports a new high against the best earlier figure', () => {
    const signals = householdSignals(
      input({
        netWorth: netWorth({ date: '2026-03-31', totalCents: 5_000_000 }),
        netWorthHistory: [
          { date: '2026-01-31', totalCents: 4_800_000 },
          { date: '2026-02-28', totalCents: 4_950_000 },
        ],
      }),
    )
    expect(find(signals, 'net_worth_high')?.metrics).toEqual({
      amountCents: 5_000_000,
      previousHighCents: 4_950_000,
      gainCents: 50_000,
    })
  })

  it('ignores its own snapshot, which is already in the table by then', () => {
    // Comparing a figure against itself never yields a record, and a first run
    // should not congratulate anyone for having no history.
    const sameDay = householdSignals(
      input({
        netWorth: netWorth({ date: '2026-03-31', totalCents: 5_000_000 }),
        netWorthHistory: [{ date: '2026-03-31', totalCents: 5_000_000 }],
      }),
    )
    expect(codes(sameDay)).not.toContain('net_worth_high')

    const first = householdSignals(input({ netWorth: netWorth(), netWorthHistory: [] }))
    expect(codes(first)).not.toContain('net_worth_high')
  })

  it('stays quiet below a previous high', () => {
    const signals = householdSignals(
      input({
        netWorth: netWorth({ totalCents: 4_900_000 }),
        netWorthHistory: [{ date: '2026-02-28', totalCents: 5_100_000 }],
      }),
    )
    expect(codes(signals)).not.toContain('net_worth_high')
  })
})

describe('household ordering', () => {
  it('puts the alert first and the good news last', () => {
    const signals = householdSignals(
      input({
        totals: totals({ incomeCents: 400_000, spentCents: 380_000 }),
        incomeHistory: series('2026-03', 6, (index) => (index === 5 ? 400_000 : 300_000)),
        netWorth: netWorth({ liquidCents: 100_000 }),
        netWorthHistory: [{ date: '2026-02-28', totalCents: 1_000 }],
      }),
    )
    // Severity first: the cushion alert, then the two warnings, then the record.
    // The two warnings report the same magnitude here (both peak at the 4000,00
    // income), so their relative order is just the order they were produced in.
    expect(codes(signals)[0]).toBe('emergency_fund_short')
    expect(codes(signals).slice(1, 3).sort()).toEqual(['income_change', 'savings_rate_low'])
    expect(codes(signals)[3]).toBe('net_worth_high')
  })
})
