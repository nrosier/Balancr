import type { Db } from './index.ts'
import { tenants } from './schema.ts'

/**
 * Interim stand-in for real per-tenant context (#371/#372 will thread an
 * actual tenant id through call sites instead). Throws if more than one
 * tenant exists, since that can't happen before #373 builds provisioning —
 * a throw here means something upstream already broke that invariant.
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
