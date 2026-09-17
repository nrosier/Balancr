/**
 * Where a pending identity becomes a real tenant member (#373).
 *
 * Both routes here are `auth: false` for the same reason `/auth/login` and
 * `/auth/callback` are: they are how a session is obtained, not something a
 * session is needed for. What replaces authentication is the onboarding
 * cookie — proof that `/auth/callback` just vouched for this `sub` — so every
 * handler starts by re-reading it, exactly like `/auth/callback` re-reads the
 * login-flow cookie.
 *
 * Both failure paths collapse every reason into one message: a missing or
 * expired onboarding cookie reads the same as any other, and a bad invite
 * code reads the same whether it was wrong, expired, revoked or already used.
 * Neither is actionable beyond "start again" or "check the code", and telling
 * the two apart would only help whoever is guessing.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.ts'
import type { Db } from '../../db/index.ts'
import { allTenantIds } from '../../db/tenant.ts'
import { logger } from '../../logger.ts'
import { createTenantAndOwner, redeemInviteAsViewer, type Identity } from '../../domain/tenant/provisioning.ts'
import {
  consumePendingIdentity,
  peekPendingIdentity,
  type PendingIdentity,
} from '../auth/onboarding.ts'
import { createSession, destroySession, sessionTtlMs } from '../auth/sessions.ts'
import { toSessionUser } from '../auth/users.ts'
import {
  clearedCookie,
  cookieAttributes,
  CSRF_COOKIE,
  ONBOARDING_COOKIE,
  SESSION_COOKIE,
} from '../cookies.ts'
import { newCsrfToken } from '../csrf.ts'
import type { OnboardingCompleteResponse } from '../contract.ts'
import { conflict, HttpError } from '../errors.ts'
import { rememberLocale, resolveLocale } from '../locale.ts'
import { inviteRedeemRateLimit } from '../rate-limit.ts'
import { parseBody } from '../validate.ts'

const log = logger.child({ module: 'server.routes.onboarding' })

/** Public route config, spelled out once — see the module header. */
const publicRoute = { config: { auth: false } } as const

/** One message for a missing, expired or already-consumed onboarding cookie. */
const onboardingExpired = (): HttpError =>
  new HttpError(400, 'bad_request', 'That took too long. Please sign in again.')

/** One message for every way an invite code can fail to redeem. See the module header. */
const inviteInvalid = (): HttpError =>
  new HttpError(400, 'bad_request', 'That invite code is not valid. Check it and try again.')

const createTenantRequest = z.strictObject({
  label: z
    .string()
    .trim()
    .min(1, 'A household needs a name.')
    .max(120),
})

const redeemInviteRequest = z.strictObject({
  code: z.string().trim().min(1, 'An invite code is required.').max(64),
})

/** The onboarding cookie's value, or null for anything not worth trying to peek. */
function onboardingToken(request: FastifyRequest): string | null {
  const token = request.cookies[ONBOARDING_COOKIE]
  return typeof token === 'string' && token.length > 0 ? token : null
}

const identityFrom = (pending: PendingIdentity): Identity => ({
  sub: pending.sub,
  email: pending.email ?? undefined,
  name: pending.displayName ?? undefined,
})

/**
 * The session-issuing tail, shared by both routes and mirroring
 * `/auth/callback`'s own tail exactly: the onboarding cookie is cleared
 * either way, any stale session this browser already held is ended rather
 * than left running, and a fresh session + CSRF cookie replace it.
 */
function finishOnboarding(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  user: ReturnType<typeof toSessionUser>,
): OnboardingCompleteResponse {
  void reply.setCookie(ONBOARDING_COOKIE, '', clearedCookie(true))

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
  void reply.setCookie(CSRF_COOKIE, newCsrfToken(), cookieAttributes(false))
  rememberLocale(reply, user.locale)

  return {
    authenticated: true,
    user: {
      email: user.email,
      displayName: user.displayName,
      locale: user.locale,
      role: user.role,
      tenantId: user.tenantId,
    },
  }
}

export function registerOnboardingRoutes(app: FastifyInstance, db: Db): void {
  /**
   * Starts a new household. Gated on `MULTI_TENANT_ONBOARDING_ENABLED`
   * whenever a tenant already exists — see that flag's doc comment in
   * `config.ts` for why a second tenant is not yet safe to create.
   */
  app.post(
    '/auth/onboarding/create-tenant',
    publicRoute,
    (request: FastifyRequest, reply: FastifyReply): OnboardingCompleteResponse => {
      const { label } = parseBody(createTenantRequest, request.body)

      const token = onboardingToken(request)
      if (token === null) throw onboardingExpired()
      const pending = peekPendingIdentity(db, token)
      if (pending === null) throw onboardingExpired()

      if (!config.MULTI_TENANT_ONBOARDING_ENABLED && allTenantIds(db).length >= 1) {
        throw conflict('Creating a new household is turned off. Ask an existing member for an invite instead.')
      }

      const owner = createTenantAndOwner(db, {
        label,
        identity: identityFrom(pending),
        locale: resolveLocale(request),
      })

      // Consumed only now that the tenant genuinely exists — see auth/onboarding.ts
      // on the accepted race this ordering leaves.
      consumePendingIdentity(db, token)

      log.info({ userId: owner.id, tenantId: owner.tenantId }, 'created a tenant during onboarding')
      return finishOnboarding(db, request, reply, toSessionUser(owner))
    },
  )

  /** Joins an existing household as a viewer. Rate-limited like a password guess. */
  app.post(
    '/auth/onboarding/redeem-invite',
    { config: { auth: false, ...inviteRedeemRateLimit().config } },
    (request: FastifyRequest, reply: FastifyReply): OnboardingCompleteResponse => {
      const { code } = parseBody(redeemInviteRequest, request.body)

      const token = onboardingToken(request)
      if (token === null) throw onboardingExpired()
      const pending = peekPendingIdentity(db, token)
      if (pending === null) throw onboardingExpired()

      const viewer = redeemInviteAsViewer(db, {
        code,
        identity: identityFrom(pending),
        locale: resolveLocale(request),
      })
      if (viewer === null) throw inviteInvalid()

      consumePendingIdentity(db, token)

      log.info({ userId: viewer.id, tenantId: viewer.tenantId }, 'redeemed an invite during onboarding')
      return finishOnboarding(db, request, reply, toSessionUser(viewer))
    },
  )
}
