import { describe, expect, it } from 'vitest'
import { q } from '@actual-app/api'
import type { Query } from '@actual-app/core/shared/query'
import { generate, CAT_RENT, CAT_SUBSCRIPTIONS, CHECKING, SAVINGS, type ActualDataset } from '../../scripts/fake-backend/actual-data.ts'
import { computeBudgetMonth, runAqlQuery, type QueryState } from '../../scripts/fake-backend/actual-fake-api.ts'
import { transferFilter } from '../../src/adapters/actual/queries.ts'

// Every filter/select/groupBy shape below is copied verbatim from
// src/adapters/actual/queries.ts, so a real shape drift there (a renamed
// field, a new operator) breaks this test instead of silently getting a
// wrong answer from the fake at dev time.

function state(query: Query): QueryState {
  return query.serialize() as unknown as QueryState
}

/** The month the fixed-amount transactions (rent, Netflix) fall in — jittered
 *  categories aren't used for assertions here, since their totals vary run to run. */
function monthOf(dataset: ActualDataset, categoryId: string): string {
  const txn = dataset.transactions.find((t) => t.category === categoryId)
  if (txn === undefined) throw new Error(`fixture has no transaction for ${categoryId}`)
  return txn.date.slice(0, 7)
}

describe('fake Actual aqlQuery interpreter', () => {
  it('answers the accounts query', () => {
    const dataset = generate()
    const result = runAqlQuery(dataset, state(q('accounts').select(['id', 'name', 'offbudget', 'closed', 'last_reconciled'])))
    expect(result.data).toEqual(
      dataset.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        offbudget: a.offbudget,
        closed: a.closed,
        last_reconciled: a.last_reconciled,
      })),
    )
  })

  it('answers the categories query', () => {
    const dataset = generate()
    const result = runAqlQuery(
      dataset,
      state(q('categories').select(['id', 'name', 'is_income', 'hidden', 'group'])),
    )
    expect(result.data).toEqual(
      dataset.categories.map((c) => ({
        id: c.id,
        name: c.name,
        is_income: c.is_income,
        hidden: c.hidden,
        group: c.group,
      })),
    )
  })

  it('resolves the account.offbudget join and $ne, keeping only the on-budget transfer leg', () => {
    const dataset = generate()
    const month = monthOf(dataset, CAT_RENT)
    const result = runAqlQuery(
      dataset,
      state(
        q('transactions')
          .filter({
            date: { $gte: `${month}-01`, $lte: `${month}-31` },
            transfer_id: { $ne: null },
            starting_balance_flag: false,
            'account.offbudget': false,
          })
          .select(['id', 'transfer_id']),
      ),
    ) as { data: { id: string; transfer_id: string }[] }

    expect(result.data).toHaveLength(1)
    const [leg] = result.data
    const row = dataset.transactions.find((t) => t.id === leg?.id)
    expect(row?.account).toBe(CHECKING)
  })

  it('resolves a dotted path inside select, not just filter', () => {
    const dataset = generate()
    const month = monthOf(dataset, CAT_RENT)
    const legs = runAqlQuery(
      dataset,
      state(
        q('transactions')
          .filter({
            date: { $gte: `${month}-01`, $lte: `${month}-31` },
            transfer_id: { $ne: null },
            starting_balance_flag: false,
            'account.offbudget': false,
          })
          .select(['id', 'transfer_id']),
      ),
    ).data as { id: string; transfer_id: string }[]
    const counterpartId = legs[0]?.transfer_id
    expect(counterpartId).toBeDefined()

    const result = runAqlQuery(
      dataset,
      state(
        q('transactions')
          .filter({ id: { $oneof: [counterpartId] } })
          .select(['id', { offbudget: 'account.offbudget' }]),
      ),
    ) as { data: { id: string; offbudget: boolean }[] }

    expect(result.data).toEqual([{ id: counterpartId, offbudget: true }])
    const counterpartRow = dataset.transactions.find((t) => t.id === counterpartId)
    expect(counterpartRow?.account).toBe(SAVINGS)
  })

  it('honours transferFilter\'s $or when a leg is explicitly kept', () => {
    const dataset = generate()
    const month = monthOf(dataset, CAT_RENT)
    const transferOut = dataset.transactions.find(
      (t) => t.date.startsWith(month) && t.account === CHECKING && t.transfer_id !== null,
    )
    expect(transferOut).toBeDefined()

    const result = runAqlQuery(
      dataset,
      state(
        q('transactions')
          .filter({
            date: { $gte: `${month}-01`, $lte: `${month}-31` },
            ...transferFilter([transferOut!.id]),
            starting_balance_flag: false,
            'account.offbudget': false,
          })
          .select(['id']),
      ),
    ) as { data: { id: string }[] }

    const ids = result.data.map((row) => row.id)
    expect(ids).toContain(transferOut!.id) // kept via the $oneof branch
    expect(ids).toContain(dataset.transactions.find((t) => t.category === CAT_RENT && t.date.startsWith(month))!.id) // kept via transfer_id: null
  })

  it('groups by $month + category and aggregates $sum/$count', () => {
    const dataset = generate()
    const month = monthOf(dataset, CAT_RENT)
    const result = runAqlQuery(
      dataset,
      state(
        q('transactions')
          .filter({
            date: { $gte: `${month}-01`, $lte: `${month}-31` },
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
      ),
    ) as { data: { month: string; category: string | null; amount: number; count: number }[] }

    const rent = result.data.find((row) => row.category === CAT_RENT)
    expect(rent).toEqual({ month, category: CAT_RENT, amount: -85_000, count: 1 })

    const netflix = result.data.find((row) => row.category === CAT_SUBSCRIPTIONS)
    expect(netflix).toEqual({ month, category: CAT_SUBSCRIPTIONS, amount: -1_399, count: 1 })
  })

  it('groups by plain date + category (the daily variant)', () => {
    const dataset = generate()
    const month = monthOf(dataset, CAT_RENT)
    const rentTxn = dataset.transactions.find((t) => t.category === CAT_RENT && t.date.startsWith(month))!

    const result = runAqlQuery(
      dataset,
      state(
        q('transactions')
          .filter({
            date: { $gte: `${month}-01`, $lte: `${month}-31` },
            transfer_id: null,
            starting_balance_flag: false,
            'account.offbudget': false,
          })
          .groupBy(['date', 'category'])
          .select(['date', 'category', { amount: { $sum: '$amount' } }]),
      ),
    ) as { data: { date: string; category: string | null; amount: number }[] }

    expect(result.data).toContainEqual({ date: rentTxn.date, category: CAT_RENT, amount: -85_000 })
  })

  it('orders by date and limits to 1 (the transaction-range query)', () => {
    const dataset = generate()
    const expected = [...dataset.transactions]
      .filter((t) => !t.starting_balance_flag)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0]!.date

    const result = runAqlQuery(
      dataset,
      state(q('transactions').filter({ starting_balance_flag: false }).orderBy({ date: 'asc' }).select(['date']).limit(1)),
    ) as { data: { date: string }[] }

    expect(result.data).toEqual([{ date: expected }])
  })

  it('resolves payee.name inside select for uncategorised transactions', () => {
    const dataset = generate()
    // Force one categorised transaction into the uncategorised bucket, the way
    // a real Actual budget would have one.
    const target = dataset.transactions.find((t) => t.category !== null && t.payee !== null)!
    target.category = null

    const month = target.date.slice(0, 7)
    const result = runAqlQuery(
      dataset,
      state(
        q('transactions')
          .filter({
            date: { $gte: `${month}-01`, $lte: `${month}-31` },
            category: null,
            transfer_id: null,
            starting_balance_flag: false,
            'account.offbudget': false,
          })
          .select(['id', 'payee', { payeeName: 'payee.name' }, 'amount', 'date']),
      ),
    ) as { data: { id: string; payeeName: string | null }[] }

    const row = result.data.find((r) => r.id === target.id)
    const expectedPayeeName = dataset.payees.find((p) => p.id === target.payee)!.name
    expect(row?.payeeName).toBe(expectedPayeeName)
  })

  it('throws on an unsupported filter operator rather than answering silently', () => {
    const dataset = generate()
    expect(() =>
      runAqlQuery(dataset, {
        table: 'transactions',
        filterExpressions: [{ amount: { $gt: 0 } }],
        selectExpressions: ['id'],
        groupExpressions: [],
        orderExpressions: [],
        limit: null,
        offset: null,
      }),
    ).toThrow(/unsupported filter operator/)
  })
})

describe('fake Actual computeBudgetMonth', () => {
  it('derives spent/received from the same transactions the interpreter would see, and applies overrides', () => {
    const dataset = generate()
    const month = monthOf(dataset, CAT_RENT)

    const budgetMonth = computeBudgetMonth(dataset, month) as {
      totalSpent: number
      categoryGroups: { categories: { id: string; spent?: number; budgeted?: number; received?: number }[] }[]
    }
    const categories = budgetMonth.categoryGroups.flatMap((g) => g.categories)
    const rent = categories.find((c) => c.id === CAT_RENT)!
    expect(rent.spent).toBe(-85_000)
    expect(rent.budgeted).toBe(85_000) // the default, before any override

    dataset.budgetOverrides[`${month}:${CAT_RENT}`] = 90_000
    const overridden = computeBudgetMonth(dataset, month) as {
      categoryGroups: { categories: { id: string; budgeted?: number; balance?: number }[] }[]
    }
    const rentAfterOverride = overridden.categoryGroups.flatMap((g) => g.categories).find((c) => c.id === CAT_RENT)!
    expect(rentAfterOverride.budgeted).toBe(90_000)
    expect(rentAfterOverride.balance).toBe(90_000 + -85_000)
  })
})
