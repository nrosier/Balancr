import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

export const migrationsFolder = new URL('./migrations', import.meta.url).pathname

/** Applies pending migrations. Used by the CLI and by test fixtures alike. */
export function applyMigrations(db: BetterSQLite3Database<never>): void {
  migrate(db, { migrationsFolder })
}
