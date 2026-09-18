/**
 * A stand-in for `@actual-app/api`, for local dev without a real Actual server
 * (#391). Exports the same functions `src/adapters/actual/worker.ts` calls;
 * swapped in by `src/adapters/actual/api-source.ts` when
 * `ACTUAL_FAKE_BACKEND=true`.
 *
 * `runAqlQuery` is the interesting part: a small, generic interpreter over the
 * `QueryState` shape `@actual-app/core/shared/query.ts` serializes to. It is
 * deliberately not a general AQL engine — just enough of one to answer the
 * handful of concrete queries `src/adapters/actual/queries.ts` issues:
 * `$gte`/`$lte`/`$ne`/`$oneof`/`$or`/equality filters, the two dotted joins
 * (`account.offbudget`, `payee.name`), and `$month`/`$sum`/`$count` in a
 * `groupBy`. Anything queries.ts does not use throws, on purpose — a silent
 * wrong answer here would be worse than a loud "unsupported".
 *
 * `runAqlQuery`/`computeBudgetMonth` take the dataset as a plain argument
 * (rather than closing over the module-level singleton below) so
 * `test/unit/fake-actual-api.test.ts` can exercise them against a fresh,
 * disposable dataset instead of the one this module persists to disk.
 */
import {
  CAT_DINING,
  CAT_GROCERIES,
  CAT_RENT,
  CAT_SHOPPING,
  CAT_SUBSCRIPTIONS,
  CAT_TRANSPORT,
  CAT_UTILITIES,
  loadOrCreateActualData,
  saveActualData,
  type ActualDataset,
  type FakeTransaction,
} from './actual-data.ts'

const dataset: ActualDataset = loadOrCreateActualData()

// ---------------------------------------------------------------------------
//  Lifecycle — worker.ts calls these directly and reads their return value.
// ---------------------------------------------------------------------------

export async function init(): Promise<void> {
  // Real init opens a local sync engine; the fake has nothing to open.
}

export async function downloadBudget(): Promise<void> {
  // Real downloadBudget pulls the budget into a local cache; the fake's
  // "budget" is already in memory.
}

export async function getServerVersion(): Promise<{ version: string } | { error: string }> {
  // Matches EXPECTED_API_VERSION (protocol.ts) so worker.ts's alignment check
  // stays quiet.
  return { version: '26.9.0' }
}

export async function getPreferences(): Promise<{ budgetType?: string; defaultCurrencyCode?: string }> {
  return { budgetType: 'envelope', defaultCurrencyCode: 'EUR' }
}

export async function sync(): Promise<void> {}

export async function shutdown(): Promise<void> {}

// ---------------------------------------------------------------------------
//  AQL interpreter — everything below is reached only through `runCall`'s
//  generic `(api as Record<string, fn>)[method]` dispatch.
// ---------------------------------------------------------------------------

export interface QueryState {
  table: string
  filterExpressions: readonly Record<string, unknown>[]
  selectExpressions: readonly (string | Record<string, unknown>)[]
  groupExpressions: readonly (string | Record<string, unknown>)[]
  orderExpressions: readonly (string | Record<string, unknown>)[]
  limit: number | null
  offset: number | null
}

export interface SerializableQuery {
  serialize(): QueryState
}

type Row = Record<string, unknown>

interface Tables {
  accountsById: Map<string, Row>
  payeesById: Map<string, Row>
  categoriesById: Map<string, Row>
}

function tablesOf(dataset: ActualDataset): Tables {
  return {
    accountsById: new Map(dataset.accounts.map((a) => [a.id, a as unknown as Row])),
    payeesById: new Map(dataset.payees.map((p) => [p.id, p as unknown as Row])),
    categoriesById: new Map(dataset.categories.map((c) => [c.id, c as unknown as Row])),
  }
}

function rowsFor(dataset: ActualDataset, name: string): Row[] {
  switch (name) {
    case 'accounts':
      return dataset.accounts as unknown as Row[]
    case 'categories':
      return dataset.categories as unknown as Row[]
    case 'category_groups':
      return dataset.categoryGroups as unknown as Row[]
    case 'transactions':
      return dataset.transactions as unknown as Row[]
    default:
      throw new Error(`fake Actual: unsupported table "${name}"`)
  }
}

/** Resolves a plain field or a one-level join (`account.offbudget`, `payee.name`). */
function getField(tables: Tables, row: Row, path: string): unknown {
  const dot = path.indexOf('.')
  if (dot === -1) return row[path]

  const relation = path.slice(0, dot)
  const field = path.slice(dot + 1)
  const refId = row[relation]
  if (refId === null || refId === undefined) return null

  const byId =
    relation === 'account'
      ? tables.accountsById
      : relation === 'payee'
        ? tables.payeesById
        : relation === 'category'
          ? tables.categoriesById
          : undefined
  if (byId === undefined) throw new Error(`fake Actual: unsupported joined field "${path}"`)

  const related = byId.get(refId as string)
  return related === undefined ? null : related[field]
}

