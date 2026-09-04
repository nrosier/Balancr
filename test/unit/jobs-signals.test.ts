/**
 * The nightly signals pass itself, not `computeSignals` (covered in
 * `signals-orchestrator.test.ts`) — what is tested here is which months it
 * chooses to judge.
 *
 * Before #162 that was always the same two months, counting back from the
 * latest stored one. What has to keep working: a month outside that floor is
 * left alone once judged, and rejudged the moment its own facts change,
 * however long ago it was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { persistFacts, syncCategoryMeta } from '../../src/domain/aggregate/facts.ts'
import { persistMonthTotals } from '../../src/domain/aggregate/month-store.ts'
import { loadHygiene, persistSignals } from '../../src/domain/aggregate/signals-store.ts'
import type { MonthlyFact, MonthTotals } from '../../src/domain/aggregate/spend.ts'
import { signalsJob } from '../../src/jobs/signals.ts'
import type { JobDetail } from '../../src/jobs/runner.ts'
import { logger } from '../../src/logger.ts'

vi.mock('../../src/adapters/actual/queries.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/actual/queries.ts')>()),
  fetchAccounts: () => Promise.resolve([]),
}))

let ctx: ReturnType<typeof createTestDb>
let db: Db

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
})

function totals(month: string, overrides: Partial<MonthTotals> = {}): MonthTotals {
  return {
    month,
    incomeCents: 380_000,
    spentCents: 310_000,
    budgetedCents: 320_000,
    toBudgetCents: 0,
    fromLastMonthCents: 12_000,
    balanceCents: 70_000,
    savingsRateBp: 1_842,
    committedCents: 0,
    committedUnallocatedCents: 0,
    committedUnallocatedCount: 0,
    committedApproximate: false,
    ...overrides,
  }
}

function fact(month: string): MonthlyFact {
  return {
    month,
    categoryId: 'food',
    categoryName: 'Food',
    isIncome: false,
    hidden: false,
    spentCents: 10_000,
    budgetedCents: 12_000,
    availableCents: 2_000,
    carryoverEnabled: false,
    txnCount: 3,
    recomputedSpentCents: 10_000,
    committedCents: 0,
    committedToDateCents: 0,
    committedApproximate: false,
    baseline: null,
  }
}

/** A month with facts and a fingerprint, exactly as a sync pass would leave it. */
function seed(month: string, hash: string): void {
  persistMonthTotals(db, [totals(month)], [], new Map([[month, hash]]))
  const facts = [fact(month)]
  syncCategoryMeta(db, facts)
  persistFacts(db, facts, [month])
}

const run = async (now: Date): Promise<JobDetail> =>
  ((await signalsJob.run({ db, now, log: logger })) ?? {}) as JobDetail

describe('which months get judged (#162)', () => {
  it('leaves an old month alone once judged, and rejudges it once its facts change', async () => {
    // 2026-01 is well outside the two-month floor once the latest month is
    // 2026-03. Judged now with the hash the sync pass wrote for it.
    seed('2026-01', 'hash-a')
    persistSignals(db, '2026-01', [], { scoreBp: 10_000, deductions: [] }, 'hash-a')
    seed('2026-02', 'hash-x')
    seed('2026-03', 'hash-y')

    const now = new Date('2026-03-15T02:00:00Z')

    // Nothing about 2026-01 has changed since it was judged, and it is outside
    // the floor, so this run must not touch it.
    const first = await run(now)
    expect(first.months).toBe(2)
    expect(loadHygiene(db, '2026-01')).toEqual({ scoreBp: 10_000, deductions: [] })

    // An edit lands in January. The next sync would write a new hash; simulated
    // here directly, the way `sync.ts` does it.
    seed('2026-01', 'hash-b')

    const second = await run(now)
    expect(second.months).toBe(3)
  })

  it('never rejudges a month whose fingerprint has not moved', async () => {
    seed('2026-01', 'hash-a')
    persistSignals(db, '2026-01', [], { scoreBp: 10_000, deductions: [] }, 'hash-a')
    seed('2026-02', 'hash-x')
    seed('2026-03', 'hash-y')

    const now = new Date('2026-03-15T02:00:00Z')
    await run(now)
    await run(now)
    const third = await run(now)

    // Every run: the two floor months, and nothing else — 2026-01's hash never moved.
    expect(third.months).toBe(2)
  })
})
