/**
 * The onboarding endpoints as HTTP (#373): where a tenantless identity picks
 * "create a household" or "redeem an invite" and comes out the other side
 * with a real session.
 *
 * `beginOnboarding` mints the cookie directly rather than routing every case
 * through a full OIDC round trip — `routes-onboarding.test.ts`'s job is these
 * two routes, and the round trip itself (state/nonce/PKCE, the flow cookie)
 * already has its own file in `server-auth.test.ts`. One test here still goes
 * through `/auth/callback` for real, because the one thing worth pinning at
 * this layer is that a brand-new `sub` lands on the onboarding cookie and not
 * a session — the behaviour the rename from `upsertOidcUser` depends on.
 *
 * Every response and every audit row a test can see is checked for the
 * invite code — the property this feature cannot afford to get wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { auditLog, users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { createInvite, revokeInvite } from '../../src/domain/tenant/invites.ts'
import { redeemInviteAsViewer } from '../../src/domain/tenant/provisioning.ts'
import { buildApp } from '../../src/server/app.ts'
import { beginOnboarding } from '../../src/server/auth/onboarding.ts'
import { createOidcClient } from '../../src/server/auth/oidc.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import {
  CSRF_COOKIE,
  LOGIN_FLOW_COOKIE,
  ONBOARDING_COOKIE,
  SESSION_COOKIE,
} from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import { INVITE_REDEEM_RATE_LIMIT } from '../../src/server/rate-limit.ts'
import { createFakeIssuer, type FakeIssuer } from '../helpers/oidc-issuer.ts'

const REDIRECT_URI = 'http://localhost:3000/auth/callback'
const CSRF = newCsrfToken()

let ctx: ReturnType<typeof createTestDb>
let app: FastifyInstance

interface WithCookies {
  cookies: { name: string; value: string }[]
}
const cookieValue = (res: WithCookies, name: string): string | undefined =>
  res.cookies.find((cookie) => cookie.name === name)?.value

/** A POST with the CSRF double-submit already satisfied, since every route
 * here checks it like any other mutation — see `csrf.ts`. */
function post(
  target: FastifyInstance,
  url: string,
  payload: object,
  cookies: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method: 'POST',
    url,
    payload,
    cookies: { ...cookies, [CSRF_COOKIE]: CSRF },
    headers: { [CSRF_HEADER]: CSRF },
  }
  return target.inject(options)
}

function seedOwner(): string {
  const row = ctx.db
    .insert(users)
    .values({ tenantId: getSoleTenantId(ctx.db), email: 'owner@example.test', role: 'owner' })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('no user')
  return row.id
}

/** Mints an onboarding cookie the way `/auth/callback` would, without the round trip. */
function pendingCookie(sub = 'ak-jo', email = 'jo@example.test', name = 'Jo'): string {
  return beginOnboarding(ctx.db, { sub, email, name }).token
}

beforeEach(async () => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  app = await buildApp({ db: ctx.db, oidc: null, web: null })
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

describe('/auth/callback for a brand-new subject', () => {
  let issuer: FakeIssuer
  let oidcApp: FastifyInstance

  beforeEach(async () => {
    issuer = await createFakeIssuer(REDIRECT_URI)
    oidcApp = await buildApp({ db: ctx.db, oidc: createOidcClient(issuer.settings), web: null })
  })

  afterEach(async () => {
    await oidcApp.close()
  })

  it('sets the onboarding cookie rather than a session, and creates nobody', async () => {
    const login = await oidcApp.inject({ method: 'GET', url: '/auth/login' })
    const flowCookie = cookieValue(login, LOGIN_FLOW_COOKIE) ?? ''
    const authUrl = new URL(String(login.headers.location))

    const res = await oidcApp.inject({
      method: 'GET',
      url: issuer.callbackUrl(authUrl),
      cookies: { [LOGIN_FLOW_COOKIE]: flowCookie },
    })

    expect(res.statusCode).toBe(303)
    expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined()
    expect(cookieValue(res, ONBOARDING_COOKIE)).toBeTruthy()
    expect(ctx.db.select().from(users).all()).toHaveLength(0)
  })

  it('still establishes a session for a subject that already has a user row', async () => {
    ctx.db
      .insert(users)
      .values({
        tenantId: getSoleTenantId(ctx.db),
        oidcSub: issuer.identity.sub,
        email: 'nick@example.test',
        role: 'owner',
      })
      .run()

    const login = await oidcApp.inject({ method: 'GET', url: '/auth/login' })
    const flowCookie = cookieValue(login, LOGIN_FLOW_COOKIE) ?? ''
    const authUrl = new URL(String(login.headers.location))

    const res = await oidcApp.inject({
      method: 'GET',
      url: issuer.callbackUrl(authUrl),
      cookies: { [LOGIN_FLOW_COOKIE]: flowCookie },
    })

    expect(cookieValue(res, SESSION_COOKIE)).toBeTruthy()
    expect(cookieValue(res, ONBOARDING_COOKIE)).toBeUndefined()
  })
})

describe('/auth/session', () => {
  it('reports no pending identity when there is no onboarding cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/session' })
    expect(res.json<{ pending: unknown }>().pending).toBeNull()
  })

  it('describes the pending identity from the onboarding cookie', async () => {
    const token = pendingCookie()
    const res = await app.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: { [ONBOARDING_COOKIE]: token },
    })

    const body = res.json<{ pending: { email: string | null; displayName: string | null } | null }>()
    expect(body.pending).toEqual({ email: 'jo@example.test', displayName: 'Jo' })
  })

  it('ignores an onboarding cookie once a session already exists', async () => {
    const ownerId = seedOwner()
    const session = createSession(ctx.db, { userId: ownerId, method: 'local', ip: '127.0.0.1', userAgent: undefined })

    const res = await app.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: { [ONBOARDING_COOKIE]: pendingCookie(), [SESSION_COOKIE]: session.token },
    })

    expect(res.json<{ pending: unknown }>().pending).toBeNull()
  })
})

