/**
 * The goal routes on `/api/settings` (#407).
 *
 * `goals.test.ts` covers the row operations; what is only true at the HTTP layer is
 * here, mirroring `settings-loans.test.ts`'s shape for the same reasons:
 *
 *  - **Three routes, one per gesture.** `POST` creates and the server assigns the
 *    id, `PATCH /:id` replaces, `DELETE /:id` removes. Each answers with the whole
 *    settings payload.
 *  - **Owner only, and CSRF-gated.**
 *  - **Another tenant's goal is a 404, not a silent no-op.**
 *  - **A misspelt field or an out-of-range target comes back as a 400.**
 *  - **Every write leaves an audit entry.**
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../../src/db/index.ts'
import { auditLog, categoryMeta, users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { createGoal, listGoals, MAX_GOALS, updateGoal } from '../../src/domain/goal/goals.ts'
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

/** A whole goal, as the form sends it. */
const BODY = {
  label: 'Emergency fund',
  kind: 'liquid' as const,
  priority: 'high' as const,
  targetCents: 1_000_000,
  targetDate: '2027-06-01',
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
  it('lists the goals, highest priority first', async () => {
    createGoal(ctx.db, tenantId, { ...BODY, priority: 'low', label: 'Low' })
    createGoal(ctx.db, tenantId, { ...BODY, priority: 'high', label: 'High' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      cookies: { [SESSION_COOKIE]: owner },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().goals.map((goal) => goal.label)).toEqual(['High', 'Low'])
  })

  it('is an empty array on a fresh instance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      cookies: { [SESSION_COOKIE]: owner },
    })

    expect(res.json<Settings>().goals).toEqual([])
  })
})

