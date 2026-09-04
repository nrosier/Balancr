/**
 * The settings surface — the one part of the API that writes.
 *
 * Four claims are load-bearing here, and none of them is "the form works":
 *
 *  - **A patch changes only what it mentions.** The thresholds are one JSON blob
 *    behind a schema full of `.default()`s, and a validator that filled in the
 *    fields a request omitted would quietly reset every slider the screen did not
 *    show. That is silent: nothing errors, the next aggregation pass simply uses
 *    different numbers than the ones on screen.
 *  - **A misspelt field is refused rather than dropped.** The domain schema strips
 *    unknown keys, which is right for reading a row written by an older version and
 *    wrong for a form — it would answer 200 with a payload that looks saved.
 *  - **Owner and viewer are not the same.** A viewer may change their own language
 *    and nothing else; the distinction is decorative if any of the other writes go
 *    through.
 *  - **Every write answers with the whole payload.** It is what lets the screen
 *    replace its state instead of patching a copy field by field, and it is only
 *    true if every handler actually does it.
 *
 * The prompt tests are about versioning rather than editing: storing a version must
 * never overwrite one, because the text that produced last month's findings is the
 * only explanation of them that exists.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Db } from '../../src/db/index.ts'
import type { ErrorBody } from '../../src/server/errors.ts'
import { auditLog, users } from '../../src/db/schema.ts'
import { loadProfile, PROFILE_PRESETS } from '../../src/domain/advice/profile.ts'
import { loadHousehold } from '../../src/domain/benchmark/household.ts'
import { loadMapping } from '../../src/domain/benchmark/mapping.ts'
import { loadAccountMap } from '../../src/domain/aggregate/accounts.ts'
import { DEFAULT_PARAMS, loadParams, saveParams } from '../../src/domain/aggregate/params.ts'
import { SHARED_LOCALE } from '../../src/domain/ai/prompt-locale.ts'
import { createPromptVersion, loadActivePrompt, resolvePrompt } from '../../src/domain/ai/prompts.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, LOCALE_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import type { Settings } from '../../src/server/routes/api/schemas.ts'
import { apiFixture } from '../helpers/api-fixture.ts'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string
let viewer: string

function signIn(db: Db, role: 'owner' | 'viewer', locale = 'en'): string {
  const row = db
    .insert(users)
    .values({
      oidcSub: `sub-${crypto.randomUUID()}`,
      email: `${role}@example.test`,
      displayName: role === 'owner' ? 'Nick' : 'Guest',
      locale,
      role,
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('inserting the user returned no row')
  return createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined })
    .token
}

const get = (url: string, token = owner) =>
  app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: token } })

/** A write that satisfies CSRF unless the test asks for it not to. */
function send(
  method: 'PATCH' | 'POST',
  url: string,
  body: object = {},
  options: { token?: string; csrf?: boolean } = {},
) {
  const csrf = newCsrfToken()
  return app.inject({
    method,
    url,
    payload: body,
    cookies: {
      [SESSION_COOKIE]: options.token ?? owner,
      ...(options.csrf === false ? {} : { [CSRF_COOKIE]: csrf }),
    },
    headers: options.csrf === false ? {} : { [CSRF_HEADER]: csrf },
  })
}

const patch = (url: string, body: object, options?: { token?: string; csrf?: boolean }) =>
  send('PATCH', url, body, options)
const post = (url: string, body: object = {}, options?: { token?: string; csrf?: boolean }) =>
  send('POST', url, body, options)

/** The audit actions written, most recent first. */
const auditActions = (db: Db): string[] =>
  db
    .select({ action: auditLog.action })
    .from(auditLog)
    .all()
    .map((row) => row.action)

const accountIds = (): string[] => loadAccountMap(ctx.db).map((row) => row.id)

beforeAll(async () => {
  await initI18n()
})

beforeEach(async () => {
  ctx = apiFixture()
  app = await buildApp({ db: ctx.db, web: null })
  owner = signIn(ctx.db, 'owner')
  viewer = signIn(ctx.db, 'viewer')
})

afterEach(async () => {
  await app.close()
  ctx.sqlite.close()
})

describe('the guard', () => {
  it('refuses the settings payload without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' })
    expect(res.statusCode).toBe(401)
  })

  it('refuses a write with no CSRF token', async () => {
    // The settings page is the one that writes, so it is the one that would break
    // if these routes had been added outside the CSRF hook's reach.
    const res = await patch('/api/settings/params', { baseline: { windowMonths: 6 } }, {
      csrf: false,
    })
    expect(res.statusCode).toBe(403)
    expect(res.json<{ error: { message: string } }>().error.message).toContain('CSRF')
  })
})

