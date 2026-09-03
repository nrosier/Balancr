/**
 * Four buckets: one against noise, one against cost, one against guessing, one
 * against a refresh loop.
 *
 * The global bucket is ordinary hygiene — it keeps a loop in a broken client from
 * saturating a single-process server. The bucket in front of `/api/ai/*` is a
 * different kind of control: those routes spend money at a pre-paid Gemini
 * account, and Authentik cannot help, because the requests that cost the most are
 * the ones that are correctly authenticated. So the AI bucket is deliberately
 * small and measured in hours rather than minutes: it is a spend limit expressed
 * as a request limit, sitting in front of the cost guard rather than instead of it.
 * The third sits in front of the break-glass password login, where each attempt
 * costs an argon2 hash and the thing being guessed is six digits long. The fourth
 * sits in front of the refresh routes, where the cost is not money or CPU but
 * somebody else's Actual instance.
 *
 * Counters live in SQLite. See `rate_limits` in the schema for why: an hourly
 * money limit that resets on restart is not a limit, and this process restarts on
 * every deploy.
 *
 * The client key is `request.ip`, which Fastify resolved through `trustProxy` —
 * correct here, and note the asymmetry with `net.ts`. A forged `X-Forwarded-For`
 * from an untrusted peer never reaches this code, because `trustProxy` ignores the
 * header for such a peer and uses the socket address instead. That is the
 * difference between "the rate limit is bypassable with a header" and not.
 */
