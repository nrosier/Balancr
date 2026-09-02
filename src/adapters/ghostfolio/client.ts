/**
 * All Ghostfolio HTTP lives in this one file.
 *
 * That is the mitigation for depending on an unversioned internal API: when a
 * Ghostfolio upgrade changes a response, the fix is confined to one file and
 * `probe.ts` says which path broke, instead of wrong numbers appearing on a
 * chart. `types.ts` explains which endpoints are documented and which are not.
 *
 * The public-share endpoint (`/api/v1/public/<accessId>/portfolio`) is
 * deliberately not used: it would require exposing an unauthenticated URL
 * containing the whole portfolio.
 */
import { z } from 'zod'
import { config } from '../../config.ts'
import { logger } from '../../logger.ts'
import {
  accountsSchema,
  authSchema,
  healthSchema,
  performanceSchema,
  portfolioDetailsSchema,
  type GhostfolioAccounts,
  type PortfolioDetails,
  type PortfolioPerformance,
} from './types.ts'

const log = logger.child({ module: 'ghostfolio' })

/** A hung upstream must not hang the nightly job for ever. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * Ghostfolio's JWT lifetime is not documented, so it is not assumed: the token
 * is cached, and a 401 triggers exactly one re-authentication and retry.
 */
let cachedToken: string | null = null

export class GhostfolioError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GhostfolioError'
  }
}

function url(path: string): string {
  return `${config.GHOSTFOLIO_URL.replace(/\/+$/, '')}${path}`
}

async function request(
  path: string,
  init: RequestInit & { authenticated?: boolean } = {},
): Promise<unknown> {
  const { authenticated = true, ...rest } = init

  const send = async (token: string | null): Promise<Response> =>
    fetch(url(path), {
      ...rest,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...rest.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

  let response: Response
  try {
    response = await send(authenticated ? await token() : null)
  } catch (error) {
    // Timeouts and DNS failures arrive as TypeError/DOMException, with a message
    // that never mentions the URL.
    throw new GhostfolioError(
      `request to ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      path,
    )
  }

  if (response.status === 401 && authenticated) {
    log.debug({ path }, 'Ghostfolio token rejected; re-authenticating once')
    cachedToken = null
    response = await send(await token())
  }

  if (!response.ok) {
    throw new GhostfolioError(
      `${path} returned HTTP ${response.status}`,
      path,
      response.status,
    )
  }

  try {
    return await response.json()
  } catch {
    throw new GhostfolioError(`${path} did not return JSON`, path, response.status)
  }
}

/** Parses a response, naming the path so a shape change is legible. */
function parse<T>(path: string, schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw)
  if (!result.success) {
    throw new GhostfolioError(
      `${path} returned an unexpected shape — Ghostfolio's internal API may have ` +
        `changed:\n${z.prettifyError(result.error)}`,
      path,
    )
  }
  return result.data
}

async function token(): Promise<string> {
  if (cachedToken) return cachedToken

  const path = '/api/v1/auth/anonymous'
  const raw = await request(path, {
    authenticated: false,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessToken: config.GHOSTFOLIO_SECURITY_TOKEN }),
  })
  cachedToken = parse(path, authSchema, raw).authToken
  return cachedToken
}

/** Drops the cached JWT. Used by the probe and by tests. */
export function resetGhostfolioToken(): void {
  cachedToken = null
}

// ---------------------------------------------------------------------------
//  Endpoints
// ---------------------------------------------------------------------------

/** Unauthenticated liveness check. The only endpoint safe to call before auth. */
export async function fetchHealth(): Promise<void> {
  const path = '/api/v1/health'
  parse(path, healthSchema, await request(path, { authenticated: false }))
}

/** Holdings and summary. The backbone of the portfolio view. */
export async function fetchPortfolioDetails(): Promise<PortfolioDetails> {
  const path = '/api/v1/portfolio/details'
  return parse(path, portfolioDetailsSchema, await request(path))
}

/**
 * Value and performance series. `range=max` because the net-worth chart wants
 * all of history, and Ghostfolio computes it far more cheaply than we could
 * from orders.
 *
 * **The only endpoint Balancr reads that is versioned twice.** Current Ghostfolio
 * answers on `/api/v2` and 404s on `/api/v1`; releases this adapter was written
 * against do the opposite. So v2 is tried first and a 404 falls back — the same
 * rule the two `holdings` layouts follow in `types.ts`, and for the same reason:
 * an upgrade in either direction has to keep working, and a version probe would
 * be a second thing to keep true.
 *
 * A 404 is the only status that falls back. Every other failure is the instance
 * telling us something — 401 is a bad token, 500 is Ghostfolio in trouble — and
 * retrying those against an older path would replace one clear error with a
 * confusing one.
 *
 * The v2 response is a superset: the same `date`, `value` and
 * `netPerformanceInPercentage` this schema reads, plus fields `.loose()` ignores.
 * That is why there is one schema for both.
 */
export async function fetchPortfolioPerformance(
  range = 'max',
): Promise<PortfolioPerformance> {
  const query = `?range=${encodeURIComponent(range)}`
  const paths = [`/api/v2/portfolio/performance${query}`, `/api/v1/portfolio/performance${query}`]

  for (const [index, path] of paths.entries()) {
    const last = index === paths.length - 1
    try {
      const raw = await request(path)
      // Logged once per pass and at debug, because the answer is stable for the
      // life of an instance — but the next time this moves, the log says where it
      // was last found.
      log.debug({ path }, 'Ghostfolio performance series answered')
      return parse(path, performanceSchema, raw)
    } catch (error) {
      if (last || !(error instanceof GhostfolioError) || error.status !== 404) throw error
      log.debug({ path }, 'Ghostfolio performance series absent here; trying the older path')
    }
  }

  // Unreachable: the final iteration either returns or rethrows.
  throw new GhostfolioError('no performance endpoint was tried', paths[0] ?? '')
}

/**
 * Accounts and cash balances.
 *
 * Needed for net worth: an investment account often exists in both Actual and
 * Ghostfolio, and `account_map.is_source_of_truth` decides which one counts.
 * Without this list there is nothing to map against.
 */
export async function fetchAccounts(): Promise<GhostfolioAccounts> {
  const path = '/api/v1/account'
  return parse(path, accountsSchema, await request(path))
}