describe('POST /api/settings/goals', () => {
  it('creates the goal, assigns its id, and answers with the whole payload', async () => {
    const res = await send('POST', '/api/settings/goals', BODY)

    expect(res.statusCode).toBe(200)
    const settings = res.json<Settings>()
    expect(settings.goals).toHaveLength(1)
    expect(settings.goals[0]?.id).toBeTruthy()
    expect(settings.goals[0]?.targetCents).toBe(1_000_000)
    expect(settings.property).toBeDefined()
    expect(settings.params).toBeDefined()
  })

  it('records an audit entry with nothing before it', async () => {
    await send('POST', '/api/settings/goals', BODY)

    const entry = auditEntries(ctx.db).find((row) => row.action === 'settings.goal')
    expect(entry?.entity).toBe('goals')
    expect(entry?.beforeJson).toBeNull()
    expect(entry?.afterJson).toContain('1000000')
  })

  it('refuses a viewer, and writes nothing', async () => {
    const res = await send('POST', '/api/settings/goals', BODY, { token: viewer })

    expect(res.statusCode).toBe(403)
    expect(listGoals(ctx.db, tenantId)).toEqual([])
  })

  it('refuses a write with no CSRF token', async () => {
    const res = await send('POST', '/api/settings/goals', BODY, { csrf: false })

    expect(res.statusCode).toBe(403)
    expect(listGoals(ctx.db, tenantId)).toEqual([])
  })

  it('names the field when a bound is exceeded', async () => {
    const res = await send('POST', '/api/settings/goals', { ...BODY, targetCents: 0 })

    expect(res.statusCode).toBe(400)
    const issues = res.json<ErrorBody>().error.issues ?? []
    expect(issues.map((issue) => issue.path)).toContain('targetCents')
    expect(listGoals(ctx.db, tenantId)).toEqual([])
  })

  it('refuses a misspelt field rather than dropping it', async () => {
    const res = await send('POST', '/api/settings/goals', { ...BODY, stretchCents: 1_000 })

    expect(res.statusCode).toBe(400)
    expect(listGoals(ctx.db, tenantId)).toEqual([])
  })

  it('answers 409 once the cap is reached, because the body was fine', async () => {
    for (let i = 0; i < MAX_GOALS; i++) {
      createGoal(ctx.db, tenantId, { ...BODY, label: `Goal ${String(i)}` })
    }

    const res = await send('POST', '/api/settings/goals', BODY)

    expect(res.statusCode).toBe(409)
    expect(listGoals(ctx.db, tenantId)).toHaveLength(MAX_GOALS)
  })

  it('accepts a category goal naming a category this tenant has seen', async () => {
    ctx.db
      .insert(categoryMeta)
      .values({ tenantId, categoryId: 'cat-tv', nameSnapshot: 'TV', isIncome: false, hidden: false })
      .run()

    const res = await send('POST', '/api/settings/goals', {
      ...BODY,
      kind: 'category',
      categoryId: 'cat-tv',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().goals[0]?.categoryId).toBe('cat-tv')
  })

  it('names categoryId when it points at no category this tenant has seen', async () => {
    const res = await send('POST', '/api/settings/goals', {
      ...BODY,
      kind: 'category',
      categoryId: 'nope',
    })

    expect(res.statusCode).toBe(400)
    const issues = res.json<ErrorBody>().error.issues ?? []
    expect(issues.map((issue) => issue.path)).toContain('categoryId')
    expect(listGoals(ctx.db, tenantId)).toEqual([])
  })
})

describe('PATCH /api/settings/goals/:id', () => {
  it('replaces the goal and answers with the whole payload', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)

    const res = await send('PATCH', `/api/settings/goals/${created.id}`, {
      ...BODY,
      targetCents: 700_000,
      targetDate: null,
    })

    expect(res.statusCode).toBe(200)
    const goals = res.json<Settings>().goals
    expect(goals).toHaveLength(1)
    expect(goals[0]?.targetCents).toBe(700_000)
    expect(goals[0]?.targetDate).toBeNull()
  })

  it('records both sides of the edit', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)
    await send('PATCH', `/api/settings/goals/${created.id}`, { ...BODY, targetCents: 700_000 })

    const entry = auditEntries(ctx.db).find((row) => row.action === 'settings.goal')
    expect(entry?.entityRef).toBe(created.id)
    expect(entry?.beforeJson).toContain('1000000')
    expect(entry?.afterJson).toContain('700000')
  })

  it('is a 404 for an id this tenant does not own', async () => {
    const otherTenant = createSecondTenant(ctx.db, 'Second')
    const theirs = createGoal(ctx.db, otherTenant, { ...BODY, label: 'Theirs' })

    const res = await send('PATCH', `/api/settings/goals/${theirs.id}`, {
      ...BODY,
      targetCents: 1,
    })

    expect(res.statusCode).toBe(404)
    expect(listGoals(ctx.db, otherTenant)[0]?.targetCents).toBe(1_000_000)
  })

  it('is a 404 for an id that never existed', async () => {
    const res = await send('PATCH', '/api/settings/goals/nope', BODY)

    expect(res.statusCode).toBe(404)
  })

  it('refuses a viewer, and leaves the goal as it was', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)

    const res = await send(
      'PATCH',
      `/api/settings/goals/${created.id}`,
      { ...BODY, targetCents: 1 },
      { token: viewer },
    )

    expect(res.statusCode).toBe(403)
    expect(listGoals(ctx.db, tenantId)[0]?.targetCents).toBe(1_000_000)
  })
})

describe('DELETE /api/settings/goals/:id', () => {
  it('removes the goal and answers with the whole payload', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)

    const res = await send('DELETE', `/api/settings/goals/${created.id}`)

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().goals).toEqual([])
    expect(listGoals(ctx.db, tenantId)).toEqual([])
  })

  it('records what was removed, since the row is the only place it existed', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)
    await send('DELETE', `/api/settings/goals/${created.id}`)

    const entry = auditEntries(ctx.db).find((row) => row.action === 'settings.goal')
    expect(entry?.beforeJson).toContain('1000000')
    expect(entry?.afterJson).toBeNull()
  })

  it('is a 404 the second time, rather than pretending to delete again', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)
    await send('DELETE', `/api/settings/goals/${created.id}`)

    const res = await send('DELETE', `/api/settings/goals/${created.id}`)
    expect(res.statusCode).toBe(404)
  })

  it("is a 404 for another tenant's goal, which stays where it is", async () => {
    const otherTenant = createSecondTenant(ctx.db, 'Second')
    const theirs = createGoal(ctx.db, otherTenant, BODY)

    const res = await send('DELETE', `/api/settings/goals/${theirs.id}`)

    expect(res.statusCode).toBe(404)
    expect(listGoals(ctx.db, otherTenant)).toHaveLength(1)
  })

  it('refuses a viewer', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)

    const res = await send('DELETE', `/api/settings/goals/${created.id}`, undefined, {
      token: viewer,
    })

    expect(res.statusCode).toBe(403)
    expect(listGoals(ctx.db, tenantId)).toHaveLength(1)
  })
})

