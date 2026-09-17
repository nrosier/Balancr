/**
 * `resolvedIntegrations` (#371) — the decrypted, ready-to-use shape every
 * adapter builds its client from. `tenant-integrations.test.ts` already
 * covers `importEnvIntegrationsOnce`/`integrationAvailability`; this is the
 * one place that checks every secret field actually round-trips through
 * `resolvedIntegrations` rather than staying ciphertext, and that the new
 * Gemini model/budget columns come through untouched (they aren't secrets,
 * so there's nothing to decrypt for them).
 */
import { describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { encryptField } from '../../src/db/field-crypto.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { tenantIntegrations } from '../../src/db/schema.ts'
import { resolvedIntegrations } from '../../src/db/tenant-integrations.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'

function freshDb(): Db {
  const { db } = createTestDb()
  applyMigrations(db as never)
  return db
}

function insertRow(db: Db, overrides: Partial<typeof tenantIntegrations.$inferInsert>): void {
  const tenantId = getSoleTenantId(db)
  db.insert(tenantIntegrations)
    .values({
      tenantId,
      actualServerUrl: 'https://actual.example.com',
      actualPasswordEnc: encryptField('actual-password'),
      actualSyncId: 'sync-id',
      ghostfolioUrl: 'https://ghostfolio.example.com',
      ghostfolioSecurityTokenEnc: encryptField('ghostfolio-token'),
      geminiProvider: 'aistudio',
      geminiApiKeyEnc: encryptField('gemini-key'),
      googleCloudProject: null,
      geminiModelFast: 'gemini-flash-lite',
      geminiModelDeep: 'gemini-pro',
      geminiMonthlyBudgetEurMicro: 42_000_000,
      ...overrides,
    })
    .run()
}

describe('resolvedIntegrations', () => {
  it('decrypts every secret field and passes the plain ones through unchanged', () => {
    const db = freshDb()
    insertRow(db, {})

    expect(resolvedIntegrations(db)).toEqual({
      actual: {
        serverUrl: 'https://actual.example.com',
        password: 'actual-password',
        syncId: 'sync-id',
        e2ePassword: null,
      },
      ghostfolio: {
        url: 'https://ghostfolio.example.com',
        token: 'ghostfolio-token',
      },
      gemini: {
        provider: 'aistudio',
        apiKey: 'gemini-key',
        project: null,
        modelFast: 'gemini-flash-lite',
        modelDeep: 'gemini-pro',
        budgetEurMicro: 42_000_000,
      },
    })
  })

  it('round-trips a set e2e password rather than leaving it null', () => {
    const db = freshDb()
    insertRow(db, { actualE2ePasswordEnc: encryptField('e2e-secret') })

    expect(resolvedIntegrations(db).actual.e2ePassword).toBe('e2e-secret')
  })

  it('reports a null gemini api key as null rather than decrypting it', () => {
    const db = freshDb()
    insertRow(db, { geminiProvider: 'vertex', geminiApiKeyEnc: null, googleCloudProject: 'my-gcp-project' })

    const gemini = resolvedIntegrations(db).gemini
    expect(gemini.apiKey).toBeNull()
    expect(gemini.project).toBe('my-gcp-project')
  })
})
