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

/**
 * The sole tenant's stored Actual/Ghostfolio/Gemini connection (#369).
 *
 * `importEnvIntegrationsOnce` runs at boot, before any request can reach a
 * caller of this function, so a missing row means the process never
 * finished starting up rather than a state a caller should recover from.
 */
export function integrationsRow(db: Db): typeof tenantIntegrations.$inferSelect {
  const tenantId = getSoleTenantId(db)
  const row = db
    .select()
    .from(tenantIntegrations)
    .where(eq(tenantIntegrations.tenantId, tenantId))
    .all()[0]
  if (row === undefined) {
    throw new Error('tenantIntegrations has no row for the sole tenant — did startup import run?')
  }
  return row
}

/**
 * Whether each integration has what it needs to actually be used (#370).
 *
 * Distinct from the wire schema's per-field `*Configured` booleans
 * (`loadIntegrations` in `routes/settings.ts`): those describe individual
 * secrets for the settings form, this describes whether the *integration as
 * a whole* is usable — which is what Budget/Overview/Portfolio and the AI
 * layer actually need to decide what to show or whether to run.
 *
 * The `ai` branch mirrors `aiCredential()`'s own provider branch
 * (`config.ts`) against the tenant's row instead of `.env`: an aistudio
 * tenant needs `geminiApiKeyEnc`, a vertex tenant needs `googleCloudProject`.
 */
export interface IntegrationAvailability {
  readonly actual: boolean
  readonly ghostfolio: boolean
  readonly ai: boolean
}

export function integrationAvailability(db: Db): IntegrationAvailability {
  const row = integrationsRow(db)
  return {
    actual: row.actualServerUrl !== '' && row.actualSyncId !== '' && row.actualPasswordEnc.length > 0,
    ghostfolio: row.ghostfolioUrl !== '' && row.ghostfolioSecurityTokenEnc.length > 0,
    ai:
      row.geminiProvider === 'aistudio'
        ? row.geminiApiKeyEnc !== null
        : row.googleCloudProject !== null,
  }
}

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
