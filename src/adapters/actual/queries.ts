/**
 * Reads from Actual. Everything here is validated before it is believed.
 *
 * Two rules earn their keep:
 *
 * **1. Actual's own numbers win.** `getBudgetMonth` returns the budgeted,
 * spent and available figures straight out of Actual's budget spreadsheet, so
 * using them makes "every category total agrees with Actual's UI" true by
 * construction rather than something to chase. Our AQL sum runs alongside only
 * as a cross-check (`recomputedSpentCents`); a disagreement is reported as a
 * data-quality problem instead of silently replacing their figure with ours.
 *
 * **2. `aqlQuery` returns `unknown`.** Actual's API types the AQL result as
 * `unknown` and the budget-month categories as loose records, so every shape is
 * parsed with Zod. A schema failure names the query, because "cannot read
 * property of undefined" three layers up costs an afternoon.
 */
import { z } from 'zod'
import type { Query } from '@actual-app/core/shared/query'
import { withActual } from './client.ts'

// ---------------------------------------------------------------------------
//  Plumbing
// ---------------------------------------------------------------------------

/** AQL always answers `{data, dependencies}`. */
function aqlResult<T extends z.ZodTypeAny>(row: T) {
  return z.object({ data: z.array(row) })
}

async function runAql<T>(
  label: string,
  build: (q: (table: string) => Query) => Query,
  row: z.ZodType<T>,
): Promise<T[]> {
  const raw = await withActual((actual) => actual.aqlQuery(build(actual.q)))
  const parsed = aqlResult(row).safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `Actual query "${label}" returned an unexpected shape: ${z.prettifyError(parsed.error)}`,
    )
  }
  return parsed.data.data as T[]
}

/**
 * Actual stores money as integer cents already, so no float ever appears —
 * but the AQL layer types amounts as `float`, and a stray decimal would round
 * silently later. Reject it here instead.
 */
const cents = z.number().int()

// ---------------------------------------------------------------------------
//  Reference data
// ---------------------------------------------------------------------------

const accountRow = z.object({
  id: z.string(),
  name: z.string(),
  offbudget: z.boolean(),
  closed: z.boolean(),
  /**
   * Read here rather than from `getAccounts()`, which does not expose it. It is
   * what makes the "not reconciled in N days" hygiene signal possible without
   * an aggregate — AQL has no `$max`.
   */
  last_reconciled: z.string().nullable(),
})
export type ActualAccount = z.infer<typeof accountRow>

export function fetchAccounts(): Promise<ActualAccount[]> {
  return runAql(
    'accounts',
    (q) =>
      q('accounts').select(['id', 'name', 'offbudget', 'closed', 'last_reconciled']),
    accountRow,
  )
}

const categoryRow = z.object({
  id: z.string(),
  name: z.string(),
  is_income: z.boolean(),
  hidden: z.boolean(),
  group: z.string().nullable(),
})
export type ActualCategory = z.infer<typeof categoryRow>

/** Includes hidden categories: they still hold history worth analysing. */
export function fetchCategories(): Promise<ActualCategory[]> {
  return runAql(
    'categories',
    (q) => q('categories').select(['id', 'name', 'is_income', 'hidden', 'group']),
    categoryRow,
  )
}

const categoryGroupRow = z.object({
  id: z.string(),
  name: z.string(),
  is_income: z.boolean(),
  hidden: z.boolean(),
})
export type ActualCategoryGroup = z.infer<typeof categoryGroupRow>

export function fetchCategoryGroups(): Promise<ActualCategoryGroup[]> {
  return runAql(
    'category_groups',
    (q) => q('category_groups').select(['id', 'name', 'is_income', 'hidden']),
    categoryGroupRow,
  )
}

// ---------------------------------------------------------------------------
//  Budget months — Actual's own figures
// ---------------------------------------------------------------------------

/**
 * Per-category budget figures, all in cents.
 *
 * `spent` is negative for expenses and `received` positive for income, exactly
 * as Actual reports them; `spentCents` below normalises so spend is positive.
 */
const budgetCategory = z
  .object({
    id: z.string(),
    name: z.string(),
    is_income: z.boolean(),
    hidden: z.boolean(),
    budgeted: z.number().int().optional(),
    spent: z.number().int().optional(),
    received: z.number().int().optional(),
    balance: z.number().int().optional(),
    /** Whether overspending rolls into next month — a flag, not an amount. */
    carryover: z.union([z.boolean(), z.number()]).optional(),
  })
  // Actual adds fields over time; extra keys must not fail the parse.
  .loose()

const budgetMonthShape = z.object({
  month: z.string(),
  totalIncome: z.number().int(),
  totalSpent: z.number().int(),
  totalBudgeted: z.number().int(),
  toBudget: z.number().int(),
  fromLastMonth: z.number().int(),
  totalBalance: z.number().int(),
  categoryGroups: z.array(
    z.object({ id: z.string(), name: z.string(), is_income: z.boolean() })
      .extend({ categories: z.array(budgetCategory).default([]) })
      .loose(),
  ),
})

export interface CategoryMonth {
  month: string
  categoryId: string
  categoryName: string
  isIncome: boolean
  hidden: boolean
  /** Positive = money out for expenses, money in for income. */
  spentCents: number
  budgetedCents: number
  /** Actual's `balance`. Negative means the envelope is overspent. */
  availableCents: number
  carryoverEnabled: boolean
}

export interface BudgetMonth {
  month: string
  totalIncomeCents: number
  totalSpentCents: number
  totalBudgetedCents: number
  /** Left unassigned. Negative means more was assigned than exists. */
  toBudgetCents: number
  fromLastMonthCents: number
  totalBalanceCents: number
  categories: CategoryMonth[]
}