describe('GET /api/settings', () => {
  it('describes the deployment, its parameters and its accounts', async () => {
    const res = await get('/api/settings')
    expect(res.statusCode).toBe(200)

    const settings = res.json<Settings>()
    expect(settings.build.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(settings.profile.role).toBe('owner')
    expect(settings.locales.supported).toContain('nl')
    expect(settings.params).toEqual(DEFAULT_PARAMS)
    expect(settings.paramDefaults).toEqual(DEFAULT_PARAMS)
    expect(settings.accounts).toHaveLength(3)
    expect(settings.ai.models.fast.length).toBeGreaterThan(0)
    // The two controls that spend money read this rather than discovering the
    // refusal by pressing: the analysis rerun and the prompt editor's test run (#165).
    expect(settings.ai.availability).toEqual({ enabled: true, reason: null })
  })

  it('lists one shared prompt per key, with the text it is really using', async () => {
    const settings = (await get('/api/settings')).json<Settings>()

    // One entry per key, not one per key per locale. A language appears only when
    // someone has written an override for it, so an entry under a language code is a
    // divergence rather than a copy of the seed.
    expect(settings.prompts).toHaveLength(2)
    expect(settings.prompts.map((prompt) => prompt.locale)).toEqual([
      SHARED_LOCALE,
      SHARED_LOCALE,
    ])
    for (const prompt of settings.prompts) {
      expect(prompt.active.body.length).toBeGreaterThan(0)
    }
  })

  it('lists a language override alongside the shared prompt, once one exists', async () => {
    createPromptVersion(ctx.db, {
      key: 'analysis.system',
      locale: 'nl',
      body: 'Je rangschikt signalen.',
      activate: true,
    })

    const settings = (await get('/api/settings')).json<Settings>()

    expect(settings.prompts).toHaveLength(3)
    const override = settings.prompts.find((prompt) => prompt.locale === 'nl')
    expect(override?.key).toBe('analysis.system')
    expect(override?.active.body).toBe('Je rangschikt signalen.')
    // And the shared entry still reads as the shared text, not as the override.
    const shared = settings.prompts.find(
      (prompt) => prompt.key === 'analysis.system' && prompt.locale === SHARED_LOCALE,
    )
    expect(shared?.active.body).not.toBe('Je rangschikt signalen.')
  })

  it('does not put a prompt body in the version list, or an external id in an account', async () => {
    createPromptVersion(ctx.db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'You rank signals.\nNothing else.',
      activate: true,
    })

    const settings = (await get('/api/settings')).json<Settings>()
    const english = settings.prompts.find(
      (p) => p.key === 'analysis.system' && p.locale === 'en',
    )
    const version = english?.versions[0]
    expect(version?.chars).toBe('You rank signals.\nNothing else.'.length)
    // The list is a history, not four copies of a kilobyte of text; the body comes
    // from `/api/settings/prompts/:id` when someone opens one.
    expect(version).not.toHaveProperty('body')

    // The account row's own identifier in Actual or Ghostfolio is of no use to the
    // screen and is one more thing the browser would be holding.
    expect(settings.accounts[0]).not.toHaveProperty('externalId')
  })

  it('is readable by a viewer', async () => {
    const res = await get('/api/settings', viewer)
    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().profile.role).toBe('viewer')
  })
})

