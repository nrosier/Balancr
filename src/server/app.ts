/**
 * The Fastify instance, assembled in one place.
 *
 * A factory rather than a module-level singleton so a test can build a real app
 * against an in-memory database — the alternative is testing hooks by calling them
 * with hand-made request objects, which passes while the wiring is wrong.
 *
 * Registration order is the security order, and each step is here because of what
 * would happen if it came later:
 *
 *  1. **cookies** — the CSRF hook reads `request.cookies`, which does not exist
 *     until the plugin is registered.
 *  2. **security headers** — an `onSend` hook, so it must be in place before any
 *     route can reply, including an error reply.
 *  3. **rate limits** — an `onRequest` hook, and it must run *before* CSRF: a flood
 *     of requests with no token should be throttled like any other flood, not given
 *     a free 403 each time.
 *  4. **CSRF** — after rate limiting, before any route.
 *  5. **error handling** — replaces Fastify's default, which echoes the thrown
 *     message and would leak SQLite and upstream detail.
 *  6. **routes** — last, so every hook above already applies to them.
 */
import cookie from '@fastify/cookie'
import Fastify, { LogController } from 'fastify'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { config } from '../config.ts'
import type { Db } from '../db/index.ts'
import { logger } from '../logger.ts'
import { registerCsrf } from './csrf.ts'
import { registerErrorHandling } from './errors.ts'
import { registerRateLimits } from './rate-limit.ts'
import { registerHealthRoutes } from './routes/health.ts'
import { registerSecurityHeaders } from './security.ts'
import { TRUSTED_PROXIES } from './trust.ts'

const log = logger.child({ module: 'server.app' })

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The parsed trusted-proxy ranges, so a route can ask `isTrustedPeer(request,
     * app.trustedProxies)` without importing configuration itself.
     */
    trustedProxies: typeof TRUSTED_PROXIES
  }
}

export interface BuildAppOptions {
  /** The database the rate-limit counters live in, and later sessions and reads. */
  db: Db
}

export async function buildApp({ db }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // Cast so the instance keeps Fastify's default generic parameters. Passing the
    // pino logger through unwidened specialises `FastifyInstance` on pino's own
    // `Logger` type, and every helper here that takes a plain `FastifyInstance`
    // then stops accepting it. Our own logging goes through the module-level
    // `logger` regardless, so nothing is lost.
    loggerInstance: logger as FastifyBaseLogger,
    // Honoured only for peers inside TRUSTED_PROXY_CIDRS: without this, anyone
    // reaching the container directly can forge X-Forwarded-For and, later, the
    // Authentik identity headers. Note that this governs `request.ip` only —
    // decisions about *identity* use the socket address; see `net.ts`.
    trustProxy: config.TRUSTED_PROXY_CIDRS,
    // The top-level `disableRequestLogging` is deprecated in Fastify 5.12 and goes
    // away in 6; the controller is the supported route. Access logs are off in
    // production because Traefik already writes them, and duplicating them here
    // doubles the disk they occupy on the way to holding financial data.
    logController: new LogController({
      disableRequestLogging: config.NODE_ENV === 'production',
    }),
    // The default 1 MiB is far more than any request here needs, and this instance
    // is reachable from the internet.
    bodyLimit: 256 * 1024,
    // `genReqId` is left at Fastify's default counter on purpose. The id goes into
    // the error envelope so a user can quote it and the matching log line can be
    // found; deriving it from a request header instead would let a caller choose
    // its own log key, which is worth nothing and costs log integrity.
  })

  app.decorate('trustedProxies', TRUSTED_PROXIES)

  // No signing secret: session ids are 32 random bytes looked up server-side, so a
  // signature would prove nothing that the lookup does not already prove. The CSRF
  // cookie is compared against itself. Adding a secret here would imply cookie
  // contents are trusted, which is exactly the belief this design avoids.
  await app.register(cookie)

  await registerSecurityHeaders(app)
  await registerRateLimits(app, db)
  registerCsrf(app)
  registerErrorHandling(app)
  registerHealthRoutes(app)

  log.debug(
    {
      trustedProxies: config.TRUSTED_PROXY_CIDRS,
      rateLimitPerMinute: config.RATE_LIMIT_API_PER_MINUTE,
      rateLimitAiPerHour: config.RATE_LIMIT_AI_PER_HOUR,
    },
    'server built',
  )

  return app
}
