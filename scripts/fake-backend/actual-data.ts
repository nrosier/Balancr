/**
 * A small but real-looking Actual budget for local dev (#391): a couple of
 * accounts, a category-group/category tree, ~2 years of transactions, and two
 * schedules with the rules that assign their category.
 *
 * Generated once and persisted to `data/fake-backend/actual.json` — under the
 * existing `/data/` gitignore rule — so numbers stay stable across restarts.
 * Writes from `updateTransaction`/`setBudgetAmount` (the two mutations
 * `queries.ts` performs) are written back to the same file. Delete it to
 * regenerate from scratch.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_PATH = fileURLToPath(new URL('../../data/fake-backend/actual.json', import.meta.url))

export interface FakeAccount {
  id: string
  name: string
  offbudget: boolean
  closed: boolean
  last_reconciled: string | null
}

export interface FakePayee {
  id: string
  name: string
}

export interface FakeCategoryGroup {
  id: string
  name: string
  is_income: boolean
  hidden: boolean
}

export interface FakeCategory {
  id: string
  name: string
  is_income: boolean
  hidden: boolean
  group: string
}

/** Actual's own sign convention: negative amount = money out, positive = money in. */
export interface FakeTransaction {
  id: string
  date: string
  amount: number
  category: string | null
  payee: string | null
  transfer_id: string | null
  starting_balance_flag: boolean
  account: string
  schedule: string | null
}

export interface FakeRuleAction {
  op: string
  field: string | null
  value: unknown
}

export interface FakeRule {
  id: string
  actions: FakeRuleAction[]
  tombstone: boolean
}

export interface FakeSchedule {
  id: string
  amount: number | { num1: number; num2: number }
  amountOp: 'is' | 'isapprox' | 'isbetween'
  date: string | { frequency: string; interval?: number; start: string }
  next_date?: string
  completed: boolean
  posts_transaction: boolean
  rule: string
  tombstone: boolean
}

export interface ActualDataset {
  accounts: FakeAccount[]
  payees: FakePayee[]
  categoryGroups: FakeCategoryGroup[]
  categories: FakeCategory[]
  transactions: FakeTransaction[]
  schedules: FakeSchedule[]
  rules: FakeRule[]
  /** Manual overrides from `setBudgetAmount`, keyed `${month}:${categoryId}`. */
  budgetOverrides: Record<string, number>
}

export const CHECKING = 'acc-checking'
export const SAVINGS = 'acc-savings'

export const CAT_PAYCHECK = 'cat-paycheck'
export const CAT_RENT = 'cat-rent'
export const CAT_UTILITIES = 'cat-utilities'
export const CAT_SUBSCRIPTIONS = 'cat-subscriptions'
export const CAT_GROCERIES = 'cat-groceries'
export const CAT_TRANSPORT = 'cat-transport'
export const CAT_DINING = 'cat-dining'
export const CAT_SHOPPING = 'cat-shopping'

const PAYEE_EMPLOYER = 'payee-employer'
const PAYEE_LANDLORD = 'payee-landlord'
const PAYEE_UTILITY = 'payee-utility'
const PAYEE_NETFLIX = 'payee-netflix'
const PAYEE_COLRUYT = 'payee-colruyt'
const PAYEE_DELHAIZE = 'payee-delhaize'
const PAYEE_NMBS = 'payee-nmbs'
const PAYEE_RESTAURANT = 'payee-restaurant'
const PAYEE_SHOP = 'payee-shop'

const MONTHS_OF_HISTORY = 24

function monthsBack(count: number): string[] {
  const out: string[] = []
  const cursor = new Date()
  cursor.setUTCDate(1)
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(cursor)
    d.setUTCMonth(d.getUTCMonth() - i)
    out.push(d.toISOString().slice(0, 7))
  }
  return out
}

function dateInMonth(month: string, day: number): string {
  return `${month}-${String(day).padStart(2, '0')}`
}

let nextId = 0
function id(prefix: string): string {
  nextId += 1
  return `${prefix}-${nextId}`
}

function jitter(base: number, spreadPercent: number): number {
  const spread = base * spreadPercent
  return Math.round(base + (Math.random() * 2 - 1) * spread)
}

