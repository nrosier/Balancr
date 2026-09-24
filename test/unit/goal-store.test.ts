/**
 * `loadGoalsWithProgress` (#407 extension) — the one place `/api/overview`,
 * `/api/budget` and `ai/bundle.ts` all read goal progress from.
 *
 * Net-worth-kind goals are a regression check for the `computeGoalProgress`
 * signature refactor (goals-progress.test.ts pins the pure function itself); the
 * rest of this file is the category-pool orchestration that only exists here,
 * where a DB read of sibling goals and category history is possible.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { categoryMeta, monthlyCategoryFacts } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { categorySiblingCount, loadGoalsWithProgress } from '../../src/domain/aggregate/goal-store.ts'
import { createGoal, updateGoal, type GoalInput } from '../../src/domain/goal/goals.ts'
import type { NetWorthSummary } from '../../src/domain/aggregate/networth.ts'

let ctx: ReturnType<typeof createTestDb>
let TENANT_ID: string

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  TENANT_ID = getSoleTenantId(ctx.db)
})

const netWorth = (overrides: Partial<NetWorthSummary> = {}): NetWorthSummary => ({
  date: '2026-09-01',
  totalCents: 900_000,
  liquidCents: 600_000,
  investedCents: 300_000,
  debtCents: 0,
  ...overrides,
})

function seedCategory(categoryId: string, availableCents: number, month = '2026-09'): void {
  ctx.db
    .insert(categoryMeta)
    .values({ tenantId: TENANT_ID, categoryId, nameSnapshot: categoryId, isIncome: false, hidden: false })
    .run()
  ctx.db
    .insert(monthlyCategoryFacts)
    .values({ tenantId: TENANT_ID, month, categoryId, availableCents })
    .run()
}

const goal = (overrides: Partial<GoalInput> = {}): GoalInput => ({
  label: 'Goal',
  kind: 'liquid',
  priority: 'normal',
  targetCents: 1_000_000,
  targetDate: null,
  ...overrides,
})

describe('a net-worth-kind goal', () => {
  it('resolves currentCents from the given net-worth summary, same as before the refactor', () => {
    const created = createGoal(ctx.db, TENANT_ID, goal({ kind: 'liquid' }))

    const results = loadGoalsWithProgress(ctx.db, TENANT_ID, netWorth(), '2026-09', '2026-09-24')
    const result = results.find((row) => row.id === created.id)

    expect(result?.currentCents).toBe(600_000)
    expect(result?.progressBp).toBe(6_000)
    expect(result?.met).toBe(false)
    expect(result?.trendMonths).toBe(0)
  })

  it('answers null throughout with no net worth yet', () => {
    const created = createGoal(ctx.db, TENANT_ID, goal())

    const results = loadGoalsWithProgress(ctx.db, TENANT_ID, null, '2026-09', '2026-09-24')
    const result = results.find((row) => row.id === created.id)

    expect(result?.currentCents).toBeNull()
    expect(result?.progressBp).toBeNull()
    expect(result?.requiredMonthlyCents).toBeNull()
    expect(result?.pace).toBeNull()
  })
})

describe('a lone category-kind goal', () => {
  it('draws the whole pool', () => {
    seedCategory('cat-tv', 30_000)
    const created = createGoal(
      ctx.db,
      TENANT_ID,
      goal({ kind: 'category', categoryId: 'cat-tv', targetDate: '2026-11-30', targetCents: 100_000 }),
    )

    const results = loadGoalsWithProgress(ctx.db, TENANT_ID, null, '2026-09', '2026-09-24')
    const result = results.find((row) => row.id === created.id)

    expect(result?.currentCents).toBe(30_000)
    expect(result?.progressBp).toBe(3_000)
  })

  it('answers null when the category has no fact row yet, rather than treating it as zero', () => {
    ctx.db
      .insert(categoryMeta)
      .values({ tenantId: TENANT_ID, categoryId: 'cat-tv', nameSnapshot: 'TV', isIncome: false, hidden: false })
      .run()
    const created = createGoal(
      ctx.db,
      TENANT_ID,
      goal({ kind: 'category', categoryId: 'cat-tv', targetDate: '2026-11-30' }),
    )

    const results = loadGoalsWithProgress(ctx.db, TENANT_ID, null, '2026-09', '2026-09-24')
    const result = results.find((row) => row.id === created.id)

    expect(result?.currentCents).toBeNull()
  })
})

describe('two goals sharing one category', () => {
  it('split the pool proportional to urgency, not raw target size', () => {
    seedCategory('cat-tv', 30_000)
    // A: due this month, target €500 -> weight 50 000/1mo.
    const a = createGoal(
      ctx.db,
      TENANT_ID,
      goal({ label: 'A', categoryId: 'cat-tv', kind: 'category', targetDate: '2026-09-30', targetCents: 50_000 }),
    )
    // B: due two months out, target €1000 -> the same weight, 100 000/2mo.
    const b = createGoal(
      ctx.db,
      TENANT_ID,
      goal({ label: 'B', categoryId: 'cat-tv', kind: 'category', targetDate: '2026-11-30', targetCents: 100_000 }),
    )

    const results = loadGoalsWithProgress(ctx.db, TENANT_ID, null, '2026-09', '2026-09-24')

    expect(results.find((row) => row.id === a.id)?.currentCents).toBe(15_000)
    expect(results.find((row) => row.id === b.id)?.currentCents).toBe(15_000)
  })
})

describe('a done goal within its grace window', () => {
  it('returns every progress field null, with status/doneAt intact, and frees its pool share', () => {
    seedCategory('cat-tv', 30_000)
    const active = createGoal(
      ctx.db,
      TENANT_ID,
      goal({ label: 'Active', categoryId: 'cat-tv', kind: 'category', targetDate: '2026-11-30', targetCents: 100_000 }),
    )
    const done = createGoal(
      ctx.db,
      TENANT_ID,
      goal({ label: 'Done', categoryId: 'cat-tv', kind: 'category', targetDate: '2026-11-30', targetCents: 100_000 }),
    )
    updateGoal(ctx.db, TENANT_ID, done.id, {
      ...goal({ categoryId: 'cat-tv', kind: 'category', targetDate: '2026-11-30', targetCents: 100_000 }),
      status: 'done',
      doneAt: '2026-09-20',
    })

    const results = loadGoalsWithProgress(ctx.db, TENANT_ID, null, '2026-09', '2026-09-24')

    const doneResult = results.find((row) => row.id === done.id)
    expect(doneResult?.status).toBe('done')
    expect(doneResult?.doneAt).toBe('2026-09-20')
    expect(doneResult?.currentCents).toBeNull()
    expect(doneResult?.progressBp).toBeNull()
    expect(doneResult?.pace).toBeNull()

    // The done goal no longer shares the pool, so the sole remaining active goal
    // draws all of it rather than half.
    expect(results.find((row) => row.id === active.id)?.currentCents).toBe(30_000)

    // Nor does it still count as a sibling — it's frozen, not an active co-tenant of the pool.
    const activeResult = results.find((row) => row.id === active.id)
    expect(activeResult && categorySiblingCount(results, activeResult)).toBe(0)
  })
})

describe('a goal created after the month being narrated', () => {
  it('does not appear in a rejudge of a month before it existed', () => {
    const created = createGoal(ctx.db, TENANT_ID, goal({ kind: 'liquid' }))

    // createGoal stamps createdAt as real wall-clock "now"; asking for a month
    // years before that must not surface a goal that did not exist yet.
    const results = loadGoalsWithProgress(ctx.db, TENANT_ID, netWorth(), '2020-01', '2026-09-24')

    expect(results.find((row) => row.id === created.id)).toBeUndefined()
  })
})

describe('a category with no fact row for the month being narrated', () => {
  it('answers null rather than falling back to an earlier month\'s stale balance', () => {
    // Only August has a fact row; September (the narrated month) has none.
    seedCategory('cat-tv', 30_000, '2026-08')
    const created = createGoal(
      ctx.db,
      TENANT_ID,
      goal({ kind: 'category', categoryId: 'cat-tv', targetDate: '2026-11-30' }),
    )

    const results = loadGoalsWithProgress(ctx.db, TENANT_ID, null, '2026-09', '2026-09-24')
    const result = results.find((row) => row.id === created.id)

    expect(result?.currentCents).toBeNull()
  })
})

describe('a lone category goal whose pool is exactly zero this month', () => {
  it('still scales its historical trend by its full share (1), rather than flattening it to zero', () => {
    seedCategory('cat-tv', 20_000, '2026-08')
    // Same category, a second month — not a second categoryMeta row (that column
    // pair is the table's primary key).
    ctx.db
      .insert(monthlyCategoryFacts)
      .values({ tenantId: TENANT_ID, month: '2026-09', categoryId: 'cat-tv', availableCents: 0 })
      .run()
    const created = createGoal(
      ctx.db,
      TENANT_ID,
      goal({ kind: 'category', categoryId: 'cat-tv', targetDate: '2026-11-30' }),
    )

    const results = loadGoalsWithProgress(ctx.db, TENANT_ID, null, '2026-09', '2026-09-24')
    const result = results.find((row) => row.id === created.id)

    expect(result?.currentCents).toBe(0)
    // A lone goal's share ratio is 1 regardless of the current pool's size, so the
    // trend behind it is the category's own history, unscaled to zero.
    expect(result?.monthlyRateCents).toBe(-20_000)
  })
})

describe('two equally-weighted goals sharing a pool that gains exactly one cent', () => {
  it('does not report a spurious rate for the goal that received none of it', () => {
    seedCategory('cat-tv', 1_000_000, '2026-08')
    ctx.db
      .insert(monthlyCategoryFacts)
      .values({ tenantId: TENANT_ID, month: '2026-09', categoryId: 'cat-tv', availableCents: 1_000_001 })
      .run()
    const a = createGoal(
      ctx.db,
      TENANT_ID,
      goal({ label: 'A', categoryId: 'cat-tv', kind: 'category', targetDate: '2026-12-01', targetCents: 5_000_000 }),
    )
    const b = createGoal(
      ctx.db,
      TENANT_ID,
      goal({ label: 'B', categoryId: 'cat-tv', kind: 'category', targetDate: '2026-12-01', targetCents: 5_000_000 }),
    )

    const results = loadGoalsWithProgress(ctx.db, TENANT_ID, null, '2026-09', '2026-09-24')
    const resultA = results.find((row) => row.id === a.id)
    const resultB = results.find((row) => row.id === b.id)

    // Exactly one of the two picks up the pool's single extra cent (largest-remainder
    // tie-break); together their currentCents still sum to the whole pool.
    expect([resultA?.currentCents, resultB?.currentCents].sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([
      500_000, 500_001,
    ])
    const loser = resultA?.currentCents === 500_000 ? resultA : resultB
    // Its own balance never moved — flat at 500 000 both months — so the rate must
    // read as flat too, not a phantom one-cent gain borrowed from the ratio scale
    // used for earlier trend points (`goalPoolShareRatio` rounds .5 the same way for
    // both goals, regardless of which one the pool split's remainder actually went to).
    expect(loser?.monthlyRateCents).toBe(0)
    expect(loser?.monthsToTarget).toBeNull()
  })
})

describe('a done goal past its grace window', () => {
  it('is excluded from the result array and from its siblings\' pool split', () => {
    seedCategory('cat-tv', 30_000)
    const active = createGoal(
      ctx.db,
      TENANT_ID,
      goal({ label: 'Active', categoryId: 'cat-tv', kind: 'category', targetDate: '2026-11-30', targetCents: 100_000 }),
    )
    const done = createGoal(
      ctx.db,
      TENANT_ID,
      goal({ label: 'Done', categoryId: 'cat-tv', kind: 'category', targetDate: '2026-11-30', targetCents: 100_000 }),
    )
    updateGoal(ctx.db, TENANT_ID, done.id, {
      ...goal({ categoryId: 'cat-tv', kind: 'category', targetDate: '2026-11-30', targetCents: 100_000 }),
      status: 'done',
      // More than GOAL_DONE_GRACE_DAYS (7) before "today" below.
      doneAt: '2026-09-01',
    })

    const results = loadGoalsWithProgress(ctx.db, TENANT_ID, null, '2026-09', '2026-09-24')

    expect(results.find((row) => row.id === done.id)).toBeUndefined()
    expect(results.find((row) => row.id === active.id)?.currentCents).toBe(30_000)
  })
})
