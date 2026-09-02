/**
 * The history backfill.
 *
 * Two halves that fail independently, and the tests are organised that way because
 * the whole point of the split is that a Ghostfolio total nobody can attribute to an
 * account still leaves the portfolio-value chart complete.
 *
 * What is actually being defended:
 *
 *  - **The figures are Actual's and Ghostfolio's, not this job's.** A backfill over
 *    known balances has to reproduce them at each month-end. Everything else here is
 *    about the cases where it must produce *nothing* instead of something plausible.
 *  - **A date the investment half cannot answer is not written.** Writing the Actual
 *    side alone would put a step in the series at the point the backfill meets live
 *    data, and a step reads as an event — money that moved, on a date when nothing
 *    happened but a job giving up.
 *  - **A Ghostfolio total that is not one account's value is never attributed to one.**
 *    The chart is a portfolio total. On an install where Ghostfolio counts seven
 *    accounts and one of them is mapped into net worth, attributing it would overstate
 *    history by six accounts every month, in the flattering direction.
 *  - **It does not spend Actual's time twice.** One `getAccountBalance` per account per
 *    month is the expensive thing in this codebase; after the first pass there are no
 *    calls left to make.
 *  - **It never downgrades a row.** A real computed metrics row beats a value-only one
 *    from the chart, so a second pass must leave it alone.
 *
 * Both adapters are mocked. A test that reached them would need someone's real budget.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { portfolioMetrics } from '../../src/db/schema.ts'
import { loadAccountMap, syncAccountMap } from '../../src/domain/aggregate/accounts.ts'
import { loadNetWorthHistory } from '../../src/domain/aggregate/networth-store.ts'
import { loadPortfolioValueHistory } from '../../src/domain/portfolio/store.ts'
import { registry } from '../../src/jobs/index.ts'
import { backfillJob } from '../../src/jobs/backfill.ts'
import type { JobDetail } from '../../src/jobs/runner.ts'
import { logger } from '../../src/logger.ts'
import { endOfMonth, monthsBefore } from '../../src/util/month.ts'
import { seedMonth } from '../fixtures/month.ts'

/** An Actual account row as `fetchAccounts` returns it. */
interface Account {
  id: string
  name: string
  offbudget: boolean
  closed: boolean
  last_reconciled: string | null
}

/** A Ghostfolio account as the `/api/v1/account` payload carries it. */
interface GfAccount {
  id: string
  name: string
  currency: string
  balance: number
  valueInBaseCurrency?: number
  isExcluded?: boolean
}

/**
 * What the two adapters answer, and what they were asked.
 *
 * Declared before `vi.mock` and read only inside the stubs, which run long after the
 * factories do. `balanceDates` is the assertion surface for cost: one entry per
 * `fetchAccountBalances` call, in order.
 */
const gave = {
  accounts: [] as Account[],
  /** Balance per account, keyed by the `YYYY-MM-DD` of the `asOf` date. */
  balances: {} as Record<string, Record<string, number>>,
  gfAccounts: [] as GfAccount[],
  chart: [] as { date: string; value: number | null }[],
  /** Set to have the performance endpoint fail the way an outage does. */
  chartError: null as Error | null,
  balanceDates: [] as string[],
  chartCalls: 0,
}

const day = (asOf: Date): string => asOf.toISOString().slice(0, 10)

vi.mock('../../src/adapters/actual/queries.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/actual/queries.ts')>()),
  fetchAccounts: () => Promise.resolve(gave.accounts),
  fetchAccountBalances: (accountIds: string[], asOf: Date) => {
    const date = day(asOf)
    gave.balanceDates.push(date)
    const onDate = gave.balances[date] ?? {}
    return Promise.resolve(
      accountIds.map((accountId) => ({ accountId, balanceCents: onDate[accountId] ?? 0 })),
    )
  },
}))

vi.mock('../../src/adapters/ghostfolio/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/ghostfolio/client.ts')>()),
  fetchAccounts: () => Promise.resolve({ accounts: gave.gfAccounts }),
  fetchPortfolioPerformance: () => {
    gave.chartCalls += 1
    if (gave.chartError !== null) return Promise.reject(gave.chartError)
    return Promise.resolve({ chart: gave.chart })
  },
}))

