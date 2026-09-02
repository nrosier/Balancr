/**
 * Login, through the real library against a fake Authentik.
 *
 * The double is a provider rather than a stub of `openid-client` (see
 * `test/helpers/oidc-issuer.ts`), which is what makes these assertions mean
 * anything: the PKCE verifier really has to arrive at a token endpoint that
 * re-derives the challenge, the `state` and `nonce` compared really are the ones
 * this application stored, and an ID token signed by a key outside the JWKS is
 * really rejected by the library rather than by the test.
 *
 * Two properties here are not about OIDC at all, and are the reason this file is
 * long:
 *
 *  - **A callback URL on its own logs nobody in.** The flow is looked up by the
 *    cookie, so an attacker who starts their own login and sends the victim the
 *    resulting link achieves nothing. Without that, the victim ends up signed in
 *    to the attacker's account and typing their finances into it.
 *  - **The guard denies by default.** A route added in six months is protected
 *    because it exists. The test for that is a route with no `auth` config at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { users } from '../../src/db/schema.ts'
import { requireUser } from '../../src/server/auth/guard.ts'
import { createOidcClient, OIDC_SCOPE } from '../../src/server/auth/oidc.ts'
import { hashSessionToken, readSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, LOGIN_FLOW_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER } from '../../src/server/csrf.ts'
import { buildApp } from '../../src/server/app.ts'
import { createFakeIssuer, type AuthorizeOptions, type FakeIssuer } from '../helpers/oidc-issuer.ts'

const REDIRECT_URI = 'http://localhost:3000/auth/callback'

let ctx: ReturnType<typeof createTestDb>
let issuer: FakeIssuer
let app: FastifyInstance

interface WithCookies {
  cookies: { name: string; value: string }[]
}

const cookieValue = (res: WithCookies, name: string): string | undefined =>
  res.cookies.find((cookie) => cookie.name === name)?.value

const cookieOf = (res: WithCookies, name: string): { name: string; value: string } | undefined =>
  res.cookies.find((cookie) => cookie.name === name)

beforeEach(async () => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  issuer = await createFakeIssuer(REDIRECT_URI)
  app = await buildApp({ db: ctx.db, oidc: createOidcClient(issuer.settings), web: null })

  // No `auth` in the config: this is the deny-by-default case, and it is here
  // rather than in a fixture so the omission is visible.
  app.get('/t/private', { config: { rateLimit: false } }, (request) => ({
    role: requireUser(request).role,
  }))
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

/** Sends the browser to the provider and reports what it was given. */
async function startLogin(returnTo?: string): Promise<{
  authUrl: URL
  flowCookie: string
  status: number
}> {
  const query = returnTo === undefined ? '' : `?return_to=${encodeURIComponent(returnTo)}`
  const res = await app.inject({ method: 'GET', url: `/auth/login${query}` })
  return {
    status: res.statusCode,
    authUrl: new URL(String(res.headers.location ?? 'http://invalid.test/')),
    flowCookie: cookieValue(res, LOGIN_FLOW_COOKIE) ?? '',
  }
}

/** The whole round trip, as a browser would walk it. */
async function login(returnTo?: string, options?: AuthorizeOptions) {
  const { authUrl, flowCookie } = await startLogin(returnTo)
  return app.inject({
    method: 'GET',
    url: issuer.callbackUrl(authUrl, options),
    cookies: { [LOGIN_FLOW_COOKIE]: flowCookie },
  })
}

describe('the guard', () => {
  it('refuses a route that said nothing about authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/private' })
    expect(res.statusCode).toBe(401)
    const body = res.json<{ error: { code: string } }>()
    expect(body.error.code).toBe('unauthenticated')
  })

  it('admits a request carrying a real session', async () => {
    const session = cookieValue(await login(), SESSION_COOKIE)
    const res = await app.inject({
      method: 'GET',
      url: '/t/private',
      cookies: { [SESSION_COOKIE]: session ?? '' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<{ role: string }>().role).toBe('owner')
  })

  it('refuses a cookie that points at nothing, and says no more than that', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/t/private',
      cookies: { [SESSION_COOKIE]: 'a'.repeat(43) },
    })

    expect(res.statusCode).toBe(401)
    // Whether the cookie was absent, expired or pointed at a deleted row is not
    // the client's business; the log line already has it.
    expect(res.payload).not.toMatch(/expired|unknown|deleted/i)
  })

  it('still answers an unknown path with 404, not 401', async () => {
    // A 401 for every unrecognised path would make "this deployment has no such
    // endpoint" impossible to say honestly — including for /auth/login when OIDC
    // is off.
    const res = await app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('leaves the container probe alone', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200)
  })
})

