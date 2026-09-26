/**
 * `GET /api/audit` — the trail of every change a human approved, over HTTP (#592).
 *
 * Nothing exercised this endpoint before it existed. Owner-only is the one thing
 * that has to hold beyond the ordinary read shape: `recordAudit`'s `before`/`after`
 * can name a co-parent or an amount a viewer should not see.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../../src/db/index.ts'
import { users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { recordAudit } from '../../src/domain/audit.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { SESSION_COOKIE } from '../../src/server/cookies.ts'
import { MAX_AUDIT_LIMIT } from '../../src/server/routes/api/audit.ts'
import type { AuditTrail } from '../../src/server/routes/api/schemas.ts'
import { apiFixture } from '../helpers/api-fixture.ts'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string
let viewer: string
let tenantId: string

function signIn(db: Db, role: 'owner' | 'viewer'): string {
  const row = db
    .insert(users)
    .values({
      tenantId: getSoleTenantId(db),
      oidcSub: `sub-${crypto.randomUUID()}`,
      email: `${role}@example.test`,
      displayName: role,
      locale: 'en',
      role,
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('inserting the user returned no row')
  return createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined })
    .token
}

beforeEach(async () => {
  ctx = apiFixture()
  app = await buildApp({ db: ctx.db, web: null })
  tenantId = getSoleTenantId(ctx.db)
  owner = signIn(ctx.db, 'owner')
  viewer = signIn(ctx.db, 'viewer')
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

const audit = (qs: string, token = owner) =>
  app.inject({ method: 'GET', url: `/api/audit${qs}`, cookies: { [SESSION_COOKIE]: token } })

describe('/api/audit', () => {
  it('needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/audit' })
    expect(res.statusCode).toBe(401)
  })

  it('refuses a viewer, the one route in this directory that does', async () => {
    const res = await audit('', viewer)
    expect(res.statusCode).toBe(403)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('forbidden')
  })

  it('answers an empty list when nothing has been recorded yet', async () => {
    const res = await audit('')
    expect(res.statusCode).toBe(200)
    expect(res.json<AuditTrail>()).toEqual({ entries: [] })
  })

  it('round-trips a real entry and filters by entity, entityRef and action', async () => {
    recordAudit(ctx.db, {
      tenantId,
      action: 'settings.coicop',
      entity: 'category_meta',
      entityRef: 'cat-groceries',
      actorId: null,
      before: { coicop: null },
      after: { coicop: '01' },
      at: new Date('2026-08-01T00:00:00Z'),
    })
    recordAudit(ctx.db, {
      tenantId,
      action: 'settings.property',
      entity: 'properties',
      entityRef: 'home-a',
      actorId: null,
      before: null,
      after: { propertyValueCents: 30_000_000 },
      at: new Date('2026-08-02T00:00:00Z'),
    })

    const all = (await audit('')).json<AuditTrail>()
    expect(all.entries).toHaveLength(2)
    expect(all.entries[0]?.entity).toBe('properties') // newest first

    const byEntity = (await audit('?entity=category_meta')).json<AuditTrail>()
    expect(byEntity.entries.map((entry) => entry.entityRef)).toEqual(['cat-groceries'])

    const byRef = (await audit('?entityRef=home-a')).json<AuditTrail>()
    expect(byRef.entries.map((entry) => entry.action)).toEqual(['settings.property'])

    const byAction = (await audit('?action=settings.coicop')).json<AuditTrail>()
    expect(byAction.entries).toHaveLength(1)
    expect(byAction.entries[0]?.before).toEqual({ coicop: null })
    expect(byAction.entries[0]?.after).toEqual({ coicop: '01' })
  })

  it('refuses an action outside the closed set rather than filtering on nothing', async () => {
    const res = await audit('?action=not-a-real-action')
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: { code: string } }>().error.code).toBe('bad_request')
  })

  it('refuses a limit outside 1..MAX_AUDIT_LIMIT rather than clamping it silently', async () => {
    expect((await audit('?limit=0')).statusCode).toBe(400)
    expect((await audit(`?limit=${MAX_AUDIT_LIMIT + 1}`)).statusCode).toBe(400)
  })

  it('never returns another tenant\'s entries', async () => {
    const otherTenantId = `${tenantId}-other`
    recordAudit(ctx.db, {
      tenantId,
      action: 'settings.coicop',
      entity: 'category_meta',
      entityRef: 'mine',
      before: null,
      after: { coicop: '01' },
    })
    recordAudit(ctx.db, {
      tenantId: otherTenantId,
      action: 'settings.coicop',
      entity: 'category_meta',
      entityRef: 'not-mine',
      before: null,
      after: { coicop: '02' },
    })

    const body = (await audit('')).json<AuditTrail>()
    expect(body.entries.map((entry) => entry.entityRef)).toEqual(['mine'])
  })
})
