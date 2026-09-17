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
import { decryptField, encryptField } from './field-crypto.ts'
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

/**
 * The tenant's connection details, decrypted and ready to use (#371).
 *
 * Every adapter builds its client from this, never from `config.*` — that's
 * the whole point of #371: `.env` only ever seeds tenant 1's row once, via
 * `importEnvIntegrationsOnce` below.
 *
 * Gemini's `provider`/`apiKey`/`project` join this shape once #371's Gemini
 * slice lands; Ghostfolio and Actual need it first, so it starts with just
 * those two.
 */
export interface ResolvedIntegrations {
  readonly actual: {
    readonly serverUrl: string
    readonly password: string
    readonly syncId: string
    readonly e2ePassword: string | null
  }
  readonly ghostfolio: {
    readonly url: string
    readonly token: string
  }
}

export function resolvedIntegrations(db: Db): ResolvedIntegrations {
  const row = integrationsRow(db)
  return {
    actual: {
      serverUrl: row.actualServerUrl,
      password: decryptField(row.actualPasswordEnc),
      syncId: row.actualSyncId,
      e2ePassword: row.actualE2ePasswordEnc === null ? null : decryptField(row.actualE2ePasswordEnc),
    },
    ghostfolio: {
      url: row.ghostfolioUrl,
      token: decryptField(row.ghostfolioSecurityTokenEnc),
    },
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
