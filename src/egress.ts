/**
 * Where this process is allowed to connect.
 *
 * #39 asks for egress restricted to Actual, Ghostfolio and the Gemini endpoint. A
 * compose file cannot express that: Docker networks are all-or-nothing, so the
 * container either reaches the internet or it does not, and Balancr needs the
 * internet for exactly three hosts. The outer layer is still worth having — the README
 * describes the firewall version — but the layer that can actually name hosts is this
 * one, inside the process, because it is the only place that knows what the three hosts
 * are: they come from `.env`.
 *
 * What it defends against is a dependency, not a network. Balancr installs ~40 npm
 * packages into a process holding a Gemini key, a Ghostfolio token, an Actual password
 * and a database of someone's finances. The realistic attack on that is a compromised
 * transitive dependency posting the lot somewhere; the realistic defence is that the
 * process refuses to open a connection to a host nobody configured, and says so loudly
 * when it happens.
 *
 * It works by wrapping `globalThis.fetch`, which is deliberately modest and stated
 * plainly rather than oversold:
 *
 *  - It covers everything that goes through global fetch — the Ghostfolio adapter,
 *    `@google/genai`, `openid-client`, and any dependency that uses the standard API.
 *  - It does **not** cover a library that reaches for `node:http` directly, or a native
 *    module, or a child process. `google-auth-library` fetching an access token for
 *    Vertex is one such path.
 *  - It is not a sandbox. Anything that can run code in this process can also restore
 *    the original `fetch`.
 *
 * So: a real barrier against accidental and casual exfiltration, an audit trail for
 * anything unexpected, and no claim to stop an attacker who has already won. The
 * network-level restriction is what stops that one, which is why both exist.
 */
import { config } from './config.ts'
import type { Db } from './db/index.ts'
import { tenantIntegrations } from './db/schema.ts'
import { logger } from './logger.ts'

const log = logger.child({ module: 'egress' })

/** Raised instead of opening the connection. Named so a caller can tell it apart. */
export class EgressDeniedError extends Error {
  constructor(readonly host: string) {
    super(
      `egress to ${host} is not allowed: it is not Actual, Ghostfolio, the Gemini ` +
        `endpoint or the OIDC issuer. Add it to EGRESS_EXTRA_HOSTS if it should be.`,
    )
    this.name = 'EgressDeniedError'
  }
}

/**
 * Google's endpoints, which are the one part of the list that is not in `.env`.
 *
 * AI Studio is one host. Vertex is regional and the SDK builds the hostname from the
 * location, so the location's host is derived rather than guessed — and the global
 * endpoint is included because the SDK falls back to it for some operations.
 *
 * `oauth2.googleapis.com` and the two metadata hosts are how a service account or a
 * workload identity obtains a token. They travel through `google-auth-library`, which
 * does not use global fetch today, so listing them is about not having to debug this
 * file on the day it changes its transport.
 */
function geminiHosts(): string[] {
  if (config.GEMINI_PROVIDER === 'aistudio') return ['generativelanguage.googleapis.com']
  const location = config.GOOGLE_CLOUD_LOCATION
  return [
    `${location}-aiplatform.googleapis.com`,
    'aiplatform.googleapis.com',
    'oauth2.googleapis.com',
    'accounts.google.com',
    'metadata.google.internal',
    'metadata.googleapis.com',
  ]
}

/** The host part of a configured URL, or nothing if it is not a URL. */
function hostOf(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return []
  try {
    return [new URL(value).hostname.toLowerCase()]
  } catch {
    return []
  }
}

/**
 * Every host this deployment is configured to talk to.
 *
 * Built from the same values the adapters read, so the allowlist cannot drift away
 * from the configuration — moving Ghostfolio to a new hostname needs no second edit,
 * which is the property that keeps a list like this from being switched off in
 * frustration a year from now.
 *
 * `db`, when given, also unions in every tenant's stored Actual/Ghostfolio URL
 * (#369) — a tenant's own credentials are exactly as configured as `.env`'s
 * ones, they just live in a different place now. Optional so the many call
 * sites that only ever check the static, `.env`-derived list (tests, mostly)
 * do not need a database to hand.
 */
export function allowedHosts(db?: Db): ReadonlySet<string> {
  const hosts = [
    ...hostOf(config.ACTUAL_SERVER_URL),
    ...hostOf(config.GHOSTFOLIO_URL),
    ...hostOf(config.AUTH_OIDC_ISSUER),
    ...geminiHosts(),
    ...config.EGRESS_EXTRA_HOSTS.map((host) => host.toLowerCase()),
  ]
  if (db !== undefined) {
    for (const row of db
      .select({ actualServerUrl: tenantIntegrations.actualServerUrl, ghostfolioUrl: tenantIntegrations.ghostfolioUrl })
      .from(tenantIntegrations)
      .all()) {
      hosts.push(...hostOf(row.actualServerUrl), ...hostOf(row.ghostfolioUrl))
    }
  }
  return new Set(hosts)
}

