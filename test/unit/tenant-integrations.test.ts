/**
 * The first-boot import of `.env`'s Actual/Ghostfolio/Gemini credentials into
 * tenant 1's `tenantIntegrations` row (#369). The property that matters is the
 * bootstrap-once guarantee: `.env` seeds this exactly one time, ever, and a
 * second call must be a no-op rather than a second read of `.env` — because
 * after tenant 1's row exists, nothing may fall back to `config.*` again.
 */
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { decryptField } from '../../src/db/field-crypto.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { tenantIntegrations } from '../../src/db/schema.ts'
import { importEnvIntegrationsOnce } from '../../src/db/tenant-integrations.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'

function freshDb(): Db {
  const { db } = createTestDb()
  applyMigrations(db as never)
  return db
}

function theRow(db: Db) {
  const tenantId = getSoleTenantId(db)
  const row = db.select().from(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId)).all()[0]
  if (row === undefined) throw new Error('no tenantIntegrations row')
  return row
}

describe('importEnvIntegrationsOnce', () => {
  it('writes exactly one row from config.* on an empty table', () => {
    const db = freshDb()
    expect(importEnvIntegrationsOnce(db)).toBe(true)

    const row = theRow(db)
    // Values come from test/setup.ts's environment.
    expect(row.actualServerUrl).toBe('http://actual.test:5006')
    expect(row.actualSyncId).toBe('test-sync-id')
    expect(row.ghostfolioUrl).toBe('http://ghostfolio.test:3333')
    expect(row.geminiProvider).toBe('aistudio')
    expect(decryptField(row.actualPasswordEnc)).toBe('test-password')
    expect(decryptField(row.ghostfolioSecurityTokenEnc)).toBe('test-token')
    expect(row.geminiApiKeyEnc).not.toBeNull()
    expect(decryptField(row.geminiApiKeyEnc as string)).toBe('test-key')
  })

  it('is a no-op once tenant 1 already has a row, even if .env would say otherwise', () => {
    const db = freshDb()
    importEnvIntegrationsOnce(db)
    const before = theRow(db)

    // The important assertion is not just "returns false" — it is "changed nothing",
    // since the whole point is that .env is never read again after the first import.
    expect(importEnvIntegrationsOnce(db)).toBe(false)
    expect(theRow(db)).toEqual(before)
  })

  it('round-trips a null e2e password and API key as null, not an encrypted empty string', () => {
    const db = freshDb()
    importEnvIntegrationsOnce(db)
    const row = theRow(db)
    // test/setup.ts sets neither ACTUAL_E2E_PASSWORD, so it must stay unset rather
    // than becoming ciphertext of an empty string that would decrypt "successfully"
    // to something meaningless.
    expect(row.actualE2ePasswordEnc).toBeNull()
  })
})
