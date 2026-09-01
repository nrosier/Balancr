/**
 * Environment configuration.
 *
 * Zod handles shape and coercion; cross-field rules are checked explicitly
 * afterwards so every problem in the file is reported at once instead of one
 * failure per restart. Misconfiguration here is a startup error, never a
 * runtime surprise — a half-configured advisor that silently skips auth or
 * sends data to the wrong place is worse than one that refuses to boot.
 */
import { z } from 'zod'

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    )

const bool = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true')

const EnvSchema = z.object({
  // App
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    // `silent` is pino's own level; the test setup uses it so an expected error
    // path does not bury the test report in JSON.
    .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  PUBLIC_BASE_URL: z.url(),
  DATABASE_PATH: z.string().min(1).default('./data/balancr.db'),

  // Actual Budget
  ACTUAL_SERVER_URL: z.url(),
  ACTUAL_PASSWORD: z.string().min(1),
  ACTUAL_SYNC_ID: z.string().min(1),
  ACTUAL_E2E_PASSWORD: z.string().min(1).optional(),
  ACTUAL_DATA_DIR: z.string().min(1).default('./data/actual'),

  // Ghostfolio
  GHOSTFOLIO_URL: z.url(),
  GHOSTFOLIO_SECURITY_TOKEN: z.string().min(1),

  // Gemini
  GEMINI_PROVIDER: z.enum(['aistudio', 'vertex']).default('vertex'),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL_FAST: z.string().min(1).default('gemini-3.7-flash'),
  GEMINI_MODEL_DEEP: z.string().min(1).default('gemini-3.1-pro-preview'),
  GEMINI_MONTHLY_BUDGET_EUR: z.coerce.number().nonnegative().default(15),
  GOOGLE_CLOUD_PROJECT: z.string().min(1).optional(),
  GOOGLE_CLOUD_LOCATION: z.string().min(1).default('europe-west1'),

  // Auth
  SESSION_SECRET: z.string().min(32),
  TRUSTED_PROXY_CIDRS: csv('127.0.0.1/32'),
  AUTH_OIDC_ISSUER: z.url().optional(),
  AUTH_OIDC_CLIENT_ID: z.string().min(1).optional(),
  AUTH_OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  AUTH_LOCAL_ENABLED: bool('false'),
  AUTH_LOCAL_ALLOWED_CIDRS: csv('127.0.0.1/32'),

  // Background jobs
  /**
   * Off leaves every pure function and every route intact and simply never
   * schedules anything — the switch for a second instance, or for looking at a
   * copy of the database without it reaching out to Actual and Ghostfolio.
   */
  JOBS_ENABLED: bool('true'),
  /** How often the sync/aggregate pipeline runs. */
  JOBS_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  /** Local hour for the nightly deep pass. Local, so it stays overnight in July. */
  JOBS_NIGHTLY_HOUR: z.coerce.number().int().min(0).max(23).default(3),
  /**
   * How many months of facts to recompute each pass. Baseline history is fetched
   * on top of this, so a smaller number does not weaken the norms — it only
   * decides how far back a correction in Actual is picked up.
   */
  JOBS_HISTORY_MONTHS: z.coerce.number().int().min(1).max(120).default(24),

  // Locale
  SUPPORTED_LOCALES: csv('en,nl'),
  DEFAULT_LOCALE: z.string().min(2).default('en'),
  FORMAT_LOCALE: z.string().min(2).default('nl-BE'),
  TZ: z.string().min(1).default('Europe/Brussels'),
  BASE_CURRENCY: z.string().length(3).default('EUR'),
})

type Env = z.infer<typeof EnvSchema>