/** `'$amount'` means "the value of the `amount` field" — the only kind of ref queries.ts sends. */
function fieldRef(tables: Tables, ref: unknown, row: Row): unknown {
  if (typeof ref !== 'string' || !ref.startsWith('$')) {
    throw new Error(`fake Actual: expected a field reference, got ${JSON.stringify(ref)}`)
  }
  return getField(tables, row, ref.slice(1))
}

function matchesOne(tables: Tables, row: Row, expr: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(expr)) {
    if (key === '$or') {
      const branches = condition as Record<string, unknown>[]
      if (!branches.some((branch) => matchesOne(tables, row, branch))) return false
      continue
    }

    const value = getField(tables, row, key)
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      for (const [op, opValue] of Object.entries(condition as Record<string, unknown>)) {
        if (op === '$gte' && !((value as string | number) >= (opValue as string | number))) return false
        else if (op === '$lte' && !((value as string | number) <= (opValue as string | number))) return false
        else if (op === '$ne' && value === opValue) return false
        else if (op === '$oneof' && !(opValue as unknown[]).includes(value)) return false
        else if (!['$gte', '$lte', '$ne', '$oneof'].includes(op)) {
          throw new Error(`fake Actual: unsupported filter operator "${op}"`)
        }
      }
    } else if (value !== condition) {
      return false
    }
  }
  return true
}

function matchesAll(tables: Tables, row: Row, exprs: readonly Record<string, unknown>[]): boolean {
  return exprs.every((expr) => matchesOne(tables, row, expr))
}

/** A per-row value: a plain field, a dotted join, or `{$month: '$date'}`. */
function perRowValue(tables: Tables, row: Row, expr: string | Record<string, unknown>): unknown {
  if (typeof expr === 'string') return getField(tables, row, expr)
  if ('$month' in expr) {
    const raw = fieldRef(tables, expr['$month'], row)
    return typeof raw === 'string' ? raw.slice(0, 7) : raw
  }
  throw new Error(`fake Actual: unsupported expression ${JSON.stringify(expr)}`)
}

/** An aggregate over a whole group: `{$sum: '$amount'}` or `{$count: '$id'}`. */
function aggregateValue(tables: Tables, rows: readonly Row[], expr: Record<string, unknown>): unknown {
  if ('$sum' in expr) {
    return rows.reduce((sum, row) => sum + (Number(fieldRef(tables, expr['$sum'], row)) || 0), 0)
  }
  if ('$count' in expr) return rows.length
  throw new Error(`fake Actual: unsupported aggregate ${JSON.stringify(expr)}`)
}

function isAggregate(expr: unknown): expr is Record<string, unknown> {
  return typeof expr === 'object' && expr !== null && ('$sum' in expr || '$count' in expr)
}

function project(tables: Tables, row: Row, selects: readonly (string | Record<string, unknown>)[]): Row {
  const out: Row = {}
  for (const select of selects) {
    if (typeof select === 'string') {
      out[select] = getField(tables, row, select)
      continue
    }
    const [alias, expr] = Object.entries(select)[0] as [string, string | Record<string, unknown>]
    out[alias] = perRowValue(tables, row, expr)
  }
  return out
}

function projectGroup(
  tables: Tables,
  rows: readonly Row[],
  selects: readonly (string | Record<string, unknown>)[],
): Row {
  const representative = rows[0] ?? {}
  const out: Row = {}
  for (const select of selects) {
    if (typeof select === 'string') {
      out[select] = getField(tables, representative, select)
      continue
    }
    const [alias, expr] = Object.entries(select)[0] as [string, string | Record<string, unknown>]
    out[alias] = isAggregate(expr) ? aggregateValue(tables, rows, expr) : perRowValue(tables, representative, expr)
  }
  return out
}

function compare(tables: Tables, a: Row, b: Row, orderExprs: readonly (string | Record<string, unknown>)[]): number {
  for (const expr of orderExprs) {
    const [field, direction] =
      typeof expr === 'string' ? [expr, 'asc'] : (Object.entries(expr)[0] as [string, 'asc' | 'desc'])
    const av = getField(tables, a, field)
    const bv = getField(tables, b, field)
    if (av === bv) continue
    const lower = (av as string | number) < (bv as string | number)
    return direction === 'desc' ? (lower ? 1 : -1) : lower ? -1 : 1
  }
  return 0
}

