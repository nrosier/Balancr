/**
 * The login endpoints.
 *
 * The shape is the ordinary OIDC code flow, and the parts worth reading for are
 * the ones that are not about OIDC at all:
 *
 *  - **The callback is looked up by cookie, not by the `state` in the URL.** An
 *    attacker who starts their own login and hands the victim the resulting
 *    callback link would otherwise log the victim in as themselves — which sounds
 *    harmless until you consider that the attacker then controls an account the
 *    victim is typing their finances into. The cookie is what makes the link
 *    useless on its own.
 *  - **Both cookies are replaced on login.** A new session id, and a new CSRF
 *    token, so nothing chosen before authentication survives it.
 *  - **`/auth/login` and `/auth/callback` exist only when OIDC is configured.** A
 *    404 is the honest answer for a capability this deployment does not have, and
 *    it is better than an endpoint that always fails with an explanation.
 *
 * Every route here is `auth: false`: they are how a session is obtained, so
 * requiring one would be a loop. `/auth/logout` is a POST and therefore still
 * carries the CSRF check, which is the point — a logout link on someone else's
 * page is a nuisance attack, but a cheap one to close.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { logger } from '../../logger.ts'
import {
  consumeLoginFlow,
  LOGIN_FLOW_TTL_MS,
  safeReturnTo,
  startLoginFlow,
} from '../auth/login-flow.ts'
import type { OidcClient } from '../auth/oidc.ts'
import { createSession, destroySession, sessionTtlMs } from '../auth/sessions.ts'
import { upsertOidcUser } from '../auth/users.ts'
import {
  clearedCookie,
  cookieAttributes,
  CSRF_COOKIE,
  LOGIN_FLOW_COOKIE,
  SESSION_COOKIE,
} from '../cookies.ts'
import { newCsrfToken } from '../csrf.ts'
import { HttpError } from '../errors.ts'

const log = logger.child({ module: 'server.routes.auth' })

/** Public route config, spelled out once. */
const publicRoute = { config: { auth: false } } as const

/**
 * One message for every way a login can fail after the redirect.
 *
 * Distinguishing "no such state" from "already used" from "expired" would confirm
 * a guess to whoever is guessing, and none of the three is actionable for the
 * person in front of the browser: the answer is always to start again.
 */
const loginFailed = (): HttpError =>
  new HttpError(400, 'bad_request', 'That login could not be completed. Please start again.')

export interface AuthRoutesOptions {
  db: Db
  /** Null when OIDC is not configured, in which case those two routes are absent. */
  oidc: OidcClient | null
}

export function registerAuthRoutes(app: FastifyInstance, { db, oidc }: AuthRoutesOptions): void {
  /**
   * What the browser may know before signing in: whether there is a session, and
   * which methods are on offer. The login screen needs the second part to decide
   * what to render, and neither part is a secret — an unauthenticated caller can
   * already discover which endpoints exist.
   */
  app.get('/auth/session', publicRoute, (request: FastifyRequest) => ({
    authenticated: request.user !== undefined,
    user:
      request.user === undefined
        ? null
        : {
            email: request.user.email,
            displayName: request.user.displayName,
            locale: request.user.locale,
            role: request.user.role,
          },
    methods: { oidc: oidc !== null, local: config.AUTH_LOCAL_ENABLED },
  }))

  app.post('/auth/logout', publicRoute, (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.sessionToken
    if (token !== undefined) destroySession(db, token)

    void reply.setCookie(SESSION_COOKIE, '', clearedCookie(true))
    // Rotated rather than cleared: the next request is very likely the login page,
    // and it needs a token to post with.
    void reply.setCookie(CSRF_COOKIE, newCsrfToken(), cookieAttributes(false))
    return reply.status(204).send()
  })

  if (oidc === null) {
    log.info('OIDC is not configured; /auth/login and /auth/callback are not registered')
    return
  }

  app.get('/auth/login', publicRoute, async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { return_to?: unknown } | undefined
    const flow = startLoginFlow(db, safeReturnTo(query?.return_to))
    const url = await oidc.authorizationUrl(flow)

    void reply.setCookie(
      LOGIN_FLOW_COOKIE,
      flow.state,
      cookieAttributes(true, Math.floor(LOGIN_FLOW_TTL_MS / 1000)),
    )

    // 303 rather than 302: this is a GET answered with "go and look over there",
    // and 303 says so without depending on how a client reads a 302.
    return reply.redirect(url.toString(), 303)
  })

  app.get('/auth/callback', publicRoute, async (request: FastifyRequest, reply: FastifyReply) => {
    const cookieState = request.cookies[LOGIN_FLOW_COOKIE]
    // Cleared before anything can go wrong, so a failed attempt does not leave a
    // usable flow cookie behind for a second try with a different code.
    void reply.setCookie(LOGIN_FLOW_COOKIE, '', clearedCookie(true))

    if (typeof cookieState !== 'string' || cookieState.length === 0) {
      log.warn({ ip: request.ip }, 'OIDC callback without a flow cookie')
      throw loginFailed()
    }

    const flow = consumeLoginFlow(db, cookieState)
    if (flow === null) {
      log.warn({ ip: request.ip }, 'OIDC callback for an unknown, used or expired flow')
      throw loginFailed()
    }

    // Rebuilt from the configured base URL rather than from the `Host` header: the
    // library reads the response parameters out of this URL, and a request-supplied
    // host has no business influencing that.
    const currentUrl = new URL(request.url, config.PUBLIC_BASE_URL)

    let identity
    try {
      identity = await oidc.exchange({
        currentUrl,
        state: flow.state,
        nonce: flow.nonce,
        codeVerifier: flow.codeVerifier,
      })
    } catch (error) {
      // Includes the state and nonce mismatches, a failed PKCE check and the
      // provider's own `error=access_denied`. All of it is logged; none of it is
      // returned, because the detail describes the attempt rather than the fix.
      if (error instanceof HttpError) throw error
      log.warn({ err: error, ip: request.ip }, 'OIDC code exchange failed')
      throw loginFailed()
    }

    const user = upsertOidcUser(db, identity)

    // Any session this browser already had is ended rather than left running. It
    // may belong to a different account, and it certainly should not outlive a
    // deliberate re-login.
    if (request.sessionToken !== undefined) destroySession(db, request.sessionToken)

    const session = createSession(db, {
      userId: user.id,
      method: 'oidc',
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    })

    void reply.setCookie(
      SESSION_COOKIE,
      session.token,
      cookieAttributes(true, Math.floor(sessionTtlMs() / 1000)),
    )
    // A fresh CSRF token for the authenticated session, so a value planted before
    // the login is not the one the session goes on using.
    void reply.setCookie(CSRF_COOKIE, newCsrfToken(), cookieAttributes(false))

    log.info({ userId: user.id, role: user.role }, 'signed in via OIDC')
    return reply.redirect(flow.returnTo, 303)
  })
}
