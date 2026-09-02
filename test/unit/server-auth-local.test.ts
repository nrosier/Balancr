/**
 * The break-glass login as an endpoint.
 *
 * `auth-local.test.ts` covers the verification; this covers the part of the design
 * that lives in the route, and the part that is easiest to get wrong:
 *
 *  - **The gate is the socket address.** A request arriving through the public
 *    tunnel with `X-Forwarded-For: 192.168.1.5` must be refused, because
 *    `X-Forwarded-For` is precisely what an attacker there would set. Tested by
 *    sending exactly that.
 *  - **404, not 403.** The interesting fact about this endpoint is that it exists,
 *    so a refusal says nothing at all — and the endpoint is absent entirely when
 *    the feature is off.
 *  - **`methods.local` tells the truth about *this* connection**, so the login
 *    screen does not draw a form that is guaranteed to fail.
 *
 * `app.inject` defaults to a peer of 127.0.0.1, which is the default
 * `AUTH_LOCAL_ALLOWED_CIDRS`, so the allowed case is the plain call and the refused
 * case states its address.
 */
import argon2 from 'argon2'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { Secret, TOTP } from 'otpauth'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { localCredentials, sessions, users } from '../../src/db/schema.ts'
import { buildApp } from '../../src/server/app.ts'
import { ARGON2_OPTIONS, TOTP_PERIOD_SECONDS } from '../../src/server/auth/local.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'

const EMAIL = 'nick@example.test'
const PASSWORD = 'a-long-enough-break-glass-password'
/** Outside the default 127.0.0.1/32, and the shape of a tunnelled request. */
const OUTSIDE = '203.0.113.9'

const SECRET = new Secret({ size: 20 })
const totp = new TOTP({ secret: SECRET, digits: 6, period: TOTP_PERIOD_SECONDS })

let passwordHash: string
let ctx: ReturnType<typeof createTestDb>
let app: FastifyInstance
let userId: string

beforeAll(async () => {
  passwordHash = await argon2.hash(PASSWORD, ARGON2_OPTIONS)
}, 30_000)

beforeEach(async () => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  app = await buildApp({ db: ctx.db, oidc: null, web: null })

  const row = ctx.db
    .insert(users)
    .values({ email: EMAIL, displayName: 'Nick', role: 'owner' })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('fixture user was not created')
  userId = row.id

  ctx.db
    .insert(localCredentials)
    .values({ userId, passwordHash, totpSecret: SECRET.base32 })
    .run()
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

interface Attempt {
  password?: string
  totp?: string
  email?: string
  remoteAddress?: string
  headers?: Record<string, string>
  csrf?: boolean
}

/** A POST that satisfies CSRF unless the test asks for it not to. */
async function attempt(options: Attempt = {}) {
  const token = newCsrfToken()
  return app.inject({
    method: 'POST',
    url: '/auth/local/login',
    ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
    cookies: { [CSRF_COOKIE]: token },
    headers: {
      ...(options.csrf === false ? {} : { [CSRF_HEADER]: token }),
      ...options.headers,
    },
    payload: {
      email: options.email ?? EMAIL,
      password: options.password ?? PASSWORD,
      totp: options.totp ?? totp.generate(),
    },
  })
}

const cookieValue = (
  res: { cookies: { name: string; value: string }[] },
  name: string,
): string | undefined => res.cookies.find((cookie) => cookie.name === name)?.value

describe('from an allowed address', () => {
  it('mints a session recorded as a local login', async () => {
    const res = await attempt()
    expect(res.statusCode).toBe(200)
    expect(res.json<{ user: { role: string } }>().user.role).toBe('owner')

    const row = ctx.db.select().from(sessions).all()[0]
    expect(row?.userId).toBe(userId)
    expect(row?.method).toBe('local')
  })

  it('sets the session cookie and a fresh CSRF token', async () => {
    const res = await attempt()
    const session = cookieValue(res, SESSION_COOKIE)
    expect(session).toBeTruthy()
    // Rotated, so a value planted before the login is not the one the session uses.
    expect(cookieValue(res, CSRF_COOKIE)).toBeTruthy()

    // And the cookie actually works.
    const session2 = await app.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: { [SESSION_COOKIE]: session as string },
    })
    expect(session2.json<{ authenticated: boolean }>().authenticated).toBe(true)
  })

  it('refuses wrong details with 401 and no detail', async () => {
    const res = await attempt({ password: 'wrong' })
    expect(res.statusCode).toBe(401)
    expect(res.payload).not.toMatch(/password|totp|argon/i)
    expect(ctx.db.select().from(sessions).all()).toHaveLength(0)
  })

  it('refuses a request with no CSRF header', async () => {
    // A POST, so the ordinary CSRF rule applies and the login is not a hole in it.
    const res = await attempt({ csrf: false })
    expect(res.statusCode).toBe(403)
  })

  it('complains about a malformed body without touching the account', async () => {
    const token = newCsrfToken()
    const res = await app.inject({
      method: 'POST',
      url: '/auth/local/login',
      cookies: { [CSRF_COOKIE]: token },
      headers: { [CSRF_HEADER]: token },
      payload: { email: EMAIL },
    })
    expect(res.statusCode).toBe(400)
    const row = ctx.db.select().from(localCredentials).all()[0]
    expect(row?.failedAttempts).toBe(0)
  })

  it('offers the method in the session document', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/session' })
    expect(res.json<{ methods: { local: boolean } }>().methods.local).toBe(true)
  })
})

