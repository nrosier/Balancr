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
 *  - **A Ghostfolio total is never attributed to one account.** The unfiltered chart is
 *    a portfolio total; on an install where Ghostfolio counts seven accounts and one of
 *    them is mapped into net worth, attributing it would overstate history by six
 *    accounts every month, in the flattering direction. So each counted account is
 *    asked for its own series, and the tests assert on which series answered which
 *    account rather than on a total that happened to match.
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

/** One point of a Ghostfolio value chart. A null value is a date it could not price. */
interface ChartPoint {
  date: string
  value: number | null
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
  /** The unfiltered `range=max` chart: the portfolio total, which the metrics half wants. */
  chart: [] as ChartPoint[],
  /**
   * Per-account series, keyed by Ghostfolio account id.
   *
   * An account with no entry here answers `chart`, which keeps every test that is not
   * about attribution reading as it did when there was only one series.
   */
  charts: {} as Record<string, ChartPoint[]>,
  /** Set to have the performance endpoint fail the way an outage does. */
  chartError: null as Error | null,
  /** Account ids whose own series must fail, for the one-of-many outage case. */
  seriesErrors: [] as string[],
  balanceDates: [] as string[],
  /**
   * One entry per performance call: the account id it filtered on, `null` unfiltered.
   *
   * The cost surface. Per-account attribution costs one request per *counted* account,
   * and the assertion that it is not one per date is the length of this array.
   */
  performanceCalls: [] as (string | null)[],
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
  fetchPortfolioPerformance: (_range?: string, accountId?: string) => {
    gave.performanceCalls.push(accountId ?? null)
    if (gave.chartError !== null) return Promise.reject(gave.chartError)
    if (accountId !== undefined && gave.seriesErrors.includes(accountId)) {
      return Promise.reject(new Error(`no series for ${accountId}`))
    }
    const chart = accountId === undefined ? gave.chart : gave.charts[accountId] ?? gave.chart
    return Promise.resolve({ chart })
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
  gave.charts = {}
  gave.chartError = null
  gave.seriesErrors = []
  gave.balanceDates = []
  gave.performanceCalls = []
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
    expect(detail.investmentHalf).toBe('accounts')
  })

  it('asks Ghostfolio once for the total and once per counted account', async () => {
    await run()
    // Not once per date, which is the reason to ask with `accounts=<id>` at all: the
    // twenty-four-month window would otherwise be twenty-four requests per account.
    expect(gave.performanceCalls).toEqual([null, 'g1'])
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

describe('two counted Ghostfolio accounts', () => {
  /** Bolero and a pension account, each with its own series and its own history. */
  beforeEach(() => {
    gave.gfAccounts = [
      { id: 'g1', name: 'Bolero', currency: 'EUR', balance: 0, valueInBaseCurrency: 4_000 },
      { id: 'g2', name: 'Pensioensparen', currency: 'EUR', balance: 0, valueInBaseCurrency: 900 },
    ]
    syncAccountMap(db, [
      { source: 'actual', externalId: 'a1', name: 'Zichtrekening' },
      { source: 'ghostfolio', externalId: 'g1', name: 'Bolero' },
      { source: 'ghostfolio', externalId: 'g2', name: 'Pensioensparen' },
    ])
  })

  it('attributes each month-end from the series of that account alone', async () => {
    gave.charts = {
      g1: [
        { date: '2026-01-31', value: 3_000 },
        { date: '2026-02-28', value: 3_200 },
        { date: '2026-03-14', value: 3_250 },
      ],
      g2: [
        { date: '2026-01-31', value: 800 },
        { date: '2026-02-28', value: 900 },
        { date: '2026-03-14', value: 910 },
      ],
    }
    const detail = await run()

    // The unfiltered chart is 3_250 + 910 in Ghostfolio's own arithmetic, and the point
    // of asking per account is that this total is never what lands in a snapshot row.
    expect(snapshots()).toEqual({
      '2026-01-31': 100_000 + 300_000 + 80_000,
      '2026-02-28': 120_000 + 320_000 + 90_000,
    })
    expect(detail.investmentHalf).toBe('accounts')
    expect(gave.performanceCalls).toEqual([null, 'g1', 'g2'])
  })

  it('does not let the younger account shorten the history of the older', async () => {
    // What the aggregate design got wrong and this one cannot: g2's first order is in
    // February, and January is a complete month in which it held nothing.
    gave.charts = {
      g1: [
        { date: '2026-01-31', value: 3_000 },
        { date: '2026-02-28', value: 3_200 },
        { date: '2026-03-14', value: 3_250 },
      ],
      g2: [
        { date: '2026-02-10', value: 850 },
        { date: '2026-02-28', value: 900 },
        { date: '2026-03-14', value: 910 },
      ],
    }
    const detail = await run()

    expect(snapshots()).toEqual({
      '2026-01-31': 100_000 + 300_000,
      '2026-02-28': 120_000 + 320_000 + 90_000,
    })
    expect(detail.snapshotsSkipped).toBe(0)
  })

  it('writes no date at all when one account series is missing', async () => {
    // All-or-nothing across the counted rows: a date answered from one of two accounts
    // is the partial investment half this job exists not to write.
    gave.seriesErrors = ['g2']
    const detail = await run()

    expect(snapshots()).toEqual({})
    expect(detail.investmentHalf).toBe('unavailable')
    // The halves stay independent, and this is where it pays: the value chart is a
    // total, so it is complete whether or not any of it can be attributed.
    expect(metrics()).toEqual({ '2026-01-31': 300_000, '2026-02-28': 320_000 })
  })
})

describe('a counted account with no dated value', () => {
  it('leaves net worth alone and backfills the value chart anyway', async () => {
    // A cash-only Ghostfolio account: its figure is `balance`, which is not dated, so
    // its chart carries nulls throughout. Today's number exists and no past one does.
    gave.charts = {
      g1: [
        { date: '2026-01-31', value: null },
        { date: '2026-02-28', value: null },
        { date: '2026-03-14', value: null },
      ],
    }
    const detail = await run()

    expect(snapshots()).toEqual({})
    expect(detail.investmentHalf).toBe('unavailable')
    expect(metrics()).toEqual({ '2026-01-31': 300_000, '2026-02-28': 320_000 })
  })
})

describe('when no investment row counts at all', () => {
  it('writes Actual alone, because today has no investment half either', async () => {
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
    // And no per-account request was made, because there was no counted row to ask about.
    expect(gave.performanceCalls).toEqual([null])
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
    // Short-circuited on the total rather than failing once per counted account.
    expect(gave.performanceCalls).toEqual([null])
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
    gave.performanceCalls = []

    await run()
    // Twenty-two month-ends predate this chart and can never be answered, so the total
    // is still asked for. One GET against a local Ghostfolio is the price of not
    // storing a floor that would need invalidating the day an older order is imported.
    //
    // The per-account requests are gone, though: the net-worth half is complete, and
    // that is what those cost money for.
    expect(gave.performanceCalls).toEqual([null])
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
    gave.performanceCalls = []

    const detail = await run()
    expect(gave.balanceDates).toEqual([])
    expect(gave.performanceCalls).toEqual([])
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
