/**
 * First-boot import of `.env`'s Actual/Ghostfolio/AI credentials into
 * tenant 1's `tenantIntegrations` row (#369). Runs once, right after
 * migrations, the same slot `seedPrompts` uses in `main.ts`.
 *
 * This is the ONLY place `.env`'s credential values are ever read into the
 * database. Once tenant 1's row exists, nothing may fall back to `config.*`
 * again — not for tenant 1, and never for any later tenant (#373).
 */
import { eq } from 'drizzle-orm'
import type { Db } from './index.ts'
import { eurToMicroEur } from '../adapters/ai/pricing.ts'
import { config } from '../config.ts'
import { decryptField, encryptField } from './field-crypto.ts'
import { getSoleTenantId } from './tenant.ts'
import { tenantIntegrations } from './schema.ts'

/**
 * A tenant's stored Actual/Ghostfolio/AI connection (#369, #376, #422).
 *
 * `importEnvIntegrationsOnce` runs at boot, before any request can reach a
 * caller of this function, so a missing row means the process never
 * finished starting up rather than a state a caller should recover from.
 */
export function integrationsRow(db: Db, tenantId: string): typeof tenantIntegrations.$inferSelect {
  const row = db
    .select()
    .from(tenantIntegrations)
    .where(eq(tenantIntegrations.tenantId, tenantId))
    .all()[0]
  if (row === undefined) {
    throw new Error('tenantIntegrations has no row for this tenant — did startup import run?')
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
 * The `ai` branch mirrors the selected provider against the tenant's row:
 * AI Studio needs an API key, while Vertex uses an ambient credential plus
 * the configured Google Cloud project.
 */
export interface IntegrationAvailability {
  readonly actual: boolean
  readonly ghostfolio: boolean
  readonly ai: boolean
}

export function integrationAvailability(db: Db, tenantId: string): IntegrationAvailability {
  const row = integrationsRow(db, tenantId)
  return {
    actual: row.actualServerUrl !== '' && row.actualSyncId !== '' && row.actualPasswordEnc.length > 0,
    ghostfolio: row.ghostfolioUrl !== '' && row.ghostfolioSecurityTokenEnc.length > 0,
    ai:
      row.aiProvider === 'gemini-aistudio'
        ? row.aiApiKeyEnc !== null
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
 * Models and the monthly AI budget are tenant columns too (#371) — the budget is stored as a micro-EUR integer,
 * matching every other money column in this schema.
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
  readonly ai: {
    readonly provider: 'gemini-aistudio' | 'gemini-vertex'
    readonly apiKey: string | null
    readonly project: string | null
    readonly modelFast: string
    readonly modelDeep: string
    readonly budgetEurMicro: number
  }
}

export function resolvedIntegrations(db: Db, tenantId: string): ResolvedIntegrations {
  const row = integrationsRow(db, tenantId)
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
    ai: {
      provider: row.aiProvider,
      apiKey: row.aiApiKeyEnc === null ? null : decryptField(row.aiApiKeyEnc),
      project: row.googleCloudProject,
      modelFast: row.aiModelFast,
      modelDeep: row.aiModelDeep,
      budgetEurMicro: row.aiMonthlyBudgetEurMicro,
    },
  }
}

/**
 * Returns true if it imported a row, false if tenant 1 already had one.
 *
 * Still uses `getSoleTenantId` rather than taking a `tenantId` parameter
 * (#376): it runs once at boot, before a second tenant can exist by
 * construction, and it's the only legitimate way to learn tenant 1's id
 * this early — there is no request or job context to thread one from.
 */
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
      aiProvider: config.GEMINI_PROVIDER === 'vertex' ? 'gemini-vertex' : 'gemini-aistudio',
      aiApiKeyEnc: config.GEMINI_API_KEY ? encryptField(config.GEMINI_API_KEY) : null,
      googleCloudProject: config.GOOGLE_CLOUD_PROJECT ?? null,
      aiModelFast: config.GEMINI_MODEL_FAST,
      aiModelDeep: config.GEMINI_MODEL_DEEP,
      aiMonthlyBudgetEurMicro: eurToMicroEur(config.GEMINI_MONTHLY_BUDGET_EUR),
    })
    .run()
  return true
}