describe('POST /api/settings/goals/:id/done', () => {
  it('marks the goal done and answers with the whole payload', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)

    const res = await send('POST', `/api/settings/goals/${created.id}/done`)

    expect(res.statusCode).toBe(200)
    const goal = res.json<Settings>().goals.find((row) => row.id === created.id)
    expect(goal?.status).toBe('done')
    expect(goal?.doneAt).not.toBeNull()
  })

  it('records both sides of the tick', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)
    await send('POST', `/api/settings/goals/${created.id}/done`)

    const entry = auditEntries(ctx.db).find((row) => row.action === 'settings.goal')
    expect(entry?.entityRef).toBe(created.id)
    expect(entry?.beforeJson).toContain('"status":"active"')
    expect(entry?.afterJson).toContain('"status":"done"')
  })

  it("is a 404 for another tenant's goal, which stays active", async () => {
    const otherTenant = createSecondTenant(ctx.db, 'Second')
    const theirs = createGoal(ctx.db, otherTenant, BODY)

    const res = await send('POST', `/api/settings/goals/${theirs.id}/done`)

    expect(res.statusCode).toBe(404)
    expect(listGoals(ctx.db, otherTenant)[0]?.status).toBe('active')
  })

  it('is a 404 for an id that never existed', async () => {
    const res = await send('POST', '/api/settings/goals/nope/done')
    expect(res.statusCode).toBe(404)
  })

  it('refuses a viewer, and leaves the goal active', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)

    const res = await send('POST', `/api/settings/goals/${created.id}/done`, undefined, {
      token: viewer,
    })

    expect(res.statusCode).toBe(403)
    expect(listGoals(ctx.db, tenantId)[0]?.status).toBe('active')
  })
})

describe('POST /api/settings/goals/:id/reactivate', () => {
  it('reactivates a done goal and answers with the whole payload', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)
    await send('POST', `/api/settings/goals/${created.id}/done`)

    const res = await send('POST', `/api/settings/goals/${created.id}/reactivate`)

    expect(res.statusCode).toBe(200)
    const goal = res.json<Settings>().goals.find((row) => row.id === created.id)
    expect(goal?.status).toBe('active')
    expect(goal?.doneAt).toBeNull()
  })

  it("is a 404 for another tenant's goal", async () => {
    const otherTenant = createSecondTenant(ctx.db, 'Second')
    const theirs = createGoal(ctx.db, otherTenant, BODY)

    const res = await send('POST', `/api/settings/goals/${theirs.id}/reactivate`)

    expect(res.statusCode).toBe(404)
  })

  it('answers 409 once the tenant is back at the cap, leaving the goal done', async () => {
    const done = createGoal(ctx.db, tenantId, { ...BODY, label: 'Goal 0' })
    await send('POST', `/api/settings/goals/${done.id}/done`)
    for (let i = 1; i < MAX_GOALS; i++) {
      createGoal(ctx.db, tenantId, { ...BODY, label: `Goal ${String(i)}` })
    }
    // The freed slot lets a replacement in, back to a full MAX_GOALS active goals.
    createGoal(ctx.db, tenantId, { ...BODY, label: 'Replacement' })

    const res = await send('POST', `/api/settings/goals/${done.id}/reactivate`)

    expect(res.statusCode).toBe(409)
    expect(listGoals(ctx.db, tenantId).find((goal) => goal.id === done.id)?.status).toBe('done')
  })

  it('refuses a viewer', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)
    await send('POST', `/api/settings/goals/${created.id}/done`)

    const res = await send('POST', `/api/settings/goals/${created.id}/reactivate`, undefined, {
      token: viewer,
    })

    expect(res.statusCode).toBe(403)
    expect(listGoals(ctx.db, tenantId)[0]?.status).toBe('done')
  })
})

describe('the settings goal list', () => {
  it('never grace-filters a done goal, however long ago it was ticked', async () => {
    const created = createGoal(ctx.db, tenantId, BODY)
    updateGoal(ctx.db, tenantId, created.id, { ...BODY, status: 'done', doneAt: '2020-01-01' })

    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      cookies: { [SESSION_COOKIE]: owner },
    })

    const goal = res.json<Settings>().goals.find((row) => row.id === created.id)
    expect(goal?.status).toBe('done')
    expect(goal?.doneAt).toBe('2020-01-01')
  })
})
