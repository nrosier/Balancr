/**
 * The revolving-debt routes on `/api/settings` (#442).
 *
 * `debts.test.ts` covers the row operations; what is only true at the HTTP layer is here,
 * mirroring `settings-loans.test.ts`'s reasoning for the same three shapes:
 *
 *  - **Three routes, one per gesture.** `POST` creates and the server assigns the id,
 *    `PATCH /:id` replaces, `DELETE /:id` removes. Each answers with the whole settings
 *    payload, like every other write on this page.
 *  - **Owner only, and CSRF-gated.**
 *  - **Another tenant's debt is a 404, not a silent no-op.**
 *  - **The APR ceiling comes back as a field-named 400.** The Fastify-boundary schema is
 *    loose on purpose; the bound is the domain's.
 *  - **Every write leaves an audit entry**, with `before`/`after` saying which of the
 *    three gestures it was.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../../src/db/index.ts'
import { auditLog, users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { createDebt, listDebts, MAX_DEBTS } from '../../src/domain/debt/debts.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import type { ErrorBody } from '../../src/server/errors.ts'
import type { Settings } from '../../src/server/routes/api/schemas.ts'
import { apiFixture } from '../helpers/api-fixture.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string
let viewer: string
let tenantId: string

/** A whole debt, as the form sends it. Synthetic, round figures only. */
const BODY = {
  kind: 'creditCard' as const,
  label: 'Card',
  balanceCents: 200_000,
  minimumPaymentCents: 10_000,
  aprBp: 1_800,
}

function signIn(db: Db, role: 'owner' | 'viewer', userTenantId = getSoleTenantId(db)): string {
  const row = db
    .insert(users)
    .values({
      tenantId: userTenantId,
      oidcSub: `sub-${crypto.randomUUID()}`,
      email: `${role}-${crypto.randomUUID()}@example.test`,
      displayName: role === 'owner' ? 'Owner' : 'Guest',
      role,
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('inserting the user returned no row')
  return createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined })
    .token
}

function send(
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: object,
  options: { token?: string; csrf?: boolean } = {},
) {
  const csrf = newCsrfToken()
  return app.inject({
    method,
    url,
    ...(body === undefined ? {} : { payload: body }),
    cookies: {
      [SESSION_COOKIE]: options.token ?? owner,
      ...(options.csrf === false ? {} : { [CSRF_COOKIE]: csrf }),
    },
    headers: options.csrf === false ? {} : { [CSRF_HEADER]: csrf },
  })
}

const auditEntries = (db: Db) => db.select().from(auditLog).all()

beforeAll(async () => {
  await initI18n()
})

beforeEach(async () => {
  ctx = apiFixture()
  tenantId = getSoleTenantId(ctx.db)
  app = await buildApp({ db: ctx.db, web: null })
  owner = signIn(ctx.db, 'owner')
  viewer = signIn(ctx.db, 'viewer')
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

describe('GET /api/settings', () => {
  it('lists the debts, most recently added first', async () => {
    createDebt(ctx.db, tenantId, { ...BODY, label: 'Older' })
    createDebt(ctx.db, tenantId, { ...BODY, label: 'Newer' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      cookies: { [SESSION_COOKIE]: owner },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().debts.map((debt) => debt.label)).toEqual(['Newer', 'Older'])
  })

  it('is an empty array on a fresh instance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      cookies: { [SESSION_COOKIE]: owner },
    })

    expect(res.json<Settings>().debts).toEqual([])
  })
})

describe('POST /api/settings/debts', () => {
  it('creates the debt, assigns its id, and answers with the whole payload', async () => {
    const res = await send('POST', '/api/settings/debts', BODY)

    expect(res.statusCode).toBe(200)
    const settings = res.json<Settings>()
    expect(settings.debts).toHaveLength(1)
    expect(settings.debts[0]?.id).toBeTruthy()
    expect(settings.debts[0]?.balanceCents).toBe(200_000)
    // The whole payload, not just the debt: what lets the screen replace its state.
    expect(settings.property).toBeDefined()
    expect(settings.params).toBeDefined()
  })

  it('records an audit entry with nothing before it', async () => {
    await send('POST', '/api/settings/debts', BODY)

    const entry = auditEntries(ctx.db).find((row) => row.action === 'settings.debt')
    expect(entry?.entity).toBe('revolving_debts')
    expect(entry?.beforeJson).toBeNull()
    expect(entry?.afterJson).toContain('200000')
  })

  it('refuses a viewer, and writes nothing', async () => {
    const res = await send('POST', '/api/settings/debts', BODY, { token: viewer })

    expect(res.statusCode).toBe(403)
    expect(listDebts(ctx.db, tenantId)).toEqual([])
  })

  it('refuses a write with no CSRF token', async () => {
    const res = await send('POST', '/api/settings/debts', BODY, { csrf: false })

    expect(res.statusCode).toBe(403)
    expect(listDebts(ctx.db, tenantId)).toEqual([])
  })

  it('names the field when a bound is exceeded', async () => {
    const res = await send('POST', '/api/settings/debts', { ...BODY, aprBp: 10_001 })

    expect(res.statusCode).toBe(400)
    const issues = res.json<ErrorBody>().error.issues ?? []
    expect(issues.map((issue) => issue.path)).toContain('aprBp')
    expect(listDebts(ctx.db, tenantId)).toEqual([])
  })

  it('refuses a misspelt field rather than dropping it', async () => {
    const res = await send('POST', '/api/settings/debts', { ...BODY, cardNumber: '4111' })

    expect(res.statusCode).toBe(400)
    expect(listDebts(ctx.db, tenantId)).toEqual([])
  })

  it('answers 409 once the cap is reached, because the body was fine', async () => {
    for (let i = 0; i < MAX_DEBTS; i++) {
      createDebt(ctx.db, tenantId, { ...BODY, label: `Card ${String(i)}` })
    }

    const res = await send('POST', '/api/settings/debts', BODY)

    expect(res.statusCode).toBe(409)
    expect(listDebts(ctx.db, tenantId)).toHaveLength(MAX_DEBTS)
  })
})