/**
 * Loopback is always allowed.
 *
 * The container's own health check calls `/healthz` through fetch, and a request to
 * itself is not egress. Named addresses rather than a range check because these are
 * the only three spellings Node produces here.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]'])

/**
 * Hosts allowed only for the lifetime of one "test connection" call (#369).
 *
 * A candidate credential someone is testing is, by construction, not yet in
 * `tenantIntegrations` — that is the entire point of testing before saving — so
 * `allowedHosts` cannot know about it. This is the narrow exception: a host the
 * signed-in owner just typed into the settings page, permitted for exactly the
 * duration of the one test call it was typed in for, and revoked afterwards whether
 * the call succeeded or not. A count rather than a boolean, in case two test calls to
 * the same host ever overlap — the second must not revoke the first's permission
 * when it finishes.
 *
 * Process-wide rather than threaded through `fetch`'s arguments, because `fetch`
 * itself carries no request context to thread it through — the same reason
 * `installed` below is a module-level flag rather than a parameter.
 */
const testAllowance = new Map<string, number>()

/** Permits every host in `url` for the duration of `fn`, then revokes it. */
export async function withTestHost<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const hosts = hostOf(url)
  for (const host of hosts) testAllowance.set(host, (testAllowance.get(host) ?? 0) + 1)
  try {
    return await fn()
  } finally {
    for (const host of hosts) {
      const count = (testAllowance.get(host) ?? 1) - 1
      if (count <= 0) testAllowance.delete(host)
      else testAllowance.set(host, count)
    }
  }
}

/** Whether `target` was explicitly permitted by an in-flight `withTestHost`. */
function isTestAllowed(target: string): boolean {
  let host: string
  try {
    host = new URL(target).hostname.toLowerCase()
  } catch {
    return false
  }
  return testAllowance.has(host)
}

/**
 * The decision, separated from the wrapping so a test can ask the question directly.
 *
 * A URL that will not parse is denied rather than passed through: `fetch` would reject
 * it anyway, and "unparseable" is not a thing to be lenient about in a security check.
 */
export function isAllowed(target: string, allowed: ReadonlySet<string>): boolean {
  let host: string
  try {
    host = new URL(target).hostname.toLowerCase()
  } catch {
    return false
  }
  return LOOPBACK.has(host) || allowed.has(host)
}

/** The URL of anything `fetch` accepts as its first argument. */
function targetOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

export type EgressMode = 'enforce' | 'warn' | 'off'

/**
 * Wraps `globalThis.fetch` for the rest of the process's life.
 *
 * Three modes, because the failure this could cause is a feature that silently stops
 * working, and the operator needs a way to find that out that is not a bisect:
 *
 *  - `enforce` (the default) refuses the connection and logs the host.
 *  - `warn` allows it and logs the host, which is how you find out what a new
 *    dependency wants before deciding whether it should have it.
 *  - `off` does not install the wrapper at all.
 *
 * Idempotent: calling it twice would otherwise nest the wrappers, and the second
 * process-wide patch of a global is never the one that was intended.
 *
 * `db`, when given, is re-queried on every fetch rather than captured once here
 * (#369): a tenant saving a new Actual/Ghostfolio URL through the settings page
 * must be able to reach it on the very next request, with no restart. The extra
 * read is one row from a single-digit-row table, which is nothing next to the
 * network call it is guarding.
 */
let installed = false

export function installEgressGuard(mode: EgressMode = config.EGRESS_MODE, db?: Db): void {
  if (mode === 'off' || installed) return
  installed = true

  const original = globalThis.fetch.bind(globalThis)
  log.info({ hosts: [...allowedHosts(db)].sort(), mode }, 'egress allowlist installed')

  globalThis.fetch = async (input, init) => {
    const target = targetOf(input)
    if (isAllowed(target, allowedHosts(db)) || isTestAllowed(target)) return original(input, init)

    // The host, never the path: a denied URL can carry a query string, and a query
    // string on an exfiltration attempt is the data being exfiltrated. Logging it
    // would copy the thing this is trying to protect into the log file.
    let host: string
    try {
      host = new URL(target).hostname
    } catch {
      host = '<unparseable>'
    }

    if (mode === 'warn') {
      log.warn({ host }, 'egress to an unconfigured host, allowed because EGRESS_MODE=warn')
      return original(input, init)
    }
    log.error({ host }, 'egress denied: host is not in the allowlist')
    throw new EgressDeniedError(host)
  }
}