describe('from an address outside the allowed range', () => {
  it('answers 404, saying nothing about the endpoint', async () => {
    const res = await attempt({ remoteAddress: OUTSIDE })
    expect(res.statusCode).toBe(404)
    expect(res.payload).not.toMatch(/local|cidr|allowed/i)
    expect(ctx.db.select().from(sessions).all()).toHaveLength(0)
  })

  it('is not fooled by a forwarded header claiming a LAN address', async () => {
    // The attack this whole gate exists for. `X-Forwarded-For` is the one thing a
    // client through the tunnel fully controls, so the gate reads the socket.
    const res = await attempt({
      remoteAddress: OUTSIDE,
      headers: { 'x-forwarded-for': '127.0.0.1' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('does not advertise the method to a caller who cannot use it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/session',
      remoteAddress: OUTSIDE,
    })
    expect(res.json<{ methods: { local: boolean } }>().methods.local).toBe(false)
  })
})

describe('a deployment with local login switched off', () => {
  it('does not register the route at all', async () => {
    // Rebuilt against a different environment, because `config.ts` validates at
    // import and the flag is read when the routes are registered. The same approach
    // as `config-guards.test.ts`, for the same reason.
    vi.resetModules()
    vi.stubEnv('AUTH_LOCAL_ENABLED', 'false')
    // Something has to remain as a login method, or the config refuses to load.
    vi.stubEnv('AUTH_OIDC_ISSUER', 'http://localhost:9000/application/o/balancr/')
    vi.stubEnv('AUTH_OIDC_CLIENT_ID', 'balancr')
    vi.stubEnv('AUTH_OIDC_CLIENT_SECRET', 'secret')

    try {
      const { buildApp: freshBuildApp } = await import('../../src/server/app.ts')
      const fresh = await freshBuildApp({ db: ctx.db, oidc: null })
      try {
        const token = newCsrfToken()
        const res = await fresh.inject({
          method: 'POST',
          url: '/auth/local/login',
          cookies: { [CSRF_COOKIE]: token },
          headers: { [CSRF_HEADER]: token },
          payload: { email: EMAIL, password: PASSWORD, totp: totp.generate() },
        })
        expect(res.statusCode).toBe(404)

        const session = await fresh.inject({ method: 'GET', url: '/auth/session' })
        expect(session.json<{ methods: { local: boolean } }>().methods.local).toBe(false)
      } finally {
        await fresh.close()
      }
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
