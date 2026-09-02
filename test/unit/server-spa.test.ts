/**
 * Serving the built SPA, against a fixture bundle rather than against `dist/`.
 *
 * A fixture because the alternative is a suite whose result depends on whether
 * `npm run build:web` has been run — green on CI, red on a fresh clone, for reasons
 * that have nothing to do with the code. `buildApp({ web })` takes the directory for
 * exactly this reason.
 *
 * What is actually being tested is a set of *refusals*, because the happy path here is
 * four lines and the ways it goes wrong are all quiet:
 *
 *  - A path traversal through the asset route reads the filesystem. `@fastify/send`
 *    refuses it, but only because the wildcard parameter is handed to it untouched;
 *    a `join()` in the handler would normalise the `..` away first and the guard
 *    would pass a path outside the root. This is the test that fails if someone
 *    tidies that up.
 *  - An unknown `/api/` path answered with `index.html` is a 200 with HTML in it, so
 *    a client's `.json()` throws somewhere unrelated and a monitoring check on a
 *    renamed endpoint reads as healthy.
 *  - A missing asset answered with `index.html` reaches the browser as HTML labelled
 *    `text/javascript`, which fails with a MIME error rather than a 404.
 *  - The shell served with a cacheable `cache-control` survives a release and then
 *    names hashed files that no longer exist — a blank page with a 404 in the console
 *    and nothing to indicate that a reload is what would fix it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { buildApp } from '../../src/server/app.ts'

const INDEX_HTML = '<!doctype html><html lang="en"><body><div id="root"></div></body></html>'
const ASSET_JS = 'console.log("bundle")\n'

let bundle: string
let ctx: ReturnType<typeof createTestDb>
let app: FastifyInstance

beforeAll(() => {
  bundle = mkdtempSync(join(tmpdir(), 'balancr-web-'))
  writeFileSync(join(bundle, 'index.html'), INDEX_HTML)
  mkdirSync(join(bundle, 'assets'))
  writeFileSync(join(bundle, 'assets', 'index-abc123.js'), ASSET_JS)
  // The thing a traversal would be reaching for: a real file one level above the
  // asset root, so a passing traversal test would be a genuine read rather than a
  // 404 that happens to look like a refusal.
  writeFileSync(join(bundle, 'secret.txt'), 'not for the browser\n')
})

afterAll(() => {
  rmSync(bundle, { recursive: true, force: true })
})

beforeEach(async () => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  app = await buildApp({ db: ctx.db, oidc: null, web: bundle })
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

/** What a browser sends when a person is navigating to a URL. */
const NAVIGATION = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }

describe('the shell', () => {
  it('serves index.html at the root, with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/', headers: NAVIGATION })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(INDEX_HTML)
    expect(res.headers['content-type']).toContain('text/html')
  })

  it('never lets the shell be cached', async () => {
    // It is the one file whose name does not change while its contents do.
    const res = await app.inject({ method: 'GET', url: '/', headers: NAVIGATION })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('answers a client-side route with the shell so a deep link works', async () => {
    const res = await app.inject({ method: 'GET', url: '/budget', headers: NAVIGATION })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(INDEX_HTML)
  })

  it('answers a nested client-side route the same way', async () => {
    const res = await app.inject({ method: 'GET', url: '/settings/prompts', headers: NAVIGATION })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(INDEX_HTML)
  })

  it('ignores the query string when deciding', async () => {
    const res = await app.inject({ method: 'GET', url: '/budget?month=2026-08', headers: NAVIGATION })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(INDEX_HTML)
  })
})

describe('what must not get the shell', () => {
  it('keeps an unknown API path a JSON 404 even for a browser', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/spelling-mistake', headers: NAVIGATION })
    expect(res.statusCode).toBe(404)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found')
  })

  it('keeps an unknown auth path a JSON 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/nope', headers: NAVIGATION })
    expect(res.statusCode).toBe(404)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found')
  })

  it('404s a missing asset rather than serving HTML labelled as JavaScript', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/gone.js', headers: NAVIGATION })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/json')
  })

  it('gives a fetch a JSON 404, because it did not ask for HTML', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/budget',
      headers: { accept: 'application/json' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found')
  })

  it('gives a request with no Accept header a JSON 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/budget' })
    expect(res.statusCode).toBe(404)
  })

  it('never answers a POST with the shell', async () => {
    // A form posted to an unknown path is a mistake, not a navigation. Answering 200
    // would make it look like it worked.
    const res = await app.inject({ method: 'POST', url: '/budget', headers: NAVIGATION })
    expect(res.statusCode).not.toBe(200)
  })
})

describe('the assets', () => {
  it('serves a hashed file, immutably, with no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe(ASSET_JS)
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable')
  })

  it('sets no cookie, so a cold load is not a dozen Set-Cookies', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' })
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('refuses a traversal encoded to survive routing', async () => {
    // `..%2f` is the one that matters. A literal `/assets/../secret.txt` never
    // reaches this handler — the router resolves the segment first and nothing
    // matches — so a test using that form would pass with the guard removed. Encoding
    // the slash keeps it a single path segment through routing, the wildcard
    // parameter decodes to `../secret.txt`, and `@fastify/send` is the only thing
    // between that and the file. 403 rather than 404 is how you can tell which of
    // the two refused it.
    const res = await app.inject({ method: 'GET', url: '/assets/..%2fsecret.txt' })
    expect(res.statusCode).toBe(403)
    expect(res.body).not.toContain('not for the browser')
  })

  it('refuses a dot-encoded traversal too', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/%2e%2e%2fsecret.txt' })
    expect(res.statusCode).toBe(403)
    expect(res.body).not.toContain('not for the browser')
  })

  it('does not resolve a resolved traversal to anything either', async () => {
    // Refused earlier and differently — the router collapses the segment and finds no
    // route — but worth pinning: this is the form a scanner actually sends.
    const res = await app.inject({ method: 'GET', url: '/assets/../secret.txt' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('not for the browser')
  })
})

describe('with no bundle on disk', () => {
  it('explains itself at the root instead of 404ing', async () => {
    // `npm start` without a build, and every server test. A bare Fastify
    // `Route GET:/ not found` on a fresh deployment reads as a broken container.
    const plain = await buildApp({ db: ctx.db, oidc: null, web: null })
    const res = await plain.inject({ method: 'GET', url: '/', headers: NAVIGATION })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ name: string }>().name).toBe('balancr')
    await plain.close()
  })

  it('answers an unknown navigation with JSON, not with a shell it does not have', async () => {
    const plain = await buildApp({ db: ctx.db, oidc: null, web: null })
    const res = await plain.inject({ method: 'GET', url: '/budget', headers: NAVIGATION })
    expect(res.statusCode).toBe(404)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('not_found')
    await plain.close()
  })
})
