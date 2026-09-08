/**
 * The wipe-scope contract `resetComputedData` exists to guarantee: exactly the nine
 * "computed facts" tables empty out, and nothing else does — durable state, identity,
 * configuration and the AI ledger all survive untouched.
 *
 * Every table below gets one hand-inserted row rather than a row built through a
 * domain persist helper, because the question this test asks is about table scope,
 * not about any one pass's own persistence logic — that is what the helpers already
 * under test elsewhere (`month-store.test.ts`, `signals-store.ts`'s own suite, ...)
 * are for.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import {
  accountMap,
  aiFindings,
  aiNarratives,
  aiRuns,
  auditLog,
  categoryGuessCandidates,
  categoryMeta,
  clarificationQueue,
  jobs,
  monthlyCategoryFacts,
  monthlyHygiene,
  monthlySignals,
  monthlyTotals,
  netWorthSnapshots,
  portfolioMetrics,
  portfolioSnapshots,
  proposals,
  prompts,
  recomputeMismatches,
  sessions,
  settings,
  users,
} from '../../src/db/schema.ts'
import { resetComputedData } from '../../src/domain/aggregate/reset.ts'

let ctx: ReturnType<typeof createTestDb>

const COMPUTED_TABLES = [
  { name: 'monthly_category_facts', table: monthlyCategoryFacts },
  { name: 'monthly_totals', table: monthlyTotals },
  { name: 'recompute_mismatches', table: recomputeMismatches },
  { name: 'monthly_hygiene', table: monthlyHygiene },
  { name: 'monthly_signals', table: monthlySignals },
  { name: 'category_guess_candidates', table: categoryGuessCandidates },
  { name: 'net_worth_snapshots', table: netWorthSnapshots },
  { name: 'portfolio_snapshots', table: portfolioSnapshots },
  { name: 'portfolio_metrics', table: portfolioMetrics },
] as const

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
})

/** One row in every table Balancr has, computed and durable alike. */
function seed(): { userId: string; accountMapId: string; runId: string } {
  const db = ctx.db

  const [user] = db
    .insert(users)
    .values({ id: 'user-1', email: 'owner@example.com', role: 'owner' })
    .returning({ id: users.id })
    .all()
  const userId = user!.id

  db.insert(sessions)
    .values({
      id: 'session-1',
      userId,
      method: 'local',
      expiresAt: new Date('2026-12-31'),
    })
    .run()

  const [account] = db
    .insert(accountMap)
    .values({ id: 'account-1', source: 'actual', externalId: 'ext-1', name: 'Checking' })
    .returning({ id: accountMap.id })
    .all()
  const accountMapId = account!.id

  db.insert(categoryMeta)
    .values({ categoryId: 'cat-1', nameSnapshot: 'Nutsvoorzieningen' })
    .run()

  db.insert(clarificationQueue)
    .values({ id: 'clar-1', categoryId: 'cat-1', questionCode: 'frequency' })
    .run()

  db.insert(settings).values({ key: 'locale', valueJson: '"nl"' }).run()

  db.insert(prompts)
    .values({ id: 'prompt-1', key: 'analysis.system', locale: 'nl', version: 1, body: 'x' })
    .run()

  const [run] = db
    .insert(aiRuns)
    .values({
      id: 'run-1',
      kind: 'findings',
      model: 'gemini-x',
      locale: 'nl',
      payloadJson: '{}',
      status: 'ok',
    })
    .returning({ id: aiRuns.id })
    .all()
  const runId = run!.id

  db.insert(aiFindings).values({ id: 'finding-1', runId, code: 'above_baseline' }).run()
  db.insert(aiNarratives)
    .values({ id: 'narrative-1', runId, period: '2026-08', locale: 'nl', bodyMd: 'x' })
    .run()

  db.insert(proposals)
    .values({ id: 'proposal-1', type: 'category_meta.set', targetRef: 'cat-1', payloadJson: '{}' })
    .run()

  db.insert(auditLog)
    .values({ id: 'audit-1', action: 'jobs.refresh', entity: 'jobs', entityRef: 'refresh' })
    .run()

  db.insert(jobs).values({ name: 'sync' }).run()

  db.insert(monthlyCategoryFacts).values({ month: '2026-08', categoryId: 'cat-1' }).run()
  db.insert(monthlyTotals).values({ month: '2026-08' }).run()
  db.insert(recomputeMismatches)
    .values({
      month: '2026-08',
      categoryId: 'cat-1',
      categoryName: 'Nutsvoorzieningen',
      actualCents: 1_000,
      recomputedCents: 1_000,
      differenceCents: 0,
    })
    .run()
  db.insert(monthlyHygiene)
    .values({ month: '2026-08', scoreBp: 10_000, deductionsJson: '[]' })
    .run()
  db.insert(monthlySignals)
    .values({
      month: '2026-08',
      code: 'above_baseline',
      subjectKey: 'cat-1',
      severity: 'info',
      metricsJson: '{}',
    })
    .run()
  db.insert(categoryGuessCandidates)
    .values({
      month: '2026-08',
      transactionId: 'txn-1',
      payeeId: 'payee-1',
      amountCents: 1_000,
      date: '2026-08-15',
      historyJson: '[]',
    })
    .run()
  db.insert(netWorthSnapshots)
    .values({ date: '2026-08-15', accountMapId, valueCents: 100_000 })
    .run()
  db.insert(portfolioSnapshots)
    .values({
      date: '2026-08-15',
      instrument: 'IE00B4L5Y983',
      quantity: '1.5',
      priceCents: 8_000,
      valueCents: 12_000,
    })
    .run()
  db.insert(portfolioMetrics).values({ date: '2026-08-15' }).run()

  return { userId, accountMapId, runId }
}

describe('resetComputedData', () => {
  it('empties exactly the nine computed tables and nothing else', () => {
    seed()

    const result = resetComputedData(ctx.db)

    expect(result).toHaveLength(COMPUTED_TABLES.length)
    for (const { name } of COMPUTED_TABLES) {
      expect(result.find((row) => row.table === name)?.rows).toBe(1)
    }

    for (const { table } of COMPUTED_TABLES) {
      expect(ctx.db.select().from(table).all()).toHaveLength(0)
    }

    // Durable state, identity, configuration and — the point of this test — the AI
    // ledger, all survive: a reset regenerates figures, it does not touch judgement
    // or the record of what has already been spent.
    expect(ctx.db.select().from(users).all()).toHaveLength(1)
    expect(ctx.db.select().from(sessions).all()).toHaveLength(1)
    expect(ctx.db.select().from(accountMap).all()).toHaveLength(1)
    expect(ctx.db.select().from(categoryMeta).all()).toHaveLength(1)
    expect(ctx.db.select().from(clarificationQueue).all()).toHaveLength(1)
    expect(ctx.db.select().from(settings).all()).toHaveLength(1)
    expect(ctx.db.select().from(prompts).all()).toHaveLength(1)
    expect(ctx.db.select().from(aiRuns).all()).toHaveLength(1)
    expect(ctx.db.select().from(aiFindings).all()).toHaveLength(1)
    expect(ctx.db.select().from(aiNarratives).all()).toHaveLength(1)
    expect(ctx.db.select().from(proposals).all()).toHaveLength(1)
    expect(ctx.db.select().from(auditLog).all()).toHaveLength(1)
    expect(ctx.db.select().from(jobs).all()).toHaveLength(1)
  })
})
