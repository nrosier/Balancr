/**
 * Turns what the adapters returned into one dense, comparable fact per
 * (month, category).
 *
 * Three things make this more than a reshape:
 *
 *  1. **Density.** Every category gets a row for every month in the window,
 *     including the months it saw no activity. A month with no transactions is a
 *     real zero, and the baseline engine refuses a series with holes in it — a
 *     rolling window over a gap silently averages across it.
 *  2. **Two columns for the same number.** `spentCents` is Actual's own figure
 *     and is the source of truth; `recomputedSpentCents` is our AQL sum of the
 *     same month. They must agree. Keeping both and reporting the difference is
 *     how a wrong hygiene rule announces itself, instead of quietly feeding every
 *     baseline and finding downstream.
 *  3. **Sign.** Actual stores expenses negative; the fact table stores spend
 *     positive-out for expenses and positive-in for income, so those two columns
 *     are directly comparable and no chart has to know the difference.
 *
 * Pure: no database, no clock, no Actual. The caller fetches, this decides.
 */
import type { BudgetMonth, CategoryMonth, RecomputedSpend } from '../../adapters/actual/queries.ts'
import { assertDenseMonths } from '../../util/month.ts'
import {
  computeBaseline,
  type BaselineResult,
  type ExpectedFrequency,
  type MonthValue,
} from './baseline.ts'
import type { AggregateParams } from './params.ts'

export interface SpendInput {
  /**
   * Dense, ascending budget months. Must reach back far enough for the widest
   * baseline window in play — an annual category needs twelve months of history
   * *before* the month being judged, or its baseline comes back null.
   */
  history: readonly BudgetMonth[]
  /** Our own AQL sum, any order, one or more rows per (month, category). */
  recomputed: readonly RecomputedSpend[]
  /** From `category_meta`. A category not listed here is treated as monthly. */
  frequencies: ReadonlyMap<string, ExpectedFrequency>
  /** Months to emit facts for. Must all appear in `history`. */
  targetMonths: readonly string[]
  params: AggregateParams
}

export interface MonthlyFact {
  month: string
  categoryId: string
  /** Latest name seen across the window, so a rename does not fork the series. */
  categoryName: string
  isIncome: boolean
  hidden: boolean
  /** Positive-out for expenses, positive-in for income. Actual's own figure. */
  spentCents: number
  budgetedCents: number
  /** Actual's `balance`. Negative means the envelope is overspent. */
  availableCents: number
  carryoverEnabled: boolean
  txnCount: number
  /** Same scale as `spentCents`, or null when no AQL row covered the month. */
  recomputedSpentCents: number | null
  /** Null when there is not enough history to state a norm. */
  baseline: BaselineResult | null
}

export interface UncategorisedBucket {
  month: string
  txnCount: number
  /**
   * Positive-out, matching `MonthlyFact.spentCents`. Negative therefore means
   * the uncategorised backlog is net money *in* — usually an unassigned refund,
   * or a transfer the hygiene filter could not pair up.
   */
  amountCents: number
}

export interface RecomputeMismatch {
  month: string
  categoryId: string
  categoryName: string
  /** Actual's figure. */
  actualCents: number
  /** Ours. */
  recomputedCents: number
  /** `recomputed - actual`, signed so the direction of the drift is visible. */
  differenceCents: number
}

export interface MonthTotals {
  month: string
  incomeCents: number
  spentCents: number
  budgetedCents: number
  toBudgetCents: number
  fromLastMonthCents: number
  balanceCents: number
  /**
   * `(income - spend) / income` in basis points, or null in a month with no
   * income — a savings rate on a zero denominator is not "minus infinity", it is
   * a month whose salary landed on the 1st of the next one.
   */
  savingsRateBp: number | null
}

export interface SpendAggregate {
  facts: MonthlyFact[]
  uncategorised: UncategorisedBucket[]
  mismatches: RecomputeMismatch[]
  totals: MonthTotals[]
}

interface CategoryDimension {
  name: string
  isIncome: boolean
  hidden: boolean
}

/** Actual's sign convention to ours. */
function toPositiveOut(amountCents: number, isIncome: boolean): number {
  return isIncome ? amountCents : -amountCents
}

const cellKey = (month: string, categoryId: string): string => `${month}:${categoryId}`