/** Rules that span more than one variable, so they cannot live in the schema. */
function crossFieldErrors(env: Env): string[] {
  const errors: string[] = []

  if (env.GEMINI_PROVIDER === 'aistudio' && !env.GEMINI_API_KEY) {
    errors.push('GEMINI_API_KEY is required when GEMINI_PROVIDER=aistudio')
  }
  if (env.GEMINI_PROVIDER === 'vertex' && !env.GOOGLE_CLOUD_PROJECT) {
    errors.push('GOOGLE_CLOUD_PROJECT is required when GEMINI_PROVIDER=vertex')
  }

  const oidcParts = {
    AUTH_OIDC_ISSUER: env.AUTH_OIDC_ISSUER,
    AUTH_OIDC_CLIENT_ID: env.AUTH_OIDC_CLIENT_ID,
    AUTH_OIDC_CLIENT_SECRET: env.AUTH_OIDC_CLIENT_SECRET,
  }
  const missingOidc = Object.entries(oidcParts)
    .filter(([, v]) => !v)
    .map(([k]) => k)
  const oidcConfigured = missingOidc.length === 0
  if (missingOidc.length > 0 && missingOidc.length < 3) {
    errors.push(
      `OIDC is partially configured; missing: ${missingOidc.join(', ')}`,
    )
  }
  if (!oidcConfigured && !env.AUTH_LOCAL_ENABLED) {
    errors.push(
      'No usable login method: configure OIDC (AUTH_OIDC_*) or set AUTH_LOCAL_ENABLED=true',
    )
  }

  if (!env.SUPPORTED_LOCALES.includes(env.DEFAULT_LOCALE)) {
    errors.push(
      `DEFAULT_LOCALE="${env.DEFAULT_LOCALE}" is not in SUPPORTED_LOCALES=[${env.SUPPORTED_LOCALES.join(', ')}]`,
    )
  }

  // A public deployment that trusts only loopback as a proxy will read every
  // request as coming from Traefik's address, breaking rate limiting and the
  // CIDR gate on local login.
  if (
    env.NODE_ENV === 'production' &&
    env.TRUSTED_PROXY_CIDRS.every((c) => c.startsWith('127.'))
  ) {
    errors.push(
      'TRUSTED_PROXY_CIDRS must name your reverse-proxy network in production ' +
        '(loopback-only means forwarded headers are never honoured)',
    )
  }

  if (env.NODE_ENV === 'production' && !env.PUBLIC_BASE_URL.startsWith('https://')) {
    errors.push('PUBLIC_BASE_URL must be https:// in production (cookies are Secure)')
  }

  return errors
}

function load(): Readonly<Env> & { readonly oidcEnabled: boolean } {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => {
      const key = i.path.join('.') || '(root)'
      return `  - ${key}: ${i.message}`
    })
    throw new Error(
      `Invalid environment configuration:\n${lines.join('\n')}\n\nSee .env.example for the full reference.`,
    )
  }

  const errors = crossFieldErrors(parsed.data)
  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}\n\nSee .env.example for the full reference.`,
    )
  }

  return Object.freeze({
    ...parsed.data,
    oidcEnabled: Boolean(parsed.data.AUTH_OIDC_ISSUER),
  })
}

export const config = load()
export type Config = typeof config

/** Safe to log: names every variable but reveals no secret values. */
export function configSummary(): Record<string, unknown> {
  const secret = (v: string | undefined) => (v ? `set (${v.length} chars)` : 'unset')
  return {
    NODE_ENV: config.NODE_ENV,
    PORT: config.PORT,
    PUBLIC_BASE_URL: config.PUBLIC_BASE_URL,
    DATABASE_PATH: config.DATABASE_PATH,
    ACTUAL_SERVER_URL: config.ACTUAL_SERVER_URL,
    ACTUAL_DATA_DIR: config.ACTUAL_DATA_DIR,
    ACTUAL_PASSWORD: secret(config.ACTUAL_PASSWORD),
    ACTUAL_E2E_PASSWORD: secret(config.ACTUAL_E2E_PASSWORD),
    GHOSTFOLIO_URL: config.GHOSTFOLIO_URL,
    GHOSTFOLIO_SECURITY_TOKEN: secret(config.GHOSTFOLIO_SECURITY_TOKEN),
    GEMINI_PROVIDER: config.GEMINI_PROVIDER,
    GEMINI_API_KEY: secret(config.GEMINI_API_KEY),
    GEMINI_MODEL_FAST: config.GEMINI_MODEL_FAST,
    GEMINI_MODEL_DEEP: config.GEMINI_MODEL_DEEP,
    GEMINI_MONTHLY_BUDGET_EUR: config.GEMINI_MONTHLY_BUDGET_EUR,
    SESSION_SECRET: secret(config.SESSION_SECRET),
    TRUSTED_PROXY_CIDRS: config.TRUSTED_PROXY_CIDRS,
    oidcEnabled: config.oidcEnabled,
    AUTH_LOCAL_ENABLED: config.AUTH_LOCAL_ENABLED,
    AUTH_LOCAL_ALLOWED_CIDRS: config.AUTH_LOCAL_ALLOWED_CIDRS,
    JOBS_ENABLED: config.JOBS_ENABLED,
    JOBS_SYNC_INTERVAL_MINUTES: config.JOBS_SYNC_INTERVAL_MINUTES,
    JOBS_NIGHTLY_HOUR: config.JOBS_NIGHTLY_HOUR,
    JOBS_HISTORY_MONTHS: config.JOBS_HISTORY_MONTHS,
    SUPPORTED_LOCALES: config.SUPPORTED_LOCALES,
    DEFAULT_LOCALE: config.DEFAULT_LOCALE,
    FORMAT_LOCALE: config.FORMAT_LOCALE,
    BASE_CURRENCY: config.BASE_CURRENCY,
  }
}