/** Mid-March, so the window is the twenty-four months ending 2026-02. */
const NIGHT = new Date('2026-03-15T02:00:00Z')

let ctx: ReturnType<typeof createTestDb>
let db: Db

/**
 * One Actual current account and one Ghostfolio account, both mapped and counted,
 * with a budget that starts in January — so the net-worth half targets exactly the
 * two month-ends the fixtures can answer.
 */
beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db

  syncAccountMap(db, [
    { source: 'actual', externalId: 'a1', name: 'Zichtrekening' },
    { source: 'ghostfolio', externalId: 'g1', name: 'Bolero' },
  ])
  seedMonth(db, '2026-01')
  seedMonth(db, '2026-02')

  gave.accounts = [
    { id: 'a1', name: 'Zichtrekening', offbudget: false, closed: false, last_reconciled: null },
  ]
  gave.balances = {
    '2026-01-31': { a1: 100_000 },
    '2026-02-28': { a1: 120_000 },
    '2026-03-15': { a1: 130_000 },
  }
  gave.gfAccounts = [
    { id: 'g1', name: 'Bolero', currency: 'EUR', balance: 0, valueInBaseCurrency: 4_000 },
  ]
  // A March entry so both January and February are settled months.
  gave.chart = [
    { date: '2026-01-31', value: 3_000 },
    { date: '2026-02-28', value: 3_200 },
    { date: '2026-03-14', value: 3_250 },
  ]
  gave.chartError = null
  gave.balanceDates = []
  gave.chartCalls = 0
})

const run = async (now = NIGHT): Promise<JobDetail> =>
  ((await backfillJob.run({ db, now, log: logger })) ?? {}) as JobDetail

/** Month-end dates the backfill wrote a net-worth snapshot for. */
const snapshots = (): Record<string, number> =>
  Object.fromEntries(loadNetWorthHistory(db).map((row) => [row.date, row.totalCents]))

const metrics = (): Record<string, number> =>
  Object.fromEntries(loadPortfolioValueHistory(db).map((row) => [row.date, row.totalCents]))

describe('registration', () => {
  it('runs nightly, in the registry, after the pass that owns today', () => {
    const names = registry.map((job) => job.name)
    expect(names).toContain('backfill')
    expect(names.indexOf('backfill')).toBeGreaterThan(names.indexOf('networth'))
    expect(backfillJob.schedule.kind).toBe('daily')
  })
})

describe('a first pass over a known fixture', () => {
  it('reproduces both sources at each month-end', async () => {
    const detail = await run()

    // Net worth is the Actual balance on the date plus the chart's close for that
    // month — not the account's value *today*, which is what the nightly pass sees.
    expect(snapshots()).toEqual({
      '2026-01-31': 100_000 + 300_000,
      '2026-02-28': 120_000 + 320_000,
    })
    expect(metrics()).toEqual({ '2026-01-31': 300_000, '2026-02-28': 320_000 })
    expect(detail.snapshotsWritten).toBe(2)
    expect(detail.snapshotsSkipped).toBe(0)
    expect(detail.metricsWritten).toBe(2)
    expect(detail.investmentHalf).toBe('chart')
  })

  it('asks Actual for each month-end once, and for today once to classify', async () => {
    await run()
    expect(gave.balanceDates).toEqual(['2026-03-15', '2026-01-31', '2026-02-28'])
  })

  it('leaves the current month alone, because its end has not happened', async () => {
    await run()
    expect(Object.keys(snapshots())).not.toContain('2026-03-31')
    expect(Object.keys(metrics())).not.toContain('2026-03-31')
  })
})