describe('the session endpoint', () => {
  it('is readable before signing in and reports the methods on offer', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/session' })
    expect(res.statusCode).toBe(200)

    const body = res.json<{
      authenticated: boolean
      user: unknown
      methods: { oidc: boolean; local: boolean }
    }>()
    expect(body.authenticated).toBe(false)
    expect(body.user).toBeNull()
    expect(body.methods.oidc).toBe(true)
  })

  it('describes the signed-in user without leaking the session id', async () => {
    const session = cookieValue(await login(), SESSION_COOKIE)
    const res = await app.inject({
      method: 'GET',
      url: '/auth/session',
      cookies: { [SESSION_COOKIE]: session ?? '' },
    })

    const body = res.json<{ authenticated: boolean; user: { email: string; role: string } }>()
    expect(body.authenticated).toBe(true)
    expect(body.user.email).toBe('nick@example.test')
    expect(body.user.role).toBe('owner')
    expect(res.payload).not.toContain(session)
    expect(res.payload).not.toContain(hashSessionToken(session ?? ''))
  })
})

describe('the redirect out', () => {
  it('sends the browser to the provider with PKCE, state and nonce', async () => {
    const { status, authUrl } = await startLogin()
    expect(status).toBe(303)

    expect(authUrl.origin).toBe('https://authentik.test')
    expect(authUrl.searchParams.get('response_type')).toBe('code')
    expect(authUrl.searchParams.get('scope')).toBe(OIDC_SCOPE)
    // Built from PUBLIC_BASE_URL, never from a Host header — the provider compares
    // it byte for byte, so a request must not get to choose it.
    expect(authUrl.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authUrl.searchParams.get('code_challenge')).toBeTruthy()
    expect(authUrl.searchParams.get('state')).toBeTruthy()
    expect(authUrl.searchParams.get('nonce')).toBeTruthy()
  })

  it('asks for no re-prompt, because that decision belongs in Authentik', async () => {
    const { authUrl } = await startLogin()
    expect(authUrl.searchParams.get('prompt')).toBeNull()
    expect(authUrl.searchParams.get('max_age')).toBeNull()
  })

  it('never puts the PKCE verifier in the URL', async () => {
    const { authUrl } = await startLogin()
    // The verifier is the one secret that must not travel through the browser; the
    // challenge is its hash and is meant to.
    expect(authUrl.search).not.toContain('code_verifier')
  })

  it('binds the flow to this browser with a short-lived httpOnly cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/login' })
    const cookie = cookieOf(res, LOGIN_FLOW_COOKIE) as
      | { value: string; httpOnly?: boolean; maxAge?: number }
      | undefined

    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.maxAge).toBeGreaterThan(0)
    expect(cookie?.maxAge).toBeLessThanOrEqual(600)
    // The cookie carries the state, which is public anyway — it is in the redirect
    // URL. What it buys is the binding, not secrecy.
    expect(cookie?.value).toBe(new URL(String(res.headers.location)).searchParams.get('state'))
  })

  it('refuses to remember an off-site return target', async () => {
    const res = await login('//evil.example/phish')
    expect(res.statusCode).toBe(303)
    // An open redirect on a login endpoint is how a phishing link borrows a real
    // domain. The fallback is the app root, not the attacker's host.
    expect(res.headers.location).toBe('/')
  })

  it('remembers where the browser was going', async () => {
    const res = await login('/insights')
    expect(res.headers.location).toBe('/insights')
  })
})