/** Exported for `test/unit/fake-actual-api.test.ts`, which builds its own dataset rather than touching disk. */
export function generate(): ActualDataset {
  const accounts: FakeAccount[] = [
    { id: CHECKING, name: 'Checking', offbudget: false, closed: false, last_reconciled: null },
    { id: SAVINGS, name: 'Savings', offbudget: true, closed: false, last_reconciled: null },
  ]

  const payees: FakePayee[] = [
    { id: PAYEE_EMPLOYER, name: 'Employer BV' },
    { id: PAYEE_LANDLORD, name: 'Landlord' },
    { id: PAYEE_UTILITY, name: 'Electrabel' },
    { id: PAYEE_NETFLIX, name: 'Netflix' },
    { id: PAYEE_COLRUYT, name: 'Colruyt' },
    { id: PAYEE_DELHAIZE, name: 'Delhaize' },
    { id: PAYEE_NMBS, name: 'NMBS' },
    { id: PAYEE_RESTAURANT, name: 'Restaurant' },
    { id: PAYEE_SHOP, name: 'Zalando' },
  ]

  const categoryGroups: FakeCategoryGroup[] = [
    { id: 'grp-income', name: 'Income', is_income: true, hidden: false },
    { id: 'grp-fixed', name: 'Fixed costs', is_income: false, hidden: false },
    { id: 'grp-variable', name: 'Variable spending', is_income: false, hidden: false },
  ]

  const categories: FakeCategory[] = [
    { id: CAT_PAYCHECK, name: 'Paycheck', is_income: true, hidden: false, group: 'grp-income' },
    { id: CAT_RENT, name: 'Rent', is_income: false, hidden: false, group: 'grp-fixed' },
    { id: CAT_UTILITIES, name: 'Utilities', is_income: false, hidden: false, group: 'grp-fixed' },
    {
      id: CAT_SUBSCRIPTIONS,
      name: 'Subscriptions',
      is_income: false,
      hidden: false,
      group: 'grp-fixed',
    },
    { id: CAT_GROCERIES, name: 'Groceries', is_income: false, hidden: false, group: 'grp-variable' },
    { id: CAT_TRANSPORT, name: 'Transport', is_income: false, hidden: false, group: 'grp-variable' },
    { id: CAT_DINING, name: 'Dining out', is_income: false, hidden: false, group: 'grp-variable' },
    { id: CAT_SHOPPING, name: 'Shopping', is_income: false, hidden: false, group: 'grp-variable' },
  ]

  const months = monthsBack(MONTHS_OF_HISTORY)
  const transactions: FakeTransaction[] = []

  const rentScheduleId = 'sched-rent'
  const netflixScheduleId = 'sched-netflix'

  transactions.push({
    id: id('txn-open'),
    date: dateInMonth(months[0] ?? '2024-01', 1),
    amount: 350_000,
    category: null,
    payee: null,
    transfer_id: null,
    starting_balance_flag: true,
    account: CHECKING,
    schedule: null,
  })
  transactions.push({
    id: id('txn-open'),
    date: dateInMonth(months[0] ?? '2024-01', 1),
    amount: 1_200_000,
    category: null,
    payee: null,
    transfer_id: null,
    starting_balance_flag: true,
    account: SAVINGS,
    schedule: null,
  })

  for (const month of months) {
    transactions.push({
      id: id('txn'),
      date: dateInMonth(month, 1),
      amount: jitter(285_000, 0.03),
      category: CAT_PAYCHECK,
      payee: PAYEE_EMPLOYER,
      transfer_id: null,
      starting_balance_flag: false,
      account: CHECKING,
      schedule: null,
    })

    transactions.push({
      id: id('txn'),
      date: dateInMonth(month, 2),
      amount: -85_000,
      category: CAT_RENT,
      payee: PAYEE_LANDLORD,
      transfer_id: null,
      starting_balance_flag: false,
      account: CHECKING,
      schedule: rentScheduleId,
    })

    transactions.push({
      id: id('txn'),
      date: dateInMonth(month, 5),
      amount: -jitter(9_500, 0.2),
      category: CAT_UTILITIES,
      payee: PAYEE_UTILITY,
      transfer_id: null,
      starting_balance_flag: false,
      account: CHECKING,
      schedule: null,
    })

    transactions.push({
      id: id('txn'),
      date: dateInMonth(month, 7),
      amount: -1_399,
      category: CAT_SUBSCRIPTIONS,
      payee: PAYEE_NETFLIX,
      transfer_id: null,
      starting_balance_flag: false,
      account: CHECKING,
      schedule: netflixScheduleId,
    })

    const groceryDays = [4, 11, 18, 25]
    for (const [index, day] of groceryDays.entries()) {
      transactions.push({
        id: id('txn'),
        date: dateInMonth(month, day),
        amount: -jitter(5_500, 0.3),
        category: CAT_GROCERIES,
        payee: index % 2 === 0 ? PAYEE_COLRUYT : PAYEE_DELHAIZE,
        transfer_id: null,
        starting_balance_flag: false,
        account: CHECKING,
        schedule: null,
      })
    }

    for (const day of [9, 22]) {
      transactions.push({
        id: id('txn'),
        date: dateInMonth(month, day),
        amount: -jitter(2_500, 0.3),
        category: CAT_TRANSPORT,
        payee: PAYEE_NMBS,
        transfer_id: null,
        starting_balance_flag: false,
        account: CHECKING,
        schedule: null,
      })
    }

    for (const day of [6, 14, 27]) {
      transactions.push({
        id: id('txn'),
        date: dateInMonth(month, day),
        amount: -jitter(3_800, 0.4),
        category: CAT_DINING,
        payee: PAYEE_RESTAURANT,
        transfer_id: null,
        starting_balance_flag: false,
        account: CHECKING,
        schedule: null,
      })
    }

    if (Math.random() > 0.35) {
      transactions.push({
        id: id('txn'),
        date: dateInMonth(month, 19),
        amount: -jitter(6_000, 0.5),
        category: CAT_SHOPPING,
        payee: PAYEE_SHOP,
        transfer_id: null,
        starting_balance_flag: false,
        account: CHECKING,
        schedule: null,
      })
    }

    // A transfer that crosses the budget boundary (on-budget checking into
    // off-budget savings) — the case `fetchOffBudgetTransferLegIds` exists for.
    const outLegId = id('txn')
    const inLegId = id('txn')
    transactions.push({
      id: outLegId,
      date: dateInMonth(month, 28),
      amount: -50_000,
      category: null,
      payee: null,
      transfer_id: inLegId,
      starting_balance_flag: false,
      account: CHECKING,
      schedule: null,
    })
    transactions.push({
      id: inLegId,
      date: dateInMonth(month, 28),
      amount: 50_000,
      category: null,
      payee: null,
      transfer_id: outLegId,
      starting_balance_flag: false,
      account: SAVINGS,
      schedule: null,
    })
  }

  const rules: FakeRule[] = [
    {
      id: id('rule'),
      actions: [{ op: 'set', field: 'category', value: CAT_RENT }],
      tombstone: false,
    },
    {
      id: id('rule'),
      actions: [{ op: 'set', field: 'category', value: CAT_SUBSCRIPTIONS }],
      tombstone: false,
    },
  ]

  const schedules: FakeSchedule[] = [
    {
      id: rentScheduleId,
      amount: -85_000,
      amountOp: 'is',
      date: { frequency: 'monthly', interval: 1, start: dateInMonth(months[0] ?? '2024-01', 2) },
      next_date: dateInMonth(months[months.length - 1] ?? '2026-01', 2),
      completed: false,
      posts_transaction: false,
      rule: rules[0]?.id ?? '',
      tombstone: false,
    },
    {
      id: netflixScheduleId,
      amount: { num1: -1_599, num2: -1_399 },
      amountOp: 'isbetween',
      date: { frequency: 'monthly', interval: 1, start: dateInMonth(months[0] ?? '2024-01', 7) },
      next_date: dateInMonth(months[months.length - 1] ?? '2026-01', 7),
      completed: false,
      posts_transaction: false,
      rule: rules[1]?.id ?? '',
      tombstone: false,
    },
  ]

  return {
    accounts,
    payees,
    categoryGroups,
    categories,
    transactions,
    schedules,
    rules,
    budgetOverrides: {},
  }
}

/** Reuses `data/fake-backend/actual.json` if present; generates and persists it otherwise. */
export function loadOrCreateActualData(): ActualDataset {
  try {
    return JSON.parse(readFileSync(DATA_PATH, 'utf8')) as ActualDataset
  } catch {
    const dataset = generate()
    saveActualData(dataset)
    return dataset
  }
}

export function saveActualData(dataset: ActualDataset): void {
  mkdirSync(dirname(DATA_PATH), { recursive: true })
  writeFileSync(DATA_PATH, JSON.stringify(dataset, null, 2))
}
