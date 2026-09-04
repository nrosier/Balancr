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

// ---------------------------------------------------------------------------
//  Schedules — what is still to come (#159)
// ---------------------------------------------------------------------------

/**
 * Reads, like everything else here. The three writers `@actual-app/api` offers for
 * schedules — `createSchedule`, `updateSchedule`, `deleteSchedule` — are named in the
 * denylist in `test/unit/actual-adapter.test.ts`, which scans this file's source, so
 * "v1 never writes to Actual" stays enforced rather than intended.
 *
 * Three decisions worth knowing about:
 *
 * **The parse is the privacy boundary.** A schedule carries `name` ("Netflix"), a
 * payee id and an account id, and none of them is a field this application has any use
 * for: the figure it produces is a per-category total. `scheduleShape` is a plain
 * `z.object`, so Zod *strips* every key not listed — those three included — and nothing
 * downstream, the AI bundle least of all, can carry what was never mapped. This is why
 * the shape is deliberately not `.loose()` like the budget rows above it.
 *
 * **A range counts at its upper bound, not its middle.** Actual's own
 * `getScheduledAmount` averages `{num1, num2}`, which is the right answer for the "next
 * up" list in its sidebar and the wrong one for "can this envelope still take what is
 * coming": an average understates the cost half the time, and the half it understates
 * is the half worth a warning. `Math.min` in Actual's sign convention — negative is
 * money out — is the larger cost, and `approximate` is on the row so every screen that
 * prints the figure can say the amount was not exact (#159).
 *
 * **A category comes from the schedule's own rule, or not at all.** Actual keeps the
 * category as a `set` action on the rule a schedule owns, so that link is a fact. Rules
 * that merely match a payee are *not* consulted: they would attribute money to an
 * envelope by inference, and #159 rules that out — an unmatched schedule is counted in
 * the month total and shown as unallocated instead.
 */

const recurPatternType = z.enum(['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'day'])

/** Actual's `RecurPattern`: "the 2nd Tuesday" is `{value: 2, type: 'TU'}`. */
export type RecurPatternType = z.infer<typeof recurPatternType>

const recurConfigShape = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().positive().optional(),
  patterns: z.array(z.object({ value: z.number().int(), type: recurPatternType })).optional(),
  skipWeekend: z.boolean().optional(),
  start: z.string(),
  endMode: z.enum(['never', 'after_n_occurrences', 'on_date']).optional(),
  endOccurrences: z.number().int().nonnegative().optional(),
  endDate: z.string().optional(),
  weekendSolveMode: z.enum(['before', 'after']).optional(),
})

/**
 * A recurrence with every default already applied.
 *
 * Normalised here rather than in the expander, so that "no `interval` means every
 * one" is decided at the boundary where Actual's shape is still in view, and the pure
 * module downstream has no optionality left to guess about.
 */
export interface ScheduleRecurrence {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  /** Every nth period. 1 unless the schedule says otherwise. */
  interval: number
  /** Monthly and yearly only: days of the month and nth-weekdays. */
  patterns: readonly { value: number; type: RecurPatternType }[]
  skipWeekend: boolean
  /** Which way a weekend date moves. Actual throws on a third value; we default. */
  weekendSolveMode: 'before' | 'after'
  /** `YYYY-MM-DD`. The anchor every occurrence is counted from. */
  start: string
  endMode: 'never' | 'after_n_occurrences' | 'on_date'
  /** Only meaningful for `after_n_occurrences`. */
  endOccurrences: number | null
  /** Only meaningful for `on_date`. */
  endDate: string | null
}

/** A schedule happens once on a date, or repeats. */
export type ScheduleDate =
  | { kind: 'once'; date: string }
  | { kind: 'recurring'; recurrence: ScheduleRecurrence }

export interface ActualSchedule {
  id: string
  /** The category the schedule's own rule assigns, or null when no rule does. */
  categoryId: string | null
  /** Actual's sign: negative is money out. The upper bound when the amount is a range. */
  amountCents: number
  /** True when the amount is a range or an approximation rather than a figure. */
  approximate: boolean
  /** A completed schedule is not coming again, whatever its dates say. */
  completed: boolean
  /**
   * Whether Actual posts the transaction itself.
   *
   * Deliberately not a filter: one that does not post automatically is still an
   * expected cost and still counts. It is carried because the distinction is real —
   * a posting schedule turns into spend on the day, a manual one waits for somebody.
   */
  postsTransaction: boolean
  /** Actual's own next occurrence, for the cross-check in the expander. */
  nextDate: string | null
  date: ScheduleDate
}

