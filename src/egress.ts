/**
 * Where this process is allowed to connect.
 *
 * #39 asks for egress restricted to Actual, Ghostfolio and approved AI endpoints. A
 * compose file cannot express that: Docker networks are all-or-nothing, so the
 * container either reaches the internet or it does not, and Balancr needs the
 * internet for exactly three hosts. The outer layer is still worth having — the README
 * describes the firewall version — but the layer that can actually name hosts is this
 * one, inside the process, because it is the only place that knows what the three hosts
 * are: they come from `.env`.
 *
 * What it defends against is a dependency, not a network. Balancr installs ~40 npm
 * packages into a process holding an AI key, a Ghostfolio token, an Actual password
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
 *
 * Allowlist rather than blocklist: the question here is "which few hosts may this
 * process reach", not "which hosts are dangerous" — the first is small and
 * enumerable, the second is not, and a blocklist could never keep pace with an
 * unknown compromised dependency reaching for an address nobody thought to list.
 *
 * Every check below is a hostname string match against `allowedHosts`, never a check
 * of the IP a hostname resolves to (#467). So an already-approved host — an
 * `EGRESS_EXTRA_HOSTS` entry, or Actual/Ghostfolio's own configured URL — whose DNS
 * record is later hijacked would still pass; nothing here re-resolves and pins the IP
 * at connect time. That is a different trust assumption than "an attacker who has
 * already won" above: rebinding an approved host needs no code running in this
 * process at all, only control of the DNS record for a name the operator already
 * trusted when they added it. Left undefended on purpose anyway: closing it needs a
 * custom `fetch` dispatcher that inspects the resolved socket address before the
 * handshake completes, which is real ongoing complexity for a threat that requires
 * the attacker to first gain that DNS control. A hostname nobody approved is refused
 * regardless of what it resolves to; that part never touches DNS.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { config } from './config.ts'
import type { Db } from './db/index.ts'
import { tenantIntegrations } from './db/schema.ts'
import { logger } from './logger.ts'

const log = logger.child({ module: 'egress' })

/** Raised instead of opening the connection. Named so a caller can tell it apart. */
export class EgressDeniedError extends Error {
  constructor(readonly host: string) {
    super(
      `egress to ${host} is not allowed: it is not Actual, Ghostfolio, an approved ` +
        `AI endpoint or the OIDC issuer. Add it to EGRESS_EXTRA_HOSTS if it should be.`,
    )
    this.name = 'EgressDeniedError'
  }
}

/** A redirect chain that cannot be followed safely or deterministically. */
export class EgressRedirectError extends Error {
  constructor(reason: 'invalid_location' | 'loop' | 'too_many') {
    const detail = {
      invalid_location: 'the redirect target is not a valid URL',
      loop: 'the redirect chain contains a loop',
      too_many: 'the redirect chain exceeds the 5-hop limit',
    }[reason]
    super(`egress redirect refused: ${detail}`)
    this.name = 'EgressRedirectError'
  }
}

/** Deliberately smaller than fetch's usual 20-hop ceiling. */
export const MAX_EGRESS_REDIRECTS = 5

const AI_STUDIO_HOST = 'generativelanguage.googleapis.com'
const OPENAI_HOST = 'api.openai.com'
const XAI_HOST = 'api.x.ai'
const ANTHROPIC_HOST = 'api.anthropic.com'

/**
 * Vertex's hosts, which are the one part of the list that is not in `.env`.
 *
 * Vertex is regional and the SDK builds the hostname from the location, so the
 * location's host is derived rather than guessed — and the global endpoint is
 * included because the SDK falls back to it for some operations.
 *
 * `oauth2.googleapis.com` and the two metadata hosts are how a service account or a
 * workload identity obtains a token. They travel through `google-auth-library`, which
 * does not use global fetch today, so listing them is about not having to debug this
 * file on the day it changes its transport.
 */
