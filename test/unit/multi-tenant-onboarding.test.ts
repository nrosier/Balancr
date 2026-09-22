/**
 * A second household, provisioned for real (#376 phase 5).
 *
 * Every other multi-tenant test either seeds tenant B through `createSecondTenant`'s
 * direct row insert (`tenant-isolation.test.ts`, `server-refresh.test.ts`) or drives
 * the onboarding routes against a database with no tenant A at all
 * (`routes-onboarding.test.ts`). Neither shows the shape a real second signup takes:
 * an owner who already has a full month of data, and a stranger who lands on
 * `/auth/onboarding/create-tenant` and has to come out the other side with a working
 * session, a settings screen, a refresh button and an insights page — none of it
 * tenant A's.
 *
 * So this one runs the real route. It asserts two things: nothing here throws, and
 * nothing tenant B does is visible to tenant A, in either direction.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify'
import type { Db } from '../../src/db/index.ts'
import { users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { REFRESHABLE, type Job } from '../../src/jobs/index.ts'
import { beginOnboarding } from '../../src/server/auth/onboarding.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, ONBOARDING_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import type { RefreshAccepted, Settings } from '../../src/server/routes/api/schemas.ts'
import { apiFixture } from '../helpers/api-fixture.ts'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let tenantA: string
let ownerA: string
let ran: string[]

/** A signed-in owner on a given tenant, without walking the OIDC flow. */
function signIn(db: Db, tenantId: string): string {
  const row = db
    .insert(users)
    .values({
      tenantId,
      oidcSub: `sub-${crypto.randomUUID()}`,
      email: `owner-${crypto.randomUUID()}@example.test`,
      displayName: 'Owner',
      locale: 'en',
      role: 'owner',
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('inserting the user returned no row')
  return createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined }).token
}

/** Every registered job, faked, recording which ones ran. */
function fakes(): Job[] {
  return REFRESHABLE.map((name) => ({
    name,
    schedule: { kind: 'interval', minutes: 60 } as const,
    run: async () => {
      ran.push(name)
    },
  }))
}

const CSRF = newCsrfToken()

/** A request with the CSRF double-submit already satisfied. */
function send(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  cookies: Record<string, string>,
  payload?: object,
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method,
    url,
    cookies: { ...cookies, [CSRF_COOKIE]: CSRF },
    headers: { [CSRF_HEADER]: CSRF },
    ...(payload === undefined ? {} : { payload }),
  }
  return app.inject(options)
}

const asOwnerA = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  send(method, url, { [SESSION_COOKIE]: ownerA }, payload)