describe('POST /auth/onboarding/create-tenant', () => {
  it('refuses without a valid onboarding cookie', async () => {
    const res = await post(app, '/auth/onboarding/create-tenant', { label: 'The Rosiers' })
    expect(res.statusCode).toBe(400)
  })

  it('refuses an invalid body before even looking at the cookie', async () => {
    const res = await post(
      app,
      '/auth/onboarding/create-tenant',
      { label: '' },
      { [ONBOARDING_COOKIE]: pendingCookie() },
    )
    expect(res.statusCode).toBe(400)
  })

  it('is off by default the moment any tenant exists', async () => {
    // The bootstrap tenant from migrations already puts the count at 1, and
    // MULTI_TENANT_ONBOARDING_ENABLED defaults to false in test/setup.ts.
    const res = await post(
      app,
      '/auth/onboarding/create-tenant',
      { label: 'The Rosiers' },
      { [ONBOARDING_COOKIE]: pendingCookie() },
    )

    expect(res.statusCode).toBe(409)
    expect(ctx.db.select().from(users).all()).toHaveLength(0)
  })

  it('creates a household and signs the caller in, once the flag is on', async () => {
    vi.resetModules()
    vi.stubEnv('MULTI_TENANT_ONBOARDING_ENABLED', 'true')
    try {
      const { buildApp: freshBuildApp } = await import('../../src/server/app.ts')
      const fresh = await freshBuildApp({ db: ctx.db, oidc: null, web: null })
      try {
        const token = pendingCookie('ak-jo', 'jo@example.test', 'Jo')
        const res = await post(fresh, '/auth/onboarding/create-tenant', { label: 'The Rosiers' }, { [ONBOARDING_COOKIE]: token })

        expect(res.statusCode).toBe(200)
        const body = res.json<{ authenticated: boolean; user: { email: string; role: string } }>()
        expect(body.authenticated).toBe(true)
        expect(body.user.role).toBe('owner')
        expect(body.user.email).toBe('jo@example.test')

        expect(cookieValue(res, SESSION_COOKIE)).toBeTruthy()
        expect(cookieValue(res, ONBOARDING_COOKIE)).toBe('')

        const entry = ctx.db.select().from(auditLog).all().find((row) => row.action === 'tenant.create')
        expect(entry).toBeDefined()
      } finally {
        await fresh.close()
      }
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })

  it('consumes the onboarding cookie, so it cannot be replayed', async () => {
    vi.resetModules()
    vi.stubEnv('MULTI_TENANT_ONBOARDING_ENABLED', 'true')
    try {
      const { buildApp: freshBuildApp } = await import('../../src/server/app.ts')
      const fresh = await freshBuildApp({ db: ctx.db, oidc: null, web: null })
      try {
        const token = pendingCookie()
        const first = await post(fresh, '/auth/onboarding/create-tenant', { label: 'First' }, { [ONBOARDING_COOKIE]: token })
        expect(first.statusCode).toBe(200)

        const second = await post(fresh, '/auth/onboarding/create-tenant', { label: 'Second' }, { [ONBOARDING_COOKIE]: token })
        expect(second.statusCode).toBe(400)
      } finally {
        await fresh.close()
      }
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})

describe('POST /auth/onboarding/redeem-invite', () => {
  it('joins the inviting tenant as a viewer', async () => {
    const tenantId = getSoleTenantId(ctx.db)
    const ownerId = seedOwner()
    const { code, invite } = createInvite(ctx.db, { tenantId, createdBy: ownerId })

    const res = await post(app, '/auth/onboarding/redeem-invite', { code }, { [ONBOARDING_COOKIE]: pendingCookie() })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ authenticated: boolean; user: { role: string; tenantId: string } }>()
    expect(body.user.role).toBe('viewer')
    expect(body.user.tenantId).toBe(tenantId)
    expect(cookieValue(res, SESSION_COOKIE)).toBeTruthy()
    expect(cookieValue(res, ONBOARDING_COOKIE)).toBe('')

    expect(JSON.stringify(body)).not.toContain(code)
    const entry = ctx.db.select().from(auditLog).all().find((row) => row.action === 'tenant.invite.redeem')
    expect(entry?.entityRef).toBe(invite.id)
    expect(JSON.stringify(entry)).not.toContain(code)
  })

  it('gives the same answer for a wrong, expired, revoked or already-used code', async () => {
    const tenantId = getSoleTenantId(ctx.db)
    const ownerId = seedOwner()

    const unknown = await post(
      app,
      '/auth/onboarding/redeem-invite',
      { code: 'AAAA-BBBB-CCCC-DDDD' },
      { [ONBOARDING_COOKIE]: pendingCookie('ak-a') },
    )

    const { code: usedCode } = createInvite(ctx.db, { tenantId, createdBy: ownerId })
    redeemInviteAsViewer(ctx.db, { code: usedCode, identity: { sub: 'ak-first' }, locale: 'en' })
    const alreadyUsed = await post(
      app,
      '/auth/onboarding/redeem-invite',
      { code: usedCode },
      { [ONBOARDING_COOKIE]: pendingCookie('ak-b') },
    )

    const { code: revokedCode, invite: revokedInvite } = createInvite(ctx.db, { tenantId, createdBy: ownerId })
    revokeInvite(ctx.db, { tenantId, inviteId: revokedInvite.id, actorId: ownerId })
    const revoked = await post(
      app,
      '/auth/onboarding/redeem-invite',
      { code: revokedCode },
      { [ONBOARDING_COOKIE]: pendingCookie('ak-c') },
    )

    const { code: expiredCode } = createInvite(ctx.db, {
      tenantId,
      createdBy: ownerId,
      now: new Date('2020-01-01T00:00:00Z'),
    })
    const expired = await post(
      app,
      '/auth/onboarding/redeem-invite',
      { code: expiredCode },
      { [ONBOARDING_COOKIE]: pendingCookie('ak-d') },
    )

    for (const res of [unknown, alreadyUsed, revoked, expired]) {
      expect(res.statusCode).toBe(400)
    }
    const messages = new Set(
      [unknown, alreadyUsed, revoked, expired].map((res) => res.json<{ error: { message: string } }>().error.message),
    )
    expect(messages.size).toBe(1)
  })

  it('does not consume the onboarding cookie on a failed redemption', async () => {
    const token = pendingCookie()
    const first = await post(
      app,
      '/auth/onboarding/redeem-invite',
      { code: 'AAAA-BBBB-CCCC-DDDD' },
      { [ONBOARDING_COOKIE]: token },
    )
    expect(first.statusCode).toBe(400)

    // The cookie must still work for a second, correct attempt.
    const tenantId = getSoleTenantId(ctx.db)
    const ownerId = seedOwner()
    const { code } = createInvite(ctx.db, { tenantId, createdBy: ownerId })

    const second = await post(app, '/auth/onboarding/redeem-invite', { code }, { [ONBOARDING_COOKIE]: token })
    expect(second.statusCode).toBe(200)
  })

  it('is rate-limited like a password guess', async () => {
    const cookies = { [ONBOARDING_COOKIE]: pendingCookie() }
    let last = 200
    for (let i = 0; i < INVITE_REDEEM_RATE_LIMIT.max + 1; i += 1) {
      const res = await post(app, '/auth/onboarding/redeem-invite', { code: 'AAAA-BBBB-CCCC-DDDD' }, cookies)
      last = res.statusCode
    }
    expect(last).toBe(429)
  })
})
