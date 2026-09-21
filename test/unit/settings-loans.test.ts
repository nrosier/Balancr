/**
 * The loan routes on `/api/settings` (#441).
 *
 * `loans.test.ts` covers the row operations; what is only true at the HTTP layer is here:
 *
 *  - **Three routes, one per gesture.** `POST` creates and the server assigns the id,
 *    `PATCH /:id` replaces, `DELETE /:id` removes — the shape a real table takes, as
 *    against the whole-list PATCH the property blob uses. Each answers with the whole
 *    settings payload, like every other write on this page.
 *  - **Owner only, and CSRF-gated.** Every write on this page is; these are three more,
 *    and a viewer must get the standard 403 with the row untouched.
 *  - **Another tenant's loan is a 404, not a silent no-op.** The routes read before they
 *    write for exactly this reason: an `UPDATE ... WHERE tenant_id = ?` that matches
 *    nothing would otherwise answer 200 and look like a save.
 *  - **Bounds come back as a field-named 400.** The Fastify-boundary schema is loose on
 *    purpose; the rate and term ceilings are the domain's, and a form has to be told
 *    which box it got wrong.
 *  - **Every write leaves an audit entry**, with `before`/`after` saying which of the
 *    three gestures it was.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../../src/db/index.ts'
import { auditLog, users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { createLoan, listLoans, MAX_LOANS } from '../../src/domain/loan/loans.ts'
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

/** A whole loan, as the form sends it. Synthetic, round figures only. */
const BODY = {
  kind: 'car' as const,
  label: 'Car',
  openingDate: '2026-01-01',
  principalCents: 1_500_000,
  anchorDate: '2026-01-01',
  rateBp: 0,
  monthlyPaymentCents: 100_000,
  remainingTermMonths: 60,
  originalPrincipalCents: null,
  extraMonthlyPaymentCents: null,
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
  it('lists the loans, most recently taken out first', async () => {
    createLoan(ctx.db, tenantId, { ...BODY, openingDate: '2024-05-01', label: 'Older' })
    createLoan(ctx.db, tenantId, { ...BODY, openingDate: '2026-02-01', label: 'Newer' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      cookies: { [SESSION_COOKIE]: owner },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().loans.map((loan) => loan.label)).toEqual(['Newer', 'Older'])
  })

  it('is an empty array on a fresh instance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      cookies: { [SESSION_COOKIE]: owner },
    })

    expect(res.json<Settings>().loans).toEqual([])
  })
})

describe('POST /api/settings/loans', () => {
  it('creates the loan, assigns its id, and answers with the whole payload', async () => {
    const res = await send('POST', '/api/settings/loans', BODY)

    expect(res.statusCode).toBe(200)
    const settings = res.json<Settings>()
    expect(settings.loans).toHaveLength(1)
    expect(settings.loans[0]?.id).toBeTruthy()
    expect(settings.loans[0]?.principalCents).toBe(1_500_000)
    // The whole payload, not just the loan: what lets the screen replace its state.
    expect(settings.property).toBeDefined()
    expect(settings.params).toBeDefined()
  })

  it('records an audit entry with nothing before it', async () => {
    await send('POST', '/api/settings/loans', BODY)

    const entry = auditEntries(ctx.db).find((row) => row.action === 'settings.loan')
    expect(entry?.entity).toBe('loans')
    expect(entry?.beforeJson).toBeNull()
    expect(entry?.afterJson).toContain('1500000')
  })

  it('refuses a viewer, and writes nothing', async () => {
    const res = await send('POST', '/api/settings/loans', BODY, { token: viewer })

    expect(res.statusCode).toBe(403)
    expect(listLoans(ctx.db, tenantId)).toEqual([])
  })

  it('refuses a write with no CSRF token', async () => {
    const res = await send('POST', '/api/settings/loans', BODY, { csrf: false })

    expect(res.statusCode).toBe(403)
    expect(listLoans(ctx.db, tenantId)).toEqual([])
  })

  it('names the field when a bound is exceeded', async () => {
    const res = await send('POST', '/api/settings/loans', { ...BODY, rateBp: 9_000 })

    expect(res.statusCode).toBe(400)
    const issues = res.json<ErrorBody>().error.issues ?? []
    expect(issues.map((issue) => issue.path)).toContain('rateBp')
    expect(listLoans(ctx.db, tenantId)).toEqual([])
  })

  it('refuses a misspelt field rather than dropping it', async () => {
    const res = await send('POST', '/api/settings/loans', { ...BODY, balloonCents: 1_000 })

    expect(res.statusCode).toBe(400)
    expect(listLoans(ctx.db, tenantId)).toEqual([])
  })

  it('answers 409 once the cap is reached, because the body was fine', async () => {
    for (let i = 0; i < MAX_LOANS; i++) {
      createLoan(ctx.db, tenantId, { ...BODY, label: `Loan ${String(i)}` })
    }

    const res = await send('POST', '/api/settings/loans', BODY)

    expect(res.statusCode).toBe(409)
    expect(listLoans(ctx.db, tenantId)).toHaveLength(MAX_LOANS)
  })
})