/** Lets a fire-and-forget refresh finish, so the test can see what ran. */
async function waitForJob(): Promise<void> {
  for (let tick = 0; tick < 200 && ran.length === 0; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (ran.length === 0) throw new Error('the fake job never ran')
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(async () => {
  ctx = apiFixture()
  tenantA = getSoleTenantId(ctx.db)
  ownerA = signIn(ctx.db, tenantA)
  ran = []

  // `config.ts` reads the flag once at import time, so a fresh `buildApp` is the
  // only way to see it on — the same pattern `routes-onboarding.test.ts` uses.
  vi.resetModules()
  vi.stubEnv('MULTI_TENANT_ONBOARDING_ENABLED', 'true')
  const { buildApp: freshBuildApp } = await import('../../src/server/app.ts')
  app = await freshBuildApp({ db: ctx.db, web: null, jobs: fakes() })
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('a second household, provisioned through the real route', () => {
  it('onboards, reads, writes and refreshes without throwing or touching tenant A', async () => {
    const insightsABefore = await asOwnerA('GET', '/api/insights')
    expect(insightsABefore.statusCode).toBe(200)
    const settingsABefore = (await asOwnerA('GET', '/api/settings')).json<Settings>()
    const categoryABefore = settingsABefore.benchmark.categories.find(
      (category) => category.categoryId === 'cat-groceries',
    )
    if (categoryABefore === undefined) throw new Error('tenant A has no groceries fixture')

    const token = beginOnboarding(ctx.db, { sub: 'ak-jo', email: 'jo@example.test', name: 'Jo' }).token
    const created = await send(
      'POST',
      '/auth/onboarding/create-tenant',
      { [ONBOARDING_COOKIE]: token },
      { label: 'The Joneses' },
    )
    expect(created.statusCode).toBe(200)

    const sessionB = created.cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value
    if (sessionB === undefined) throw new Error('onboarding did not set a session')
    const { user } = created.json<{ user: { tenantId: string; role: string } }>()
    expect(user.tenantId).not.toBe(tenantA)
    expect(user.role).toBe('owner')

    const asOwnerB = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
      send(method, url, { [SESSION_COOKIE]: sessionB }, payload)

    // Every read a brand-new household hits on its first visit — none of it throws,
    // and none of it is tenant A's numbers.
    for (const url of [
      '/api/settings',
      '/api/budget',
      '/api/overview',
      '/api/portfolio',
      '/api/insights',
      '/api/status',
      '/api/status/history?job=sync',
    ]) {
      const res = await asOwnerB('GET', url)
      expect(res.statusCode).toBe(200)
    }

    const overviewB = await asOwnerB('GET', '/api/overview')
    expect(overviewB.json<{ netWorth: unknown }>().netWorth).toBeNull()

    const insightsB = await asOwnerB('GET', '/api/insights')
    expect(insightsB.json<{ months: string[] }>().months).toEqual([])

    // Tenant A's category ids are not a capability: B neither sees the rows in the
    // settings payload nor reaches any of the four manual mapping writers by guessing
    // one (#409).
    const settingsB = (await asOwnerB('GET', '/api/settings')).json<Settings>()
    expect(settingsB.benchmark.categories).toEqual([])
    for (const [path, payload] of [
      ['coicop', { coicop: '01' }],
      ['custody-shared', { custodyShared: true }],
      ['ai-visibility', { aiVisibility: 'absent' }],
      ['nature', { nature: 'savings' }],
      ['translation/nl', { name: 'Boodschappen' }],
    ] as const) {
      const attempted = await asOwnerB(
        'PATCH',
        `/api/settings/categories/${categoryABefore.categoryId}/${path}`,
        payload,
      )
      expect(attempted.statusCode).toBe(404)
    }

    const categoryAAfter = (await asOwnerA('GET', '/api/settings'))
      .json<Settings>()
      .benchmark.categories.find(
        (category) => category.categoryId === categoryABefore.categoryId,
      )
    expect(categoryAAfter).toEqual(categoryABefore)

    // A settings write for B never touches A's household.
    const patchB = await asOwnerB('PATCH', '/api/settings/household', {
      members: [{ birthYear: 2020 }],
    })
    expect(patchB.statusCode).toBe(200)
    expect(
      patchB.json<{ benchmark: { household: { members: unknown[] } } }>().benchmark.household
        .members,
    ).toHaveLength(1)

    const settingsA = await asOwnerA('GET', '/api/settings')
    expect(
      settingsA.json<{ benchmark: { household: { members: unknown[] } } }>().benchmark.household
        .members,
    ).toHaveLength(0)

    // One job tick, started by B, runs scoped to B — and A's pipeline stays untouched.
    const refreshB = await asOwnerB('POST', '/api/refresh', { jobs: ['sync'] })
    expect(refreshB.statusCode).toBe(202)
    expect(refreshB.json<RefreshAccepted>().accepted).toContain('sync')

    await waitForJob()
    expect(ran).toContain('sync')

    // Tenant A's own numbers are exactly what they were before B ever existed.
    const insightsAAfter = await asOwnerA('GET', '/api/insights')
    expect(insightsAAfter.json()).toEqual(insightsABefore.json())
  })
})