const scheduleAmountShape = z.union([
  z.number().int(),
  z.object({ num1: z.number().int(), num2: z.number().int() }),
])

const scheduleShape = z.object({
  id: z.string(),
  amount: scheduleAmountShape.optional(),
  amountOp: z.enum(['is', 'isapprox', 'isbetween']),
  date: z.union([z.string(), recurConfigShape]),
  next_date: z.string().optional(),
  completed: z.boolean().optional(),
  posts_transaction: z.boolean().optional(),
  /** The id of the rule this schedule owns, which is where its category lives. */
  rule: z.string().optional(),
  /** Actual soft-deletes; a tombstoned schedule is gone even if it comes back. */
  tombstone: z.boolean().optional(),
})

const ruleShape = z.object({
  id: z.string(),
  /**
   * `conditions` is absent on purpose, and the strip is what removes it: a rule's
   * conditions are the payee and account matchers, which is exactly the text this
   * application has no business holding.
   */
  actions: z.array(
    // `field` is `nullish` rather than just `optional`: Actual sends an explicit
    // `null` (not a missing key) on actions where a field doesn't apply — a
    // `link-schedule` action, for instance, has none to set.
    z.object({ op: z.string(), field: z.string().nullish(), value: z.unknown() }),
  ),
  tombstone: z.boolean().optional(),
})

type ParsedRule = z.infer<typeof ruleShape>

/**
 * Rule id → the category that rule sets.
 *
 * Exported for its test: this one link is the whole of schedule attribution, and a
 * silent miss here would move a bill into the unallocated line rather than fail.
 */
export function scheduleCategories(rules: readonly ParsedRule[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const rule of rules) {
    if (rule.tombstone === true) continue
    for (const action of rule.actions) {
      if (action.op !== 'set' || action.field !== 'category') continue
      // `value` is `unknown` in Actual's own types and is legitimately null for
      // "set the category to nothing", which is not an attribution.
      if (typeof action.value === 'string' && action.value !== '') out.set(rule.id, action.value)
    }
  }
  return out
}

/** The upper bound of a scheduled cost, in Actual's sign convention. */
function scheduledAmount(amount: z.infer<typeof scheduleAmountShape> | undefined): number {
  if (amount === undefined) return 0
  if (typeof amount === 'number') return amount
  return Math.min(amount.num1, amount.num2)
}

function toRecurrence(config: z.infer<typeof recurConfigShape>): ScheduleRecurrence {
  return {
    frequency: config.frequency,
    interval: config.interval ?? 1,
    patterns: config.patterns ?? [],
    skipWeekend: config.skipWeekend ?? false,
    weekendSolveMode: config.weekendSolveMode ?? 'after',
    start: config.start,
    endMode: config.endMode ?? 'never',
    endOccurrences: config.endOccurrences ?? null,
    endDate: config.endDate ?? null,
  }
}

/**
 * Every live schedule, with its category resolved and its identity left behind.
 *
 * One `withActual` call for both reads, because the two have to agree: a rule list
 * fetched after a sync that changed a schedule's category would attribute this month's
 * bill to last month's envelope.
 */
export async function fetchSchedules(): Promise<ActualSchedule[]> {
  const raw = await withActual(async (actual) => ({
    schedules: await actual.getSchedules(),
    rules: await actual.getRules(),
  }))

  const schedules = z.array(scheduleShape).safeParse(raw.schedules)
  if (!schedules.success) {
    throw new Error(
      `Actual "getSchedules" returned an unexpected shape: ${z.prettifyError(schedules.error)}`,
    )
  }
  const rules = z.array(ruleShape).safeParse(raw.rules)
  if (!rules.success) {
    throw new Error(
      `Actual "getRules" returned an unexpected shape: ${z.prettifyError(rules.error)}`,
    )
  }

  const categories = scheduleCategories(rules.data)

  return schedules.data
    .filter((schedule) => schedule.tombstone !== true)
    .map((schedule) => ({
      id: schedule.id,
      categoryId: (schedule.rule === undefined ? null : categories.get(schedule.rule)) ?? null,
      amountCents: scheduledAmount(schedule.amount),
      approximate: schedule.amountOp !== 'is',
      completed: schedule.completed ?? false,
      postsTransaction: schedule.posts_transaction ?? false,
      nextDate: schedule.next_date ?? null,
      date:
        typeof schedule.date === 'string'
          ? { kind: 'once' as const, date: schedule.date }
          : { kind: 'recurring' as const, recurrence: toRecurrence(schedule.date) },
    }))
}