describe('PATCH /api/settings/params', () => {
  it('changes only the fields the patch mentions', async () => {
    // The trap this exists for: a patch schema built out of `.partial()` still
    // applies the inner `.default()`s, so a request naming one group would come
    // back with every other group reset to the shipped numbers — with no error.
    saveParams(ctx.db, { overspend: { baselineWarnBp: 3_000 } })

    const res = await patch('/api/settings/params', { baseline: { windowMonths: 6 } })
    expect(res.statusCode).toBe(200)

    const params = res.json<Settings>().params
    expect(params.baseline.windowMonths).toBe(6)
    expect(params.overspend.baselineWarnBp).toBe(3_000)
    expect(params.baseline.halfLifeMonths).toBe(DEFAULT_PARAMS.baseline.halfLifeMonths)
    expect(loadParams(ctx.db).overspend.baselineWarnBp).toBe(3_000)
  })

  it('refuses a field name it does not know instead of dropping it', async () => {
    const res = await patch('/api/settings/params', { baseline: { windowMonth: 6 } })
    expect(res.statusCode).toBe(400)
    // Named, because the form has twenty numbers in it and "not valid" points at
    // none of them.
    expect(res.json<ErrorBody>().error.issues).toEqual([
      { path: 'baseline.windowMonth', message: 'Unknown field.' },
    ])
    expect(loadParams(ctx.db)).toEqual(DEFAULT_PARAMS)
  })

  it('refuses a value outside the range the aggregation can use', async () => {
    const res = await patch('/api/settings/params', { baseline: { windowMonths: 1 } })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues?.[0]?.path).toBe('baseline.windowMonths')
  })

  it('refuses two thresholds in the wrong order, and says which', async () => {
    // A cross-field rule, so it can only be checked after the merge — the failure
    // that would otherwise arrive as a 500 about someone else's mistake.
    const res = await patch('/api/settings/params', { overspend: { baselineWarnBp: 9_000 } })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues).toEqual([
      {
        path: 'overspend.baselineWarnBp',
        message: 'baselineWarnBp must not exceed baselineAlertBp',
      },
    ])
  })

  it('refuses an unknown group', async () => {
    const res = await patch('/api/settings/params', { madeUp: { x: 1 } })
    expect(res.statusCode).toBe(400)
  })

  it('records only the groups that changed', async () => {
    await patch('/api/settings/params', { household: { savingsRateTargetBp: 2_000 } })

    const entry = ctx.db.select().from(auditLog).all().at(-1)
    expect(entry?.action).toBe('settings.params')
    expect(Object.keys(JSON.parse(entry?.afterJson ?? '{}'))).toEqual(['household'])
    expect(JSON.parse(entry?.beforeJson ?? '{}').household.savingsRateTargetBp).toBe(
      DEFAULT_PARAMS.household.savingsRateTargetBp,
    )
  })

  it('is refused for a viewer', async () => {
    const res = await patch('/api/settings/params', { baseline: { windowMonths: 6 } }, {
      token: viewer,
    })
    expect(res.statusCode).toBe(403)
    expect(loadParams(ctx.db)).toEqual(DEFAULT_PARAMS)
  })
})

describe('PATCH /api/settings/household', () => {
  const send_ = (body: object, options?: { token?: string }) =>
    patch('/api/settings/household', body, options)

  it('stores a stated share and answers with it', async () => {
    // 50% of the time, 60% of the costs: the two are separate facts, and this endpoint is
    // the only place the second one can be said (#44).
    const res = await send_({
      members: [{ birthYear: 2013, custodyBp: 5_000 }],
      sharedCostBp: 6_000,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().benchmark.household.sharedCostBp).toBe(6_000)
    expect(loadHousehold(ctx.db).sharedCostBp).toBe(6_000)
  })

  it('stores a name for the first person and answers with it (#215)', async () => {
    const res = await send_({ members: [], selfLabel: 'Nick' })

    expect(res.json<Settings>().benchmark.household.selfLabel).toBe('Nick')
    expect(loadHousehold(ctx.db).selfLabel).toBe('Nick')
  })

  it('drops the first person\'s name when a later patch omits it, like the roster it travels with', async () => {
    await send_({ members: [], selfLabel: 'Nick' })
    const res = await send_({ members: [] })

    expect(res.json<Settings>().benchmark.household.selfLabel).toBeUndefined()
    expect(loadHousehold(ctx.db).selfLabel).toBeUndefined()
  })

  it('takes null as "derive it from the roster again"', async () => {
    await send_({ members: [{ birthYear: 2013, custodyBp: 5_000 }], sharedCostBp: 6_000 })
    const res = await send_({ members: [{ birthYear: 2013, custodyBp: 5_000 }], sharedCostBp: null })

    expect(res.json<Settings>().benchmark.household.sharedCostBp).toBeNull()
    expect(loadHousehold(ctx.db).sharedCostBp).toBeNull()
  })

  it('drops a stated share when the patch omits it, like the roster it travels with', async () => {
    // The household is one row written wholesale. The safe direction: a stated share
    // surviving a roster edit invisibly is how somebody reads a split they had removed.
    await send_({ members: [], sharedCostBp: 6_000 })
    await send_({ members: [{ birthYear: 2013, custodyBp: 5_000 }] })
    expect(loadHousehold(ctx.db).sharedCostBp).toBeNull()
  })

  it('refuses a share outside 0–100%, naming the field', async () => {
    const res = await send_({ members: [], sharedCostBp: 12_000 })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues?.map((issue) => issue.path)).toEqual([
      'sharedCostBp',
    ])
    expect(loadHousehold(ctx.db).sharedCostBp).toBeNull()
  })

  it('is refused for a viewer', async () => {
    const res = await send_({ members: [], sharedCostBp: 6_000 }, { token: viewer })
    expect(res.statusCode).toBe(403)
    expect(loadHousehold(ctx.db).sharedCostBp).toBeNull()
  })
})

