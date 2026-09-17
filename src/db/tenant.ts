import type { Db } from './index.ts'
import { tenants } from './schema.ts'

/**
 * CLI and break-glass use only, now that #376 has threaded a real tenantId
 * through every request-path call site. Still legitimate for
 * `scripts/local-user.ts --tenant` and other one-off tooling with no session
 * to read a tenant id from. Throws if more than one tenant exists, so a throw
 * from a request-path caller means it should have taken a tenantId instead.
 */
export function getSoleTenantId(db: Db): string {
  const rows = db.select({ id: tenants.id }).from(tenants).all()
  const [row] = rows
  if (!row || rows.length !== 1) throw new Error(`expected exactly one tenant, found ${rows.length}`)
  return row.id
}

/**
 * Every tenant the scheduler must fan out over (#372), ordered by creation so a
 * tick's fan-out order is stable and reproducible rather than whatever order
 * SQLite happens to return.
 */
export function allTenantIds(db: Db): string[] {
  return db
    .select({ id: tenants.id })
    .from(tenants)
    .orderBy(tenants.createdAt)
    .all()
    .map((row) => row.id)
}
