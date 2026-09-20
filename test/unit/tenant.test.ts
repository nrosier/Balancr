/**
 * `getSoleTenantId` and the default-tenant backfill migration (0024) are the
 * whole multi-tenant foundation for now: every write site relies on exactly
 * one tenant existing, and the backfill is what guarantees that's still true
 * for data that predates the `tenants` table. Both are worth testing directly
 * rather than only through the call sites that happen to use them.
 */
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { tenants, users } from '../../src/db/schema.ts'
import { allTenantIds, getSoleTenantId } from '../../src/db/tenant.ts'
import { seedPreMigrationDb } from '../helpers/pre-migration-db.ts'

describe('default-tenant backfill migration', () => {
  it('seeds exactly one tenant labelled Default', () => {
    const { db } = createTestDb()
    applyMigrations(db as never)

    const allTenants = db.select().from(tenants).all()
    expect(allTenants).toHaveLength(1)
    expect(allTenants[0]?.label).toBe('Default')
  })

  it('points a row created before the migration ran at the seeded tenant', () => {
    const { sqlite, db } = createTestDb()
    seedPreMigrationDb(sqlite, '0023_optimal_adam_destine')
    // The shape every pre-existing deployment's data is in: a row written
    // while `tenant_id` was still a column that didn't exist to fill in.
    // `created_at` has no SQL-level default — drizzle applies it client-side
    // — so a raw insert has to supply one itself.
    sqlite.exec("INSERT INTO users (id, created_at) VALUES ('legacy-user', 0)")

    applyMigrations(db as never)

    const [tenant] = db.select().from(tenants).all()
    expect(tenant).toBeDefined()
    const [user] = db.select().from(users).where(eq(users.id, 'legacy-user')).all()
    expect(user?.tenantId).toBe(tenant?.id)
  })
})

describe('getSoleTenantId', () => {
  let ctx: ReturnType<typeof createTestDb>

  beforeEach(() => {
    ctx = createTestDb()
    applyMigrations(ctx.db as never)
  })

  it('returns the one tenant the backfill seeded', () => {
    const [tenant] = ctx.db.select().from(tenants).all()
    expect(getSoleTenantId(ctx.db)).toBe(tenant?.id)
  })

  it('throws when no tenant exists', () => {
    ctx.sqlite.prepare('delete from tenants').run()
    expect(() => getSoleTenantId(ctx.db)).toThrow(/expected exactly one tenant, found 0/)
  })

  it('throws when more than one tenant exists', () => {
    ctx.db.insert(tenants).values({ id: 'second-tenant', label: 'Second' }).run()
    expect(() => getSoleTenantId(ctx.db)).toThrow(/expected exactly one tenant, found 2/)
  })
})

describe('allTenantIds', () => {
  it('returns every tenant once a second one exists (#373 onboarding)', () => {
    const { db, sqlite } = createTestDb()
    applyMigrations(db as never)
    try {
      const [bootstrap] = db.select().from(tenants).all()
      const second = db.insert(tenants).values({ label: 'Second' }).returning().all()[0]

      const ids = allTenantIds(db)
      expect(ids).toHaveLength(2)
      expect(ids).toEqual(expect.arrayContaining([bootstrap?.id, second?.id]))
    } finally {
      sqlite.close()
    }
  })
})
