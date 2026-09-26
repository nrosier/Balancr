/**
 * Regression coverage for #577 (D1 in docs/security-review-2026-09-26.md):
 * `PRAGMA foreign_keys=OFF` inside a generated table-rebuild migration is a
 * no-op, because drizzle runs every pending migration inside one
 * `BEGIN…COMMIT` and SQLite ignores that pragma inside a transaction. Every
 * `DROP TABLE <parent>` in `0025_unknown_brother_voodoo.sql` therefore fired
 * `ON DELETE CASCADE` on its children for real, on any upgrade that already
 * had data — silently and irreversibly.
 *
 * Seeds one child row for each cascade named in the finding, at the schema
 * as it stood the migration before, then runs every later migration
 * (through the current head) and checks the child survived.
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

describe('generated table-rebuild migrations do not cascade-delete children (#577)', () => {
  it('survives the account_map rebuild: a net_worth_snapshots row is not dropped', () => {
    const context = createTestDb()
    contexts.push(context)
    seedPreMigrationDb(context.sqlite, '0024_seed_default_tenant')

    context.sqlite
      .prepare(
        `insert into account_map (id, tenant_id, source, external_id, name, created_at)
         values ('acct-1', ?, 'actual', 'ext-1', 'Checking', ?)`,
      )
      .run(TENANT_ID, Date.now())
    context.sqlite
      .prepare(
        `insert into net_worth_snapshots (date, tenant_id, account_map_id, value_cents, computed_at)
         values ('2026-01-01', ?, 'acct-1', 100000, ?)`,
      )
      .run(TENANT_ID, Date.now())

    applyMigrations(context.db as never)

    const row = context.sqlite
      .prepare('select account_map_id from net_worth_snapshots where account_map_id = ?')
      .get('acct-1')
    expect(row).toBeDefined()
  })

  it('survives the ai_runs rebuild: ai_findings and ai_narratives rows are not dropped', () => {
    const context = createTestDb()
    contexts.push(context)
    seedPreMigrationDb(context.sqlite, '0024_seed_default_tenant')

    context.sqlite
      .prepare(
        `insert into ai_runs (id, tenant_id, kind, model, locale, payload_json, status, created_at)
         values ('run-1', ?, 'findings', 'model', 'en', '{}', 'ok', ?)`,
      )
      .run(TENANT_ID, Date.now())
    context.sqlite
      .prepare(
        `insert into ai_findings (id, tenant_id, run_id, code, created_at)
         values ('finding-1', ?, 'run-1', 'code', ?)`,
      )
      .run(TENANT_ID, Date.now())
    context.sqlite
      .prepare(
        `insert into ai_narratives (id, tenant_id, run_id, period, locale, body_md, created_at)
         values ('narrative-1', ?, 'run-1', '2026-01', 'en', 'body', ?)`,
      )
      .run(TENANT_ID, Date.now())

    applyMigrations(context.db as never)

    expect(context.sqlite.prepare('select id from ai_findings where id = ?').get('finding-1')).toBeDefined()
    expect(context.sqlite.prepare('select id from ai_narratives where id = ?').get('narrative-1')).toBeDefined()
  })

  it('survives the users rebuild: local_credentials and sessions rows are not dropped', () => {
    const context = createTestDb()
    contexts.push(context)
    seedPreMigrationDb(context.sqlite, '0024_seed_default_tenant')

    context.sqlite
      .prepare(`insert into users (id, tenant_id, created_at) values ('user-1', ?, ?)`)
      .run(TENANT_ID, Date.now())
    context.sqlite
      .prepare(
        `insert into local_credentials (user_id, password_hash, totp_secret, password_changed_at)
         values ('user-1', 'hash', 'secret', ?)`,
      )
      .run(Date.now())
    context.sqlite
      .prepare(
        `insert into sessions (id, user_id, method, created_at, expires_at)
         values ('sess-1', 'user-1', 'local', ?, ?)`,
      )
      .run(Date.now(), Date.now() + 1000)

    applyMigrations(context.db as never)

    expect(
      context.sqlite.prepare('select user_id from local_credentials where user_id = ?').get('user-1'),
    ).toBeDefined()
    expect(context.sqlite.prepare('select id from sessions where id = ?').get('sess-1')).toBeDefined()
  })
})
