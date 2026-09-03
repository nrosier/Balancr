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
 *  5. **authentication** — a `preHandler`, so it runs after all of the above and
 *     an anonymous flood is throttled before it costs a session lookup. Deny by
 *     default; a route opts out with `config: { auth: false }`.
 *  6. **error handling** — replaces Fastify's default, which echoes the thrown
 *     message and would leak SQLite and upstream detail.
 *  7. **routes** — last, so every hook above already applies to them, and the SPA
 *     last of all: it is the only thing here that claims a wildcard.
 */
import cookie from '@fastify/cookie'
import Fastify, { LogController } from 'fastify'
import type { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { config } from '../config.ts'
import type { Db } from '../db/index.ts'
import { logger } from '../logger.ts'
import { registerAuth } from './auth/guard.ts'
import { oidcClientFromConfig, type OidcClient } from './auth/oidc.ts'
import { registerCsrf } from './csrf.ts'
import { notFoundHandler, registerErrorHandling } from './errors.ts'
import { registerRateLimits } from './rate-limit.ts'
import { registerAiRoutes } from './routes/ai.ts'
import { registerApiRoutes } from './routes/api/index.ts'
import { registerAuthRoutes } from './routes/auth.ts'
import { registerBootstrapRoute } from './routes/bootstrap.ts'
import { registerHealthRoutes } from './routes/health.ts'
import { registerSettingsRoutes } from './routes/settings.ts'
import { registerSecurityHeaders } from './security.ts'
import { registerSpa, spaNotFoundHandler, webRoot } from './spa.ts'
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
  /** Where the rate-limit counters, the sessions and the login flows live. */
  db: Db
  /**
   * The OIDC client, for tests that drive a fake issuer.
   *
   * Undefined means "build it from configuration", which is what production does.
   * Explicit `null` means "this deployment has no OIDC", which is a case a test
   * needs to be able to state — otherwise the only way to reach that path would be
   * to mutate the environment after `config.ts` has already read it.
   */
  oidc?: OidcClient | null
  /**
   * Where the built SPA is.
   *
   * Undefined means "look for it on disk", which is what production does. Explicit
   * `null` means "this instance serves the API only" — which every server test says,
   * because otherwise the behaviour of `GET /` and of an unknown path would depend on
   * whether the developer happened to have run `npm run build`, and a suite that
   * passes or fails according to what is in `dist/` is worse than no suite. A string
   * points at a bundle directly, which is how the SPA's own test uses a fixture.
   */
  web?: string | null
}

export async function buildApp({ db, oidc, web }: BuildAppOptions): Promise<FastifyInstance> {
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
  registerAuth(app, db)

  // Resolved once, before error handling, because it decides what a 404 is: with a
  // bundle an unknown path that a browser is navigating to gets the shell so the
  // client-side router can resolve it, and without one it gets the JSON envelope.
  const bundle = web === undefined ? webRoot() : web
  registerErrorHandling(
    app,
    bundle === null ? notFoundHandler : spaNotFoundHandler(bundle, notFoundHandler),
  )

  registerHealthRoutes(app, db)
  registerBootstrapRoute(app)
  registerAuthRoutes(app, { db, oidc: oidc === undefined ? oidcClientFromConfig() : oidc })
  registerApiRoutes(app, db)
  // The two route modules that are allowed to write, kept out of `routes/api/` so
  // that directory's read-only rule stays checkable by a test that scans it.
  registerSettingsRoutes(app, db)
  registerAiRoutes(app, db)
  await registerSpa(app, bundle)

  log.debug(
    {
      trustedProxies: config.TRUSTED_PROXY_CIDRS,
      rateLimitPerMinute: config.RATE_LIMIT_API_PER_MINUTE,
      rateLimitAiPerHour: config.RATE_LIMIT_AI_PER_HOUR,
      oidc: config.AUTH_OIDC_ISSUER !== undefined,
      localLogin: config.AUTH_LOCAL_ENABLED,
      web: bundle !== null,
    },
    'server built',
  )

  return app
}
