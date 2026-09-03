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

/**
 * A blank value is not a value.
 *
 * `.env.example` ships every optional variable empty, because an empty slot with a
 * comment above it is how you say "fill this in if you need it". Copying that file
 * and filling in only what you use is the documented way to start, so a blank must
 * mean the same thing as an absent line. Without this it does not: Zod sees a string
 * of length zero and reports it as too short, which reads as a rule about length and
 * invites you to put a placeholder in a security-relevant slot to get past it (#118).
 *
 * Only whitespace-only strings are converted, and nothing else is touched. A value
 * with real content keeps its spaces: two of these variables are secrets, and a
 * password or client secret is entitled to end in a space if its owner says so.
 */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value

/**
 * An optional string, where blank means unset.
 *
 * Deliberately not applied to required variables: there, a blank `ACTUAL_PASSWORD` is
 * a misconfiguration and refusing to boot is the whole point. The distinction is
 * optional versus required, not empty versus absent.
 */
const optionalText = () => z.preprocess(blankToUndefined, z.string().min(1).optional())

/** As `optionalText`, for a variable that must parse as a URL when it is set. */
const optionalUrl = () => z.preprocess(blankToUndefined, z.url().optional())

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
  ACTUAL_E2E_PASSWORD: optionalText(),
  ACTUAL_DATA_DIR: z.string().min(1).default('./data/actual'),

  // Ghostfolio
  GHOSTFOLIO_URL: z.url(),
  GHOSTFOLIO_SECURITY_TOKEN: z.string().min(1),

  // Gemini
  /**
   * Whether this deployment wants a model at all.
   *
   * Default `true`, which does **not** mean the AI layer is on: it means "on if it
   * is configured". Absent credentials switch it off silently rather than refusing
   * to boot, because the half of Balancr that can be trusted with a number is the
   * half that never calls a model — the aggregation, the four overspend signals,
   * the burn rate, net worth. Someone who has not got a key yet should get all of
   * that (#165).
   *
   * `false` is for the other case: a key that stays in `.env` while spending is
   * paused, without editing the secret out and back in.
   */
  AI_ENABLED: bool('true'),
  GEMINI_PROVIDER: z.enum(['aistudio', 'vertex']).default('vertex'),
  GEMINI_API_KEY: optionalText(),
  GEMINI_MODEL_FAST: z.string().min(1).default('gemini-3.7-flash'),
  GEMINI_MODEL_DEEP: z.string().min(1).default('gemini-3.1-pro-preview'),
  GEMINI_MONTHLY_BUDGET_EUR: z.coerce.number().nonnegative().default(15),
  // Google's floor for a cacheable context, as a local rule rather than a
  // discovered error — see `estimateTokens` in the Gemini adapter. `0` disables
  // the check and lets the provider decide, which is the escape hatch if the
  // estimate is ever wrong in the direction that costs money.
  GEMINI_CACHE_MIN_TOKENS: z.coerce.number().int().nonnegative().default(1024),
  GOOGLE_CLOUD_PROJECT: optionalText(),
  GOOGLE_CLOUD_LOCATION: z.string().min(1).default('europe-west1'),

  // Auth
  SESSION_SECRET: z.string().min(32),
  TRUSTED_PROXY_CIDRS: csv('127.0.0.1/32'),
  AUTH_OIDC_ISSUER: optionalUrl(),
  AUTH_OIDC_CLIENT_ID: optionalText(),
  AUTH_OIDC_CLIENT_SECRET: optionalText(),
  AUTH_LOCAL_ENABLED: bool('false'),
  AUTH_LOCAL_ALLOWED_CIDRS: csv('127.0.0.1/32'),
  /**
   * How long a session stays valid, counted from its last renewal.
   *
   * A week rather than a day because Authentik is the thing being trusted to
   * decide who you are, and re-running a full SSO round trip every morning adds
   * friction without adding a decision — Authentik's own session policy is where
   * that belongs. Short enough that a forgotten browser on a borrowed laptop
   * stops working on its own.
   */
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(168),

  // Rate limiting
  /**
   * The ordinary bucket: enough headroom that a page loading a dozen panels is
   * never throttled, low enough that a client stuck in a loop cannot saturate a
   * single-process server.
   */
  RATE_LIMIT_API_PER_MINUTE: z.coerce.number().int().min(10).max(10_000).default(300),
  /**
   * The bucket in front of anything that can call Gemini. Measured in hours
   * because it is a spend limit wearing a request limit's clothes: a correctly
   * authenticated caller is exactly the one who can run up the bill, so Authentik
   * cannot help here. Small on purpose — the nightly job precomputes, so normal
   * use of the UI makes no AI calls at all.
   */
  RATE_LIMIT_AI_PER_HOUR: z.coerce.number().int().min(1).max(1000).default(30),

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

/**
 * The one variable that decides whether Gemini can be reached, per provider.
 *
 * One each, which is what makes "AI is off" a single readable question rather than a
 * matrix: AI Studio needs a key, Vertex needs a project (its credentials come from
 * the ambient service account, not from `.env`). The other provider's variable is
 * returned alongside so the cross-field check can tell "nothing configured" from
 * "configured for the provider you did not pick".
 */
function aiCredential(env: Env): {
  readonly name: string
  readonly value: string | undefined
  readonly otherName: string
  readonly otherValue: string | undefined
  readonly otherProvider: string
} {
  return env.GEMINI_PROVIDER === 'aistudio'
    ? {
        name: 'GEMINI_API_KEY',
        value: env.GEMINI_API_KEY,
        otherName: 'GOOGLE_CLOUD_PROJECT',
        otherValue: env.GOOGLE_CLOUD_PROJECT,
        otherProvider: 'vertex',
      }
    : {
        name: 'GOOGLE_CLOUD_PROJECT',
        value: env.GOOGLE_CLOUD_PROJECT,
        otherName: 'GEMINI_API_KEY',
        otherValue: env.GEMINI_API_KEY,
        otherProvider: 'aistudio',
      }
}

