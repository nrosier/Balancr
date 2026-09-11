/**
 * `sync`'s named steps, run for real.
 *
 * `jobs-runner.test.ts` proves `ctx.step` records order, status and duration
 * against a synthetic job; this file proves the real `syncJob` actually calls
 * `step` four times, in order, and that each one lands in `job_runs.steps_json`
 * through the real `runJob` path — not the `noopStep` bypass every other job
 * test uses, because the point here is the recording itself.
 *
 * Three past, consecutive budget months are enough to reach every step: `load`
 * is always a superset of `targets` (it only trims from the *earlier* end), so
 * feeding a small fixed window through `fetchBudgetMonths`/`fetchBudgetMonth`
 * makes both equal to that window, and choosing months well before the real
 * current one keeps `targets.includes(currentMonth)` false — so the
 * committed/day-curve branches, and the schedule fetches behind them, never
 * run and need no mock.
 */
import { asc, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { jobRuns as jobRunsTable } from '../../src/db/schema.ts'
import { runJob, type JobStep } from '../../src/jobs/runner.ts'
import { syncJob } from '../../src/jobs/sync.ts'
import { budgetMonth } from '../fixtures/budget.ts'
import type { BudgetMonth } from '../../src/adapters/actual/queries.ts'

/** Well before any real "now": keeps `targets` from ever including the current month. */
const MONTHS = ['2020-01', '2020-02', '2020-03']

const gave = {
  months: [...MONTHS] as string[],
  byMonth: new Map(MONTHS.map((month) => [month, budgetMonth(month, [{ id: 'c1', spent: 1_000 }])])),
}

vi.mock('../../src/adapters/actual/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/actual/client.ts')>()),
  syncActual: () => Promise.resolve(),
}))

vi.mock('../../src/adapters/actual/queries.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/actual/queries.ts')>()),
  fetchAccounts: () => Promise.resolve([]),
  fetchBudgetMonths: () => Promise.resolve(gave.months),
  fetchBudgetMonth: (month: string): Promise<BudgetMonth> => {
    const found = gave.byMonth.get(month)
    if (found === undefined) throw new Error(`no fixture for ${month}`)
    return Promise.resolve(found)
  },
  fetchRecomputedSpend: () => Promise.resolve([]),
}))

vi.mock('../../src/adapters/ghostfolio/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/ghostfolio/client.ts')>()),
  fetchAccounts: () => Promise.resolve({ accounts: [] }),
}))

let db: Db

beforeEach(() => {
  const ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
  gave.months = [...MONTHS]
})

const steps = (): JobStep[] => {
  const row = db
    .select({ stepsJson: jobRunsTable.stepsJson })
    .from(jobRunsTable)
    .where(eq(jobRunsTable.jobName, 'sync'))
    .orderBy(asc(jobRunsTable.startedAt))
    .all()[0]
  if (row === undefined) throw new Error('no job_runs row for sync')
  return JSON.parse(row.stepsJson) as JobStep[]
}

describe('a real sync run', () => {
  it('records connect, fetch, compute and accounts, in order, all ok', async () => {
    await runJob(db, syncJob)

    expect(steps().map((step) => step.name)).toEqual(['connect', 'fetch', 'compute', 'accounts'])
    expect(steps().every((step) => step.status === 'ok')).toBe(true)
  })
})
