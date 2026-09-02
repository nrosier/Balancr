/**
 * The two buckets, and the store underneath them.
 *
 * The AI bucket is the one that matters: it is a spend limit wearing a request
 * limit's clothes, and being logged in is what makes a caller expensive, so
 * Authentik cannot help. Three properties carry it, and each has a test here:
 *
 *  - **The counter survives a restart.** It lives in SQLite because an hourly money
 *    limit that resets on deploy is not a limit. Tested by building a second store
 *    over the same database.
 *  - **The buckets do not share a counter.** Without a per-route key, a burst of
 *    ordinary reads would eat the AI allowance — the opposite of the point.
 *  - **A window that has elapsed starts again.** Otherwise the first hour is the
 *    only hour anyone gets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { rateLimits } from '../../src/db/schema.ts'
import { buildApp } from '../../src/server/app.ts'
import { AI_RATE_LIMIT, aiRateLimit, sqliteRateLimitStore } from '../../src/server/rate-limit.ts'

interface Result {
  current: number
  ttl: number
}
interface Store {
  incr: (k: string, cb: (e: Error | null, r?: Result) => void, w: number, m: number) => void
  read: (k: string, cb: (e: Error | null, r?: Result) => void, w: number, m: number) => void
}

let ctx: ReturnType<typeof createTestDb>
let app: FastifyInstance

/** The plugin calls these with a callback; a promise is easier to assert on. */
const incr = (store: Store, key: string, window = 60_000): Promise<Result> =>
  new Promise((resolve, reject) => {
    store.incr(key, (error, result) => {
      if (error !== null) reject(error)
      else if (result === undefined) reject(new Error('no result'))
      else resolve(result)
    }, window, 10)
  })

const peek = (store: Store, key: string, window = 60_000): Promise<Result> =>
  new Promise((resolve, reject) => {
    store.read(key, (error, result) => {
      if (error !== null) reject(error)
      else if (result === undefined) reject(new Error('no result'))
      else resolve(result)
    }, window, 10)
  })

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Route config for the ad-hoc routes below: a limit small enough to trip in a
 * test, and public, because the auth guard is deny-by-default and there is no
 * session behind an injected request.
 */
const limitedTo = (max: number): { config: { rateLimit: object; auth: false } } => ({
  config: { rateLimit: { max, timeWindow: '1 minute' }, auth: false },
})