describe('the callback', () => {
  it('establishes a session and creates the user', async () => {
    const res = await login('/budget')
    expect(res.statusCode).toBe(303)
    expect(res.headers.location).toBe('/budget')

    const token = cookieValue(res, SESSION_COOKIE)
    expect(token).toBeTruthy()
    expect(readSession(ctx.db, token ?? '')?.user.role).toBe('owner')

    const row = ctx.db.select().from(users).all()[0]
    expect(row?.oidcSub).toBe('ak-subject-1')
    expect(row?.email).toBe('nick@example.test')
  })

  it('replaces both cookies and clears the one for the flow', async () => {
    const res = await login()

    const session = cookieOf(res, SESSION_COOKIE) as { httpOnly?: boolean } | undefined
    expect(session?.httpOnly).toBe(true)
    // Rotated, so a token planted before the login is not the one the session goes
    // on using.
    expect(cookieValue(res, CSRF_COOKIE)).toBeTruthy()
    // Cleared, so a second code cannot be tried against the same flow cookie.
    expect(cookieValue(res, LOGIN_FLOW_COOKIE)).toBe('')
  })

  it('is useless without the cookie from the browser that started it', async () => {
    // The attack: someone starts their own login, then sends the victim the
    // callback link. The victim's browser has no matching flow cookie.
    const { authUrl } = await startLogin()
    const res = await app.inject({ method: 'GET', url: issuer.callbackUrl(authUrl) })

    expect(res.statusCode).toBe(400)
    expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined()
    expect(ctx.db.select().from(users).all()).toHaveLength(0)
  })

  it('refuses a flow cookie that matches no flow', async () => {
    const { authUrl } = await startLogin()
    const res = await app.inject({
      method: 'GET',
      url: issuer.callbackUrl(authUrl),
      cookies: { [LOGIN_FLOW_COOKIE]: 'invented' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a state in the URL that is not the one the flow stored', async () => {
    const res = await login(undefined, { state: 'someone-elses-state' })
    expect(res.statusCode).toBe(400)
    expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined()
  })

  it('refuses an ID token whose nonce is not the one this flow asked for', async () => {
    // Replay of an ID token minted for a different authorization request.
    const res = await login(undefined, { nonce: 'a-nonce-from-another-login' })
    expect(res.statusCode).toBe(400)
  })

  it('refuses an ID token minted for a different application', async () => {
    // Realistic in a homelab with several applications behind one Authentik: a
    // token issued for the wrong client must not be a login here.
    const res = await login(undefined, { audience: 'some-other-client' })
    expect(res.statusCode).toBe(400)
    expect(ctx.db.select().from(users).all()).toHaveLength(0)
  })

  it('trusts the ID token because of the channel, not its signature', async () => {
    // Worth a test precisely because the opposite is the natural assumption. OIDC
    // Core 3.1.3.7 condition 6 permits a client to skip signature verification
    // when the ID token arrives over a direct TLS connection to the token
    // endpoint, and `openid-client` takes that permission — so a token signed by a
    // key that is not in the JWKS is accepted.
    //
    // That is sound only while the connection to Authentik is TLS, which is why
    // `config.ts` refuses a plain-http `AUTH_OIDC_ISSUER` in production. This test
    // is here so that a change in the library's behaviour shows up as a failure
    // and the reasoning gets revisited, rather than quietly becoming wrong.
    issuer.signWithUnknownKey = true
    expect((await login()).statusCode).toBe(303)
  })

  it('cannot be replayed', async () => {
    const { authUrl, flowCookie } = await startLogin()
    const url = issuer.callbackUrl(authUrl)

    const first = await app.inject({
      method: 'GET',
      url,
      cookies: { [LOGIN_FLOW_COOKIE]: flowCookie },
    })
    expect(first.statusCode).toBe(303)

    // Same URL, same cookie, second time. The flow row is gone, so there is
    // nothing to look the verifier up in.
    const second = await app.inject({
      method: 'GET',
      url,
      cookies: { [LOGIN_FLOW_COOKIE]: flowCookie },
    })
    expect(second.statusCode).toBe(400)
  })

  it('says the same thing however it failed', async () => {
    const noCookie = await app.inject({ method: 'GET', url: '/auth/callback?code=x&state=y' })
    const badState = await login(undefined, { state: 'wrong' })

    const one = noCookie.json<{ error: { code: string; message: string } }>()
    const two = badState.json<{ error: { code: string; message: string } }>()
    // Distinguishing them would confirm a guess, and neither is actionable: the
    // answer is always to start again.
    expect(one.error.message).toBe(two.error.message)
    expect(one.error.code).toBe('bad_request')
  })

  it('ends any session the browser already had', async () => {
    const old = cookieValue(await login(), SESSION_COOKIE) ?? ''
    expect(readSession(ctx.db, old)).not.toBeNull()

    const { authUrl, flowCookie } = await startLogin()
    const again = await app.inject({
      method: 'GET',
      url: issuer.callbackUrl(authUrl),
      cookies: { [LOGIN_FLOW_COOKIE]: flowCookie, [SESSION_COOKIE]: old },
    })

    const fresh = cookieValue(again, SESSION_COOKIE) ?? ''
    expect(fresh).not.toBe(old)
    // It may have belonged to another account, and it should certainly not outlive
    // a deliberate re-login.
    expect(readSession(ctx.db, old)).toBeNull()
    expect(readSession(ctx.db, fresh)).not.toBeNull()
  })

  it('refuses a login for an account that has been disabled', async () => {
    const first = await login()
    expect(first.statusCode).toBe(303)
    ctx.db.update(users).set({ disabled: true }).run()

    const res = await login()
    expect(res.statusCode).toBe(403)
    expect(cookieValue(res, SESSION_COOKIE)).toBeUndefined()
  })
})

describe('logout', () => {
  it('ends the session and clears the cookie', async () => {
    const landed = await login()
    const session = cookieValue(landed, SESSION_COOKIE) ?? ''
    const csrf = cookieValue(landed, CSRF_COOKIE) ?? ''

    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { [SESSION_COOKIE]: session, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
    })

    expect(res.statusCode).toBe(204)
    expect(readSession(ctx.db, session)).toBeNull()
    expect(cookieValue(res, SESSION_COOKIE)).toBe('')
    // Rotated rather than cleared: the next page is very likely the login screen,
    // and it needs a token to post with.
    expect(cookieValue(res, CSRF_COOKIE)).toBeTruthy()
    expect(cookieValue(res, CSRF_COOKIE)).not.toBe(csrf)
  })

  it('is not something another site can do for you', async () => {
    const session = cookieValue(await login(), SESSION_COOKIE) ?? ''
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { [SESSION_COOKIE]: session },
    })

    expect(res.statusCode).toBe(403)
    expect(readSession(ctx.db, session)).not.toBeNull()
  })
})

