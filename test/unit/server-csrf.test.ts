/**
 * Double-submit CSRF, through the real app.
 *
 * The attack this prevents needs no ability to read the response: the session
 * cookie rides along on a cross-site form POST, so a page anywhere on the
 * internet can make an authenticated request. `SameSite=Lax` is the first lock;
 * this is the second, and the `__Host-` cookie prefix is what makes it sound —
 * without it a sibling host could set the cookie the header is compared against.
 *
 * Tested against a built app, because the failure that matters is a hook that runs
 * for the wrong set of routes rather than a comparison that is wrong.
 *
 * Note the cookie *name* is read from the module rather than written out: it gains
 * the `__Host-` prefix only on an HTTPS deployment, and the test environment is
 * `http://localhost`. Hardcoding the name here would pass locally and hide a
 * production mismatch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { CSRF_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'

let ctx: ReturnType<typeof createTestDb>
let app: FastifyInstance

beforeEach(async () => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  app = await buildApp({ db: ctx.db })

  app.get('/t/read', { config: { rateLimit: false, auth: false } }, () => ({ ok: true }))
  app.post('/t/write', { config: { rateLimit: false, auth: false } }, () => ({ ok: true }))
  app.post('/t/open', { config: { rateLimit: false, csrf: false, auth: false } }, () => ({
    ok: true,
  }))
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

/** The Set-Cookie value for our token, or undefined. */
function issuedToken(setCookie: string | string[] | undefined): string | undefined {
  const values = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie]
  const match = values.find((value) => value.startsWith(`${CSRF_COOKIE}=`))
  return match?.split(';')[0]?.split('=')[1]
}

describe('token issue', () => {
  it('hands the browser a token on a safe request', async () => {
    // So the SPA's first mutation does not need a bootstrap round trip first.
    const res = await app.inject({ method: 'GET', url: '/t/read' })
    expect(res.statusCode).toBe(200)
    const token = issuedToken(res.headers['set-cookie'])
    expect(token).toBeTruthy()
    expect((token as string).length).toBeGreaterThan(20)
  })

  it('is readable by script, because the SPA has to echo it', async () => {
    const res = await app.inject({ method: 'GET', url: '/t/read' })
    const raw = res.headers['set-cookie']
    const value = (Array.isArray(raw) ? raw : [raw]).find((v) => v?.startsWith(CSRF_COOKIE))
    expect(value).not.toContain('HttpOnly')
    expect(value).toContain('SameSite=Lax')
  })

  it('keeps the same token rather than rotating per render', async () => {
    // A fresh token per render breaks the back button and two tabs, and buys
    // nothing: the value is unreadable cross-origin either way.
    const existing = newCsrfToken()
    const res = await app.inject({
      method: 'GET',
      url: '/t/read',
      cookies: { [CSRF_COOKIE]: existing },
    })
    expect(issuedToken(res.headers['set-cookie'])).toBeUndefined()
  })
})

describe('mutation guard', () => {
  it('refuses a POST with no token at all', async () => {
    const res = await app.inject({ method: 'POST', url: '/t/write' })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('forbidden')
  })

  it('refuses a POST with a cookie but no header — the cross-site case', async () => {
    // This is exactly the attacker's position: the cookie is sent automatically,
    // the header cannot be set from another origin.
    const token = newCsrfToken()
    const res = await app.inject({
      method: 'POST',
      url: '/t/write',
      cookies: { [CSRF_COOKIE]: token },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses a header that does not match the cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/t/write',
      cookies: { [CSRF_COOKIE]: newCsrfToken() },
      headers: { [CSRF_HEADER]: newCsrfToken() },
    })
    expect(res.statusCode).toBe(403)
  })

  it('accepts a matching pair', async () => {
    const token = newCsrfToken()
    const res = await app.inject({
      method: 'POST',
      url: '/t/write',
      cookies: { [CSRF_COOKIE]: token },
      headers: { [CSRF_HEADER]: token },
    })
    expect(res.statusCode).toBe(200)
  })

  it('refuses two different tokens in a repeated header', async () => {
    const token = newCsrfToken()
    const res = await app.inject({
      method: 'POST',
      url: '/t/write',
      cookies: { [CSRF_COOKIE]: token },
      headers: { [CSRF_HEADER]: [token, newCsrfToken()] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('guards PUT, PATCH and DELETE as well as POST', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      app.route({
        method,
        url: `/t/${method}`,
        config: { rateLimit: false, auth: false },
        handler: () => ({ ok: true }),
      })
    }
    await app.ready()

    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: `/t/${method}` })
      expect(res.statusCode, method).toBe(403)
    }
  })

  it('lets a route opt out explicitly', async () => {
    // The opt-out is greppable, unlike a route someone forgot to add to a list.
    const res = await app.inject({ method: 'POST', url: '/t/open' })
    expect(res.statusCode).toBe(200)
  })

  it('applies to a route registered after the hook', async () => {
    // The reason this is tested through the app: a hook added after the routes
    // would silently protect nothing.
    app.post('/t/late', { config: { rateLimit: false, auth: false } }, () => ({ ok: true }))
    await app.ready()
    const res = await app.inject({ method: 'POST', url: '/t/late' })
    expect(res.statusCode).toBe(403)
  })
})
