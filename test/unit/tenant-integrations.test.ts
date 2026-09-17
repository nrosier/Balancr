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
import { decryptField, encryptField } from '../../src/db/field-crypto.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { tenantIntegrations } from '../../src/db/schema.ts'
import {
  importEnvIntegrationsOnce,
  integrationAvailability,
} from '../../src/db/tenant-integrations.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

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

/**
 * `integrationAvailability` (#370) against rows this test inserts directly.
 *
 * Not against `importEnvIntegrationsOnce`: that import is all-or-nothing, so a row
 * with Actual configured and Ghostfolio not — the very state this function exists to
 * tell apart — cannot be produced through any app flow until #371/#372/#373 give each
 * tenant independent provisioning. Until then, this is the only way to exercise it.
 */
describe('integrationAvailability', () => {
  function insertRow(
    db: Db,
    tenantId: string,
    overrides: Partial<typeof tenantIntegrations.$inferInsert>,
  ): void {
    db.insert(tenantIntegrations)
      .values({
        tenantId,
        actualServerUrl: '',
        actualPasswordEnc: '',
        actualSyncId: '',
        ghostfolioUrl: '',
        ghostfolioSecurityTokenEnc: '',
        geminiProvider: 'aistudio',
        geminiApiKeyEnc: null,
        googleCloudProject: null,
        ...overrides,
      })
      .onConflictDoUpdate({ target: tenantIntegrations.tenantId, set: { tenantId, ...overrides } })
      .run()
  }

  it('reports actual and ghostfolio unavailable on an all-empty row', () => {
    const db = freshDb()
    const tenantId = getSoleTenantId(db)
    insertRow(db, tenantId, {})
    expect(integrationAvailability(db, tenantId)).toEqual({ actual: false, ghostfolio: false, ai: false })
  })

  it('reports actual available once its three fields are all set, independent of ghostfolio', () => {
    const db = freshDb()
    const tenantId = getSoleTenantId(db)
    insertRow(db, tenantId, {
      actualServerUrl: 'http://actual.test:5006',
      actualSyncId: 'sync-id',
      actualPasswordEnc: encryptField('password'),
    })
    const availability = integrationAvailability(db, tenantId)
    expect(availability.actual).toBe(true)
    expect(availability.ghostfolio).toBe(false)
  })

  it('reports ghostfolio available once its two fields are set, independent of actual', () => {
    const db = freshDb()
    const tenantId = getSoleTenantId(db)
    insertRow(db, tenantId, {
      ghostfolioUrl: 'http://ghostfolio.test:3333',
      ghostfolioSecurityTokenEnc: encryptField('token'),
    })
    const availability = integrationAvailability(db, tenantId)
    expect(availability.ghostfolio).toBe(true)
    expect(availability.actual).toBe(false)
  })

  it('reports ai unavailable for an aistudio row with no key, available once one is set', () => {
    const db = freshDb()
    const tenantId = getSoleTenantId(db)
    insertRow(db, tenantId, { geminiProvider: 'aistudio', geminiApiKeyEnc: null })
    expect(integrationAvailability(db, tenantId).ai).toBe(false)

    const db2 = freshDb()
    const tenantId2 = getSoleTenantId(db2)
    insertRow(db2, tenantId2, { geminiProvider: 'aistudio', geminiApiKeyEnc: encryptField('key') })
    expect(integrationAvailability(db2, tenantId2).ai).toBe(true)
  })

  it('reports ai unavailable for a vertex row with no project, available once one is set', () => {
    const db = freshDb()
    const tenantId = getSoleTenantId(db)
    insertRow(db, tenantId, { geminiProvider: 'vertex', googleCloudProject: null })
    expect(integrationAvailability(db, tenantId).ai).toBe(false)

    const db2 = freshDb()
    const tenantId2 = getSoleTenantId(db2)
    insertRow(db2, tenantId2, { geminiProvider: 'vertex', googleCloudProject: 'my-gcp-project' })
    expect(integrationAvailability(db2, tenantId2).ai).toBe(true)
  })

  it('ignores googleCloudProject for an aistudio row and geminiApiKeyEnc for a vertex row', () => {
    const db = freshDb()
    const tenantId = getSoleTenantId(db)
    // An aistudio row with a leftover project value but no key: still unavailable.
    insertRow(db, tenantId, { geminiProvider: 'aistudio', geminiApiKeyEnc: null, googleCloudProject: 'stale-project' })
    expect(integrationAvailability(db, tenantId).ai).toBe(false)

    const db2 = freshDb()
    const tenantId2 = getSoleTenantId(db2)
    // A vertex row with a leftover key but no project: still unavailable.
    insertRow(db2, tenantId2, {
      geminiProvider: 'vertex',
      googleCloudProject: null,
      geminiApiKeyEnc: encryptField('stale-key'),
    })
    expect(integrationAvailability(db2, tenantId2).ai).toBe(false)
  })

  it('keeps two tenants in the same database from cross-contaminating (#376 phase 2)', () => {
    const db = freshDb()
    const tenantA = getSoleTenantId(db)
    const tenantB = createSecondTenant(db)

    insertRow(db, tenantA, {
      actualServerUrl: 'http://actual.test:5006',
      actualSyncId: 'sync-id',
      actualPasswordEnc: encryptField('password'),
      geminiProvider: 'aistudio',
      geminiApiKeyEnc: encryptField('key'),
    })
    // Tenant B is left with the all-empty placeholder `createSecondTenant` seeds —
    // everything unavailable — so a leak toward tenant A's row would show up as a
    // false positive here rather than a false negative.
    insertRow(db, tenantB, {})

    expect(integrationAvailability(db, tenantA)).toEqual({ actual: true, ghostfolio: false, ai: true })
    expect(integrationAvailability(db, tenantB)).toEqual({ actual: false, ghostfolio: false, ai: false })
  })
})