import rateLimit from '@fastify/rate-limit'
import { and, eq, gt, lt, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify'
import { config } from '../config.ts'
import type { Db } from '../db/index.ts'
import { rateLimits } from '../db/schema.ts'
import { logger } from '../logger.ts'
import { HttpError } from './errors.ts'

const log = logger.child({ module: 'server.rate-limit' })

/**
 * How often expired rows are swept, as one in every N writes.
 *
 * Sweeping on every request would double the write cost to delete rows nothing
 * reads; a cron job for a handful of rows would be silly. One in fifty keeps the
 * table bounded by the number of *active* clients rather than by uptime.
 */
export const SWEEP_EVERY = 50

/** The route config for anything that can reach Gemini. */
export const AI_RATE_LIMIT = {
  max: config.RATE_LIMIT_AI_PER_HOUR,
  timeWindow: '1 hour',
} as const

/**
 * Spreadable route options, so a costly route opts in by construction rather than
 * by remembering a convention: `app.get('/api/ai/x', { ...aiRateLimit() }, h)`.
 */
export const aiRateLimit = (): { config: { rateLimit: typeof AI_RATE_LIMIT } } => ({
  config: { rateLimit: AI_RATE_LIMIT },
})

/**
 * The bucket in front of the break-glass password login.
 *
 * Fixed rather than configurable, because there is no deployment that wants this
 * looser and the knob would only ever be turned the wrong way. Ten attempts a
 * quarter of an hour per address is far above what a person needs — a password and
 * a six-digit code, mistyped a few times — and far below what guessing needs. The
 * per-account lockout in `auth/local.ts` is the real defence; this is what stops
 * one client spending the server's argon2 budget on many accounts.
 */
export const LOGIN_RATE_LIMIT = {
  max: 10,
  timeWindow: '15 minutes',
} as const

/**
 * The bucket in front of a refresh.
 *
 * A refresh is already refused while one is running, so this is not about
 * concurrency — it is about the client that starts one the instant the last finished.
 * Every accepted refresh reaches out to Actual and Ghostfolio, and those are someone
 * else's instances on the same host: a loop in a browser tab that cannot overlap
 * itself can still hold the sync engine busy indefinitely and starve the nightly pass.
 *
 * Thirty an hour, fixed rather than configurable. A person watching a page and
 * pressing refresh after fixing something in Actual does that a handful of times; no
 * deployment wants this looser, and a knob would only ever be turned the wrong way.
 */
export const REFRESH_RATE_LIMIT = {
  max: 30,
  timeWindow: '1 hour',
} as const

/** Spreadable route options for the refresh routes. See `REFRESH_RATE_LIMIT`. */
export const refreshRateLimit = (): { config: { rateLimit: typeof REFRESH_RATE_LIMIT } } => ({
  config: { rateLimit: REFRESH_RATE_LIMIT },
})

/** Spreadable route options for the local login route. See `LOGIN_RATE_LIMIT`. */
export const loginRateLimit = (): { config: { rateLimit: typeof LOGIN_RATE_LIMIT } } => ({
  config: { rateLimit: LOGIN_RATE_LIMIT },
})

/** What the plugin hands the store's constructor and `child`. */
interface StoreParams {
  timeWindow?: number
  max?: number
  routeInfo?: { method?: string; url?: string }
}

interface StoreResult {
  current: number
  ttl: number
}

type StoreCallback = (error: Error | null, result?: StoreResult) => void

/**
 * The store, as a class the plugin can construct, built by a factory closing over
 * the database.
 *
 * Not a module singleton: the plugin instantiates the store itself
 * (`new Store(params)`) and rebuilds those params from the option keys it knows
 * about, so there is no way to pass a database handle through plugin options — and
 * a module-level connection would make this untestable against an in-memory
 * database.
 */
export function sqliteRateLimitStore(db: Db) {
  let writes = 0

  function sweep(now: number): void {
    writes += 1
    if (writes % SWEEP_EVERY !== 0) return
    db.delete(rateLimits).where(lt(rateLimits.expiresAt, new Date(now))).run()
  }

  return class SqliteStore {
    /**
     * Keeps the buckets apart. Without a per-route key every limited route would
     * increment the same row, and a burst of ordinary reads would eat the AI
     * allowance — the opposite of the point.
     */
    private readonly bucket: string

    constructor(_params: StoreParams, bucket = 'global') {
      this.bucket = bucket
    }

    /**
     * One statement, so two concurrent requests cannot both read 4 and write 5.
     *
     * The upsert either starts a window or advances it: the `case` compares the
     * *stored* `expires_at` against now, so an elapsed window restarts at 1 while a
     * live one increments and keeps its original end. In JavaScript this would be a
     * read followed by a write over a connection shared with the job queue.
     */
    incr(key: string, callback: StoreCallback, timeWindow: number, _max: number): void {
      const now = Date.now()
      const expires = now + timeWindow
      const id = `${this.bucket}:${key}`

      try {
        const rows = db
          .insert(rateLimits)
          .values({ key: id, count: 1, expiresAt: new Date(expires) })
          .onConflictDoUpdate({
            target: rateLimits.key,
            set: {
              count: sql`case when ${rateLimits.expiresAt} <= ${now} then 1 else ${rateLimits.count} + 1 end`,
              expiresAt: sql`case when ${rateLimits.expiresAt} <= ${now} then ${expires} else ${rateLimits.expiresAt} end`,
            },
          })
          .returning()
          .all()

        const row = rows[0]
        if (row === undefined) {
          callback(new Error('rate limit counter returned no row'))
          return
        }

        sweep(now)
        // `ttl` becomes `Retry-After`, so it is the time left in the window and
        // never the window's length — otherwise a client told to wait an hour
        // after 59 minutes of a quiet window would back off for no reason.
        callback(null, { current: row.count, ttl: Math.max(0, row.expiresAt.getTime() - now) })
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    }

    /**
     * A non-mutating peek, for the plugin's `{ increment: false }` mode.
     *
     * An elapsed window reads as a clean slate rather than as its stale count, so a
     * peek and a real request agree on whether the window is still open.
     */
    read(key: string, callback: StoreCallback, _timeWindow: number, _max: number): void {
      const now = Date.now()
      try {
        const rows = db
          .select()
          .from(rateLimits)
          .where(
            and(eq(rateLimits.key, `${this.bucket}:${key}`), gt(rateLimits.expiresAt, new Date(now))),
          )
          .all()
        const row = rows[0]
        callback(
          null,
          row === undefined
            ? { current: 0, ttl: 0 }
            : { current: row.count, ttl: Math.max(0, row.expiresAt.getTime() - now) },
        )
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    }

    /**
     * Per-route store. The plugin calls this once per route at registration.
     *
     * The published typings say the argument is a `RouteOptions`; the plugin
     * actually passes its own merged params, which carry the route under
     * `routeInfo`. Signature written to match the typings so the store is
     * assignable, body written against what actually arrives.
     */
    child(routeOptions: RouteOptions & { path: string; prefix: string }): SqliteStore {
      const params = routeOptions as unknown as StoreParams
      const route = params.routeInfo
      const bucket = route?.url === undefined ? 'global' : `${route.method ?? 'ANY'} ${route.url}`
      return new SqliteStore(params, bucket)
    }
  }
}

/** Where the client key comes from. See the module header on why `ip` is right. */
const keyGenerator = (request: FastifyRequest): string => request.ip

export async function registerRateLimits(app: FastifyInstance, db: Db): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_API_PER_MINUTE,
    timeWindow: '1 minute',
    store: sqliteRateLimitStore(db),
    keyGenerator,
    // A counter that cannot be written must not become an outage: this connection
    // is shared with the job queue, and a SQLITE_BUSY there would otherwise 500
    // every request. Logged by the plugin, so it is degraded rather than silent.
    skipOnError: true,
    // Worth a line on this deployment: tripping a limit means either a broken
    // client or someone knocking, and both are things to look at.
    onExceeded: (request, key) => {
      log.warn(
        { key, ip: request.ip, method: request.method, url: request.url },
        'rate limit exceeded',
      )
    },
    // Returned as an `HttpError` rather than a plain body: the plugin throws
    // whatever this builds, so the shared error handler is what actually
    // serialises it, and only an `HttpError` has its message echoed rather than
    // replaced. That keeps one envelope in the app and still lets the client be
    // told how long to wait — the same figure the plugin puts in `Retry-After`.
    errorResponseBuilder: (_request, context) =>
      new HttpError(429, 'rate_limited', `Too many requests. Try again in ${context.after}.`),
  })
}
