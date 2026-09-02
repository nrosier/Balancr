/**
 * The assembled server.
 *
 * Built through `buildApp` rather than by calling hooks with hand-made request
 * objects, because the thing most likely to be wrong is the wiring: a hook
 * registered after the routes, a header plugin that never reaches an error reply,
 * an exemption that silently applies to everything. Those all pass a unit test of
 * the hook itself.
 *
 * The two properties that matter here:
 *
 *  - **The CSP names no external origin.** Not "no untrusted CDN" — none. A
 *    financial dashboard that fetches a script from someone else's domain gives
 *    that domain the page.
 *  - **A thrown message never reaches the client.** Fastify's default echoes it,
 *    and the messages in reach include SQLite constraint text, better-sqlite3
 *    paths and internal Actual/Ghostfolio host:port.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { badRequest, notFound } from '../../src/server/errors.ts'
import { contentSecurityPolicy } from '../../src/server/security.ts'

let ctx: ReturnType<typeof createTestDb>
let app: FastifyInstance

beforeEach(async () => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  app = await buildApp({ db: ctx.db, web: null })
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

/** `default-src 'self'` → `["'self'"]`, so a test can inspect the sources. */
function parseCsp(header: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const part of header.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name !== undefined && name !== '') out[name] = sources
  }
  return out
}

describe('health', () => {
  it('answers liveness with the running version and touches nothing else', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ status: string; version: string | null }>()
    expect(body.status).toBe('ok')
    // Read from package.json rather than npm_package_version, which is unset
    // under `node dist/main.js`.
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('sets no cookie on the health check', async () => {
    // A container probe runs every few seconds; handing it a CSRF cookie each time
    // is pure noise, and the probe has no browser to keep it in.
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('explains the missing UI at the root instead of 404ing', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ name: string }>().name).toBe('balancr')
  })
})

describe('security headers', () => {
  it('permits no external origin anywhere in the policy', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    const csp = res.headers['content-security-policy']
    expect(typeof csp).toBe('string')

    const directives = parseCsp(csp as string)
    const allowed = new Set(["'self'", "'none'", 'data:'])
    for (const [directive, sources] of Object.entries(directives)) {
      for (const source of sources) {
        expect(allowed.has(source), `${directive} allows ${source}`).toBe(true)
      }
    }
  })

  it('never allows inline script or style', async () => {
    // Asserted on the data as well as the header: this is a constraint on the
    // frontend build, and it should fail here rather than in a review.
    const serialised = JSON.stringify(contentSecurityPolicy)
    expect(serialised).not.toContain('unsafe-inline')
    expect(serialised).not.toContain('unsafe-eval')

    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.headers['content-security-policy']).not.toContain('unsafe-')
  })

  it('refuses framing and locks the document base', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    const csp = parseCsp(res.headers['content-security-policy'] as string)
    expect(csp['frame-ancestors']).toEqual(["'none'"])
    expect(csp['base-uri']).toEqual(["'none'"])
    expect(csp['object-src']).toEqual(["'none'"])
  })

  it('sends no referrer and no sniffing', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
  })

  it('does not pin HSTS on a plain-http deployment', async () => {
    // Sent from http://localhost it would pin every application on localhost to
    // HTTPS, which costs a developer an afternoon and a cleared HSTS cache.
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.headers['strict-transport-security']).toBeUndefined()
  })
})

describe('error handling', () => {
  it('answers an unknown path with the envelope, not Fastify’s default', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
    const body = res.json<{ error: { code: string; message: string; requestId: string } }>()
    expect(body.error.code).toBe('not_found')
    expect(body.error.requestId).toBeTruthy()
  })

  it('replaces the message of an unexpected error', async () => {
    app.get('/boom', { config: { rateLimit: false, auth: false } }, () => {
      // The shape of a message that must never be echoed: it names the database
      // file and a constraint.
      throw new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed at /data/balancr.db')
    })
    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(500)
    const body = res.json<{ error: { code: string; message: string } }>()
    expect(body.error.code).toBe('internal_error')
    expect(res.payload).not.toContain('SQLITE_CONSTRAINT')
    expect(res.payload).not.toContain('balancr.db')
  })

  it('echoes the message of an error the code chose', async () => {
    app.get('/bad', { config: { rateLimit: false, auth: false } }, () => {
      throw badRequest('Month must be YYYY-MM.')
    })
    app.get('/missing', { config: { rateLimit: false, auth: false } }, () => {
      throw notFound('No facts for that month yet.')
    })

    const bad = await app.inject({ method: 'GET', url: '/bad' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json<{ error: { message: string } }>().error.message).toBe('Month must be YYYY-MM.')

    const missing = await app.inject({ method: 'GET', url: '/missing' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json<{ error: { code: string } }>().error.code).toBe('not_found')
  })

  it('keeps details out of the response', async () => {
    app.get('/detailed', { config: { rateLimit: false, auth: false } }, () => {
      throw badRequest('That is not a month.', { received: 'secret-internal-value' })
    })
    const res = await app.inject({ method: 'GET', url: '/detailed' })
    expect(res.payload).not.toContain('secret-internal-value')
  })
})
