/**
 * Who is making this request, and whether they may.
 *
 * Deny by default, the same shape as the CSRF hook and for the same reason: a
 * route added in six months is protected because it exists, not because whoever
 * wrote it remembered a list. Opting out is `config: { auth: false }` on the
 * route, which is a string that can be grepped for and reviewed — unlike a route
 * that was simply never added to an allow-list.
 *
 * The hook runs at `preHandler` rather than `onRequest` so that the CSRF check and
 * the rate limiter, both `onRequest`, still apply to unauthenticated traffic. An
 * anonymous flood should be throttled rather than each request paying for a
 * session lookup first.
 *
 * `request.user` is set for every request that has a session, including ones on
 * exempt routes — the login page wants to know whether to show a name, and the
 * callback wants to know whether there is an old session to replace.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '../../db/index.ts'
import { SESSION_COOKIE } from '../cookies.ts'
import { unauthenticated } from '../errors.ts'
import { readSession, type ActiveSession, type SessionUser } from './sessions.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, or undefined. Set on every request. */
    user?: SessionUser
    /** The session behind `user`. Its token is deliberately not carried here. */
    session?: ActiveSession
    /** The raw cookie value, so logout can delete the row it points at. */
    sessionToken?: string
  }
  interface FastifyContextConfig {
    /**
     * `false` makes the route public. Absent means a session is required, which is
     * the default a new route gets by saying nothing.
     */
    auth?: boolean
  }
}

/**
 * Whether this request may proceed without a session.
 *
 * Two cases. The route said so, or the request matched no route at all —
 * `routeOptions.url` is undefined on the way to the not-found handler, and there
 * is nothing there to protect. Answering 401 for an unknown path would also make
 * every "this deployment has no such endpoint" answer a lie, including the 404
 * that `routes/auth.ts` relies on when OIDC is not configured.
 */
const isPublic = (request: FastifyRequest): boolean =>
  request.routeOptions.config.auth === false || request.routeOptions.url === undefined

export function registerAuth(app: FastifyInstance, db: Db): void {
  app.decorateRequest('user', undefined)
  app.decorateRequest('session', undefined)
  app.decorateRequest('sessionToken', undefined)

  app.addHook('preHandler', async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = request.cookies[SESSION_COOKIE]

    if (typeof token === 'string' && token.length > 0) {
      const resolved = readSession(db, token)
      if (resolved !== null) {
        request.user = resolved.user
        request.session = resolved.session
        request.sessionToken = token
      }
    }

    if (request.user === undefined && !isPublic(request)) {
      // No detail about why: whether a cookie was absent, expired or pointed at a
      // deleted row is not the client's business, and the log line already has it.
      throw unauthenticated()
    }
  })
}

/**
 * The signed-in user, or a 401.
 *
 * For handlers on protected routes, where the hook has already guaranteed a user
 * but the type cannot say so. Cheaper than widening `FastifyRequest` with a
 * non-optional field that is genuinely absent on public routes.
 */
export function requireUser(request: FastifyRequest): SessionUser {
  const user = request.user
  if (user === undefined) throw unauthenticated()
  return user
}
