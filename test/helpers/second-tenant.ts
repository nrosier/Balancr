/**
 * A genuine second tenant, for fixtures that need one to exist without hitting
 * `integrationsRow`'s hard throw on a tenant with no `tenantIntegrations` row —
 * the same placeholder `domain/tenant/provisioning.ts`'s `createTenantAndOwner`
 * inserts for a tenant created through onboarding (#373).
 */
import { config } from '../../src/config.ts'
import type { Db } from '../../src/db/index.ts'
import { encryptField } from '../../src/db/field-crypto.ts'
import { tenantIntegrations, tenants } from '../../src/db/schema.ts'

export function createSecondTenant(db: Db, label = 'Second'): string {
  const tenant = db.insert(tenants).values({ label }).returning().all()[0]
  if (tenant === undefined) throw new Error('creating the tenant returned no row')

  db.insert(tenantIntegrations)
    .values({
      tenantId: tenant.id,
      actualServerUrl: '',
      actualPasswordEnc: encryptField(''),
      actualSyncId: '',
      actualE2ePasswordEnc: null,
      ghostfolioUrl: '',
      ghostfolioSecurityTokenEnc: encryptField(''),
      aiProvider: 'gemini-aistudio',
      aiApiKeyEnc: null,
      googleCloudProject: null,
      aiModelFast: config.GEMINI_MODEL_FAST,
      aiModelDeep: config.GEMINI_MODEL_DEEP,
      aiMonthlyBudgetEurMicro: 0,
    })
    .run()

  return tenant.id
}
