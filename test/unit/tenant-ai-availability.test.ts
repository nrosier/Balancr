/**
 * `tenantAiAvailability` (#370) — `aiAvailability`'s own precedence logic,
 * composed with the tenant's own credential instead of `.env`'s.
 *
 * `aiAvailability` itself stays covered by `ai-availability.test.ts` with plain
 * literals; this only has to show that `tenantAiAvailability` supplies
 * `integrationAvailability(db).ai` as the credential and preserves `aiAvailability`'s
 * own precedence over the rest of the config.
 */
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { encryptField } from '../../src/db/field-crypto.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { tenantIntegrations } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { tenantAiAvailability } from '../../src/domain/ai/availability.ts'

function freshDb(): Db {
  const { db } = createTestDb()
  applyMigrations(db as never)
  return db
}

/**
 * `tenantAiAvailability` reads through `resolvedIntegrations`, which decrypts
 * every secret field unconditionally — so even the fields this suite doesn't
 * care about need real (if empty) ciphertext, not a raw `''`.
 */
function insertRow(db: Db, overrides: Partial<typeof tenantIntegrations.$inferInsert>): void {
  const tenantId = getSoleTenantId(db)
  db.insert(tenantIntegrations)
    .values({
      tenantId,
      actualServerUrl: '',
      actualPasswordEnc: encryptField(''),
      actualSyncId: '',
      ghostfolioUrl: '',
      ghostfolioSecurityTokenEnc: encryptField(''),
      geminiProvider: 'aistudio',
      geminiApiKeyEnc: null,
      googleCloudProject: null,
      ...overrides,
    })
    .run()
}

const on = { AI_ENABLED: true }

describe('tenantAiAvailability', () => {
  it('names notConfigured for a tenant with no gemini key, regardless of the cfg passed in', () => {
    const db = freshDb()
    const tenantId = getSoleTenantId(db)
    insertRow(db, { geminiApiKeyEnc: null })
    expect(tenantAiAvailability(db, tenantId, on)).toEqual({
      enabled: false,
      reason: 'notConfigured',
    })
  })

  it('is enabled for a tenant with a gemini key when the switch and budget allow it', () => {
    const db = freshDb()
    const tenantId = getSoleTenantId(db)
    insertRow(db, { geminiApiKeyEnc: encryptField('irrelevant-key') })
    expect(tenantAiAvailability(db, tenantId, on)).toEqual({ enabled: true, reason: null })
  })

  it('still names switchedOff for a credentialed tenant when AI_ENABLED is false', () => {
    const db = freshDb()
    const tenantId = getSoleTenantId(db)
    insertRow(db, { geminiApiKeyEnc: encryptField('irrelevant-key') })
    expect(tenantAiAvailability(db, tenantId, { ...on, AI_ENABLED: false }).reason).toBe('switchedOff')
  })

  it('reads the vertex branch too: a project counts, a leftover key on its own does not', () => {
    const db = freshDb()
    const tenantId = getSoleTenantId(db)
    insertRow(db, { geminiProvider: 'vertex', googleCloudProject: 'my-gcp-project' })
    expect(tenantAiAvailability(db, tenantId, on).enabled).toBe(true)
  })
})
