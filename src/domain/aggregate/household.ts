/**
 * The four questions that are about the household rather than any one envelope:
 * how much is being kept, how long the cushion would last, whether income moved,
 * and whether net worth just did something worth noticing.
 *
 * Two rules run through all of it:
 *
 *  - **A ratio with a zero denominator is not a finding.** No income this month
 *    means the salary landed on the 1st of the next one, not that the savings
 *    rate is minus infinity. Those cases return nothing.
 *  - **The cushion is measured against typical spend, not this month's.** A month
 *    with an annual insurance premium in it would otherwise shorten the emergency
 *    fund by weeks on paper, which is precisely backwards — that premium was
 *    always going to be paid.
 *
 * Pure. Every series arrives dense and ascending from the caller.
 */
import { ewma, type MonthValue } from './baseline.ts'
import type { NetWorthResult } from './networth.ts'
import type { AggregateParams } from './params.ts'
import type { Signal } from './overspend.ts'
import { capSeverity } from '../ai/codes.ts'
import { sortSignals } from './overspend.ts'
import { assertDenseMonths } from '../../util/month.ts'
import type { MonthTotals } from './spend.ts'

export interface HouseholdInput {
  /** The month being judged. Must be the last entry of both series. */
  month: string
  totals: MonthTotals
  /** Total income per month, dense and ascending, ending at `month`. */
  incomeHistory: readonly MonthValue[]
  /** Total spend per month, same shape. Feeds the emergency-fund denominator. */
  spendHistory: readonly MonthValue[]
  netWorth: NetWorthResult | null
  /**
   * Every earlier net worth figure, any order. Used only for "is this a new
   * high" — an empty history means the first run says nothing, rather than
   * congratulating the user on a record set by having no previous record.
   */
  netWorthHistory: readonly { date: string; totalCents: number }[]
  params: AggregateParams
}

/** Household signals carry no category, so this keeps the shape honest. */
function householdSignal(
  code: Signal['code'],
  severity: Signal['severity'],
  metrics: Record<string, number>,
): Signal {
  return {
    code,
    categoryId: null,
    categoryName: null,
    severity: capSeverity(code, severity),
    metrics,
  }
}

export function householdSignals(input: HouseholdInput): Signal[] {
  const { params, totals } = input
  const signals: Signal[] = []

  assertDenseMonths(
    input.incomeHistory.map((entry) => entry.month),
    'income history',
  )
  assertDenseMonths(
    input.spendHistory.map((entry) => entry.month),
    'spend history',
  )

  // --- savings rate -------------------------------------------------------
  if (totals.savingsRateBp !== null) {
    const target = params.household.savingsRateTargetBp
    if (totals.savingsRateBp < target) {
      signals.push(
        householdSignal('savings_rate_low', 'warn', {
          rateBp: totals.savingsRateBp,
          targetBp: target,
          shortfallBp: target - totals.savingsRateBp,
          incomeCents: totals.incomeCents,
        }),
      )
    } else {
      // Good news, and the only positive reinforcement in the whole panel.
      signals.push(
        householdSignal('savings_rate_up', 'info', {
          rateBp: totals.savingsRateBp,
          targetBp: target,
          deltaBp: totals.savingsRateBp - target,
          savedCents: totals.incomeCents - totals.spentCents,
        }),
      )
    }
  }

  // --- income change ------------------------------------------------------
  // Judged against the EWMA of previous months, so a bonus reads as a change and
  // a raise reads as a change once — not as a permanent anomaly.
  const previousIncome = input.incomeHistory.slice(0, -1).map((entry) => entry.cents)
  if (previousIncome.length >= params.baseline.minMonths) {
    const baselineCents = Math.round(ewma(previousIncome, params.baseline.halfLifeMonths))
    if (baselineCents > 0) {
      const deltaBp = Math.round(
        ((totals.incomeCents - baselineCents) / baselineCents) * 10_000,
      )
      // Symmetric threshold, reusing the category one: whichever direction income
      // moves by a fifth, it changes what every other number here means.
      if (Math.abs(deltaBp) >= params.overspend.baselineWarnBp) {
        signals.push(
          householdSignal('income_change', 'warn', {
            deltaBp,
            baselineCents,
            currentCents: totals.incomeCents,
            changeCents: totals.incomeCents - baselineCents,
          }),
        )
      }
    }
  }

  // --- emergency fund -----------------------------------------------------
  // Needs both a cushion to measure and something to measure it against: with no
  // spend history there is no denominator, and `ewma` of nothing is an error
  // rather than a zero.
  if (input.netWorth && input.spendHistory.length > 0) {
    const typicalSpend = Math.round(
      ewma(
        input.spendHistory.map((entry) => entry.cents),
        params.baseline.halfLifeMonths,
      ),
    )
    if (typicalSpend > 0) {
      // Basis points of a month, so "2.4 months" survives being an integer.
      const monthsBp = Math.round((input.netWorth.liquidCents / typicalSpend) * 10_000)
      const targetBp = Math.round(params.household.emergencyFundTargetMonths * 10_000)
      if (monthsBp < targetBp) {
        signals.push(
          householdSignal('emergency_fund_short', 'alert', {
            monthsBp,
            targetBp,
            liquidCents: input.netWorth.liquidCents,
            typicalSpendCents: typicalSpend,
            shortfallCents: Math.round(
              (typicalSpend * (targetBp - monthsBp)) / 10_000,
            ),
          }),
        )
      }
    }
  }

  // --- net worth high -----------------------------------------------------
  if (input.netWorth) {
    const current = input.netWorth
    // Strictly earlier: today's own snapshot is in the table by the time this
    // runs, and comparing a figure against itself never yields a record.
    const earlier = input.netWorthHistory.filter((entry) => entry.date < current.date)
    if (earlier.length > 0) {
      const previousHigh = Math.max(...earlier.map((entry) => entry.totalCents))
      if (current.totalCents > previousHigh) {
        signals.push(
          householdSignal('net_worth_high', 'info', {
            amountCents: current.totalCents,
            previousHighCents: previousHigh,
            gainCents: current.totalCents - previousHigh,
          }),
        )
      }
    }
  }

  return sortSignals(signals)
}
