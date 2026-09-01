/**
 * Budget-month fixtures in Actual's shape.
 *
 * Totals are derived from the rows rather than typed in, because a fixture whose
 * total disagrees with its own categories tests nothing except the fixture. The
 * `totals` override exists for the cases that deliberately want that
 * disagreement — an unassigned surplus, a carry-in from last month.
 */
import type { BudgetMonth, CategoryMonth } from '../../src/adapters/actual/queries.ts'
import { addMonths } from '../../src/util/month.ts'

export interface CategoryRow {
  id: string
  name?: string
  /** Positive-out for expenses, positive-in for income, as Actual reports it. */
  spent?: number
  budgeted?: number
  /** Actual's `balance`. Defaults to `budgeted - spent`, i.e. no carry-in. */
  available?: number
  isIncome?: boolean
  hidden?: boolean
  carryover?: boolean
}

export function category(month: string, row: CategoryRow): CategoryMonth {
  const spentCents = row.spent ?? 0
  const budgetedCents = row.budgeted ?? 0
  return {
    month,
    categoryId: row.id,
    categoryName: row.name ?? row.id,
    isIncome: row.isIncome ?? false,
    hidden: row.hidden ?? false,
    spentCents,
    budgetedCents,
    availableCents: row.available ?? budgetedCents - spentCents,
    carryoverEnabled: row.carryover ?? false,
  }
}

export function budgetMonth(
  month: string,
  rows: readonly CategoryRow[],
  totals: Partial<Omit<BudgetMonth, 'month' | 'categories'>> = {},
): BudgetMonth {
  const categories = rows.map((row) => category(month, row))
  const income = categories.filter((c) => c.isIncome)
  const expense = categories.filter((c) => !c.isIncome)
  const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0)

  return {
    month,
    totalIncomeCents: sum(income.map((c) => c.spentCents)),
    totalSpentCents: sum(expense.map((c) => c.spentCents)),
    totalBudgetedCents: sum(expense.map((c) => c.budgetedCents)),
    toBudgetCents: 0,
    fromLastMonthCents: 0,
    totalBalanceCents: sum(expense.map((c) => c.availableCents)),
    categories,
    ...totals,
  }
}

/**
 * `count` consecutive months from `start`, each built by `rows(month, index)`.
 * Dense by construction, which is what the aggregator demands.
 */
export function history(
  start: string,
  count: number,
  rows: (month: string, index: number) => readonly CategoryRow[],
): BudgetMonth[] {
  return Array.from({ length: count }, (_, index) => {
    const month = addMonths(start, index)
    return budgetMonth(month, rows(month, index))
  })
}