describe('discovery', () => {
  it('fetches the metadata once and reuses it', async () => {
    await startLogin()
    await startLogin()
    // Two logins, one round trip: the provider is not asked to describe itself on
    // every click.
    expect(issuer.discoveryCount).toBe(1)
  })

  it('does not remember a failure', async () => {
    issuer.discoveryFails = true
    const down = await app.inject({ method: 'GET', url: '/auth/login' })
    // Someone else's outage, so 503 rather than 500.
    expect(down.statusCode).toBe(503)

    issuer.discoveryFails = false
    // The point: Authentik starting after Balancr in the same compose stack must
    // not poison logins until a restart.
    expect((await app.inject({ method: 'GET', url: '/auth/login' })).statusCode).toBe(303)
    expect(issuer.discoveryCount).toBe(2)
  })
})

describe('a deployment with no OIDC', () => {
  it('has no login endpoints at all, and says so in the session summary', async () => {
    const plain = await buildApp({ db: ctx.db, oidc: null, web: null })
    try {
      // A 404 is the honest answer for a capability this deployment does not have,
      // and better than an endpoint that exists only to fail.
      expect((await plain.inject({ method: 'GET', url: '/auth/login' })).statusCode).toBe(404)
      expect((await plain.inject({ method: 'GET', url: '/auth/callback' })).statusCode).toBe(404)

      const res = await plain.inject({ method: 'GET', url: '/auth/session' })
      expect(res.json<{ methods: { oidc: boolean } }>().methods.oidc).toBe(false)
    } finally {
      await plain.close()
    }
  })
})
