/**
 * SQLite connection.
 *
 * `casing: 'snake_case'` is set here AND in drizzle.config.ts — they must agree,
 * or generated migrations will name columns differently from what the runtime
 * queries. It lets columns be declared without repeating the snake_case name.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { config } from '../config.ts'
import { schema } from './schema.ts'

function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const sqlite = new Database(path)

  // SQLite defaults foreign_keys to OFF, which would make every references()
  // in the schema purely decorative. Must be set per connection.
  sqlite.pragma('foreign_keys = ON')
  // WAL lets the HTTP readers work while a job is writing.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  // Wait rather than throw SQLITE_BUSY when a job holds the write lock.
  sqlite.pragma('busy_timeout = 5000')

  return sqlite
}

export const sqlite = openDatabase(config.DATABASE_PATH)

export const db = drizzle(sqlite, { schema, casing: 'snake_case' })

export type Db = typeof db

/** For tests: an isolated in-memory database with the same settings. */
export function createTestDb() {
  const mem = openDatabase(':memory:')
  return { sqlite: mem, db: drizzle(mem, { schema, casing: 'snake_case' }) }
}

export function closeDatabase(): void {
  sqlite.close()
}