describe('PATCH /api/settings/categories/:id/custody-shared', () => {
  const send_ = (id: string, body: object, options?: { token?: string }) =>
    patch(`/api/settings/categories/${id}/custody-shared`, body, options)

  const flagOf = (id: string): boolean | undefined =>
    loadMapping(ctx.db, null).find((row) => row.categoryId === id)?.custodyShared

  it('flags a category as shared, and answers with the list saying so (#44)', async () => {
    // The point of the route: before it, this column had no writer a person could reach
    // without a Gemini key, which made the shared-cost split the one thing on the budget
    // page that an installation with no AI could never switch on.
    const res = await send_('cat-groceries', { custodyShared: true })

    expect(res.statusCode).toBe(200)
    const row = res
      .json<Settings>()
      .benchmark.categories.find((category) => category.categoryId === 'cat-groceries')
    expect(row?.custodyShared).toBe(true)
    expect(flagOf('cat-groceries')).toBe(true)
  })

  it('takes the flag back, which is the correction people actually make', async () => {
    await send_('cat-groceries', { custodyShared: true })
    const res = await send_('cat-groceries', { custodyShared: false })

    expect(res.statusCode).toBe(200)
    expect(flagOf('cat-groceries')).toBe(false)
  })

  it('records the change against the category, not against settings', async () => {
    // `category_meta` is the table the row lands in and the AI path already writes there
    // through `proposal.apply`, so a category's history reads as one list whether the flag
    // came from an approved proposal or from a checkbox.
    await send_('cat-groceries', { custodyShared: true })
    expect(auditActions(ctx.db)).toContain('settings.custodyShared')
  })

  it('accepts the flag on an income category rather than refusing it', async () => {
    // The split ignores income and hidden categories, so this stores something inert —
    // deliberately. A route that refused would also refuse to let a flag be *removed*
    // from a category hidden after it was set. The form closes the box instead.
    const res = await send_('cat-salary', { custodyShared: true })
    expect(res.statusCode).toBe(200)
    expect(flagOf('cat-salary')).toBe(true)
  })

  it('refuses a body that is not a boolean, and one that is empty', async () => {
    expect((await send_('cat-groceries', { custodyShared: 'yes' })).statusCode).toBe(400)
    expect((await send_('cat-groceries', {})).statusCode).toBe(400)
    expect(flagOf('cat-groceries')).toBe(false)
  })

  it('answers 404 for a category Balancr has never seen', async () => {
    // Never an insert: `category_meta` rows come from what Actual actually has, and a row
    // conjured here would be a category that exists only in Balancr.
    const res = await send_('cat-invented', { custodyShared: true })
    expect(res.statusCode).toBe(404)
  })

  it('is refused for a viewer', async () => {
    const res = await send_('cat-groceries', { custodyShared: true }, { token: viewer })
    expect(res.statusCode).toBe(403)
    expect(flagOf('cat-groceries')).toBe(false)
  })
})