export function aggregateSpend(input: SpendInput): SpendAggregate {
  const { history, params } = input
  assertDenseMonths(
    history.map((month) => month.month),
    'budget history',
  )

  const months = history.map((month) => month.month)
  const monthIndex = new Map(months.map((month, index) => [month, index]))
  const targets = [...input.targetMonths].sort()
  for (const target of targets) {
    if (!monthIndex.has(target)) {
      throw new Error(`budget history does not contain target month ${target}`)
    }
  }

  // Ascending iteration, last write wins: the dimension carries the *latest*
  // name, so a category renamed in July stays one series instead of becoming two.
  const dimensions = new Map<string, CategoryDimension>()
  const byMonth = new Map<string, Map<string, CategoryMonth>>()
  for (const month of history) {
    const categories = new Map<string, CategoryMonth>()
    for (const category of month.categories) {
      categories.set(category.categoryId, category)
      dimensions.set(category.categoryId, {
        name: category.categoryName,
        isIncome: category.isIncome,
        hidden: category.hidden,
      })
    }
    byMonth.set(month.month, categories)
  }

  // Accumulated rather than assigned: the query groups by (month, category)
  // today, but if that grouping ever changes this should show up as a wrong
  // total rather than as a silently dropped row.
  const recomputedCents = new Map<string, number>()
  const recomputedCounts = new Map<string, number>()
  const uncategorised = new Map<string, UncategorisedBucket>()

  for (const row of input.recomputed) {
    if (row.categoryId === null) {
      const bucket = uncategorised.get(row.month) ?? {
        month: row.month,
        txnCount: 0,
        amountCents: 0,
      }
      bucket.txnCount += row.txnCount
      bucket.amountCents += toPositiveOut(row.amountCents, false)
      uncategorised.set(row.month, bucket)
      continue
    }

    const dimension = dimensions.get(row.categoryId)
    // A category present in the ledger but in none of these budget months has
    // nothing to be compared against, so a mismatch on it would be noise.
    if (!dimension) continue

    const cell = cellKey(row.month, row.categoryId)
    recomputedCents.set(
      cell,
      (recomputedCents.get(cell) ?? 0) + toPositiveOut(row.amountCents, dimension.isIncome),
    )
    recomputedCounts.set(cell, (recomputedCounts.get(cell) ?? 0) + row.txnCount)
  }

  // One dense series per category, built once and sliced per target month.
  const series = new Map<string, MonthValue[]>()
  for (const categoryId of dimensions.keys()) {
    series.set(
      categoryId,
      months.map((month) => ({
        month,
        cents: byMonth.get(month)?.get(categoryId)?.spentCents ?? 0,
      })),
    )
  }

  const facts: MonthlyFact[] = []
  const mismatches: RecomputeMismatch[] = []
  const categoryIds = [...dimensions.keys()].sort()

  for (const month of targets) {
    for (const categoryId of categoryIds) {
      const dimension = dimensions.get(categoryId) as CategoryDimension
      const cell = byMonth.get(month)?.get(categoryId)
      const recomputed = recomputedCents.get(cellKey(month, categoryId))

      // A hidden category absent from this month entirely would otherwise pad
      // every month with rows nobody will ever look at.
      if (!cell && recomputed === undefined && dimension.hidden) continue

      const spentCents = cell?.spentCents ?? 0

      facts.push({
        month,
        categoryId,
        categoryName: dimension.name,
        isIncome: dimension.isIncome,
        hidden: dimension.hidden,
        spentCents,
        budgetedCents: cell?.budgetedCents ?? 0,
        availableCents: cell?.availableCents ?? 0,
        carryoverEnabled: cell?.carryoverEnabled ?? false,
        txnCount: recomputedCounts.get(cellKey(month, categoryId)) ?? 0,
        recomputedSpentCents: recomputed ?? null,
        baseline: computeBaseline(
          series.get(categoryId) as MonthValue[],
          month,
          input.frequencies.get(categoryId) ?? 'monthly',
          params.baseline,
        ),
      })

      if (recomputed === undefined) continue
      const differenceCents = recomputed - spentCents
      if (Math.abs(differenceCents) > params.hygiene.recomputationToleranceCents) {
        mismatches.push({
          month,
          categoryId,
          categoryName: dimension.name,
          actualCents: spentCents,
          recomputedCents: recomputed,
          differenceCents,
        })
      }
    }
  }

  const totals: MonthTotals[] = targets.map((month) => {
    const budgetMonth = history[monthIndex.get(month) as number] as BudgetMonth
    const incomeCents = budgetMonth.totalIncomeCents
    return {
      month,
      incomeCents,
      spentCents: budgetMonth.totalSpentCents,
      budgetedCents: budgetMonth.totalBudgetedCents,
      toBudgetCents: budgetMonth.toBudgetCents,
      fromLastMonthCents: budgetMonth.fromLastMonthCents,
      balanceCents: budgetMonth.totalBalanceCents,
      savingsRateBp:
        incomeCents > 0
          ? Math.round(((incomeCents - budgetMonth.totalSpentCents) / incomeCents) * 10_000)
          : null,
    }
  })

  return {
    facts,
    uncategorised: targets.flatMap((month) => {
      const bucket = uncategorised.get(month)
      return bucket ? [bucket] : []
    }),
    mismatches,
    totals,
  }
}
