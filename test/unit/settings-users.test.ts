/**
 * Owner-facing user management through `/api/settings` (#695) — the in-app
 * gesture that was missing when a co-parent's viewer account outlived the
 * relationship it was created for.
 *
 * What is only true at the HTTP layer, on top of what `auth-users.test.ts`
 * already covers at the domain layer:
 *
 *  - **Owner only, and CSRF-gated**, like every other write in this file.
 *  - **Disabling ends the account's sessions immediately** — the whole point,
 *    since a cookie already in someone's browser must not outlive the rest of
 *    `SESSION_TTL_HOURS` on the strength of a column nobody re-checks.
 *  - **A viewer never sees the user list at all** — `buildSettings` returns an
 *    empty `users` array for them, same as it does for `invites`.
 *  - **The change lands in the audit trail** as `settings.userAccess`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../../src/db/index.ts'
import { auditLog, users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession, readSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import type { Settings } from '../../src/server/routes/api/schemas.ts'
import { apiFixture } from '../helpers/api-fixture.ts'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string
let viewer: string
let viewerId: string

function signIn(db: Db, role: 'owner' | 'viewer'): { token: string; userId: string } {
  const row = db
    .insert(users)
    .values({
      tenantId: getSoleTenantId(db),
      oidcSub: `sub-${crypto.randomUUID()}`,
      email: `${role}-${crypto.randomUUID()}@example.test`,
      displayName: role === 'owner' ? 'Nick' : 'Guest',
      role,
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('inserting the user returned no row')
  return {
    token: createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined }).token,
    userId: row.id,
  }
}

const get = (url: string, token = owner) =>
  app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: token } })

function patch(url: string, body: object, options: { token?: string; csrf?: boolean } = {}) {
  const csrf = newCsrfToken()
  return app.inject({
    method: 'PATCH',
    url,
    payload: body,
    cookies: {
      [SESSION_COOKIE]: options.token ?? owner,
      ...(options.csrf === false ? {} : { [CSRF_COOKIE]: csrf }),
    },
    headers: options.csrf === false ? {} : { [CSRF_HEADER]: csrf },
  })
}

const auditRows = (db: Db) => db.select().from(auditLog).all()

beforeAll(async () => {
  await initI18n()
})

beforeEach(async () => {
  ctx = apiFixture()
  app = await buildApp({ db: ctx.db, web: null })
  owner = signIn(ctx.db, 'owner').token
  const seededViewer = signIn(ctx.db, 'viewer')
  viewer = seededViewer.token
  viewerId = seededViewer.userId
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

describe('the user list on GET /api/settings', () => {
  it('lists every user in the tenant for an owner', async () => {
    const res = await get('/api/settings')
    const body = res.json<Settings>()
    expect(body.users.map((row) => row.id)).toContain(viewerId)
  })

  it('is empty for a viewer', async () => {
    const res = await get('/api/settings', viewer)
    expect(res.json<Settings>().users).toEqual([])
  })
})

describe('PATCH /api/settings/users/:id', () => {
  it('disables the account and returns the whole settings payload', async () => {
    const res = await patch(`/api/settings/users/${viewerId}`, { disabled: true })
    expect(res.statusCode).toBe(200)

    const body = res.json<Settings>()
    const row = body.users.find((u) => u.id === viewerId)
    expect(row?.disabled).toBe(true)

    const entry = auditRows(ctx.db).find((r) => r.action === 'settings.userAccess')
    expect(entry).toBeDefined()
    expect(entry?.entityRef).toBe(viewerId)
  })

  it('ends every session the account already holds', async () => {
    const token = createSession(ctx.db, {
      userId: viewerId,
      method: 'oidc',
      ip: undefined,
      userAgent: undefined,
    }).token
    expect(readSession(ctx.db, token)).not.toBeNull()

    const res = await patch(`/api/settings/users/${viewerId}`, { disabled: true })
    expect(res.statusCode).toBe(200)
    expect(readSession(ctx.db, token)).toBeNull()
  })

  it('re-enabling does not need to touch sessions, and is reflected on read', async () => {
    await patch(`/api/settings/users/${viewerId}`, { disabled: true })
    const res = await patch(`/api/settings/users/${viewerId}`, { disabled: false })
    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().users.find((u) => u.id === viewerId)?.disabled).toBe(false)
  })

  it('is owner-only, and leaves the account untouched', async () => {
    const res = await patch(`/api/settings/users/${viewerId}`, { disabled: true }, { token: viewer })
    expect(res.statusCode).toBe(403)

    const settingsRes = await get('/api/settings')
    const row = settingsRes.json<Settings>().users.find((u) => u.id === viewerId)
    expect(row?.disabled).toBe(false)
  })

  it('refuses a write with no CSRF token', async () => {
    const res = await patch(`/api/settings/users/${viewerId}`, { disabled: true }, { csrf: false })
    expect(res.statusCode).toBe(403)
  })

  it('refuses to disable the only enabled owner', async () => {
    const originalOwnerId = (await get('/api/settings')).json<Settings>().users.find(
      (u) => u.role === 'owner',
    )!.id
    const secondOwnerId = signIn(ctx.db, 'owner').userId

    const first = await patch(`/api/settings/users/${secondOwnerId}`, { disabled: true })
    expect(first.statusCode).toBe(200)

    const before = auditRows(ctx.db).length
    const second = await patch(`/api/settings/users/${originalOwnerId}`, { disabled: true })
    expect(second.statusCode).toBe(400)
    // The refused attempt left no trail — nothing changed to record.
    expect(auditRows(ctx.db)).toHaveLength(before)
  })

  it('404s for a user that does not exist', async () => {
    const res = await patch('/api/settings/users/not-a-real-id', { disabled: true })
    expect(res.statusCode).toBe(404)
  })

  it('rejects an unrecognised field', async () => {
    const res = await patch(`/api/settings/users/${viewerId}`, { role: 'owner' })
    expect(res.statusCode).toBe(400)
  })
})