/** Pure — takes the dataset explicitly so tests can run it against a disposable one. */
export function runAqlQuery(dataset: ActualDataset, state: QueryState): { data: unknown[] } {
  const tables = tablesOf(dataset)
  const rows = rowsFor(dataset, state.table)
  const filtered = rows.filter((row) => matchesAll(tables, row, state.filterExpressions))

  if (state.groupExpressions.length > 0) {
    const groups = new Map<string, Row[]>()
    for (const row of filtered) {
      const key = JSON.stringify(state.groupExpressions.map((expr) => perRowValue(tables, row, expr)))
      const bucket = groups.get(key)
      if (bucket) bucket.push(row)
      else groups.set(key, [row])
    }
    return { data: [...groups.values()].map((bucket) => projectGroup(tables, bucket, state.selectExpressions)) }
  }

  let ordered = filtered
  if (state.orderExpressions.length > 0) {
    ordered = [...filtered].sort((a, b) => compare(tables, a, b, state.orderExpressions))
  }
  const offset = state.offset ?? 0
  const limited = state.limit === null ? ordered.slice(offset) : ordered.slice(offset, offset + state.limit)

  return { data: limited.map((row) => project(tables, row, state.selectExpressions)) }
}

export async function aqlQuery(query: SerializableQuery): Promise<{ data: unknown[] }> {
  return runAqlQuery(dataset, query.serialize())
}

// ---------------------------------------------------------------------------
//  Non-AQL reads and the two writes #45 allows
// ---------------------------------------------------------------------------

const DEFAULT_BUDGETED: Readonly<Record<string, number>> = {
  [CAT_RENT]: 85_000,
  [CAT_UTILITIES]: 10_000,
  [CAT_SUBSCRIPTIONS]: 1_500,
  [CAT_GROCERIES]: 24_000,
  [CAT_TRANSPORT]: 6_000,
  [CAT_DINING]: 12_000,
  [CAT_SHOPPING]: 6_000,
}

export async function getBudgetMonths(): Promise<string[]> {
  const months = new Set(dataset.transactions.map((t) => t.date.slice(0, 7)))
  return [...months].sort()
}

/** Pure — takes the dataset explicitly so tests can run it against a disposable one. */
export function computeBudgetMonth(dataset: ActualDataset, month: string): Row {
  const monthTxns = dataset.transactions.filter(
    (t) => t.date.startsWith(month) && !t.starting_balance_flag && t.transfer_id === null,
  )
  const byCategory = new Map<string, number>()
  for (const t of monthTxns) {
    if (t.category === null) continue
    byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + t.amount)
  }

  let totalIncome = 0
  let totalSpent = 0
  let totalBudgeted = 0
  let totalBalance = 0

  const categoryGroups = dataset.categoryGroups.map((group) => ({
    id: group.id,
    name: group.name,
    is_income: group.is_income,
    categories: dataset.categories
      .filter((c) => c.group === group.id)
      .map((c) => {
        const amount = byCategory.get(c.id) ?? 0
        if (c.is_income) {
          totalIncome += amount
          return { id: c.id, name: c.name, is_income: true, hidden: c.hidden, received: amount }
        }
        const override = dataset.budgetOverrides[`${month}:${c.id}`]
        const budgeted = override ?? DEFAULT_BUDGETED[c.id] ?? 0
        const balance = budgeted + amount
        totalSpent += amount
        totalBudgeted += budgeted
        totalBalance += balance
        return {
          id: c.id,
          name: c.name,
          is_income: false,
          hidden: c.hidden,
          budgeted,
          spent: amount,
          balance,
          carryover: false,
        }
      }),
  }))

  return {
    month,
    totalIncome,
    totalSpent,
    totalBudgeted,
    toBudget: totalIncome - totalBudgeted,
    fromLastMonth: 0,
    totalBalance,
    categoryGroups,
  }
}

export async function getBudgetMonth(month: string): Promise<Row> {
  return computeBudgetMonth(dataset, month)
}

export async function getAccountBalance(accountId: string, cutoff?: Date): Promise<number> {
  const cutoffDate = (cutoff ?? new Date()).toISOString().slice(0, 10)
  return dataset.transactions
    .filter((t) => t.account === accountId && t.date <= cutoffDate)
    .reduce((sum, t) => sum + t.amount, 0)
}

export async function updateTransaction(id: string, fields: Partial<FakeTransaction>): Promise<void> {
  const txn = dataset.transactions.find((t) => t.id === id)
  if (txn === undefined) throw new Error(`fake Actual: no transaction "${id}"`)
  Object.assign(txn, fields)
  saveActualData(dataset)
}

export async function setBudgetAmount(month: string, categoryId: string, value: number): Promise<void> {
  dataset.budgetOverrides[`${month}:${categoryId}`] = value
  saveActualData(dataset)
}

export async function getSchedules(): Promise<unknown[]> {
  return dataset.schedules
}

export async function getRules(): Promise<unknown[]> {
  return dataset.rules
}