/** Rules that span more than one variable, so they cannot live in the schema. */
function crossFieldErrors(env: Env): string[] {
  const errors: string[] = []

  // Not "GEMINI_API_KEY is required": with none of it set the AI layer is simply off
  // and the rest of the app runs. What is refused is the *contradiction* — the
  // credential for the provider that was not chosen — because that is someone who
  // plainly wants a model and would otherwise get a silently AI-less instance with
  // their key sitting in the file. See `aiCredential`.
  const gemini = aiCredential(env)
  if (gemini.value === undefined && gemini.otherValue !== undefined) {
    errors.push(
      `GEMINI_PROVIDER=${env.GEMINI_PROVIDER} needs ${gemini.name}, but only ` +
        `${gemini.otherName} is set — set ${gemini.name}, or switch ` +
        `GEMINI_PROVIDER to ${gemini.otherProvider}`,
    )
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

  // Not cosmetic, and not the same rule as the one above. OpenID Connect permits a
  // client to skip verifying the ID token's signature when the token arrives over
  // a direct, TLS-authenticated channel from the token endpoint (OIDC Core
  // 3.1.3.7, condition 6), and `openid-client` takes that permission. So TLS to
  // Authentik *is* the thing authenticating the claims: over plain HTTP, anything
  // on the container network that can answer the token request can name itself as
  // any user. Refused rather than warned about, because the failure is silent.
  if (
    env.NODE_ENV === 'production' &&
    env.AUTH_OIDC_ISSUER !== undefined &&
    !env.AUTH_OIDC_ISSUER.startsWith('https://')
  ) {
    errors.push(
      'AUTH_OIDC_ISSUER must be https:// in production (the TLS channel to the ' +
        'token endpoint is what authenticates the ID token claims)',
    )
  }

  return errors
}

/** The derived flags, alongside the parsed environment. See the returns below. */
interface Derived {
  readonly oidcEnabled: boolean
  readonly aiCredentialed: boolean
  readonly aiConfigured: boolean
}

function load(): Readonly<Env> & Derived {
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
    /**
     * Whether a model can be called at all: wanted, and configured.
     *
     * Derived rather than a switch of its own, the same way `oidcEnabled` is. A
     * separate flag would allow the state nobody wants — a key present and the
     * features quietly off, with two places to look for why. `AI_ENABLED=false` is
     * the deliberate override, and it reads as one.
     *
     * A monthly budget of zero is *not* part of this. That is a spending decision
     * about a configured integration, and the layer that reports availability keeps
     * the two apart so the page can say which one it is — see
     * `domain/ai/availability.ts`.
     *
     * `aiCredentialed` above is the other half, and it exists so that layer can tell
     * "no key" from "key present, switched off". Collapsed into one boolean, an
     * instance with `AI_ENABLED=false` and no key would be told to flip the switch
     * and would still get nothing.
     */
    aiCredentialed: aiCredential(parsed.data).value !== undefined,
    aiConfigured: parsed.data.AI_ENABLED && aiCredential(parsed.data).value !== undefined,
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
    AI_ENABLED: config.AI_ENABLED,
    // Beside `AI_ENABLED` rather than derived silently: the pair is the answer to
    // "why is there no narrative on the insights page", and a startup log that
    // printed only the wish and not the outcome would make it a two-step question.
    aiConfigured: config.aiConfigured,
    GEMINI_PROVIDER: config.GEMINI_PROVIDER,
    GOOGLE_CLOUD_PROJECT: config.GOOGLE_CLOUD_PROJECT ?? 'unset',
    GEMINI_API_KEY: secret(config.GEMINI_API_KEY),
    GEMINI_MODEL_FAST: config.GEMINI_MODEL_FAST,
    GEMINI_MODEL_DEEP: config.GEMINI_MODEL_DEEP,
    GEMINI_MONTHLY_BUDGET_EUR: config.GEMINI_MONTHLY_BUDGET_EUR,
    GEMINI_CACHE_MIN_TOKENS: config.GEMINI_CACHE_MIN_TOKENS,
    SESSION_SECRET: secret(config.SESSION_SECRET),
    TRUSTED_PROXY_CIDRS: config.TRUSTED_PROXY_CIDRS,
    oidcEnabled: config.oidcEnabled,
    // Both printed in full, and neither is a secret: the client id travels in the
    // authorization URL in plain sight, and the issuer is a public metadata
    // endpoint. Naming them beats `oidcEnabled: true`, which says a provider was
    // configured without saying which one. The redirect URI is not here because
    // it is derived — `oidcClientFromConfig` logs it, where the derivation lives.
    AUTH_OIDC_ISSUER: config.AUTH_OIDC_ISSUER ?? 'unset',
    AUTH_OIDC_CLIENT_ID: config.AUTH_OIDC_CLIENT_ID ?? 'unset',
    AUTH_LOCAL_ENABLED: config.AUTH_LOCAL_ENABLED,
    AUTH_LOCAL_ALLOWED_CIDRS: config.AUTH_LOCAL_ALLOWED_CIDRS,
    SESSION_TTL_HOURS: config.SESSION_TTL_HOURS,
    RATE_LIMIT_API_PER_MINUTE: config.RATE_LIMIT_API_PER_MINUTE,
    RATE_LIMIT_AI_PER_HOUR: config.RATE_LIMIT_AI_PER_HOUR,
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
