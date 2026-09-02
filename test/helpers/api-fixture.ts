/**
 * A database with enough in it for the read API to have something to return.
 *
 * Built by calling the same persistence functions the jobs call, rather than by
 * inserting rows by hand. That is the point: if a store's column names or scaling
 * change, this fixture changes with them, and a test written against hand-made rows
 * would keep passing while the real read path broke.
 *
 * Deliberately small — two months, three categories, two holdings. The aggregation
 * itself has its own golden tests over a real fixture budget; what these numbers
 * are for is proving the API returns what was stored, in the shape it promised.
 */
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { accountMap, jobs, type AccountKind } from '../../src/db/schema.ts'
import { loadAccountMap, syncAccountMap } from '../../src/domain/aggregate/accounts.ts'
import { persistFacts, syncCategoryMeta } from '../../src/domain/aggregate/facts.ts'
import { persistMonthTotals } from '../../src/domain/aggregate/month-store.ts'
import type { AccountValue } from '../../src/domain/aggregate/networth.ts'
import { persistNetWorth } from '../../src/domain/aggregate/networth-store.ts'
import { persistSignals } from '../../src/domain/aggregate/signals-store.ts'
import type { MonthlyFact, MonthTotals } from '../../src/domain/aggregate/spend.ts'
import {
  persistPortfolioMetrics,
  persistPortfolioSnapshots,
} from '../../src/domain/portfolio/store.ts'

export const PREVIOUS_MONTH = '2026-07'
export const MONTH = '2026-08'
export const SNAPSHOT_DATE = '2026-08-31'

const totals = (month: string, income: number, spent: number): MonthTotals => ({
  month,
  incomeCents: income,
  spentCents: spent,
  budgetedCents: spent + 5_000,
  toBudgetCents: 0,
  fromLastMonthCents: 0,
  balanceCents: income - spent,
  savingsRateBp: income === 0 ? null : Math.round(((income - spent) / income) * 10_000),
})

const fact = (
  month: string,
  id: string,
  name: string,
  spent: number,
  overrides: Partial<MonthlyFact> = {},
): MonthlyFact => ({
  month,
  categoryId: id,
  categoryName: name,
  isIncome: false,
  hidden: false,
  spentCents: spent,
  budgetedCents: spent + 1_000,
  availableCents: 1_000,
  carryoverEnabled: false,
  txnCount: 4,
  recomputedSpentCents: spent,
  baseline: null,
  ...overrides,
})

export interface ApiFixture {
  db: Db
  sqlite: { close: () => void }
}

/**
 * `jobsFailed` marks the sync job as having errored, which is the only thing that
 * makes `freshness.stale` true.
 */