export async function fetchBudgetMonth(month: string): Promise<BudgetMonth> {
  const raw = await withActual((actual) => actual.getBudgetMonth(month))
  const parsed = budgetMonthShape.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `Actual getBudgetMonth("${month}") returned an unexpected shape: ` +
        z.prettifyError(parsed.error),
    )
  }
  const data = parsed.data

  const categories: CategoryMonth[] = []
  for (const group of data.categoryGroups) {
    for (const category of group.categories) {
      // Income categories carry `received`; expenses carry a negative `spent`.
      // In envelope mode income has no budgeted/balance at all, hence the zeros.
      const activity = category.is_income
        ? (category.received ?? 0)
        : -(category.spent ?? 0)
      categories.push({
        month: data.month,
        categoryId: category.id,
        categoryName: category.name,
        isIncome: category.is_income,
        hidden: category.hidden,
        spentCents: activity,
        budgetedCents: category.budgeted ?? 0,
        availableCents: category.balance ?? 0,
        carryoverEnabled: Boolean(category.carryover),
      })
    }
  }

  return {
    month: data.month,
    totalIncomeCents: data.totalIncome,
    totalSpentCents: -data.totalSpent,
    totalBudgetedCents: data.totalBudgeted,
    toBudgetCents: data.toBudget,
    fromLastMonthCents: data.fromLastMonth,
    totalBalanceCents: data.totalBalance,
    categories,
  }
}

/** Months Actual holds a budget for, ascending. Bounds every backfill. */
export function fetchBudgetMonths(): Promise<string[]> {
  return withActual((actual) => actual.getBudgetMonths())
}

// ---------------------------------------------------------------------------
//  Cross-check aggregate
// ---------------------------------------------------------------------------

const monthCategoryRow = z.object({
  month: z.string(),
  category: z.string().nullable(),
  amount: cents.nullable(),
  count: z.number().int(),
})
export interface RecomputedSpend {
  month: string
  /** Null is the uncategorised bucket, which is the hygiene backlog. */
  categoryId: string | null
  /** Signed, as Actual stores it: negative for expenses. */
  amountCents: number
  txnCount: number
}

/**
 * Our own monthly sum per category, for comparison against Actual's figures.
 *
 * The hygiene rules live in this filter, and each clause is deliberate:
 *  - `transfer_id: null` drops both legs of every transfer, which is also what
 *    stops a credit-card payment being counted as spending.
 *  - `starting_balance_flag: false` drops the opening balance, which is not spend.
 *  - `account.offbudget: false` keeps off-budget accounts out of budget figures;
 *    they still count toward net worth, which is computed elsewhere.
 *  - splits need no clause: AQL's default `splits: 'inline'` already filters
 *    `is_parent = 0`, so children are counted and the parent is not. Do not
 *    "fix" this by passing `splits: 'all'` — that double-counts every split.
 *  - refunds need no clause either: summing signed amounts nets them off.
 */
export function fetchRecomputedSpend(
  from: string,
  to: string,
): Promise<RecomputedSpend[]> {
  return runAql(
    'recomputed-spend',
    (q) =>
      q('transactions')
        .filter({
          date: { $gte: from, $lte: to },
          transfer_id: null,
          starting_balance_flag: false,
          'account.offbudget': false,
        })
        .groupBy([{ $month: '$date' }, 'category'])
        .select([
          { month: { $month: '$date' } },
          'category',
          { amount: { $sum: '$amount' } },
          { count: { $count: '$id' } },
        ]),
    monthCategoryRow,
  ).then((rows) =>
    rows.map((row) => ({
      month: row.month,
      categoryId: row.category,
      amountCents: row.amount ?? 0,
      txnCount: row.count,
    })),
  )
}

// ---------------------------------------------------------------------------
//  Balances — Actual's own computation, for net worth
// ---------------------------------------------------------------------------

export interface AccountBalance {
  accountId: string
  balanceCents: number
}

/**
 * Balances as of `asOf`, from `getAccountBalance`.
 *
 * Deliberately not an AQL sum of our own: this is Actual's own function
 * (`sum(amount) where isParent = 0 and date <= cutoff`), so the figure matches
 * their UI. Two implementations that can disagree is the problem, not the fix.
 * Note the filters here are the *opposite* of the spend query above — transfers
 * and starting balances belong in a balance and must not be excluded.
 */
export function fetchAccountBalances(
  accountIds: string[],
  asOf: Date,
): Promise<AccountBalance[]> {
  return withActual(async (actual) => {
    const out: AccountBalance[] = []
    for (const accountId of accountIds) {
      out.push({
        accountId,
        balanceCents: await actual.getAccountBalance(accountId, asOf),
      })
    }
    return out
  })
}

// ---------------------------------------------------------------------------
//  Hygiene
// ---------------------------------------------------------------------------

const coverageRow = z.object({ date: z.string() })

/** Earliest and latest on-budget transaction, or null on an empty budget. */
export async function fetchTransactionDateRange(): Promise<{
  first: string | null
  last: string | null
}> {
  const edge = async (order: 'asc' | 'desc'): Promise<string | null> => {
    const rows = await runAql(
      `transaction-range-${order}`,
      (q) =>
        q('transactions')
          .filter({ starting_balance_flag: false })
          .orderBy({ date: order })
          .select(['date'])
          .limit(1),
      coverageRow,
    )
    return rows[0]?.date ?? null
  }
  return { first: await edge('asc'), last: await edge('desc') }
}