describe('a date the investment half cannot answer', () => {
  it('is skipped rather than written as an Actual-only total', async () => {
    // February is inside the chart's range but has no usable value in it.
    gave.chart = [
      { date: '2026-01-31', value: 3_000 },
      { date: '2026-02-15', value: null },
      { date: '2026-03-14', value: 3_250 },
    ]
    const detail = await run()

    expect(snapshots()).toEqual({ '2026-01-31': 400_000 })
    // The wrong answer would be 120_000 here: Actual's half, looking like a month the
    // portfolio was sold.
    expect(snapshots()['2026-02-28']).toBeUndefined()
    expect(detail.snapshotsWritten).toBe(1)
    expect(detail.snapshotsSkipped).toBe(1)
  })

  it('is filled in by the next pass once the chart can answer it', async () => {
    gave.chart = [
      { date: '2026-01-31', value: 3_000 },
      { date: '2026-02-15', value: null },
      { date: '2026-03-14', value: 3_250 },
    ]
    await run()
    expect(Object.keys(snapshots())).toEqual(['2026-01-31'])

    // Nothing had to be cleared for this to work: the skipped date is simply still
    // missing, which is the whole argument for skipping over marking.
    gave.chart = [
      { date: '2026-01-31', value: 3_000 },
      { date: '2026-02-28', value: 3_200 },
      { date: '2026-03-14', value: 3_250 },
    ]
    await run()
    expect(snapshots()).toEqual({ '2026-01-31': 400_000, '2026-02-28': 440_000 })
  })
})

describe('a month-end before the portfolio existed', () => {
  it('is written in full from Actual alone', async () => {
    // The chart starts in February, so January is not a date with a missing
    // investment half — it is a date with no investments.
    gave.chart = [
      { date: '2026-02-10', value: 3_100 },
      { date: '2026-02-28', value: 3_200 },
      { date: '2026-03-14', value: 3_250 },
    ]
    const detail = await run()

    expect(snapshots()).toEqual({ '2026-01-31': 100_000, '2026-02-28': 440_000 })
    expect(detail.snapshotsSkipped).toBe(0)
  })
})

describe('when the chart is not one account', () => {
  it('leaves net worth alone and backfills the value chart anyway', async () => {
    // Ghostfolio counts two accounts; one is mapped here. Its chart is the total of
    // both, and there is no honest way to split it.
    gave.gfAccounts = [
      { id: 'g1', name: 'Bolero', currency: 'EUR', balance: 0, valueInBaseCurrency: 4_000 },
      { id: 'g2', name: 'Pensioensparen', currency: 'EUR', balance: 0, valueInBaseCurrency: 900 },
    ]
    const detail = await run()

    expect(snapshots()).toEqual({})
    expect(detail.investmentHalf).toBe('unavailable')
    // The halves are independent, and this is where it pays: the portfolio-value
    // chart is a total, so an unattributable total is exactly what it wants.
    expect(metrics()).toEqual({ '2026-01-31': 300_000, '2026-02-28': 320_000 })
  })

  it('writes Actual alone when no investment row counts at all', async () => {
    // Ghostfolio's own exclusion flag, which `collectAccountValues` ANDs with ours.
    // This is `none`, not `unavailable`, and the difference is the whole point of the
    // skip rule: *today's* figure has no investment half either, so an Actual-only
    // history agrees with the live number at the join. There is no step to create.
    gave.gfAccounts = [
      {
        id: 'g1',
        name: 'Bolero',
        currency: 'EUR',
        balance: 0,
        valueInBaseCurrency: 4_000,
        isExcluded: true,
      },
    ]
    const detail = await run()

    expect(snapshots()).toEqual({ '2026-01-31': 100_000, '2026-02-28': 120_000 })
    expect(detail.investmentHalf).toBe('none')
    expect(detail.snapshotsSkipped).toBe(0)
  })
})

describe('when Ghostfolio cannot be reached', () => {
  it('writes neither half and does not fail the job', async () => {
    gave.chartError = new Error('ECONNREFUSED')
    const detail = await run()

    // An Actual-only history would be a net-worth series missing the portfolio for
    // every month before today, which is a fall to zero on the chart.
    expect(snapshots()).toEqual({})
    expect(metrics()).toEqual({})
    expect(detail.investmentHalf).toBe('unavailable')
  })
})

