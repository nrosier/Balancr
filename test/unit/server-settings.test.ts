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
import { loadAccountMap } from '../../src/domain/aggregate/accounts.ts'
import { DEFAULT_PARAMS, loadParams, saveParams } from '../../src/domain/aggregate/params.ts'
import { createPromptVersion, loadActivePrompt } from '../../src/domain/ai/prompts.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
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
  })

  it('lists a prompt for every key and locale, with the text it is really using', async () => {
    const settings = (await get('/api/settings')).json<Settings>()

    // Two keys × two locales, and the Dutch entries resolve to the English or
    // built-in body rather than to an empty box.
    expect(settings.prompts).toHaveLength(4)
    for (const prompt of settings.prompts) {
      expect(prompt.active.body.length).toBeGreaterThan(0)
    }
    const dutch = settings.prompts.find((p) => p.locale === 'nl')
    expect(dutch?.versions).toEqual([])
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
    // The whole payload, so the screen replaces its state rather than patching it.
    expect(settings.params).toEqual(DEFAULT_PARAMS)
    expect(settings.prompts).toHaveLength(4)
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
})
