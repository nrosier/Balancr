/**
 * Portfolio transforms, metrics and persistence.
 *
 * The two things worth being strict about: floats become integer cents exactly
 * once, at the Ghostfolio boundary, and allocation shares add up to exactly
 * 10 000 bp. A pie chart labelled 99.97% invites the reader to distrust every
 * other figure on the page, and they would be right to.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import type {
  GhostfolioAccounts,
  PortfolioDetails,
  PortfolioPerformance,
} from '../../src/adapters/ghostfolio/types.ts'
import {
  allocationByAssetClass,
  computePortfolioMetrics,
  reportedTwrBp,
} from '../../src/domain/portfolio/metrics.ts'
import {
  toAccountValues,
  toHoldingSnapshots,
  type HoldingSnapshot,
} from '../../src/domain/portfolio/snapshot.ts'
import {
  latestSnapshotDate,
  loadPortfolioValueHistory,
  loadSnapshot,
  persistPortfolioMetrics,
  persistPortfolioSnapshots,
} from '../../src/domain/portfolio/store.ts'

type RawHolding = PortfolioDetails['holdings'][string]

function holding(overrides: Partial<RawHolding> & { symbol: string }): RawHolding {
  return {
    name: overrides.symbol,
    currency: 'EUR',
    quantity: 10,
    marketPrice: 100,
    valueInBaseCurrency: 1_000,
    assetClass: 'EQUITY',
    ...overrides,
  } as RawHolding
}

function details(...holdings: RawHolding[]): PortfolioDetails {
  return {
    holdings: Object.fromEntries(holdings.map((h) => [h.symbol, h])),
  } as PortfolioDetails
}

describe('toHoldingSnapshots', () => {
  it('rounds money to cents once and keeps the quantity verbatim', () => {
    const [row] = toHoldingSnapshots(
      '2026-03-01',
      details(
        holding({
          symbol: 'IWDA.AS',
          isin: 'IE00B4L5Y983',
          quantity: 12.345_678,
          marketPrice: 98.765,
          valueInBaseCurrency: 1_219.29,
        }),
      ),
      'EUR',
    )

    expect(row).toMatchObject({
      date: '2026-03-01',
      instrument: 'IE00B4L5Y983',
      symbol: 'IWDA.AS',
      isin: 'IE00B4L5Y983',
      // Text, not a float: 12.345678 shares is a real position, and the broker's
      // own digits are what a statement will be checked against.
      quantity: '12.345678',
      priceCents: 9_877,
      valueCents: 121_929,
      currency: 'EUR',
    })
  })

  it('keys on the symbol when the data source gives no ISIN', () => {
    // Dropping the holding would understate the portfolio, which is worse than an
    // identifier that cannot be matched to a broker statement.
    const [row] = toHoldingSnapshots('2026-03-01', details(holding({ symbol: 'BTC' })), 'EUR')
    expect(row).toMatchObject({ instrument: 'BTC', isin: null })
  })

  it('labels the row with the base currency, not the instrument currency', () => {
    // The stored value is already converted; labelling it USD would misdescribe
    // the number sitting next to it.
    const [row] = toHoldingSnapshots(
      '2026-03-01',
      details(holding({ symbol: 'VTI', currency: 'USD', valueInBaseCurrency: 900 })),
      'EUR',
    )
    expect(row).toMatchObject({ currency: 'EUR', valueCents: 90_000 })
  })

  it('treats a missing price or value as zero rather than crashing', () => {
    const [row] = toHoldingSnapshots(
      '2026-03-01',
      details(holding({ symbol: 'DELISTED', marketPrice: null, valueInBaseCurrency: null })),
      'EUR',
    )
    expect(row).toMatchObject({ priceCents: 0, valueCents: 0 })
  })

  it('merges two positions in the same ISIN into one row', () => {
    // The same fund at two brokers is one instrument and one primary key.
    const rows = toHoldingSnapshots(
      '2026-03-01',
      details(
        holding({ symbol: 'IWDA.AS', isin: 'IE00B4L5Y983', quantity: 10, valueInBaseCurrency: 1_000 }),
        holding({ symbol: 'IWDA.L', isin: 'IE00B4L5Y983', quantity: 5, valueInBaseCurrency: 500 }),
      ),
      'EUR',
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      instrument: 'IE00B4L5Y983',
      quantity: '15',
      valueCents: 150_000,
      // Per-unit, so kept rather than summed.
      priceCents: 10_000,
    })
  })

  it('sorts by instrument, so two runs of the same data agree', () => {
    const rows = toHoldingSnapshots(
      '2026-03-01',
      details(holding({ symbol: 'ZZZ' }), holding({ symbol: 'AAA' })),
      'EUR',
    )
    expect(rows.map((row) => row.instrument)).toEqual(['AAA', 'ZZZ'])
  })

  it('returns nothing for an empty portfolio', () => {
    expect(toHoldingSnapshots('2026-03-01', details(), 'EUR')).toEqual([])
  })
})

describe('toAccountValues', () => {
  const accounts = (...list: GhostfolioAccounts['accounts']): GhostfolioAccounts =>
    ({ accounts: list }) as GhostfolioAccounts

  it('prefers the account value over its cash balance', () => {
    // `balance` is cash only; the value includes the positions held there, which
    // is what makes it comparable with the Actual account that mirrors it.
    const [row] = toAccountValues(
      accounts({ id: 'g1', name: 'Bolero', currency: 'EUR', balance: 120.5, valueInBaseCurrency: 15_400.25 }),
    )
    expect(row).toMatchObject({ externalId: 'g1', valueCents: 1_540_025, excluded: false })
  })

  it('falls back to the balance for a cash-only account', () => {
    const [row] = toAccountValues(accounts({ id: 'g2', name: 'Cash', currency: 'EUR', balance: 500 }))
    expect(row).toMatchObject({ valueCents: 50_000 })
  })

  it("honours Ghostfolio's own exclusion flag", () => {
    const [row] = toAccountValues(
      accounts({ id: 'g3', name: 'Play money', currency: 'EUR', balance: 10, isExcluded: true }),
    )
    expect(row?.excluded).toBe(true)
  })
})

describe('allocationByAssetClass', () => {
  const slice = (assetClass: string | null, valueCents: number, key = assetClass ?? 'x'): HoldingSnapshot => ({
    date: '2026-03-01',
    instrument: key,
    symbol: key,
    isin: null,
    name: key,
    quantity: '1',
    priceCents: valueCents,
    valueCents,
    currency: 'EUR',
    assetClass,
    assetSubClass: null,
  })

  it('groups by class, descending by value', () => {
    const allocation = allocationByAssetClass([
      slice('EQUITY', 60_000, 'a'),
      slice('FIXED_INCOME', 30_000, 'b'),
      slice('EQUITY', 10_000, 'c'),
    ])

    expect(allocation).toEqual([
      { key: 'EQUITY', valueCents: 70_000, shareBp: 7_000 },
      { key: 'FIXED_INCOME', valueCents: 30_000, shareBp: 3_000 },
    ])
  })

  it('labels an unclassified holding rather than dropping it', () => {
    const allocation = allocationByAssetClass([slice(null, 1_000, 'a')])
    expect(allocation).toEqual([{ key: 'unknown', valueCents: 1_000, shareBp: 10_000 }])
  })

  it('adds up to exactly 10 000 bp on a total that does not divide', () => {
    // Three equal thirds floor to 3 333 each and leave 1 bp over.
    const allocation = allocationByAssetClass([
      slice('A', 1_000, 'a'),
      slice('B', 1_000, 'b'),
      slice('C', 1_000, 'c'),
    ])

    expect(allocation.reduce((sum, s) => sum + s.shareBp, 0)).toBe(10_000)
    expect(allocation.map((s) => s.shareBp).sort((a, b) => a - b)).toEqual([3_333, 3_333, 3_334])
  })

  it('gives the leftover basis point to the largest remainder', () => {
    const allocation = allocationByAssetClass([
      slice('BIG', 50_005, 'a'),
      slice('SMALL', 49_995, 'b'),
    ])
    expect(allocation).toEqual([
      { key: 'BIG', valueCents: 50_005, shareBp: 5_001 },
      { key: 'SMALL', valueCents: 49_995, shareBp: 4_999 },
    ])
  })

  it('gives every share as zero when there is nothing to divide by', () => {
    // Not NaN, and not Infinity, which would both render as a number.
    const allocation = allocationByAssetClass([slice('EQUITY', 0, 'a')])
    expect(allocation).toEqual([{ key: 'EQUITY', valueCents: 0, shareBp: 0 }])
  })

  it('is empty for an empty portfolio', () => {
    expect(allocationByAssetClass([])).toEqual([])
  })
})

describe('reportedTwrBp', () => {
  const performance = (perf: Record<string, number> | undefined): PortfolioPerformance =>
    ({ chart: [], ...(perf ? { performance: perf } : {}) }) as PortfolioPerformance

  it('converts the current field to basis points', () => {
    expect(reportedTwrBp(performance({ netPerformancePercentage: 0.0734 }))).toBe(734)
  })

  it('accepts the older field name', () => {
    // Two names for one figure is what an unversioned internal API costs.
    expect(reportedTwrBp(performance({ currentNetPerformancePercent: -0.052 }))).toBe(-520)
  })

  it('is null when Ghostfolio reports no performance at all', () => {
    // An absent return is not a zero return.
    expect(reportedTwrBp(performance(undefined))).toBeNull()
  })
})

describe('computePortfolioMetrics', () => {
  it('totals the holdings and leaves the unknowable null', () => {
    const holdings = toHoldingSnapshots(
      '2026-03-01',
      details(
        holding({ symbol: 'IWDA.AS', valueInBaseCurrency: 1_000 }),
        holding({ symbol: 'AGGH.AS', valueInBaseCurrency: 500, assetClass: 'FIXED_INCOME' }),
      ),
      'EUR',
    )

    const metrics = computePortfolioMetrics('2026-03-01', holdings, {
      chart: [],
      performance: { netPerformancePercentage: 0.12 },
    } as PortfolioPerformance)

    expect(metrics).toMatchObject({
      date: '2026-03-01',
      totalValueCents: 150_000,
      twrBp: 1_200,
      // Money-weighted return needs the cashflow series, drift needs a target
      // allocation and TER needs fund data — none of which exist yet, and a
      // guess would render as a number.
      mwrBp: null,
      driftJson: null,
      terAnnualCents: null,
    })
    expect(metrics.allocation.map((s) => s.key)).toEqual(['EQUITY', 'FIXED_INCOME'])
  })

  it('reports a null twr when the performance call failed', () => {
    expect(computePortfolioMetrics('2026-03-01', [], null).twrBp).toBeNull()
  })
})

describe('persistence', () => {
  let ctx: ReturnType<typeof createTestDb>

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
  })

  const snapshot = (date: string, ...symbols: string[]) =>
    toHoldingSnapshots(date, details(...symbols.map((symbol) => holding({ symbol }))), 'EUR')

  it('writes one row per holding', () => {
    const result = persistPortfolioSnapshots(ctx.db, '2026-03-01', snapshot('2026-03-01', 'A', 'B'))

    expect(result).toEqual({ written: 2, removed: 0 })
    expect(loadSnapshot(ctx.db, '2026-03-01').map((row) => row.instrument)).toEqual(['A', 'B'])
  })

  it('corrects the day rather than duplicating it', () => {
    persistPortfolioSnapshots(ctx.db, '2026-03-01', snapshot('2026-03-01', 'A'))
    const again = persistPortfolioSnapshots(
      ctx.db,
      '2026-03-01',
      toHoldingSnapshots(
        '2026-03-01',
        details(holding({ symbol: 'A', valueInBaseCurrency: 2_000, marketPrice: 200 })),
        'EUR',
      ),
    )

    expect(again).toEqual({ written: 1, removed: 0 })
    const rows = loadSnapshot(ctx.db, '2026-03-01')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ valueCents: 200_000, priceCents: 20_000 })
  })

  it('removes a position sold since the earlier pass', () => {
    persistPortfolioSnapshots(ctx.db, '2026-03-01', snapshot('2026-03-01', 'A', 'B'))
    const again = persistPortfolioSnapshots(ctx.db, '2026-03-01', snapshot('2026-03-01', 'A'))

    expect(again).toEqual({ written: 1, removed: 1 })
    expect(loadSnapshot(ctx.db, '2026-03-01').map((row) => row.instrument)).toEqual(['A'])
  })

  it('clears the day when the portfolio is emptied', () => {
    // The empty-list branch: `notInArray` over nothing matches nothing in SQL, so
    // without it yesterday's holdings would stand as today's.
    persistPortfolioSnapshots(ctx.db, '2026-03-01', snapshot('2026-03-01', 'A'))
    const again = persistPortfolioSnapshots(ctx.db, '2026-03-01', [])

    expect(again).toEqual({ written: 0, removed: 1 })
    expect(loadSnapshot(ctx.db, '2026-03-01')).toEqual([])
  })

  it('leaves other dates alone', () => {
    persistPortfolioSnapshots(ctx.db, '2026-03-01', snapshot('2026-03-01', 'A'))
    persistPortfolioSnapshots(ctx.db, '2026-03-02', snapshot('2026-03-02', 'B'))

    expect(loadSnapshot(ctx.db, '2026-03-01')).toHaveLength(1)
    expect(loadSnapshot(ctx.db, '2026-03-02')).toHaveLength(1)
  })

  it('upserts the metrics row and round-trips the allocation', () => {
    const holdings = snapshot('2026-03-01', 'A')
    persistPortfolioMetrics(ctx.db, computePortfolioMetrics('2026-03-01', holdings, null))
    persistPortfolioMetrics(ctx.db, {
      ...computePortfolioMetrics('2026-03-01', holdings, null),
      twrBp: 1_500,
    })

    expect(loadPortfolioValueHistory(ctx.db)).toEqual([
      { date: '2026-03-01', totalCents: 100_000 },
    ])
    const row = ctx.db.query.portfolioMetrics.findFirst().sync()
    expect(row).toMatchObject({ twrBp: 1_500, mwrBp: null, driftJson: null })
    expect(JSON.parse(row!.allocationJson as string)).toEqual([
      { key: 'EQUITY', valueCents: 100_000, shareBp: 10_000 },
    ])
  })

  it('reports the latest snapshot date, and null before the first one', () => {
    // This is what the hygiene score reads to decide whether prices are stale;
    // "no snapshot at all" must be distinguishable from "an old one".
    expect(latestSnapshotDate(ctx.db)).toBeNull()

    persistPortfolioSnapshots(ctx.db, '2026-03-01', snapshot('2026-03-01', 'A'))
    persistPortfolioSnapshots(ctx.db, '2026-02-01', snapshot('2026-02-01', 'A'))

    expect(latestSnapshotDate(ctx.db)).toBe('2026-03-01')
  })
})