describe('PATCH /api/settings/debts/:id', () => {
  it('replaces the debt and answers with the whole payload', async () => {
    const created = createDebt(ctx.db, tenantId, BODY)

    const res = await send('PATCH', `/api/settings/debts/${created.id}`, {
      ...BODY,
      balanceCents: 150_000,
    })

    expect(res.statusCode).toBe(200)
    const debts = res.json<Settings>().debts
    expect(debts).toHaveLength(1)
    expect(debts[0]?.balanceCents).toBe(150_000)
  })

  it('records both sides of the balance update', async () => {
    const created = createDebt(ctx.db, tenantId, BODY)
    await send('PATCH', `/api/settings/debts/${created.id}`, { ...BODY, balanceCents: 150_000 })

    const entry = auditEntries(ctx.db).find((row) => row.action === 'settings.debt')
    expect(entry?.entityRef).toBe(created.id)
    expect(entry?.beforeJson).toContain('200000')
    expect(entry?.afterJson).toContain('150000')
  })

  it('is a 404 for an id this tenant does not own', async () => {
    const otherTenant = createSecondTenant(ctx.db, 'Second')
    const theirs = createDebt(ctx.db, otherTenant, { ...BODY, label: 'Theirs' })

    const res = await send('PATCH', `/api/settings/debts/${theirs.id}`, {
      ...BODY,
      balanceCents: 1,
    })

    expect(res.statusCode).toBe(404)
    expect(listDebts(ctx.db, otherTenant)[0]?.balanceCents).toBe(200_000)
  })

  it('is a 404 for an id that never existed', async () => {
    const res = await send('PATCH', '/api/settings/debts/nope', BODY)

    expect(res.statusCode).toBe(404)
  })

  it('refuses a viewer, and leaves the debt as it was', async () => {
    const created = createDebt(ctx.db, tenantId, BODY)

    const res = await send(
      'PATCH',
      `/api/settings/debts/${created.id}`,
      { ...BODY, balanceCents: 1 },
      { token: viewer },
    )

    expect(res.statusCode).toBe(403)
    expect(listDebts(ctx.db, tenantId)[0]?.balanceCents).toBe(200_000)
  })
})

describe('DELETE /api/settings/debts/:id', () => {
  it('removes the debt and answers with the whole payload', async () => {
    const created = createDebt(ctx.db, tenantId, BODY)

    const res = await send('DELETE', `/api/settings/debts/${created.id}`)

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().debts).toEqual([])
    expect(listDebts(ctx.db, tenantId)).toEqual([])
  })

  it('records what was removed, since the row is the only place it existed', async () => {
    const created = createDebt(ctx.db, tenantId, BODY)
    await send('DELETE', `/api/settings/debts/${created.id}`)

    const entry = auditEntries(ctx.db).find((row) => row.action === 'settings.debt')
    expect(entry?.beforeJson).toContain('200000')
    expect(entry?.afterJson).toBeNull()
  })

  it('is a 404 the second time, rather than pretending to delete again', async () => {
    const created = createDebt(ctx.db, tenantId, BODY)
    await send('DELETE', `/api/settings/debts/${created.id}`)

    const res = await send('DELETE', `/api/settings/debts/${created.id}`)
    expect(res.statusCode).toBe(404)
  })

  it("is a 404 for another tenant's debt, which stays where it is", async () => {
    const otherTenant = createSecondTenant(ctx.db, 'Second')
    const theirs = createDebt(ctx.db, otherTenant, BODY)

    const res = await send('DELETE', `/api/settings/debts/${theirs.id}`)

    expect(res.statusCode).toBe(404)
    expect(listDebts(ctx.db, otherTenant)).toHaveLength(1)
  })

  it('refuses a viewer', async () => {
    const created = createDebt(ctx.db, tenantId, BODY)

    const res = await send('DELETE', `/api/settings/debts/${created.id}`, undefined, {
      token: viewer,
    })

    expect(res.statusCode).toBe(403)
    expect(listDebts(ctx.db, tenantId)).toHaveLength(1)
  })
})
