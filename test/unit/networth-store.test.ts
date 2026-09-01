/**
 * The net-worth series is derived data, so idempotence is the contract: the
 * nightly pass, a manual re-run after fixing a mapping, and a re-run after a
 * crash must all leave the same rows behind.
 *
 * The load-bearing case is the one at the bottom — excluded accounts must not
 * reach the table at all. A deduplicated mirror stored next to the real account
 * would be summed back into the total by the first `sum(value_cents)` anyone
 * writes, which is exactly the double counting the dedupe exists to prevent.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { netWorthSnapshots } from '../../src/db/schema.ts'
import {
  loadNetWorthHistory,
  persistNetWorth,
} from '../../src/domain/aggregate/networth-store.ts'
import { computeNetWorth, type AccountValue } from '../../src/domain/aggregate/networth.ts'
import { loadAccountMap, syncAccountMap } from '../../src/domain/aggregate/accounts.ts'

let ctx: ReturnType<typeof createTestDb>
/** Real `account_map` rows, because the snapshot table has a foreign key to them. */
let ids: Record<string, string>

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  syncAccountMap(ctx.db, [
    { source: 'actual', externalId: 'a1', name: 'Zichtrekening' },
    { source: 'actual', externalId: 'a2', name: 'Beleggingen', offBudget: true },
    { source: 'ghostfolio', externalId: 'g1', name: 'Bolero' },
  ])
  ids = Object.fromEntries(loadAccountMap(ctx.db).map((row) => [row.externalId, row.id]))
})

function account(externalId: string, valueCents: number, overrides: Partial<AccountValue> = {}): AccountValue {
  return {
    accountMapId: ids[externalId] as string,
    source: externalId.startsWith('g') ? 'ghostfolio' : 'actual',
    externalId,
    name: externalId,
    kind: 'checking',
    valueCents,
    includeInNetWorth: true,
    dedupeGroup: null,
    isSourceOfTruth: true,
    ...overrides,
  }
}

const rows = () =>
  ctx.db.select().from(netWorthSnapshots).orderBy(netWorthSnapshots.accountMapId).all()

describe('persistNetWorth', () => {
  it('writes one row per counted account', () => {
    const result = persistNetWorth(
      ctx.db,
      computeNetWorth('2026-03-01', [account('a1', 250_000), account('g1', 1_500_000)]),
    )

    expect(result).toEqual({ written: 2, removed: 0 })
    expect(rows().map((row) => row.valueCents).sort((a, b) => a - b)).toEqual([250_000, 1_500_000])
    expect(rows()[0]!.currency).toBe('EUR')
  })

  it('corrects the day rather than duplicating it', () => {
    persistNetWorth(ctx.db, computeNetWorth('2026-03-01', [account('a1', 250_000)]))
    const second = persistNetWorth(ctx.db, computeNetWorth('2026-03-01', [account('a1', 260_000)]))

    expect(second).toEqual({ written: 1, removed: 0 })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.valueCents).toBe(260_000)
  })

  it('removes a row whose account stopped counting', () => {
    persistNetWorth(
      ctx.db,
      computeNetWorth('2026-03-01', [account('a1', 250_000), account('g1', 1_500_000)]),
    )

    // The mirror is now deduplicated against Ghostfolio, so it must leave.
    const second = persistNetWorth(ctx.db, computeNetWorth('2026-03-01', [account('a1', 250_000)]))

    expect(second).toEqual({ written: 1, removed: 1 })
    expect(rows().map((row) => row.accountMapId)).toEqual([ids.a1])
  })

  it('clears the day when nothing counts at all', () => {
    // `notInArray` with an empty list matches nothing in SQL, so this is the case
    // that would silently leave yesterday's figures standing as today's.
    persistNetWorth(ctx.db, computeNetWorth('2026-03-01', [account('a1', 250_000)]))

    const second = persistNetWorth(
      ctx.db,
      computeNetWorth('2026-03-01', [account('a1', 250_000, { includeInNetWorth: false })]),
    )

    expect(second).toEqual({ written: 0, removed: 1 })
    expect(rows()).toEqual([])
  })

  it('leaves other dates alone', () => {
    persistNetWorth(ctx.db, computeNetWorth('2026-03-01', [account('a1', 250_000)]))
    persistNetWorth(ctx.db, computeNetWorth('2026-03-02', [account('g1', 1_500_000)]))

    expect(rows()).toHaveLength(2)
  })

  it('never stores a deduplicated mirror beside the account that counts', () => {
    const result = computeNetWorth('2026-03-01', [
      account('a2', 1_490_000, { dedupeGroup: 'broker', isSourceOfTruth: false, kind: 'other' }),
      account('g1', 1_500_000, { dedupeGroup: 'broker', kind: 'investment' }),
    ])
    persistNetWorth(ctx.db, result)

    expect(rows().map((row) => row.accountMapId)).toEqual([ids.g1])
    expect(loadNetWorthHistory(ctx.db)).toEqual([{ date: '2026-03-01', totalCents: 1_500_000 }])
  })
})

describe('loadNetWorthHistory', () => {
  it('sums the accounts per date, ascending', () => {
    persistNetWorth(
      ctx.db,
      computeNetWorth('2026-02-01', [account('a1', 250_000), account('g1', 1_400_000)]),
    )
    persistNetWorth(
      ctx.db,
      computeNetWorth('2026-03-01', [account('a1', 240_000), account('g1', 1_500_000)]),
    )

    expect(loadNetWorthHistory(ctx.db)).toEqual([
      { date: '2026-02-01', totalCents: 1_650_000 },
      { date: '2026-03-01', totalCents: 1_740_000 },
    ])
  })

  it('nets a debt off the total rather than ignoring it', () => {
    persistNetWorth(
      ctx.db,
      computeNetWorth('2026-03-01', [
        account('a1', 250_000),
        account('a2', -40_000, { kind: 'credit' }),
      ]),
    )

    expect(loadNetWorthHistory(ctx.db)).toEqual([{ date: '2026-03-01', totalCents: 210_000 }])
  })

  it('is empty before the first pass', () => {
    expect(loadNetWorthHistory(ctx.db)).toEqual([])
  })
})
