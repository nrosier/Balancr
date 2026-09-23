/**
 * Regression coverage for the `ai_runs.seq` backfill (#514).
 *
 * `recentRuns`'s tie-break used to be SQLite's implicit `rowid`, which only
 * reflects insertion order up to the point a migration rebuilds the table —
 * `0025_unknown_brother_voodoo.sql` already did that once via an unordered
 * `INSERT ... SELECT`. `0039_steady_pandemic.sql` replaces it with a persisted
 * `seq` column, backfilled from `rowid` the one time that is still safe to do
 * so. This seeds rows the way `rowid` actually assigns them — out of
 * `created_at` order, with a same-millisecond tie — and checks the backfill
 * reproduces `recentRuns`'s own ordering rule: `created_at` first, `rowid` only
 * to break a tie.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { seedPreMigrationDb } from '../helpers/pre-migration-db.ts'

const TENANT_ID = 'd020a702-3d59-456c-a944-99c04894a42c'

let contexts: ReturnType<typeof createTestDb>[] = []

afterEach(() => {
  for (const context of contexts) context.sqlite.close()
  contexts = []
})

describe('ai_runs.seq backfill (#514)', () => {
  it('orders by created_at first, falling back to insertion order only on a tie', () => {
    const context = createTestDb()
    contexts.push(context)
    seedPreMigrationDb(context.sqlite, '0038_smooth_kingpin')

    const insert = context.sqlite.prepare(
      `insert into ai_runs (id, tenant_id, kind, model, locale, payload_json, status, created_at)
       values (?, ?, 'findings', 'model', 'en', '{}', 'ok', ?)`,
    )
    // Inserted first (lowest rowid) but the newest run — must still rank last.
    insert.run('run-a', TENANT_ID, Date.parse('2026-09-20T00:00:00Z'))
    // Inserted second, and shares its millisecond with `run-c` inserted after it —
    // insertion order must break that tie.
    insert.run('run-b', TENANT_ID, Date.parse('2026-09-10T00:00:00Z'))
    insert.run('run-c', TENANT_ID, Date.parse('2026-09-10T00:00:00Z'))

    applyMigrations(context.db as never)

    const rows = context.sqlite
      .prepare('select id, seq from ai_runs order by seq asc')
      .all() as { id: string; seq: number }[]
    expect(rows.map((row) => row.id)).toEqual(['run-b', 'run-c', 'run-a'])
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3])
  })
})
