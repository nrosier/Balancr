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
 *
 * **Nothing here may write to Ghostfolio, and the types are what say so.** These are
 * somebody's real accounts on an instance Balancr shares with nothing else, and v1's
 * proposal machinery is deliberately local-effect only — no handler mutates either
 * source. Actual's half of that promise is enforced by not re-exporting a single
 * mutating method; this file's half is `ReadOptions`, which cannot express a method or
 * a body, and one POST that takes no arguments at all. It matters more here than the
 * endpoint count suggests: `POST /api/v1/order` and `POST /api/v1/import` are real
 * endpoints on the instance we authenticate against, and this is the file somebody
 * reaching for "while I'm in here, let me just record that transaction" would open.
 * `test/unit/ghostfolio-guard.test.ts` is the tripwire under both halves.
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

/**
 * Everything a read is allowed to ask for.
 *
 * This used to be `RequestInit & { authenticated?: boolean }`, and that is the door
 * #120 closes. `RequestInit` carries `method`, `body` and arbitrary headers, so any
 * caller holding one could place an order or start an import; the fact that no caller
 * did was a property of today's code rather than a property of the type. Every read
 * below needs exactly one thing to vary, so exactly one thing is on offer, and a write
 * is no longer a change to a string literal — it has to get past the compiler.
 */
interface ReadOptions {
  /**
   * False for the liveness check, which runs before there is a token to send and is
   * the only endpoint Ghostfolio answers without one.
   */
  authenticated?: boolean
}

/**
 * A fetch rejection, named.
 *
 * Timeouts and DNS failures arrive as TypeError/DOMException with a message that never
 * mentions the URL, so the path has to be added here or the log says only "fetch
 * failed" about one of three upstreams.
 */
function networkError(path: string, cause: unknown): GhostfolioError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new GhostfolioError(`request to ${path} failed: ${detail}`, path)
}

/** The decoded JSON body, or a GhostfolioError that says which of the two went wrong. */
async function decode(path: string, response: Response): Promise<unknown> {
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

/**
 * One GET, with a single re-authentication if the token has expired.
 *
 * There is no `method` here and no way to pass one: `fetch` defaults to GET, and the
 * default is the only thing this function can issue.
 */
async function request(path: string, options: ReadOptions = {}): Promise<unknown> {
  const authenticated = options.authenticated ?? true

  const get = async (bearer: string | null): Promise<Response> =>
    fetch(url(path), {
      headers: {
        accept: 'application/json',
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

  let response: Response
  try {
    response = await get(authenticated ? await token() : null)
  } catch (error) {
    throw networkError(path, error)
  }

  if (response.status === 401 && authenticated) {
    log.debug({ path }, 'Ghostfolio token rejected; re-authenticating once')
    cachedToken = null
    // Wrapped too: the retry can fail the same way the first attempt can, and an
    // unwrapped TypeError escaping from here would be the one Ghostfolio failure the
    // jobs could not tell apart from a bug in themselves.
    try {
      response = await get(await token())
    } catch (error) {
      throw networkError(path, error)
    }
  }

  return decode(path, response)
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

/**
 * The one POST this adapter issues, written out here rather than routed through
 * `request`.
 *
 * Authentication is not a mutation — it exchanges the security token from `.env` for a
 * JWT and changes nothing on the instance — but it is the only call that needs a method
 * and a body, so it is the only place either appears. Two things fall out of that.
 * `request` no longer has to accept them from anybody, which is the guarantee; and the
 * reentrancy is gone, where `request` called `token`, which called `request` again with
 * `authenticated: false` so as not to recurse for ever.
 *
 * It takes no arguments, so there is nothing here for a future caller to point at a
 * different path or fill with a different body.
 */
async function token(): Promise<string> {
  if (cachedToken !== null) return cachedToken

  const path = '/api/v1/auth/anonymous'
  let response: Response
  try {
    response = await fetch(url(path), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: config.GHOSTFOLIO_SECURITY_TOKEN }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw networkError(path, error)
  }

  // `authSchema` requires a non-empty string, so the cache can never hold a token that
  // would go out as a bare `Bearer`.
  cachedToken = parse(path, authSchema, await decode(path, response)).authToken
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
 *
 * `accountId` narrows the series to one account. The parameter is `accounts=<id>`,
 * repeated or comma-joined for several — **not** the `filters=[{id,type}]` array the
 * frontend sends elsewhere, which answers 400 here. It is honoured, and the proof is
 * a cash account: filtered to one it returns a shorter series of null values, where
 * an ignored parameter would have returned the portfolio's. Filtering to the account
 * that holds everything returns the unfiltered series byte for byte, which is the
 * right answer rather than evidence of a no-op.
 *
 * This is what lets the history backfill attribute a value to an account instead of
 * splitting a portfolio total across several, which would be inventing figures.
 */
export async function fetchPortfolioPerformance(
  range = 'max',
  accountId?: string,
): Promise<PortfolioPerformance> {
  const filter = accountId === undefined ? '' : `&accounts=${encodeURIComponent(accountId)}`
  const query = `?range=${encodeURIComponent(range)}${filter}`
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
