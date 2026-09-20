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
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

let ctx: ReturnType<typeof createTestDb>
let TENANT_ID: string

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
  TENANT_ID = getSoleTenantId(ctx.db)
})

/**
 * One row in every table Balancr has, computed and durable alike.
 *
 * Takes `tenantId` and a `suffix` rather than closing over `TENANT_ID`, so the
 * cross-tenant test below can seed two tenants' worth of rows without their
 * globally-unique ids (`accountMap.id`, `aiRuns.id`, ...) colliding.
 */
function seed(tenantId: string, suffix = '1'): { userId: string; accountMapId: string; runId: string } {
  const db = ctx.db

  const [user] = db
    .insert(users)
    .values({
      id: `user-${suffix}`,
      tenantId,
      email: `owner-${suffix}@example.com`,
      role: 'owner',
    })
    .returning({ id: users.id })
    .all()
  const userId = user!.id

  db.insert(sessions)
    .values({
      id: `session-${suffix}`,
      userId,
      method: 'local',
      expiresAt: new Date('2026-12-31'),
    })
    .run()

  const [account] = db
    .insert(accountMap)
    .values({
      id: `account-${suffix}`,
      tenantId,
      source: 'actual',
      externalId: 'ext-1',
      name: 'Checking',
    })
    .returning({ id: accountMap.id })
    .all()
  const accountMapId = account!.id

  db.insert(categoryMeta)
    .values({ tenantId, categoryId: 'cat-1', nameSnapshot: 'Nutsvoorzieningen' })
    .run()

  db.insert(clarificationQueue)
    .values({ id: `clar-${suffix}`, tenantId, categoryId: 'cat-1', questionCode: 'frequency' })
    .run()

  db.insert(settings).values({ tenantId, key: 'locale', valueJson: '"nl"' }).run()

  db.insert(prompts)
    .values({
      id: `prompt-${suffix}`,
      tenantId,
      key: `analysis.system-${suffix}`,
      locale: 'nl',
      version: 1,
      body: 'x',
    })
    .run()

  const [run] = db
    .insert(aiRuns)
    .values({
      id: `run-${suffix}`,
      tenantId,
      kind: 'findings',
      model: 'gemini-x',
      locale: 'nl',
      payloadJson: '{}',
      status: 'ok',
    })
    .returning({ id: aiRuns.id })
    .all()
  const runId = run!.id

  db.insert(aiFindings)
    .values({ id: `finding-${suffix}`, tenantId, runId, code: 'above_baseline' })
    .run()
  db.insert(aiNarratives)
    .values({
      id: `narrative-${suffix}`,
      tenantId,
      runId,
      period: '2026-08',
      locale: 'nl',
      bodyMd: 'x',
    })
    .run()

  db.insert(proposals)
    .values({
      id: `proposal-${suffix}`,
      tenantId,
      type: 'category_meta.set',
      targetRef: 'cat-1',
      payloadJson: '{}',
    })
    .run()

  db.insert(auditLog)
    .values({
      id: `audit-${suffix}`,
      tenantId,
      action: 'jobs.refresh',
      entity: 'jobs',
      entityRef: 'refresh',
    })
    .run()

  db.insert(jobs).values({ name: `sync-${suffix}`, tenantId }).run()

  db.insert(monthlyCategoryFacts).values({ tenantId, month: '2026-08', categoryId: 'cat-1' }).run()
  db.insert(monthlyTotals).values({ tenantId, month: '2026-08' }).run()
  db.insert(recomputeMismatches)
    .values({
      tenantId,
      month: '2026-08',
      categoryId: 'cat-1',
      categoryName: 'Nutsvoorzieningen',
      actualCents: 1_000,
      recomputedCents: 1_000,
      differenceCents: 0,
    })
    .run()
  db.insert(monthlyHygiene)
    .values({ tenantId, month: '2026-08', scoreBp: 10_000, deductionsJson: '[]' })
    .run()
  db.insert(monthlySignals)
    .values({
      tenantId,
      month: '2026-08',
      code: 'above_baseline',
      subjectKey: 'cat-1',
      severity: 'info',
      metricsJson: '{}',
    })
    .run()
  db.insert(categoryGuessCandidates)
    .values({
      tenantId,
      month: '2026-08',
      transactionId: 'txn-1',
      payeeId: 'payee-1',
      amountCents: 1_000,
      date: '2026-08-15',
      historyJson: '[]',
    })
    .run()
  db.insert(netWorthSnapshots).values({ tenantId, date: '2026-08-15', accountMapId, valueCents: 100_000 }).run()
  db.insert(portfolioSnapshots)
    .values({
      tenantId,
      date: '2026-08-15',
      instrument: 'IE00B4L5Y983',
      quantity: '1.5',
      priceCents: 8_000,
      valueCents: 12_000,
    })
    .run()
  db.insert(portfolioMetrics).values({ tenantId, date: '2026-08-15' }).run()

  return { userId, accountMapId, runId }
}

describe('resetComputedData', () => {
  it('empties exactly the nine computed tables and nothing else', () => {
    seed(TENANT_ID)

    const result = resetComputedData(ctx.db, TENANT_ID)

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

  it('never touches another tenant\'s computed rows (#379)', () => {
    const tenantB = createSecondTenant(ctx.db, 'Second')
    seed(TENANT_ID, 'a')
    seed(tenantB, 'b')

    const result = resetComputedData(ctx.db, tenantB)

    // Only tenant B's rows were counted and wiped.
    for (const { name } of COMPUTED_TABLES) {
      expect(result.find((row) => row.table === name)?.rows).toBe(1)
    }
    for (const { table } of COMPUTED_TABLES) {
      const remaining = ctx.db.select().from(table).all() as { tenantId: string }[]
      expect(remaining).toHaveLength(1)
      expect(remaining[0]?.tenantId).toBe(TENANT_ID)
    }
  })
})