describe('PATCH /api/settings/loans/:id', () => {
  it('replaces the loan and answers with the whole payload', async () => {
    const created = createLoan(ctx.db, tenantId, BODY)

    const res = await send('PATCH', `/api/settings/loans/${created.id}`, {
      ...BODY,
      principalCents: 700_000,
      anchorDate: '2026-09-01',
      remainingTermMonths: 7,
    })

    expect(res.statusCode).toBe(200)
    const loans = res.json<Settings>().loans
    expect(loans).toHaveLength(1)
    expect(loans[0]?.principalCents).toBe(700_000)
    expect(loans[0]?.anchorDate).toBe('2026-09-01')
  })

  it('records both sides of the re-anchor', async () => {
    const created = createLoan(ctx.db, tenantId, BODY)
    await send('PATCH', `/api/settings/loans/${created.id}`, { ...BODY, principalCents: 700_000 })

    const entry = auditEntries(ctx.db).find((row) => row.action === 'settings.loan')
    expect(entry?.entityRef).toBe(created.id)
    expect(entry?.beforeJson).toContain('1500000')
    expect(entry?.afterJson).toContain('700000')
  })

  it('is a 404 for an id this tenant does not own', async () => {
    const otherTenant = createSecondTenant(ctx.db, 'Second')
    const theirs = createLoan(ctx.db, otherTenant, { ...BODY, label: 'Theirs' })

    const res = await send('PATCH', `/api/settings/loans/${theirs.id}`, {
      ...BODY,
      principalCents: 1,
    })

    expect(res.statusCode).toBe(404)
    expect(listLoans(ctx.db, otherTenant)[0]?.principalCents).toBe(1_500_000)
  })

  it('is a 404 for an id that never existed', async () => {
    const res = await send('PATCH', '/api/settings/loans/nope', BODY)

    expect(res.statusCode).toBe(404)
  })

  it('refuses a viewer, and leaves the loan as it was', async () => {
    const created = createLoan(ctx.db, tenantId, BODY)

    const res = await send(
      'PATCH',
      `/api/settings/loans/${created.id}`,
      { ...BODY, principalCents: 1 },
      { token: viewer },
    )

    expect(res.statusCode).toBe(403)
    expect(listLoans(ctx.db, tenantId)[0]?.principalCents).toBe(1_500_000)
  })
})

describe('DELETE /api/settings/loans/:id', () => {
  it('removes the loan and answers with the whole payload', async () => {
    const created = createLoan(ctx.db, tenantId, BODY)

    const res = await send('DELETE', `/api/settings/loans/${created.id}`)

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().loans).toEqual([])
    expect(listLoans(ctx.db, tenantId)).toEqual([])
  })

  it('records what was removed, since the row is the only place it existed', async () => {
    const created = createLoan(ctx.db, tenantId, BODY)
    await send('DELETE', `/api/settings/loans/${created.id}`)

    const entry = auditEntries(ctx.db).find((row) => row.action === 'settings.loan')
    expect(entry?.beforeJson).toContain('1500000')
    expect(entry?.afterJson).toBeNull()
  })

  it('is a 404 the second time, rather than pretending to delete again', async () => {
    const created = createLoan(ctx.db, tenantId, BODY)
    await send('DELETE', `/api/settings/loans/${created.id}`)

    const res = await send('DELETE', `/api/settings/loans/${created.id}`)
    expect(res.statusCode).toBe(404)
  })

  it("is a 404 for another tenant's loan, which stays where it is", async () => {
    const otherTenant = createSecondTenant(ctx.db, 'Second')
    const theirs = createLoan(ctx.db, otherTenant, BODY)

    const res = await send('DELETE', `/api/settings/loans/${theirs.id}`)

    expect(res.statusCode).toBe(404)
    expect(listLoans(ctx.db, otherTenant)).toHaveLength(1)
  })

  it('refuses a viewer', async () => {
    const created = createLoan(ctx.db, tenantId, BODY)

    const res = await send('DELETE', `/api/settings/loans/${created.id}`, undefined, {
      token: viewer,
    })

    expect(res.statusCode).toBe(403)
    expect(listLoans(ctx.db, tenantId)).toHaveLength(1)
  })
})
