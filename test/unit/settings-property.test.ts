/**
 * The property route on `/api/settings` (#227, and the read-only category link/
 * comparison spike from #643).
 *
 * `property-properties.test.ts` covers `saveProperties` itself; what is only true at
 * the HTTP layer is here, mirroring `settings-goals.test.ts`'s shape:
 *
 *  - **One route for the whole list.** Unlike goals/loans, there is no per-row
 *    POST/PATCH/DELETE — the form always sends the entire `properties` array.
 *  - **Owner only, and CSRF-gated.**
 *  - **An invalid category link comes back as a 400, field-scoped, and does not
 *    persist.**
 *  - **The response carries `rentComparisonCents`/`paymentComparisonCents`** — null
 *    before anything has synced, a real figure once a `monthlyCategoryFacts` row
 *    exists for the latest stored month.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../../src/db/index.ts'
import { auditLog, categoryMeta, monthlyTotals, scheduleMeta, users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { persistFacts } from '../../src/domain/aggregate/facts.ts'
import type { MonthlyFact } from '../../src/domain/aggregate/spend.ts'
import { loadProperties } from '../../src/domain/property/properties.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import type { ErrorBody } from '../../src/server/errors.ts'
import type { Settings } from '../../src/server/routes/api/schemas.ts'
import { apiFixture } from '../helpers/api-fixture.ts'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string
let viewer: string
let tenantId: string

/** One property with a mortgage, both category links unset. */
const BODY = {
  properties: [
    {
      id: 'home',
      kind: 'primary' as const,
      label: 'Home',
      propertyValueCents: 40_000_000,
      rentCents: null,
      rentCategoryId: null,
      mortgages: [
        {
          principalCents: 20_000_000,
          anchorDate: '2026-01-01',
          rateBp: 350,
          monthlyPaymentCents: 90_000,
          remainingTermMonths: 240,
          originalPrincipalCents: null,
          paymentCategoryId: null,
        },
      ],
    },
  ],
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

function send(url: string, body: object, options: { token?: string; csrf?: boolean } = {}) {
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

const auditEntries = (db: Db) => db.select().from(auditLog).all()

function seedCategory(id: string, overrides: { isIncome?: boolean; hidden?: boolean } = {}): void {
  ctx.db
    .insert(categoryMeta)
    .values({
      tenantId,
      categoryId: id,
      nameSnapshot: id,
      isIncome: overrides.isIncome ?? false,
      hidden: overrides.hidden ?? false,
    })
    .run()
}

function seedSchedule(
  id: string,
  overrides: { categoryId?: string | null; completed?: boolean; amountCents?: number; approximate?: boolean } = {},
): void {
  ctx.db
    .insert(scheduleMeta)
    .values({
      tenantId,
      scheduleId: id,
      label: id,
      categoryId: overrides.categoryId ?? null,
      amountCents: overrides.amountCents ?? -90_000,
      approximate: overrides.approximate ?? false,
      completed: overrides.completed ?? false,
    })
    .run()
}

function fact(month: string, id: string, overrides: Partial<MonthlyFact> = {}): MonthlyFact {
  return {
    month,
    categoryId: id,
    categoryName: id,
    isIncome: false,
    hidden: false,
    spentCents: 0,
    budgetedCents: 0,
    availableCents: 0,
    carryoverEnabled: false,
    txnCount: 0,
    recomputedSpentCents: 0,
    committedCents: 0,
    committedToDateCents: 0,
    committedApproximate: false,
    baseline: null,
    dayCurve: null,
    ...overrides,
  }
}

/** Stands in for a synced month: `latestStoredMonth` reads `monthlyTotals`, not the facts table. */
function markMonthStored(month: string): void {
  ctx.db.insert(monthlyTotals).values({ tenantId, month }).run()
}

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

describe('PATCH /api/settings/property', () => {
  it('saves the list and answers with the whole payload', async () => {
    const res = await send('/api/settings/property', BODY)

    expect(res.statusCode).toBe(200)
    const settings = res.json<Settings>()
    expect(settings.property.properties).toHaveLength(1)
    expect(settings.property.properties[0]?.label).toBe('Home')
    expect(settings.goals).toBeDefined()
  })

  it('records an audit entry', async () => {
    await send('/api/settings/property', BODY)

    const entry = auditEntries(ctx.db).find((row) => row.action === 'settings.property')
    expect(entry?.entity).toBe('settings')
    expect(entry?.afterJson).toContain('"home"')
  })

  it('refuses a viewer, and writes nothing', async () => {
    const res = await send('/api/settings/property', BODY, { token: viewer })

    expect(res.statusCode).toBe(403)
    expect(loadProperties(ctx.db, tenantId).properties).toEqual([])
  })

  it('refuses a write with no CSRF token', async () => {
    const res = await send('/api/settings/property', BODY, { csrf: false })

    expect(res.statusCode).toBe(403)
    expect(loadProperties(ctx.db, tenantId).properties).toEqual([])
  })

  it('accepts kind "owned", not just "primary"/"rental" (#658)', async () => {
    const res = await send('/api/settings/property', {
      properties: [{ ...BODY.properties[0], kind: 'owned' as const }],
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().property.properties[0]?.kind).toBe('owned')
  })

  it('round-trips a valid rent category link', async () => {
    seedCategory('cat-rent', { isIncome: true })
    const res = await send('/api/settings/property', {
      properties: [
        { ...BODY.properties[0], kind: 'rental' as const, rentCents: 90_000, rentCategoryId: 'cat-rent' },
      ],
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().property.properties[0]?.rentCategoryId).toBe('cat-rent')
  })

  it('round-trips a valid payment category link', async () => {
    seedCategory('cat-mortgage', { isIncome: false })
    const res = await send('/api/settings/property', {
      properties: [
        {
          ...BODY.properties[0],
          mortgages: [{ ...BODY.properties[0]!.mortgages[0]!, paymentCategoryId: 'cat-mortgage' }],
        },
      ],
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().property.properties[0]?.mortgages[0]?.paymentCategoryId).toBe(
      'cat-mortgage',
    )
  })

  it('names the field for an unknown category link, as a 400, and does not persist', async () => {
    const res = await send('/api/settings/property', {
      properties: [
        { ...BODY.properties[0], kind: 'rental' as const, rentCents: 90_000, rentCategoryId: 'nope' },
      ],
    })

    expect(res.statusCode).toBe(400)
    const issues = res.json<ErrorBody>().error.issues ?? []
    expect(issues.map((issue) => issue.path)).toContain('rentCategoryId')
    expect(loadProperties(ctx.db, tenantId).properties).toEqual([])
  })

  it('names the field for a category link in the wrong direction, as a 400', async () => {
    // 'cat-groceries' already exists as a non-income category, courtesy of `apiFixture()`.
    const res = await send('/api/settings/property', {
      properties: [
        {
          ...BODY.properties[0],
          kind: 'rental' as const,
          rentCents: 90_000,
          rentCategoryId: 'cat-groceries',
        },
      ],
    })

    expect(res.statusCode).toBe(400)
    const issues = res.json<ErrorBody>().error.issues ?? []
    expect(issues.map((issue) => issue.path)).toContain('rentCategoryId')
  })

  it('names the field for a hidden category link, even though the direction matches', async () => {
    seedCategory('cat-mortgage', { isIncome: false, hidden: true })
    const res = await send('/api/settings/property', {
      properties: [
        {
          ...BODY.properties[0],
          mortgages: [{ ...BODY.properties[0]!.mortgages[0]!, paymentCategoryId: 'cat-mortgage' }],
        },
      ],
    })

    expect(res.statusCode).toBe(400)
    const issues = res.json<ErrorBody>().error.issues ?? []
    expect(issues.map((issue) => issue.path)).toContain('paymentCategoryId')
  })

  it('round-trips a valid rent schedule link, with its cached label/amount surfacing (#662)', async () => {
    seedCategory('cat-rent', { isIncome: true })
    seedSchedule('sch-rent', { categoryId: 'cat-rent', amountCents: -90_000 })
    const res = await send('/api/settings/property', {
      properties: [
        { ...BODY.properties[0], kind: 'rental' as const, rentCents: 90_000, rentScheduleId: 'sch-rent' },
      ],
    })

    expect(res.statusCode).toBe(200)
    const property = res.json<Settings>().property.properties[0]
    expect(property?.rentScheduleId).toBe('sch-rent')
    expect(property?.rentScheduleAmountCents).toBe(90_000)
    expect(property?.rentScheduleApproximate).toBe(false)
  })

  it('round-trips a valid payment schedule link', async () => {
    seedCategory('cat-mortgage', { isIncome: false })
    seedSchedule('sch-mortgage', { categoryId: 'cat-mortgage', amountCents: -95_000, approximate: true })
    const res = await send('/api/settings/property', {
      properties: [
        {
          ...BODY.properties[0],
          mortgages: [{ ...BODY.properties[0]!.mortgages[0]!, paymentScheduleId: 'sch-mortgage' }],
        },
      ],
    })

    expect(res.statusCode).toBe(200)
    const mortgage = res.json<Settings>().property.properties[0]?.mortgages[0]
    expect(mortgage?.paymentScheduleId).toBe('sch-mortgage')
    expect(mortgage?.paymentScheduleAmountCents).toBe(95_000)
    expect(mortgage?.paymentScheduleApproximate).toBe(true)
  })

  it('names the field for an unknown schedule link, as a 400, and does not persist', async () => {
    const res = await send('/api/settings/property', {
      properties: [
        { ...BODY.properties[0], kind: 'rental' as const, rentCents: 90_000, rentScheduleId: 'nope' },
      ],
    })

    expect(res.statusCode).toBe(400)
    const issues = res.json<ErrorBody>().error.issues ?? []
    expect(issues.map((issue) => issue.path)).toContain('rentScheduleId')
    expect(loadProperties(ctx.db, tenantId).properties).toEqual([])
  })

  it('names the field for a completed schedule link, as a 400', async () => {
    seedSchedule('sch-mortgage', { completed: true })
    const res = await send('/api/settings/property', {
      properties: [
        {
          ...BODY.properties[0],
          mortgages: [{ ...BODY.properties[0]!.mortgages[0]!, paymentScheduleId: 'sch-mortgage' }],
        },
      ],
    })

    expect(res.statusCode).toBe(400)
    const issues = res.json<ErrorBody>().error.issues ?? []
    expect(issues.map((issue) => issue.path)).toContain('paymentScheduleId')
  })

  it('names the field for a schedule whose own category is in the wrong direction', async () => {
    // 'cat-groceries' already exists as a non-income category, courtesy of `apiFixture()`.
    seedSchedule('sch-rent', { categoryId: 'cat-groceries' })
    const res = await send('/api/settings/property', {
      properties: [
        { ...BODY.properties[0], kind: 'rental' as const, rentCents: 90_000, rentScheduleId: 'sch-rent' },
      ],
    })

    expect(res.statusCode).toBe(400)
    const issues = res.json<ErrorBody>().error.issues ?? []
    expect(issues.map((issue) => issue.path)).toContain('rentScheduleId')
  })
})

describe('GET /api/settings — the property comparison figures (#643)', () => {
  const getSettings = async (): Promise<Settings> => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      cookies: { [SESSION_COOKIE]: owner },
    })
    return res.json<Settings>()
  }

  it('is null when the linked category has no fact row for the latest stored month', async () => {
    // `apiFixture()` already seeds a monthlyTotals row (2026-08), so a stored month
    // always exists here — the missing piece under test is the fact row itself.
    seedCategory('cat-rent', { isIncome: true })
    await send('/api/settings/property', {
      properties: [
        { ...BODY.properties[0], kind: 'rental' as const, rentCents: 90_000, rentCategoryId: 'cat-rent' },
      ],
    })

    const property = (await getSettings()).property.properties[0]
    expect(property?.rentComparisonCents).toBeNull()
  })

  it('is null when no category is linked, even with facts on file', async () => {
    await send('/api/settings/property', BODY)

    const property = (await getSettings()).property.properties[0]
    expect(property?.rentComparisonCents).toBeNull()
    expect(property?.mortgages[0]?.paymentComparisonCents).toBeNull()
  })

  it('is the real figure once a fact row exists for the latest stored month', async () => {
    // Later than the fixture's own 2026-08 monthlyTotals row, so this month wins as "latest".
    const month = '2026-09'
    seedCategory('cat-rent', { isIncome: true })
    seedCategory('cat-mortgage', { isIncome: false })
    markMonthStored(month)
    persistFacts(
      ctx.db,
      tenantId,
      [
        fact(month, 'cat-rent', { spentCents: 95_000 }),
        fact(month, 'cat-mortgage', { spentCents: 88_000 }),
      ],
      [month],
    )

    await send('/api/settings/property', {
      properties: [
        {
          ...BODY.properties[0],
          kind: 'rental' as const,
          rentCents: 90_000,
          rentCategoryId: 'cat-rent',
          mortgages: [{ ...BODY.properties[0]!.mortgages[0]!, paymentCategoryId: 'cat-mortgage' }],
        },
      ],
    })

    const property = (await getSettings()).property.properties[0]
    expect(property?.rentComparisonCents).toBe(95_000)
    expect(property?.mortgages[0]?.paymentComparisonCents).toBe(88_000)
  })

  it('sources the comparison from a linked schedule\'s own category, not a separately-set one (#662)', async () => {
    const month = '2026-09'
    seedCategory('cat-rent', { isIncome: true })
    seedCategory('cat-sublet', { isIncome: true })
    seedSchedule('sch-rent', { categoryId: 'cat-sublet' })
    markMonthStored(month)
    persistFacts(
      ctx.db,
      tenantId,
      [fact(month, 'cat-rent', { spentCents: 95_000 }), fact(month, 'cat-sublet', { spentCents: 88_000 })],
      [month],
    )

    await send('/api/settings/property', {
      properties: [
        {
          ...BODY.properties[0],
          kind: 'rental' as const,
          rentCents: 90_000,
          rentCategoryId: 'cat-rent',
          rentScheduleId: 'sch-rent',
        },
      ],
    })

    const property = (await getSettings()).property.properties[0]
    expect(property?.rentComparisonCents).toBe(88_000)
  })
})
