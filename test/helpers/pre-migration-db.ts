/**
 * Reconstructs the schema as it stood after one named migration and fakes
 * drizzle's bookkeeping so `applyMigrations` resumes with the next one.
 *
 * Data migrations need rows that genuinely predate their new columns; inserting
 * a paraphrased old shape into today's schema cannot prove the shipped SQL works.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { migrationsFolder } from '../../src/db/apply-migrations.ts'

interface JournalEntry {
  tag: string
  when: number
}

export function seedPreMigrationDb(
  sqlite: { exec: (sql: string) => unknown },
  lastAppliedTag: string,
): void {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] }

  const lastIdx = journal.entries.findIndex((entry) => entry.tag === lastAppliedTag)
  if (lastIdx === -1) throw new Error(`no journal entry for ${lastAppliedTag}`)

  for (const entry of journal.entries.slice(0, lastIdx + 1)) {
    const source = readFileSync(join(migrationsFolder, `${entry.tag}.sql`), 'utf8')
    for (const statement of source.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed.length > 0) sqlite.exec(trimmed)
    }
  }

  sqlite.exec(
    'CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
  )
  sqlite.exec(
    `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('fixture', ${journal.entries[lastIdx]!.when})`,
  )
}