function vertexHosts(): string[] {
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

/**
 * The active AI-provider hosts this deployment needs, static or tenant-aware.
 *
 * Without `db`, this is still the single, deployment-wide `.env` provider —
 * unchanged behavior for the many call sites that only ever check the static
 * list. With `db`, a provider is no longer one global value (#371): each
 * tenant picked its own, so the allowlist has to union both host sets when a
 * mixed deployment has at least one tenant on each provider.
 */
function aiHosts(db?: Db): string[] {
  if (db === undefined) {
    return config.GEMINI_PROVIDER === 'aistudio' ? [AI_STUDIO_HOST] : vertexHosts()
  }
  const providers = new Set(
    db
      .select({ aiProvider: tenantIntegrations.aiProvider })
      .from(tenantIntegrations)
      .all()
      .map((row) => row.aiProvider),
  )
  const hosts: string[] = []
  if (providers.has('gemini-aistudio')) hosts.push(AI_STUDIO_HOST)
  if (providers.has('gemini-vertex')) hosts.push(...vertexHosts())
  if (providers.has('openai')) hosts.push(OPENAI_HOST)
  if (providers.has('xai')) hosts.push(XAI_HOST)
  if (providers.has('anthropic')) hosts.push(ANTHROPIC_HOST)
  // Custom endpoints are deliberately absent: only EGRESS_EXTRA_HOSTS may
  // approve them, so a tenant setting can never widen process egress.
  return hosts
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
 * `db` is only used for `aiHosts` — a tenant's chosen AI provider is one of a
 * handful of known-safe, operator-recognised hosts, never an arbitrary
 * string a tenant typed in. A tenant's own Actual/Ghostfolio URL is exactly
 * that arbitrary string (#369/#371's whole point is self-service, no
 * operator step), so it is deliberately absent here: unioning it into this
 * process-wide set would let one tenant's saved URL widen what *every*
 * fetch in the process — another tenant's request, an unrelated compromised
 * dependency — may reach. `withScopedHost` below is where a tenant's own URL
 * is allowed instead: only for the duration of the one call made on that
 * tenant's behalf (#535).
 */
export function allowedHosts(db?: Db): ReadonlySet<string> {
  const hosts = [
    ...hostOf(config.ACTUAL_SERVER_URL),
    ...hostOf(config.GHOSTFOLIO_URL),
    ...hostOf(config.AUTH_OIDC_ISSUER),
    ...aiHosts(db),
    ...config.EGRESS_EXTRA_HOSTS.map((host) => host.toLowerCase()),
  ]
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
 * Hosts allowed only for the lifetime of one call (#369, #535).
 *
 * Two callers rely on this, for related but distinct reasons. A "test connection"
 * candidate is, by construction, not yet in `tenantIntegrations` — that is the entire
 * point of testing before saving — so `allowedHosts` cannot know about it. A tenant's
 * *saved* Actual/Ghostfolio URL is in `tenantIntegrations`, but deliberately still not
 * in `allowedHosts` (see that function's doc comment): unioning every tenant's own URL
 * into one process-wide set would let one tenant's saved host widen what any other
 * fetch in the process may reach. Both cases get the same answer: permit the host for
 * exactly the duration of the one call made on that tenant's behalf, whether that call
 * is a connection test or the tenant's own real traffic.
 *
 * `AsyncLocalStorage` rather than a module-level map (#548): a map keyed only by
 * hostname has no notion of *which* call granted the host, so any unrelated concurrent
 * fetch could ride along on someone else's grant for as long as it was open. The async
 * context, by contrast, propagates only along the call that opened it and its own
 * awaited descendants — an unrelated concurrent call never sees it, and there is
 * nothing to revoke on the way out: leaving the context does that automatically.
 */
const scopedHosts = new AsyncLocalStorage<ReadonlySet<string>>()

/** Permits every host in `url` for the duration of `fn`. */
export async function withScopedHost<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const hosts = hostOf(url)
  const inherited = scopedHosts.getStore() ?? new Set<string>()
  return scopedHosts.run(new Set([...inherited, ...hosts]), fn)
}

/** Whether `target` was explicitly permitted by an in-flight `withScopedHost`. */
function isScopedAllowed(target: string): boolean {
  let host: string
  try {
    host = new URL(target).hostname.toLowerCase()
  } catch {
    return false
  }
  return scopedHosts.getStore()?.has(host) === true
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

/**
 * Redirects do not inherit the initial request's loopback exception.
 *
 * Loopback is useful for Balancr's own health check when it is the URL the caller
 * deliberately requested. It is not a safe implicit destination for a server's
 * `Location` header. Configured private hosts still work: like every other redirect
 * target, they must be present in the explicit allowlist.
 */
function isRedirectAllowed(target: string, allowed: ReadonlySet<string>): boolean {
  try {
    return allowed.has(new URL(target).hostname.toLowerCase())
  } catch {
    return false
  }
}

/** The URL of anything `fetch` accepts as its first argument. */
function targetOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

export type EgressMode = 'enforce' | 'warn' | 'off'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
]
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'cookie2', 'host']

/** A URL key for loop detection. Fragments never reach the server. */
function redirectKey(url: URL): string {
  const key = new URL(url)
  key.hash = ''
  return key.href
}

/**
 * Reproduces fetch's redirect request rules while keeping every hop visible to the
 * guard. 301/302 turn POST into GET, 303 turns every non-GET/HEAD request into GET,
 * and 307/308 preserve the method and body. Credentials never cross an origin.
 */
function redirectedRequest(request: Request, target: URL, status: number): Request {
  const headers = new Headers(request.headers)
  const becomesGet =
    ((status === 301 || status === 302) && request.method === 'POST') ||
    (status === 303 && request.method !== 'GET' && request.method !== 'HEAD')

  if (becomesGet) {
    for (const name of BODY_HEADERS) headers.delete(name)
  }
  if (new URL(request.url).origin !== target.origin) {
    for (const name of CREDENTIAL_HEADERS) headers.delete(name)
  }

  const body = becomesGet || request.method === 'GET' || request.method === 'HEAD' ? null : request.body
  const init: RequestInit & { duplex?: 'half' } = {
    method: becomesGet ? 'GET' : request.method,
    headers,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  }
  if (body !== null) {
    init.body = body
    init.duplex = 'half'
  }
  return new Request(target, init)
}

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
 * (#369): a tenant picking a new AI provider through the settings page must be
 * able to reach it on the very next request, with no restart. The extra read is
 * one row from a single-digit-row table, which is nothing next to the network
 * call it is guarding. A tenant's Actual/Ghostfolio URL needs no such query here
 * at all — it is granted per call via `withScopedHost` instead (#535).
 */
let installed = false

export function installEgressGuard(mode: EgressMode = config.EGRESS_MODE, db?: Db): void {
  if (mode === 'off' || installed) return
  installed = true

  const original = globalThis.fetch.bind(globalThis)
  log.info({ hosts: [...allowedHosts(db)].sort(), mode }, 'egress allowlist installed')

  globalThis.fetch = async (input, init) => {
    const requestedTarget = targetOf(input)

    /**
     * The host, never the path: a denied URL can carry a query string, and a query
     * string on an exfiltration attempt is the data being exfiltrated. Logging it
     * would copy the thing this is trying to protect into the log file.
     */
    const permit = (target: string, redirect: boolean): void => {
      const allowed = redirect
        ? isRedirectAllowed(target, allowedHosts(db))
        : isAllowed(target, allowedHosts(db))
      if (allowed || isScopedAllowed(target)) return

      let host: string
      try {
        host = new URL(target).hostname
      } catch {
        host = '<unparseable>'
      }
      if (mode === 'warn') {
        log.warn({ host }, 'egress to an unconfigured host, allowed because EGRESS_MODE=warn')
        return
      }
      log.error({ host }, 'egress denied: host is not in the allowlist')
      throw new EgressDeniedError(host)
    }

    permit(requestedTarget, false)
    let request = new Request(input, init)
    const redirectMode = request.redirect
    const visited = new Set([redirectKey(new URL(request.url))])
    let redirects = 0

    for (;;) {
      // Keep the canonical request unconsumed so a 307/308 can replay its body.
      const response = await original(request.clone(), { redirect: 'manual' })
      if (!REDIRECT_STATUSES.has(response.status)) return response

      const location = response.headers.get('location')
      if (location === null) return response
      if (redirectMode === 'manual') return response
      if (redirectMode === 'error') throw new TypeError('fetch redirect mode is set to error')

      let target: URL
      try {
        target = new URL(location, request.url)
      } catch {
        throw new EgressRedirectError('invalid_location')
      }

      redirects += 1
      if (redirects > MAX_EGRESS_REDIRECTS) throw new EgressRedirectError('too_many')
      const key = redirectKey(target)
      if (visited.has(key)) throw new EgressRedirectError('loop')
      visited.add(key)

      permit(target.href, true)
      request = redirectedRequest(request, target, response.status)
    }
  }
}
