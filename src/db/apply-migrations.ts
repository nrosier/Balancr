import type { Database } from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

export const migrationsFolder = new URL('./migrations', import.meta.url).pathname

/**
 * Applies pending migrations. Used by the CLI and by test fixtures alike.
 *
 * drizzle runs every pending migration inside one `BEGIN…COMMIT`, and SQLite
 * documents `PRAGMA foreign_keys` as a no-op inside a transaction — so the
 * `PRAGMA foreign_keys=OFF` each generated table-rebuild migration opens with
 * never takes effect, and `DROP TABLE <parent>` cascade-deletes children for
 * real. Toggling the pragma on the connection here, outside any transaction,
 * is what actually disables enforcement for the run; it's restored
 * immediately after, since `src/db/index.ts` deliberately turns it on for
 * every other query.
 */
export function applyMigrations(db: BetterSQLite3Database<never> & { $client: Database }): void {
  const sqlite = db.$client
  sqlite.pragma('foreign_keys = OFF')
  try {
    migrate(db, { migrationsFolder })
  } finally {
    sqlite.pragma('foreign_keys = ON')
  }
}
