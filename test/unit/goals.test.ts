/**
 * The stored savings goals (#407): the four row operations and their ordering.
 *
 * Same contract shape `loans.test.ts` pins for `loan/loans.ts`: a create assigns an
 * id, an edit replaces exactly one row, a delete reports whether it found anything,
 * and every one of the four refuses to see another tenant's row (the isolation case
 * lives in `tenant-isolation.test.ts`, as for every other domain area).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { categoryMeta } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import {
  createGoal,
  deleteGoal,
  listGoals,
  loadGoal,
  markGoalDone,
  MAX_GOALS,
  reactivateGoal,
  TooManyGoalsError,
  UnknownCategoryError,
  updateGoal,
  type GoalInput,
} from '../../src/domain/goal/goals.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

const input = (overrides: Partial<GoalInput> = {}): GoalInput => ({
  label: 'Emergency fund',
  kind: 'liquid',
  priority: 'normal',
  targetCents: 1_000_000,
  targetDate: null,
  ...overrides,
})

describe('the stored goals', () => {
  let ctx: ReturnType<typeof createTestDb>
  let TENANT_ID: string

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
    TENANT_ID = getSoleTenantId(ctx.db)
  })

  it('is an empty list until somebody creates one', () => {
    expect(listGoals(ctx.db, TENANT_ID)).toEqual([])
  })

  it('assigns the id itself and round-trips every field', () => {
    const created = createGoal(ctx.db, TENANT_ID, input({ targetDate: '2027-06-01' }))

    expect(created.id).not.toBe('')
    expect(loadGoal(ctx.db, TENANT_ID, created.id)).toEqual(created)
    expect(listGoals(ctx.db, TENANT_ID)).toEqual([created])
    expect(created.targetDate).toBe('2027-06-01')
  })

  it('defaults label, kind and priority for a bare create', () => {
    const created = createGoal(ctx.db, TENANT_ID, { targetCents: 500_000 })

    expect(created.label).toBe('')
    expect(created.kind).toBe('liquid')
    expect(created.priority).toBe('normal')
    expect(created.targetDate).toBeNull()
  })

  it('orders by priority, then target date ascending with nulls last, then id', () => {
    const low = createGoal(ctx.db, TENANT_ID, input({ priority: 'low', targetDate: '2026-01-01' }))
    const highNoDate = createGoal(ctx.db, TENANT_ID, input({ priority: 'high', targetDate: null }))
    const highEarlier = createGoal(
      ctx.db,
      TENANT_ID,
      input({ priority: 'high', targetDate: '2026-06-01' }),
    )
    const highLater = createGoal(
      ctx.db,
      TENANT_ID,
      input({ priority: 'high', targetDate: '2027-06-01' }),
    )

    expect(listGoals(ctx.db, TENANT_ID).map((row) => row.id)).toEqual([
      highEarlier.id,
      highLater.id,
      highNoDate.id,
      low.id,
    ])
  })

  it('replaces exactly one goal and leaves the other alone', () => {
    const savings = createGoal(ctx.db, TENANT_ID, input())
    const house = createGoal(ctx.db, TENANT_ID, input({ label: 'House deposit', kind: 'invested' }))

    const updated = updateGoal(ctx.db, TENANT_ID, savings.id, input({ targetCents: 2_000_000 }))

    expect(updated?.targetCents).toBe(2_000_000)
    expect(loadGoal(ctx.db, TENANT_ID, house.id)?.targetCents).toBe(1_000_000)
  })

  it('answers null when there is no such goal to update', () => {
    expect(updateGoal(ctx.db, TENANT_ID, 'nope', input())).toBeNull()
  })

  it('reports whether a delete found anything', () => {
    const created = createGoal(ctx.db, TENANT_ID, input())

    expect(deleteGoal(ctx.db, TENANT_ID, created.id)).toBe(true)
    expect(deleteGoal(ctx.db, TENANT_ID, created.id)).toBe(false)
    expect(listGoals(ctx.db, TENANT_ID)).toEqual([])
  })

  it('refuses a non-positive target, a bad date, and a kind that is not a kind', () => {
    expect(() => createGoal(ctx.db, TENANT_ID, input({ targetCents: 0 }))).toThrow()
    expect(() => createGoal(ctx.db, TENANT_ID, input({ targetDate: 'someday' }))).toThrow()
    expect(() => createGoal(ctx.db, TENANT_ID, input({ kind: 'cash' as never }))).toThrow()
  })

  it('refuses an unknown field rather than dropping it', () => {
    expect(() =>
      createGoal(ctx.db, TENANT_ID, { ...input(), stretch: true } as never),
    ).toThrow()
    const created = createGoal(ctx.db, TENANT_ID, input())
    expect(() =>
      updateGoal(ctx.db, TENANT_ID, created.id, { ...input(), stretch: true } as never),
    ).toThrow()
  })

  it('refuses more than the cap, and says so with its own error', () => {
    for (let i = 0; i < MAX_GOALS; i++) {
      createGoal(ctx.db, TENANT_ID, input({ label: `Goal ${String(i)}` }))
    }

    expect(() => createGoal(ctx.db, TENANT_ID, input())).toThrow(TooManyGoalsError)
    expect(listGoals(ctx.db, TENANT_ID)).toHaveLength(MAX_GOALS)
  })

  function seedCategory(id = 'cat-tv'): void {
    ctx.db
      .insert(categoryMeta)
      .values({ tenantId: TENANT_ID, categoryId: id, nameSnapshot: 'TV', isIncome: false, hidden: false })
      .run()
  }

  it('round-trips a category-kind goal naming a known category', () => {
    seedCategory()
    const created = createGoal(
      ctx.db,
      TENANT_ID,
      input({ kind: 'category', categoryId: 'cat-tv', targetDate: '2027-01-01' }),
    )

    expect(created.categoryId).toBe('cat-tv')
    expect(loadGoal(ctx.db, TENANT_ID, created.id)?.categoryId).toBe('cat-tv')
  })

  it('refuses a category-kind goal naming an unknown category', () => {
    expect(() =>
      createGoal(ctx.db, TENANT_ID, input({ kind: 'category', categoryId: 'nope', targetDate: '2027-01-01' })),
    ).toThrow(UnknownCategoryError)
  })

  it('refuses a categoryId on a non-category goal, and a category goal with no categoryId', () => {
    expect(() => createGoal(ctx.db, TENANT_ID, input({ categoryId: 'cat-tv' } as never))).toThrow()
    expect(() => createGoal(ctx.db, TENANT_ID, input({ kind: 'category' } as never))).toThrow()
  })

  it('refuses a category-kind goal with no target date', () => {
    seedCategory()
    expect(() =>
      createGoal(ctx.db, TENANT_ID, input({ kind: 'category', categoryId: 'cat-tv', targetDate: null })),
    ).toThrow()
  })

  it('refuses status and doneAt out of sync', () => {
    expect(() => createGoal(ctx.db, TENANT_ID, input({ status: 'done' } as never))).toThrow()
    expect(() =>
      createGoal(ctx.db, TENANT_ID, input({ doneAt: '2026-01-01' } as never)),
    ).toThrow()
  })

  it('checks the category on update too', () => {
    seedCategory()
    const created = createGoal(
      ctx.db,
      TENANT_ID,
      input({ kind: 'category', categoryId: 'cat-tv', targetDate: '2027-01-01' }),
    )

    expect(() =>
      updateGoal(
        ctx.db,
        TENANT_ID,
        created.id,
        input({ kind: 'category', categoryId: 'nope', targetDate: '2027-01-01' }),
      ),
    ).toThrow(UnknownCategoryError)
  })

  it('marks a goal done and reactivates it', () => {
    const created = createGoal(ctx.db, TENANT_ID, input())

    const done = markGoalDone(ctx.db, TENANT_ID, created.id)
    expect(done?.status).toBe('done')
    expect(done?.doneAt).not.toBeNull()

    const reactivated = reactivateGoal(ctx.db, TENANT_ID, created.id)
    expect(reactivated?.status).toBe('active')
    expect(reactivated?.doneAt).toBeNull()
  })

  it('answers null marking done or reactivating a goal that is not this tenant\'s', () => {
    const otherTenantId = createSecondTenant(ctx.db)
    const created = createGoal(ctx.db, TENANT_ID, input())

    expect(markGoalDone(ctx.db, otherTenantId, created.id)).toBeNull()
    expect(reactivateGoal(ctx.db, otherTenantId, created.id)).toBeNull()
  })
})
