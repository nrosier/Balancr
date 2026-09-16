/**
 * First-boot import of `.env`'s Actual/Ghostfolio/Gemini credentials into
 * tenant 1's `tenantIntegrations` row (#369). Runs once, right after
 * migrations, the same slot `seedPrompts` uses in `main.ts`.
 *
 * This is the ONLY place `.env`'s credential values are ever read into the
 * database. Once tenant 1's row exists, nothing may fall back to `config.*`
 * again — not for tenant 1, and never for any later tenant (#373).
 */
import { eq } from 'drizzle-orm'
import type { Db } from './index.ts'
import { config } from '../config.ts'
import { encryptField } from './field-crypto.ts'
import { getSoleTenantId } from './tenant.ts'
import { tenantIntegrations } from './schema.ts'

/** Returns true if it imported a row, false if tenant 1 already had one. */
export function importEnvIntegrationsOnce(db: Db): boolean {
  const tenantId = getSoleTenantId(db)
  const existing = db
    .select({ tenantId: tenantIntegrations.tenantId })
    .from(tenantIntegrations)
    .where(eq(tenantIntegrations.tenantId, tenantId))
    .all()[0]
  if (existing !== undefined) return false

  db.insert(tenantIntegrations)
    .values({
      tenantId,
      actualServerUrl: config.ACTUAL_SERVER_URL,
      actualPasswordEnc: encryptField(config.ACTUAL_PASSWORD),
      actualSyncId: config.ACTUAL_SYNC_ID,
      actualE2ePasswordEnc: config.ACTUAL_E2E_PASSWORD ? encryptField(config.ACTUAL_E2E_PASSWORD) : null,
      ghostfolioUrl: config.GHOSTFOLIO_URL,
      ghostfolioSecurityTokenEnc: encryptField(config.GHOSTFOLIO_SECURITY_TOKEN),
      geminiProvider: config.GEMINI_PROVIDER,
      geminiApiKeyEnc: config.GEMINI_API_KEY ? encryptField(config.GEMINI_API_KEY) : null,
      googleCloudProject: config.GOOGLE_CLOUD_PROJECT ?? null,
    })
    .run()
  return true
}