export function apiFixture(options: { jobsFailed?: boolean; empty?: boolean } = {}): ApiFixture {
  const ctx = createTestDb()
  applyMigrations(ctx.db as never)
  const db = ctx.db

  if (options.empty === true) return { db, sqlite: ctx.sqlite }

  const months = [PREVIOUS_MONTH, MONTH]
  persistMonthTotals(
    db,
    [totals(PREVIOUS_MONTH, 400_000, 310_000), totals(MONTH, 400_000, 352_000)],
    [
      { month: PREVIOUS_MONTH, txnCount: 0, amountCents: 0 },
      { month: MONTH, txnCount: 3, amountCents: 4_250 },
    ],
  )

  const facts = [
    fact(PREVIOUS_MONTH, 'cat-groceries', 'Groceries', 60_000),
    fact(PREVIOUS_MONTH, 'cat-energy', 'Energy', 18_000),
    fact(MONTH, 'cat-groceries', 'Groceries', 72_000, {
      baseline: {
        baselineCents: 61_000,
        currentCents: 72_000,
        deltaBp: 1_803,
        monthsUsed: 11,
        windowMonths: 12,
        winsorEffectBp: null,
      },
    }),
    fact(MONTH, 'cat-energy', 'Energy', 18_500),
    fact(MONTH, 'cat-salary', 'Salary', -400_000, { isIncome: true }),
  ]

  // In the order the sync job runs them: `loadFacts` joins `category_meta`, so a
  // fact whose category has no meta row is invisible to the API. A fixture that
  // wrote facts alone would leave every category endpoint returning an empty list
  // while passing every assertion that did not look.
  syncCategoryMeta(db, facts)
  persistFacts(db, facts, months)

  persistSignals(
    db,
    MONTH,
    [
      {
        code: 'above_baseline',
        categoryId: 'cat-groceries',
        categoryName: 'Groceries',
        severity: 'warn',
        metrics: { deltaBp: 1_803, spentCents: 72_000, baselineCents: 61_000 },
      },
    ],
    { scoreBp: 9_150, deductions: [{ reason: 'uncategorised', bp: 150 }] },
  )

  // Three accounts, of three kinds, because the summary is not stored: the API
  // recomputes total, liquid, invested and debt from the snapshot rows joined to
  // `account_map.kind`. A fixture with one checking account would make all four
  // figures the same number and prove nothing about the classification. Written
  // through `syncAccountMap` because `net_worth_snapshots.account_map_id` is a
  // foreign key onto a generated id — a hand-made mapping id would fail the
  // constraint that keeps a snapshot from outliving the account it describes.
  syncAccountMap(db, [
    { source: 'actual', externalId: 'acct-checking', name: 'Checking' },
    { source: 'ghostfolio', externalId: 'acct-broker', name: 'Broker' },
    { source: 'actual', externalId: 'acct-card', name: 'Credit card' },
  ])
  // `defaultKind` has no way to know a card is a card — it reads Actual's
  // `off_budget` flag and nothing else. Setting it here stands in for the account
  // mapping screen, which is where this decision belongs and lands in `0.6.0`.
  db.update(accountMap)
    .set({ kind: 'credit' })
    .where(eq(accountMap.externalId, 'acct-card'))
    .run()

  const byExternalId = new Map(loadAccountMap(db).map((row) => [row.externalId, row.id]))
  const mappingFor = (externalId: string): string => {
    const id = byExternalId.get(externalId)
    if (id === undefined) throw new Error(`the fixture failed to map ${externalId}`)
    return id
  }

  const contribution = (
    externalId: string,
    name: string,
    kind: AccountKind,
    valueCents: number,
  ): AccountValue => ({
    accountMapId: mappingFor(externalId),
    source: externalId === 'acct-broker' ? 'ghostfolio' : 'actual',
    externalId,
    name,
    kind,
    valueCents,
    includeInNetWorth: true,
    dedupeGroup: null,
    isSourceOfTruth: true,
  })

  persistNetWorth(db, {
    date: SNAPSHOT_DATE,
    // Recomputed on the way out, so these four are what the fixture *intends*
    // rather than what the API will report. Kept honest by matching the accounts:
    // 1 240 000 liquid + 3 700 000 invested − 120 000 owed.
    totalCents: 4_820_000,
    liquidCents: 1_240_000,
    investedCents: 3_700_000,
    debtCents: 120_000,
    contributions: [
      contribution('acct-checking', 'Checking', 'checking', 1_240_000),
      contribution('acct-broker', 'Broker', 'investment', 3_700_000),
      contribution('acct-card', 'Credit card', 'credit', -120_000),
    ],
    excluded: [],
    unresolvedGroups: [],
  })

  persistPortfolioSnapshots(db, SNAPSHOT_DATE, [
    {
      date: SNAPSHOT_DATE,
      instrument: 'IE00B4L5Y983',
      symbol: 'IWDA.AS',
      isin: 'IE00B4L5Y983',
      name: 'iShares Core MSCI World',
      quantity: '31.5',
      priceCents: 9_842,
      valueCents: 310_023,
      currency: 'EUR',
      assetClass: 'EQUITY',
      assetSubClass: 'ETF',
    },
    {
      date: SNAPSHOT_DATE,
      instrument: 'IE00BF4RFH31',
      symbol: 'WSML.AS',
      isin: 'IE00BF4RFH31',
      name: 'iShares MSCI World Small Cap',
      quantity: '12',
      priceCents: 6_010,
      valueCents: 72_120,
      currency: 'EUR',
      assetClass: 'EQUITY',
      assetSubClass: 'ETF',
    },
  ])

  persistPortfolioMetrics(db, {
    date: SNAPSHOT_DATE,
    totalValueCents: 382_143,
    twrBp: 742,
    mwrBp: null,
    allocation: [{ key: 'EQUITY', valueCents: 382_143, shareBp: 10_000 }],
    driftJson: null,
    terAnnualCents: null,
  })

  const now = new Date()
  for (const name of ['sync', 'portfolio', 'networth', 'signals'] as const) {
    const failed = options.jobsFailed === true && name === 'sync'
    db.insert(jobs)
      .values({
        name,
        status: failed ? 'error' : 'ok',
        lastRunAt: now,
        lastSuccessAt: failed ? null : now,
        error: failed ? 'ECONNREFUSED actual:5006' : null,
      })
      .run()
  }

  return { db, sqlite: ctx.sqlite }
}