beforeEach(async () => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  app = await buildApp({ db: ctx.db })
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

describe('the store', () => {
  it('counts up within a window and reports the time left, not the window', async () => {
    const Store = sqliteRateLimitStore(ctx.db)
    const store = new Store({})

    const first = await incr(store, '10.0.0.1')
    expect(first.current).toBe(1)
    expect(first.ttl).toBeLessThanOrEqual(60_000)

    const second = await incr(store, '10.0.0.1')
    expect(second.current).toBe(2)
    // Still the same window: the end did not move when the count did. A store that
    // reset `expires_at` on every request would hand a busy client an endless window.
    expect(second.ttl).toBeLessThanOrEqual(first.ttl)
  })

  it('keeps clients apart', async () => {
    const store = new (sqliteRateLimitStore(ctx.db))({})
    await incr(store, '10.0.0.1')
    await incr(store, '10.0.0.1')
    expect((await incr(store, '10.0.0.2')).current).toBe(1)
  })

  it('starts a fresh window once the old one has elapsed', async () => {
    const store = new (sqliteRateLimitStore(ctx.db))({})
    await incr(store, '10.0.0.1', 20)
    await wait(30)
    expect((await incr(store, '10.0.0.1', 20)).current).toBe(1)
  })

  it('gives each route its own bucket', async () => {
    const global = new (sqliteRateLimitStore(ctx.db))({})
    const ai = global.child({ routeInfo: { method: 'POST', url: '/api/ai/ask' } } as never)

    await incr(global, '10.0.0.1')
    await incr(global, '10.0.0.1')
    // Same client, different bucket: the reads it just made must not have spent its
    // AI allowance.
    expect((await incr(ai, '10.0.0.1')).current).toBe(1)
  })

  it('peeks without incrementing, and reads an elapsed window as clean', async () => {
    const store = new (sqliteRateLimitStore(ctx.db))({})
    await incr(store, '10.0.0.1', 20)

    expect((await peek(store, '10.0.0.1', 20)).current).toBe(1)
    expect((await peek(store, '10.0.0.1', 20)).current).toBe(1)

    await wait(30)
    // Not the stale count: a peek and a real request must agree on whether the
    // window is still open.
    expect((await peek(store, '10.0.0.1', 20)).current).toBe(0)
  })

  it('survives the process it was counting in', async () => {
    // The whole reason the counters are not in memory. A restart mid-hour must not
    // hand back a fresh AI allowance.
    const before = sqliteRateLimitStore(ctx.db)
    await incr(new before({}), '10.0.0.1')
    await incr(new before({}), '10.0.0.1')

    const after = sqliteRateLimitStore(ctx.db)
    expect((await incr(new after({}), '10.0.0.1')).current).toBe(3)
  })
})

describe('through the app', () => {
  it('refuses past the limit with the shared error envelope', async () => {
    app.get('/t/limited', limitedTo(2), () => ({ ok: true }))
    await app.ready()

    expect((await app.inject({ method: 'GET', url: '/t/limited' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/t/limited' })).statusCode).toBe(200)

    const blocked = await app.inject({ method: 'GET', url: '/t/limited' })
    expect(blocked.statusCode).toBe(429)
    // The same envelope as every other error, and a message specific enough to act
    // on rather than the generic fallback for a status the code did not choose.
    const body = blocked.json<{ error: { code: string; message: string } }>()
    expect(body.error.code).toBe('rate_limited')
    expect(body.error.message).toMatch(/try again in/i)
    expect(blocked.headers['retry-after']).toBeDefined()
  })

  it('exempts the health check, where a 429 reads as a dead container', async () => {
    app.get('/t/probe', limitedTo(1), () => ({ ok: true }))
    await app.ready()
    await app.inject({ method: 'GET', url: '/t/probe' })
    expect((await app.inject({ method: 'GET', url: '/t/probe' })).statusCode).toBe(429)

    // Same client, many probes, never throttled.
    for (let i = 0; i < 5; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
    }
  })

  it('spends an AI route’s allowance separately from ordinary reads', async () => {
    app.get('/t/read', limitedTo(2), () => ({ ok: true }))
    const ai = { config: { ...aiRateLimit().config, auth: false } }
    app.get('/api/ai/ask', ai, () => ({ ok: true }))
    await app.ready()

    await app.inject({ method: 'GET', url: '/t/read' })
    await app.inject({ method: 'GET', url: '/t/read' })
    expect((await app.inject({ method: 'GET', url: '/t/read' })).statusCode).toBe(429)

    // The reads are spent; the AI bucket is untouched.
    expect((await app.inject({ method: 'GET', url: '/api/ai/ask' })).statusCode).toBe(200)
  })

  it('measures the AI bucket in hours', () => {
    // Not cosmetic: the same number per minute would be 43 200 calls a day, which
    // is a different order of money entirely.
    expect(AI_RATE_LIMIT.timeWindow).toBe('1 hour')
    expect(AI_RATE_LIMIT.max).toBeGreaterThan(0)
  })

  it('writes its counters where they can be inspected', async () => {
    app.get('/t/counted', limitedTo(5), () => ({ ok: true }))
    await app.ready()
    await app.inject({ method: 'GET', url: '/t/counted' })

    const rows = ctx.db.select().from(rateLimits).all()
    expect(rows.length).toBeGreaterThan(0)
    // The bucket prefix is what keeps the AI window separate; it should be legible
    // in the table rather than a hash.
    expect(rows.some((row) => row.key.includes('/t/counted'))).toBe(true)
  })
})
