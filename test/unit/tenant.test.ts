/**
 * `getSoleTenantId` and the default-tenant backfill migration (0024) are the
 * whole multi-tenant foundation for now: every write site relies on exactly
 * one tenant existing, and the backfill is what guarantees that's still true
 * for data that predates the `tenants` table. Both are worth testing directly
 * rather than only through the call sites that happen to use them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, migrationsFolder } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { tenants, users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'

interface JournalEntry {
  tag: string
  when: number
}

/**
 * Fakes drizzle's own migration bookkeeping so a later `applyMigrations` call
 * treats every migration up to and including `lastAppliedTag` as already run,
 * after executing their raw SQL directly. This reproduces a database as it
 * stood just before the backfill migration (0024), so the backfill itself —
 * the one hand-written, data-touching migration in this project — can be
 * exercised against a row that predates it, the way a real deployment's does.
 */
function seedPreMigrationDb(sqlite: { exec: (sql: string) => unknown }, lastAppliedTag: string): void {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] }

  const lastIdx = journal.entries.findIndex((entry) => entry.tag === lastAppliedTag)
  if (lastIdx === -1) throw new Error(`no journal entry for ${lastAppliedTag}`)

  for (const entry of journal.entries.slice(0, lastIdx + 1)) {
    const sql = readFileSync(join(migrationsFolder, `${entry.tag}.sql`), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed.length > 0) sqlite.exec(trimmed)
    }
  }

  // Mirrors the table drizzle's migrator creates for itself, with one row
  // dated at the last migration we just ran by hand — `migrate()` only looks
  // at the newest `created_at` to decide where to resume.
  sqlite.exec(
    'CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  )
  sqlite.exec(
    `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('fixture', ${journal.entries[lastIdx]!.when})`,
  )
}

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