describe('PATCH /api/settings/advice', () => {
  it('publishes the bands in force and every preset to choose from', async () => {
    // The presets travel on the wire because `PROFILE_PRESETS` lives on this side: the
    // settings screen offers three named choices and shows their numbers, and it cannot
    // import them. A default install is `balanced`, unedited.
    const advice = (await get('/api/settings')).json<Settings>().advice

    expect(advice.profile).toBe('balanced')
    expect(advice.isPreset).toBe(true)
    expect(advice.bands).toEqual(PROFILE_PRESETS.balanced)
    expect(advice.presets).toEqual(PROFILE_PRESETS)
    expect(advice.toleranceBp).toBe(100)
    expect(advice.minTradeCents).toBe(50_000)
  })

  it('takes a named preset and drops any bands that were stored', async () => {
    await patch('/api/settings/advice', { bands: PROFILE_PRESETS.growth, profile: 'custom' })

    const res = await patch('/api/settings/advice', { profile: 'defensive' })
    expect(res.statusCode).toBe(200)

    const advice = res.json<Settings>().advice
    expect(advice.profile).toBe('defensive')
    expect(advice.isPreset).toBe(true)
    expect(advice.bands).toEqual(PROFILE_PRESETS.defensive)
    // Picking a preset has to mean picking its numbers. Bands left behind would make
    // the screen say "defensive" over somebody else's allocation.
    expect(loadProfile(ctx.db).bands).toBeUndefined()
  })

  it('turns an edited preset into a custom profile rather than relabelling it', async () => {
    const edited = {
      ...PROFILE_PRESETS.balanced,
      EQUITY: { minBp: 6_000, targetBp: 7_000, maxBp: 8_000 },
      FIXED_INCOME: { minBp: 1_500, targetBp: 2_500, maxBp: 3_500 },
    }

    const res = await patch('/api/settings/advice', { bands: edited })
    expect(res.statusCode).toBe(200)

    const advice = res.json<Settings>().advice
    expect(advice.profile).toBe('custom')
    expect(advice.isPreset).toBe(false)
    expect(advice.bands).toEqual(edited)
  })

  it('refuses targets that do not add up, and names the field', async () => {
    const res = await patch('/api/settings/advice', {
      bands: { ...PROFILE_PRESETS.balanced, COMMODITY: { minBp: 0, targetBp: 1_000, maxBp: 2_000 } },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues).toEqual([
      { path: 'bands', message: 'targets add up to 110.00% instead of 100%' },
    ])
    expect(loadProfile(ctx.db).bands).toBeUndefined()
  })

  it('refuses a target outside its own band', async () => {
    const res = await patch('/api/settings/advice', {
      bands: { ...PROFILE_PRESETS.balanced, EQUITY: { minBp: 7_000, targetBp: 6_500, maxBp: 7_500 } },
    })

    expect(res.statusCode).toBe(400)
    // The class, not just `bands`: fourteen numbers on screen and one of them is wrong.
    expect(res.json<ErrorBody>().error.issues?.[0]?.path).toBe('bands.EQUITY')
  })

  it('refuses a patch carrying one band instead of all four', async () => {
    // The state this refusal exists for: three bands from the previous profile beside
    // one new one, four targets that no longer sum to 100%, and a set of suggestions
    // that contradict each other. Bands are replaced wholesale or not at all.
    const res = await patch('/api/settings/advice', {
      bands: { EQUITY: { minBp: 6_000, targetBp: 7_000, maxBp: 8_000 } },
    })

    expect(res.statusCode).toBe(400)
    expect(loadProfile(ctx.db).bands).toBeUndefined()
  })

  it('changes the thresholds without touching the bands', async () => {
    const res = await patch('/api/settings/advice', { toleranceBp: 250, minTradeCents: 100_000 })
    expect(res.statusCode).toBe(200)

    const advice = res.json<Settings>().advice
    expect(advice.toleranceBp).toBe(250)
    expect(advice.minTradeCents).toBe(100_000)
    expect(advice.profile).toBe('balanced')
    expect(advice.bands).toEqual(PROFILE_PRESETS.balanced)
  })

  it('records the whole profile on both sides of the change', async () => {
    await patch('/api/settings/advice', { profile: 'growth' })

    const entry = ctx.db.select().from(auditLog).all().at(-1)
    expect(entry?.action).toBe('settings.advice')
    // "What were the bands when that advice was given" needs all of them, so the entry
    // carries the profile rather than the touched fields.
    expect(JSON.parse(entry?.beforeJson ?? '{}').profile).toBe('balanced')
    expect(JSON.parse(entry?.afterJson ?? '{}').profile).toBe('growth')
  })

  it('refuses a field name it does not know', async () => {
    const res = await patch('/api/settings/advice', { tolerance: 250 })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues).toEqual([
      { path: 'tolerance', message: 'Unknown field.' },
    ])
  })

  it('is refused for a viewer', async () => {
    const res = await patch('/api/settings/advice', { profile: 'growth' }, { token: viewer })
    expect(res.statusCode).toBe(403)
    expect(loadProfile(ctx.db).profile).toBe('balanced')
  })
})

