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
 *  - **Local login is gated on the *peer* address, not on `request.ip`.** The
 *    socket's remote address is the one an HTTP client cannot choose;
 *    `X-Forwarded-For` is exactly what an attacker coming through the tunnel would
 *    set. That distinction is the entire value of `AUTH_LOCAL_ALLOWED_CIDRS`.
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
import { verifyLocalLogin } from '../auth/local.ts'
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
import { badRequest, HttpError, notFound } from '../errors.ts'
import { inCidrs, peerAddress } from '../net.ts'
import { loginRateLimit } from '../rate-limit.ts'
import { LOCAL_LOGIN_CIDRS } from '../trust.ts'

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

/**
 * Whether a password login would be entertained from this connection.
 *
 * Two conditions, and the second is the one that matters: the peer address, from
 * the socket, must be inside `AUTH_LOCAL_ALLOWED_CIDRS`. Not `request.ip` — that
 * is derived from `X-Forwarded-For` for a trusted proxy, and the whole scenario
 * being defended against is a request arriving through the public tunnel with a
 * LAN address written into a header.
 *
 * Which means Traefik's own address must not be in the range: if it is, everything
 * it forwards is inside the range, tunnel included. That is why `config.ts` refuses
 * a `TRUSTED_PROXY_CIDRS` of loopback in production, and why this is worth reading
 * twice before changing.
 */
const localLoginAvailable = (request: FastifyRequest): boolean =>
  config.AUTH_LOCAL_ENABLED && inCidrs(peerAddress(request), LOCAL_LOGIN_CIDRS)

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
    // `local` answers "would a password work from where you are", not "is the
    // feature switched on" — the login screen uses this to decide whether to draw
    // the form, and a form that is guaranteed to 404 is worse than no form.
    methods: { oidc: oidc !== null, local: localLoginAvailable(request) },
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

  if (config.AUTH_LOCAL_ENABLED) {
    /**
     * The break-glass password login.
     *
     * Registered only when the feature is on, and then answered with a 404 unless
     * the peer is inside the allowed range. A 404 rather than a 403 in both cases:
     * the interesting fact about this endpoint is that it exists, and an attacker
     * who learns "there is a password login here, just not for you" has learned
     * where to go looking for a foothold. The operator's diagnostic is the log line
     * below, which says precisely which address was turned away — the response
     * deliberately says nothing.
     */
    app.post(
      '/auth/local/login',
      { config: { auth: false, ...loginRateLimit().config } },
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (!localLoginAvailable(request)) {
          log.warn(
            { peer: peerAddress(request), allowed: config.AUTH_LOCAL_ALLOWED_CIDRS },
            'local login refused: peer outside AUTH_LOCAL_ALLOWED_CIDRS',
          )
          throw notFound()
        }

        const body = request.body as Record<string, unknown> | undefined
        const email = body?.['email']
        const password = body?.['password']
        const totp = body?.['totp']
        if (
          typeof email !== 'string' ||
          typeof password !== 'string' ||
          typeof totp !== 'string' ||
          email.length === 0
        ) {
          // A shape complaint, not a credential verdict, so this one is allowed to
          // be specific: it describes the request rather than the account.
          throw badRequest('email, password and totp are required.')
        }

        const user = await verifyLocalLogin(db, { email, password, totp })

        if (request.sessionToken !== undefined) destroySession(db, request.sessionToken)

        const session = createSession(db, {
          userId: user.id,
          method: 'local',
          ip: request.ip,
          userAgent: request.headers['user-agent'],
        })

        void reply.setCookie(
          SESSION_COOKIE,
          session.token,
          cookieAttributes(true, Math.floor(sessionTtlMs() / 1000)),
        )
        void reply.setCookie(CSRF_COOKIE, newCsrfToken(), cookieAttributes(false))

        return reply.status(200).send({
          authenticated: true,
          user: {
            email: user.email,
            displayName: user.displayName,
            locale: user.locale,
            role: user.role,
          },
        })
      },
    )
  }

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