describe('the steady state', () => {
  it('stops asking Actual once every month-end is stored', async () => {
    await run()
    gave.balanceDates = []

    const detail = await run()
    // The expensive half is done: no `getAccountBalance` at all, for any date.
    expect(gave.balanceDates).toEqual([])
    expect(detail.snapshotsWritten).toBe(0)
  })

  it('still reads the chart, because months before the first order stay pending', async () => {
    await run()
    const after = gave.chartCalls

    await run()
    // Twenty-two month-ends predate this chart and can never be answered. One GET
    // against a local Ghostfolio is the price of not storing a floor that would need
    // invalidating the day an older order is imported.
    expect(gave.chartCalls).toBe(after + 1)
  })

  it('makes no call at all once nothing is pending', async () => {
    // The install this describes is one whose portfolio is older than the window: the
    // chart answers every month-end, so after one pass there is nothing left to ask
    // about and the job returns without opening a connection.
    const window = monthsBefore('2026-03', 24)
    const first = window[0] as string
    seedMonth(db, first)
    gave.chart = [
      ...window.map((month) => ({ date: endOfMonth(month), value: 3_000 })),
      { date: '2026-03-14', value: 3_250 },
    ]

    const firstPass = await run()
    expect(firstPass.metricsPending).toBe(0)
    gave.balanceDates = []
    gave.chartCalls = 0

    const detail = await run()
    expect(gave.balanceDates).toEqual([])
    expect(gave.chartCalls).toBe(0)
    expect(detail.pending).toBe(0)
  })
})

describe('an existing metrics row', () => {
  it('is kept rather than downgraded to a value-only one', async () => {
    // What the portfolio job writes: a total *and* a return. The chart can only offer
    // the total, and overwriting would lose the return — worse data after a job
    // succeeded, which is the failure nobody goes looking for.
    db.insert(portfolioMetrics)
      .values({
        date: '2026-01-31',
        twrBp: 420,
        mwrBp: 410,
        totalValueCents: 299_000,
        computedAt: new Date('2026-02-01T03:00:00Z'),
      })
      .run()

    const detail = await run()
    const row = db
      .select()
      .from(portfolioMetrics)
      .where(eq(portfolioMetrics.date, '2026-01-31'))
      .get()

    expect(row?.twrBp).toBe(420)
    expect(row?.totalValueCents).toBe(299_000)
    expect(detail.metricsWritten).toBe(1)
    expect(metrics()['2026-02-28']).toBe(320_000)
  })
})

describe('an install whose budget is younger than the window', () => {
  it('writes no net worth for month-ends before the budget existed', async () => {
    // `getAccountBalance` answers a date before the budget with zero, and a zero that
    // means "we did not look" renders exactly like one that means "there was nothing".
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
    db = ctx.db
    syncAccountMap(db, [
      { source: 'actual', externalId: 'a1', name: 'Zichtrekening' },
      { source: 'ghostfolio', externalId: 'g1', name: 'Bolero' },
    ])
    seedMonth(db, '2026-02')

    const detail = await run()

    expect(Object.keys(snapshots())).toEqual(['2026-02-28'])
    expect(detail.snapshotsWritten).toBe(1)
    // The value chart is not clamped: it needs no budget to be true.
    expect(metrics()).toEqual({ '2026-01-31': 300_000, '2026-02-28': 320_000 })
  })

  it('writes nothing at all when the sync job has never run', async () => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
    db = ctx.db
    syncAccountMap(db, [{ source: 'actual', externalId: 'a1', name: 'Zichtrekening' }])

    const detail = await run()

    expect(snapshots()).toEqual({})
    expect(gave.balanceDates).toEqual([])
    expect(detail.snapshotsWritten).toBe(0)
  })
})

describe('the account map', () => {
  it('is never added to: a backfill reports history, it does not find accounts', async () => {
    gave.accounts.push({
      id: 'a-new',
      name: 'Spaarrekening',
      offbudget: false,
      closed: false,
      last_reconciled: null,
    })
    await run()

    expect(loadAccountMap(db).map((row) => row.externalId).sort()).toEqual(['a1', 'g1'])
  })
})