describe('PATCH /api/settings/profile', () => {
  it('changes the language and answers in terms of the new one', async () => {
    const res = await patch('/api/settings/profile', { locale: 'nl' })
    expect(res.statusCode).toBe(200)
    // Built after the write, not before: the page would otherwise render the
    // language it just left and need a reload to agree with the server.
    expect(res.json<Settings>().profile.locale).toBe('nl')
  })

  it('is the one write a viewer may make', async () => {
    const res = await patch('/api/settings/profile', { locale: 'nl' }, { token: viewer })
    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().profile.locale).toBe('nl')
    expect(auditActions(ctx.db)).toContain('settings.locale')
  })

  it('moves the locale cookie with the column', async () => {
    // The cookie is what the shell reads on the next full load. Left behind, it would
    // put `<html lang="en">` on a document whose every string is Dutch — and the page
    // would look right, so nothing would ever point at it.
    const res = await patch('/api/settings/profile', { locale: 'nl' })
    const set = res.cookies.find((cookie) => cookie.name === LOCALE_COOKIE)
    expect(set?.value).toBe('nl')
    expect(set?.httpOnly).toBe(true)
  })

  it('refuses a locale the deployment does not serve', async () => {
    const res = await patch('/api/settings/profile', { locale: 'fr' })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a role change dressed up as a profile change', async () => {
    // `strictObject`, so the field does not have to be ignored — it is rejected,
    // and a viewer cannot promote themselves on a page every viewer can open.
    const res = await patch('/api/settings/profile', { locale: 'nl', role: 'owner' }, {
      token: viewer,
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('the account mapping', () => {
  it('changes what an account contributes, and answers with the whole payload', async () => {
    const id = accountIds()[0] ?? ''
    const res = await patch(`/api/settings/accounts/${id}`, {
      kind: 'savings',
      includeInNetWorth: false,
    })
    expect(res.statusCode).toBe(200)

    const settings = res.json<Settings>()
    const account = settings.accounts.find((row) => row.id === id)
    expect(account?.kind).toBe('savings')
    expect(account?.includeInNetWorth).toBe(false)
    // The screen has to be able to say *why* a value reads the way it does, because
    // "a rule guessed this" and "you set this" invite different actions from the
    // reader — and #124's classifier will only overwrite the former.
    expect(account?.decidedFields.sort()).toEqual(['includeInNetWorth', 'kind'])
    // The whole payload, so the screen replaces its state rather than patching it.
    expect(settings.params).toEqual(DEFAULT_PARAMS)
    expect(settings.prompts).toHaveLength(2)
    expect(auditActions(ctx.db)).toContain('account.map')
  })

  it('groups two accounts and leaves exactly one of them the truth', async () => {
    // The dedupe rule the net-worth figure depends on: the same money in Actual and
    // in Ghostfolio counted twice is wrong in the flattering direction.
    const [first, second] = accountIds()
    const res = await post('/api/settings/accounts/group', {
      accountMapIds: [first, second],
      sourceOfTruthId: second,
    })
    expect(res.statusCode).toBe(200)

    const grouped = res.json<Settings>().accounts.filter((row) => row.dedupeGroup !== null)
    expect(grouped).toHaveLength(2)
    for (const row of grouped) {
      expect(row.decidedFields.sort()).toEqual(['dedupeGroup', 'isSourceOfTruth'])
    }
    expect(grouped.filter((row) => row.isSourceOfTruth)).toHaveLength(1)
    expect(grouped.find((row) => row.isSourceOfTruth)?.id).toBe(second)
    // One entry per account touched, because the change is to both rows.
    expect(auditActions(ctx.db).filter((action) => action === 'account.map')).toHaveLength(2)
  })

  it('moves the truth within a group without leaving two of them', async () => {
    const [first, second] = accountIds()
    await post('/api/settings/accounts/group', {
      accountMapIds: [first, second],
      sourceOfTruthId: second,
    })

    const res = await post(`/api/settings/accounts/${first}/source-of-truth`)
    expect(res.statusCode).toBe(200)

    const accounts = res.json<Settings>().accounts
    expect(accounts.find((row) => row.id === first)?.isSourceOfTruth).toBe(true)
    expect(accounts.find((row) => row.id === second)?.isSourceOfTruth).toBe(false)
  })

  it('takes an account back out of a group and lets it count for itself', async () => {
    const [first, second] = accountIds()
    await post('/api/settings/accounts/group', {
      accountMapIds: [first, second],
      sourceOfTruthId: second,
    })

    const res = await post(`/api/settings/accounts/${first}/ungroup`)
    expect(res.statusCode).toBe(200)

    const account = res.json<Settings>().accounts.find((row) => row.id === first)
    expect(account?.dedupeGroup).toBeNull()
    // Money that belongs to no group and is nobody's truth would be invisible.
    expect(account?.isSourceOfTruth).toBe(true)
  })

  it('records a dismissal as a decision, without dropping the account', async () => {
    const [first] = accountIds()

    const res = await post(`/api/settings/accounts/${first}/not-mirrored`)
    expect(res.statusCode).toBe(200)

    const account = res.json<Settings>().accounts.find((row) => row.id === first)
    // The whole point: nothing is grouped and nothing stops counting. Only the null
    // becomes an answer, so the matcher stops proposing this account.
    expect(account?.dedupeGroup).toBeNull()
    expect(account?.isSourceOfTruth).toBe(true)
    expect(account?.decidedFields).toEqual(['dedupeGroup'])
  })

  it('refuses a dismissal from a viewer', async () => {
    const [first] = accountIds()
    const res = await post(`/api/settings/accounts/${first}/not-mirrored`, {}, {
      token: viewer,
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses to dismiss an account that is in a group', async () => {
    const [first, second] = accountIds()
    await post('/api/settings/accounts/group', {
      accountMapIds: [first, second],
      sourceOfTruthId: second,
    })

    // 409 rather than 404: the account exists, and `ungroup` is the operation wanted.
    const res = await post(`/api/settings/accounts/${first}/not-mirrored`)
    expect(res.statusCode).toBe(409)
  })

  it('answers 404 dismissing an account that does not exist', async () => {
    expect((await post('/api/settings/accounts/nope/not-mirrored')).statusCode).toBe(404)
  })

  it('refuses a group whose truth is not in it', async () => {
    const [first, second, third] = accountIds()
    const res = await post('/api/settings/accounts/group', {
      accountMapIds: [first, second],
      sourceOfTruthId: third,
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a group of one', async () => {
    const res = await post('/api/settings/accounts/group', {
      accountMapIds: accountIds().slice(0, 1),
      sourceOfTruthId: accountIds()[0],
    })
    expect(res.statusCode).toBe(400)
  })

  it('answers 404 for an account that does not exist', async () => {
    const res = await patch('/api/settings/accounts/nope', { kind: 'savings' })
    expect(res.statusCode).toBe(404)
  })

  it('is refused for a viewer', async () => {
    const id = accountIds()[0] ?? ''
    const res = await patch(`/api/settings/accounts/${id}`, { kind: 'savings' }, {
      token: viewer,
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('the prompt editor', () => {
  const body = 'You rank precomputed signals.\nYou never compute a number.'

  it('stores a version without activating it', async () => {
    // Two gestures, because the point of versioning a prompt is that saving a draft
    // does not change tonight's output.
    const before = loadActivePrompt(ctx.db, 'analysis.system', 'en')
    const res = await post('/api/settings/prompts', {
      key: 'analysis.system',
      locale: 'en',
      body,
      note: 'shorter',
    })
    expect(res.statusCode).toBe(200)

    const versions = res
      .json<Settings>()
      .prompts.find((p) => p.key === 'analysis.system' && p.locale === 'en')?.versions
    expect(versions).toHaveLength(1)
    expect(versions?.[0]?.active).toBe(false)
    expect(versions?.[0]?.note).toBe('shorter')
    expect(loadActivePrompt(ctx.db, 'analysis.system', 'en')?.id).toBe(before?.id)
    expect(auditActions(ctx.db)).toEqual(['prompt.create'])
  })

  it('stores and activates in one gesture when asked', async () => {
    const res = await post('/api/settings/prompts', {
      key: 'analysis.system',
      locale: 'en',
      body,
      activate: true,
    })
    expect(res.statusCode).toBe(200)
    expect(loadActivePrompt(ctx.db, 'analysis.system', 'en')?.body).toBe(body)
    // Two entries: what was written, and what became active. They are separate
    // questions and an audit trail that merged them could answer neither.
    expect(auditActions(ctx.db)).toEqual(['prompt.create', 'prompt.activate'])
  })

  it('serves one version with its text', async () => {
    const created = createPromptVersion(ctx.db, {
      key: 'analysis.system',
      locale: 'en',
      body,
    })

    const res = await get(`/api/settings/prompts/${created.id}`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ body: string; chars: number }>().body).toBe(body)
    expect(res.json<{ chars: number }>().chars).toBe(body.length)
  })

  it('answers 404 for a version id that does not exist', async () => {
    const res = await get('/api/settings/prompts/nope')
    expect(res.statusCode).toBe(404)
  })

  it('diffs a candidate against the active text without storing anything', async () => {
    const res = await post('/api/settings/prompts/diff', {
      key: 'analysis.system',
      locale: 'en',
      body,
    })
    expect(res.statusCode).toBe(200)

    const diff = res.json<{ stat: { added: number; removed: number }; lines: unknown[] }>()
    expect(diff.lines.length).toBeGreaterThan(0)
    expect(diff.stat.added + diff.stat.removed).toBeGreaterThan(0)
    // A POST, because a prompt does not go in a query string — but it writes nothing.
    expect(auditActions(ctx.db)).toEqual([])
  })

  it('rolls back by activating an older version, text untouched', async () => {
    const first = createPromptVersion(ctx.db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'The first one.',
      activate: true,
    })
    createPromptVersion(ctx.db, {
      key: 'analysis.system',
      locale: 'en',
      body,
      activate: true,
    })

    const res = await post(`/api/settings/prompts/${first.id}/activate`)
    expect(res.statusCode).toBe(200)
    const active = loadActivePrompt(ctx.db, 'analysis.system', 'en')
    expect(active?.id).toBe(first.id)
    expect(active?.body).toBe('The first one.')
    expect(auditActions(ctx.db)).toEqual(['prompt.activate'])
  })

  it('refuses an empty body rather than storing a prompt that does nothing', async () => {
    const res = await post('/api/settings/prompts', {
      key: 'analysis.system',
      locale: 'en',
      body: '   \n  ',
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a key it does not have', async () => {
    const res = await post('/api/settings/prompts', {
      key: 'analysis.systemm',
      locale: 'en',
      body,
    })
    expect(res.statusCode).toBe(400)
  })

  it('is refused for a viewer, who may still read the diff', async () => {
    const create = await post(
      '/api/settings/prompts',
      { key: 'analysis.system', locale: 'en', body },
      { token: viewer },
    )
    expect(create.statusCode).toBe(403)

    const diff = await post(
      '/api/settings/prompts/diff',
      { key: 'analysis.system', locale: 'en', body },
      { token: viewer },
    )
    expect(diff.statusCode).toBe(200)
  })

  it('stores a shared version that every language then resolves to', async () => {
    const res = await post('/api/settings/prompts', {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body,
      activate: true,
    })
    expect(res.statusCode).toBe(200)

    // The bug this replaced: an edit made in one language stopped applying to the
    // other, and nothing said so.
    for (const locale of ['en', 'nl']) {
      expect(resolvePrompt(ctx.db, 'analysis.system', locale).body).toBe(body)
    }
  })

  it('sends a language back to the shared prompt without deleting its versions', async () => {
    createPromptVersion(ctx.db, {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body,
      activate: true,
    })
    createPromptVersion(ctx.db, {
      key: 'analysis.system',
      locale: 'nl',
      body: 'Je rangschikt signalen.',
      activate: true,
    })

    const res = await post('/api/settings/prompts/analysis.system/nl/shared')
    expect(res.statusCode).toBe(200)
    expect(resolvePrompt(ctx.db, 'analysis.system', 'nl').body).toBe(body)
    // The entry stays in the payload with its history, because nothing here destroys
    // text and reactivating a version is the ordinary rollback. What changed is what
    // the language resolves to, and the payload says so: `active.locale` is now the
    // shared one, which is how the editor knows to label it switched off.
    const settings = res.json<Settings>()
    const override = settings.prompts.find((prompt) => prompt.locale === 'nl')
    expect(override?.versions).toHaveLength(1)
    expect(override?.versions[0]?.active).toBe(false)
    expect(override?.active.locale).toBe(SHARED_LOCALE)
    expect(loadActivePrompt(ctx.db, 'analysis.system', 'nl')).toBeNull()
    expect(auditActions(ctx.db)).toEqual(['prompt.activate'])
  })

  it('answers 409 when the language has no override to switch off', async () => {
    // 409 rather than 404: the language exists, the request simply changed nothing.
    const res = await post('/api/settings/prompts/analysis.system/nl/shared')
    expect(res.statusCode).toBe(409)
  })

  it('refuses to switch off the shared prompt itself', async () => {
    const res = await post(`/api/settings/prompts/analysis.system/${SHARED_LOCALE}/shared`)
    expect(res.statusCode).toBe(400)
  })

  it('refuses to switch off a locale the deployment does not support', async () => {
    const res = await post('/api/settings/prompts/analysis.system/fr/shared')
    expect(res.statusCode).toBe(400)
  })

  it('is refused for a viewer', async () => {
    createPromptVersion(ctx.db, {
      key: 'analysis.system',
      locale: 'nl',
      body: 'Je rangschikt signalen.',
      activate: true,
    })

    const res = await post(
      '/api/settings/prompts/analysis.system/nl/shared',
      {},
      { token: viewer },
    )
    expect(res.statusCode).toBe(403)
    expect(loadActivePrompt(ctx.db, 'analysis.system', 'nl')).not.toBeNull()
  })
})
