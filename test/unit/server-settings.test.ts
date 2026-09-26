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
import { config } from '../../src/config.ts'
import { auditLog, prompts, users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { loadProfile, PROFILE_PRESETS } from '../../src/domain/advice/profile.ts'
import { loadHousehold } from '../../src/domain/benchmark/household.ts'
import {
  DEFAULT_DIGEST_PREFERENCE,
  loadDigestPreference,
  MAX_DIGEST_RECIPIENTS,
} from '../../src/domain/digest/preference.ts'
import { loadDigestPdf, saveDigestPdf } from '../../src/domain/digest/storage.ts'
import { loadReferenceOverride } from '../../src/domain/benchmark/reference.ts'
import { loadMapping } from '../../src/domain/benchmark/mapping.ts'
import { loadAccountMap } from '../../src/domain/aggregate/accounts.ts'
import { DEFAULT_PARAMS, loadParams, saveParams } from '../../src/domain/aggregate/params.ts'
import { loadCategoryTranslationRows } from '../../src/domain/i18n/category-translations.ts'
import { SHARED_LOCALE } from '../../src/domain/ai/prompt-locale.ts'
import {
  activatePrompt,
  createPromptVersion,
  DEFAULT_PROMPTS,
  isGatedKey,
  loadActivePrompt,
  loadPrompt,
  resolvePrompt,
  storePromptValidation,
  SUPERSEDED_PROMPTS,
  VALIDATION_RULES_VERSION,
} from '../../src/domain/ai/prompts.ts'
import type { PromptKey, PromptValidation } from '../../src/domain/ai/prompts.ts'
import { recordRun } from '../../src/domain/ai/runs.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, LOCALE_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import type { PromptDiff, Settings } from '../../src/server/routes/api/schemas.ts'
import { apiFixture } from '../helpers/api-fixture.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string
let viewer: string
let tenantId: string

function signIn(
  db: Db,
  role: 'owner' | 'viewer',
  locale = 'en',
  userTenantId = getSoleTenantId(db),
): string {
  const row = db
    .insert(users)
    .values({
      tenantId: userTenantId,
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
  method: 'DELETE' | 'PATCH' | 'POST',
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
const del = (url: string, options?: { token?: string; csrf?: boolean }) =>
  send('DELETE', url, {}, options)

/** The audit actions written, most recent first. */
const auditActions = (db: Db): string[] =>
  db
    .select({ action: auditLog.action })
    .from(auditLog)
    .all()
    .map((row) => row.action)

const auditEntries = (db: Db) => db.select().from(auditLog).all()

const accountIds = (): string[] => loadAccountMap(ctx.db, tenantId).map((row) => row.id)

/** A safe verdict at the current rules version, as a passing check would leave one. */
const verdict = (): PromptValidation => ({
  verdict: 'safe',
  json: JSON.stringify({
    verdict: 'safe',
    missing: [],
    weakened: [],
    conflicts: [],
    advisory: [],
    notes: '',
  }),
  rulesVersion: VALIDATION_RULES_VERSION,
  runId: null,
  provider: 'gemini-aistudio',
  model: 'gemini-3.7-flash',
  validatedBy: null,
  validatedAt: new Date('2026-09-01T10:00:00.000Z'),
})

/**
 * Creates a version and activates it the way an owner does once a check has passed.
 * `analysis.system` is gated under `locked`, the default, since #468 — a raw
 * `createPromptVersion(..., activate: true)` with an arbitrary body now throws for it the
 * same way it always has for `narrative.system`.
 */
const activateChecked = (key: PromptKey, locale: string, text: string, tid: string = tenantId) => {
  const row = createPromptVersion(ctx.db, tid, { key, locale, body: text })
  if (isGatedKey(config.PROMPT_EDITING, key)) storePromptValidation(ctx.db, tid, row.id, verdict())
  return activatePrompt(ctx.db, tid, row.id)
}

/**
 * Lets an HTTP `activate: true` request for this exact body succeed with no second paid
 * check: `inheritableValidation` matches by tenant, key and byte-identical body regardless
 * of locale, so a throwaway validated draft is enough.
 */
const preValidate = (key: PromptKey, text: string, tid: string = tenantId): void => {
  if (!isGatedKey(config.PROMPT_EDITING, key)) return
  const draft = createPromptVersion(ctx.db, tid, { key, locale: SHARED_LOCALE, body: text })
  storePromptValidation(ctx.db, tid, draft.id, verdict())
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
    // A prerelease suffix is allowed because the versioning scheme in README calls for
    // one: a feature-complete build ships as `1.0.0-rc.N` while the testing happens. A
    // three-number-only pattern would fail every release candidate.
    expect(settings.build.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/)
    expect(settings.profile.role).toBe('owner')
    expect(settings.locales.supported).toContain('nl')
    expect(settings.params).toEqual(DEFAULT_PARAMS)
    expect(settings.paramDefaults).toEqual(DEFAULT_PARAMS)
    expect(settings.accounts).toHaveLength(3)
    expect(settings.integrations.ai.modelFast.length).toBeGreaterThan(0)
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
    activateChecked('analysis.system', 'nl', 'Je rangschikt signalen.')

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
    activateChecked('analysis.system', 'en', 'You rank signals.\nNothing else.')

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

  it('hides digest recipient emails from a viewer, keeping only the count (#573)', async () => {
    await patch('/api/settings/digest', {
      mode: 'email',
      recipientEmails: ['a@example.test', 'b@example.test'],
    })

    const viewerSettings = (await get('/api/settings', viewer)).json<Settings>()
    expect(viewerSettings.digest.recipientEmails).toEqual([])
    expect(viewerSettings.digest.recipientCount).toBe(2)

    const ownerSettings = (await get('/api/settings')).json<Settings>()
    expect(ownerSettings.digest.recipientEmails).toEqual(['a@example.test', 'b@example.test'])
    expect(ownerSettings.digest.recipientCount).toBe(2)
  })

  it("shows only the signed-in tenant's AI spend history (#411)", async () => {
    const otherTenantId = createSecondTenant(ctx.db)
    const capped = (payloadHash: string) => ({
      kind: 'findings' as const,
      provider: 'gemini-aistudio' as const,
      model: 'gemini-3.7-flash',
      locale: 'en',
      payload: { month: '2026-09' },
      payloadHash,
      status: 'capped' as const,
    })
    recordRun(ctx.db, tenantId, capped('own-run'))
    recordRun(ctx.db, otherTenantId, capped('other-run'))

    const settings = (await get('/api/settings')).json<Settings>()
    expect(settings.ai.history).toHaveLength(1)
    expect(settings.ai.history[0]?.runCount).toBe(1)
  })
})

describe('PATCH /api/settings/params', () => {
  it('changes only the fields the patch mentions', async () => {
    // The trap this exists for: a patch schema built out of `.partial()` still
    // applies the inner `.default()`s, so a request naming one group would come
    // back with every other group reset to the shipped numbers — with no error.
    saveParams(ctx.db, tenantId, { overspend: { baselineWarnBp: 3_000 } })

    const res = await patch('/api/settings/params', { baseline: { windowMonths: 6 } })
    expect(res.statusCode).toBe(200)

    const params = res.json<Settings>().params
    expect(params.baseline.windowMonths).toBe(6)
    expect(params.overspend.baselineWarnBp).toBe(3_000)
    expect(params.baseline.halfLifeMonths).toBe(DEFAULT_PARAMS.baseline.halfLifeMonths)
    expect(loadParams(ctx.db, tenantId).overspend.baselineWarnBp).toBe(3_000)
  })

  it('refuses a field name it does not know instead of dropping it', async () => {
    const res = await patch('/api/settings/params', { baseline: { windowMonth: 6 } })
    expect(res.statusCode).toBe(400)
    // Named, because the form has twenty numbers in it and "not valid" points at
    // none of them.
    expect(res.json<ErrorBody>().error.issues).toEqual([
      { path: 'baseline.windowMonth', message: 'Unknown field.' },
    ])
    expect(loadParams(ctx.db, tenantId)).toEqual(DEFAULT_PARAMS)
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
    expect(loadParams(ctx.db, tenantId)).toEqual(DEFAULT_PARAMS)
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
    expect(loadHousehold(ctx.db, tenantId).sharedCostBp).toBe(6_000)
  })

  it('stores a name for the first person and answers with it (#215)', async () => {
    const res = await send_({ members: [], selfLabel: 'Nick' })

    expect(res.json<Settings>().benchmark.household.selfLabel).toBe('Nick')
    expect(loadHousehold(ctx.db, tenantId).selfLabel).toBe('Nick')
  })

  it('drops the first person\'s name when a later patch omits it, like the roster it travels with', async () => {
    await send_({ members: [], selfLabel: 'Nick' })
    const res = await send_({ members: [] })

    expect(res.json<Settings>().benchmark.household.selfLabel).toBeUndefined()
    expect(loadHousehold(ctx.db, tenantId).selfLabel).toBeUndefined()
  })

  it('takes null as "derive it from the roster again"', async () => {
    await send_({ members: [{ birthYear: 2013, custodyBp: 5_000 }], sharedCostBp: 6_000 })
    const res = await send_({ members: [{ birthYear: 2013, custodyBp: 5_000 }], sharedCostBp: null })

    expect(res.json<Settings>().benchmark.household.sharedCostBp).toBeNull()
    expect(loadHousehold(ctx.db, tenantId).sharedCostBp).toBeNull()
  })

  it('drops a stated share when the patch omits it, like the roster it travels with', async () => {
    // The household is one row written wholesale. The safe direction: a stated share
    // surviving a roster edit invisibly is how somebody reads a split they had removed.
    await send_({ members: [], sharedCostBp: 6_000 })
    await send_({ members: [{ birthYear: 2013, custodyBp: 5_000 }] })
    expect(loadHousehold(ctx.db, tenantId).sharedCostBp).toBeNull()
  })

  it('refuses a share outside 0–100%, naming the field', async () => {
    const res = await send_({ members: [], sharedCostBp: 12_000 })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues?.map((issue) => issue.path)).toEqual([
      'sharedCostBp',
    ])
    expect(loadHousehold(ctx.db, tenantId).sharedCostBp).toBeNull()
  })

  it('is refused for a viewer', async () => {
    const res = await send_({ members: [], sharedCostBp: 6_000 }, { token: viewer })
    expect(res.statusCode).toBe(403)
    expect(loadHousehold(ctx.db, tenantId).sharedCostBp).toBeNull()
  })
})

describe('PATCH /api/settings/digest', () => {
  const send_ = (body: object, options?: { token?: string }) =>
    patch('/api/settings/digest', body, options)

  it('stores a pdf preference and answers with it', async () => {
    const res = await send_({ mode: 'pdf' })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().digest).toMatchObject({
      mode: 'pdf',
      recipientEmails: [],
      locale: null,
    })
    expect(loadDigestPreference(ctx.db, tenantId).mode).toBe('pdf')
  })

  it('stores an email preference with its recipients and a locale override', async () => {
    const res = await send_({
      mode: 'email',
      recipientEmails: ['a@example.test', 'b@example.test'],
      locale: 'nl',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().digest).toMatchObject({
      mode: 'email',
      recipientEmails: ['a@example.test', 'b@example.test'],
      locale: 'nl',
    })
    expect(loadDigestPreference(ctx.db, tenantId)).toMatchObject({
      mode: 'email',
      recipientEmails: ['a@example.test', 'b@example.test'],
      locale: 'nl',
    })
  })

  it('refuses a request that omits mode, rather than silently switching the digest off', async () => {
    await send_({ mode: 'email', recipientEmails: ['a@example.test'] })
    const res = await send_({ recipientEmails: ['a@example.test'] })

    expect(res.statusCode).toBe(400)
    // Left exactly as it was — no default is silently applied to a field this schema
    // treats as required.
    expect(loadDigestPreference(ctx.db, tenantId).mode).toBe('email')
  })

  it('refuses email mode with no recipients, naming the field', async () => {
    const res = await send_({ mode: 'email' })

    expect(res.statusCode).toBe(400)
    expect(loadDigestPreference(ctx.db, tenantId)).toEqual(DEFAULT_DIGEST_PREFERENCE)
  })

  it('refuses more recipients than the cap', async () => {
    const recipientEmails = Array.from(
      { length: MAX_DIGEST_RECIPIENTS + 1 },
      (_, i) => `r${String(i)}@example.test`,
    )
    const res = await send_({ mode: 'email', recipientEmails })

    expect(res.statusCode).toBe(400)
  })

  it('is refused for a viewer', async () => {
    const res = await send_({ mode: 'pdf' }, { token: viewer })
    expect(res.statusCode).toBe(403)
    expect(loadDigestPreference(ctx.db, tenantId)).toEqual(DEFAULT_DIGEST_PREFERENCE)
  })

  it('records an audit entry for the change', async () => {
    await send_({ mode: 'pdf' })

    const entry = auditEntries(ctx.db).at(-1)
    expect(entry?.action).toBe('settings.digest')
    expect(JSON.parse(entry?.afterJson ?? '{}').mode).toBe('pdf')
  })

  it('deletes the stored PDF once mode moves away from pdf, rather than leaving it downloadable (#572)', async () => {
    await send_({ mode: 'pdf' })
    saveDigestPdf(ctx.db, tenantId, '2026-03', Buffer.from('%PDF-fake'))
    expect(loadDigestPdf(ctx.db, tenantId)).not.toBeNull()

    const res = await send_({ mode: 'off' })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().digest.hasPdf).toBe(false)
    expect(loadDigestPdf(ctx.db, tenantId)).toBeNull()
  })

  it('keeps the stored PDF when the mode stays pdf', async () => {
    await send_({ mode: 'pdf' })
    saveDigestPdf(ctx.db, tenantId, '2026-03', Buffer.from('%PDF-fake'))

    const res = await send_({ mode: 'pdf' })

    expect(res.json<Settings>().digest.hasPdf).toBe(true)
    expect(loadDigestPdf(ctx.db, tenantId)).not.toBeNull()
  })
})

describe('GET /api/settings/digest/pdf', () => {
  it('answers 404 when nothing has been generated yet', async () => {
    const res = await get('/api/settings/digest/pdf')
    expect(res.statusCode).toBe(404)
  })

  it('streams back the stored bytes with a filename naming the period', async () => {
    saveDigestPdf(ctx.db, tenantId, '2026-03', Buffer.from('%PDF-fake'))

    const res = await get('/api/settings/digest/pdf')

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toContain('balancr-digest-2026-03.pdf')
    expect(res.rawPayload.toString()).toBe('%PDF-fake')
  })

  it('is refused for a viewer', async () => {
    saveDigestPdf(ctx.db, tenantId, '2026-03', Buffer.from('%PDF-fake'))
    const res = await get('/api/settings/digest/pdf', viewer)
    expect(res.statusCode).toBe(403)
  })
})

describe('PATCH /api/settings/benchmark-reference', () => {
  const send_ = (body: object, options?: { token?: string }) =>
    patch('/api/settings/benchmark-reference', body, options)

  /** Invented round figures, as everything in this repo's tests is. */
  const reference = {
    meanMonthlyCents: 400_000,
    equivalentAdultsBp: 16_000,
    citation: 'Statbel, Household Budget Survey 2026 — invented figures',
  }

  it('stores a correction, answers with it, and marks it unconfirmed (#290)', async () => {
    const res = await send_({ reference })

    expect(res.statusCode).toBe(200)
    const payload = res.json<Settings>().benchmark
    expect(payload.referenceOverride).toMatchObject(reference)
    // The file's own figure is still on the wire beside it — it is what reset goes back
    // to, and a correction whose starting point is invisible is one nobody can check.
    // The shipped figure is itself an inflation-adjusted estimate (#398), so it already
    // reads `transcribed` rather than `confirmed` before any override is applied.
    expect(payload.file?.referenceHousehold?.status).toBe('transcribed')
    expect(payload.file?.transcribed).toContain('reference_household')
    expect(loadReferenceOverride(ctx.db, tenantId)).toMatchObject(reference)
  })

  it('takes null as "use the file\'s figure again"', async () => {
    await send_({ reference })
    const res = await send_({ reference: null })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().benchmark.referenceOverride).toBeNull()
    // Cleared rather than stored as a copy of the file: a copy would freeze today's
    // caveat in place and would ignore the next edition. The caveat itself still shows
    // here regardless, because the shipped figure is an estimate (#398) — clearing the
    // override goes back to *that* figure's own honest status, not to a clean bill of
    // health.
    expect(res.json<Settings>().benchmark.file?.transcribed).toContain('reference_household')
    expect(loadReferenceOverride(ctx.db, tenantId)).toBeNull()
  })

  it('refuses a household smaller than one person, naming the field', async () => {
    // The comparison divides by this number. Below one adult it scales a national
    // average *up*, which is not a correction anybody meant to make.
    const res = await send_({
      reference: { ...reference, equivalentAdultsBp: 5_000 },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues?.map((issue) => issue.path)).toEqual([
      'equivalentAdultsBp',
    ])
    expect(loadReferenceOverride(ctx.db, tenantId)).toBeNull()
  })

  it('refuses a correction with no citation, because that is the whole provenance', async () => {
    const res = await send_({ reference: { ...reference, citation: 'HBS' } })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues?.map((issue) => issue.path)).toEqual(['citation'])
  })

  it('records the change with both figures, so a moved comparison can be traced', async () => {
    await send_({ reference })
    const entry = ctx.db.select().from(auditLog).all().at(-1)
    expect(entry?.action).toBe('settings.benchmarkReference')
    // No `before` row at all, because the file's figure applied — which is itself the
    // answer to "what average household was that comparison drawn against".
    expect(entry?.beforeJson).toBeNull()
    expect(JSON.parse(entry?.afterJson ?? 'null')).toMatchObject(reference)
  })

  it('is refused for a viewer', async () => {
    const res = await send_({ reference }, { token: viewer })
    expect(res.statusCode).toBe(403)
    expect(loadReferenceOverride(ctx.db, tenantId)).toBeNull()
  })
})

describe('PATCH /api/settings/categories/:id/custody-shared', () => {
  const send_ = (id: string, body: object, options?: { token?: string }) =>
    patch(`/api/settings/categories/${id}/custody-shared`, body, options)

  const flagOf = (id: string): boolean | undefined =>
    loadMapping(ctx.db, tenantId, null).find((row) => row.categoryId === id)?.custodyShared

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

describe('PATCH /api/settings/categories/:id/nature', () => {
  const send_ = (id: string, body: object, options?: { token?: string }) =>
    patch(`/api/settings/categories/${id}/nature`, body, options)

  const natureOf = (id: string): string | null | undefined =>
    loadMapping(ctx.db, tenantId, null).find((row) => row.categoryId === id)?.nature

  it('tags a category as savings, and answers with the list saying so (#252)', async () => {
    const res = await send_('cat-groceries', { nature: 'savings' })

    expect(res.statusCode).toBe(200)
    const row = res
      .json<Settings>()
      .benchmark.categories.find((category) => category.categoryId === 'cat-groceries')
    expect(row?.nature).toBe('savings')
    expect(natureOf('cat-groceries')).toBe('savings')
  })

  it('retags a category from savings to investments', async () => {
    await send_('cat-groceries', { nature: 'savings' })
    const res = await send_('cat-groceries', { nature: 'investments' })

    expect(res.statusCode).toBe(200)
    expect(natureOf('cat-groceries')).toBe('investments')
  })

  it('takes the tag back, which is the correction people actually make', async () => {
    await send_('cat-groceries', { nature: 'savings' })
    const res = await send_('cat-groceries', { nature: null })

    expect(res.statusCode).toBe(200)
    expect(natureOf('cat-groceries')).toBe(null)
  })

  it('records the change against the category, not against settings', async () => {
    await send_('cat-groceries', { nature: 'savings' })
    expect(auditActions(ctx.db)).toContain('settings.nature')
  })

  it('refuses a value outside the two-choice enum, and a body with neither key nor null', async () => {
    expect((await send_('cat-groceries', { nature: 'fixed' })).statusCode).toBe(400)
    expect((await send_('cat-groceries', {})).statusCode).toBe(400)
    expect(natureOf('cat-groceries')).toBe(null)
  })

  it('answers 404 for a category Balancr has never seen', async () => {
    const res = await send_('cat-invented', { nature: 'savings' })
    expect(res.statusCode).toBe(404)
  })

  it('is refused for a viewer', async () => {
    const res = await send_('cat-groceries', { nature: 'savings' }, { token: viewer })
    expect(res.statusCode).toBe(403)
    expect(natureOf('cat-groceries')).toBe(null)
  })
})

describe('PATCH /api/settings/categories/:id/ai-visibility', () => {
  const send_ = (id: string, body: object, options?: { token?: string }) =>
    patch(`/api/settings/categories/${id}/ai-visibility`, body, options)

  const visibilityOf = (id: string): string | undefined =>
    loadMapping(ctx.db, tenantId, null).find((row) => row.categoryId === id)?.aiVisibility

  it('withholds an envelope entirely, and answers with the list saying so (#278)', async () => {
    const res = await send_('cat-groceries', { aiVisibility: 'absent' })

    expect(res.statusCode).toBe(200)
    const row = res
      .json<Settings>()
      .benchmark.categories.find((category) => category.categoryId === 'cat-groceries')
    expect(row?.aiVisibility).toBe('absent')
    expect(visibilityOf('cat-groceries')).toBe('absent')
  })

  it('answers the weaker state too, and does not leave the pair half-written', async () => {
    // The two flags are one control, so the middle state has to be reachable from the
    // strongest one: somebody who over-corrected must be able to come back to it.
    await send_('cat-groceries', { aiVisibility: 'absent' })
    expect((await send_('cat-groceries', { aiVisibility: 'label_only' })).statusCode).toBe(200)
    expect(visibilityOf('cat-groceries')).toBe('label_only')
    expect((await send_('cat-groceries', { aiVisibility: 'shown' })).statusCode).toBe(200)
    expect(visibilityOf('cat-groceries')).toBe('shown')
  })

  it('records the change as the three-state answer, not as two columns', async () => {
    // The one settings write whose effect is what leaves the machine, so the entry has
    // to read as the decision somebody made rather than as the pair it was stored in.
    await send_('cat-groceries', { aiVisibility: 'label_only' })
    await send_('cat-groceries', { aiVisibility: 'absent' })
    expect(auditActions(ctx.db)).toContain('settings.aiVisibility')

    const entry = ctx.db.select().from(auditLog).all().at(-1)
    expect(JSON.parse(entry?.beforeJson ?? '{}')).toEqual({ aiVisibility: 'label_only' })
    expect(JSON.parse(entry?.afterJson ?? '{}')).toEqual({ aiVisibility: 'absent' })
  })

  it('accepts it on an income category, which is always sent otherwise', async () => {
    // Unlike the custody flag, this is not inert on income: an income envelope has no
    // "worth sending" threshold to fall under, so excluding one is the only way to keep
    // it out. The control is therefore never disabled in the panel either.
    const res = await send_('cat-salary', { aiVisibility: 'absent' })
    expect(res.statusCode).toBe(200)
    expect(visibilityOf('cat-salary')).toBe('absent')
  })

  it('refuses a state outside the three, and an empty body', async () => {
    expect((await send_('cat-groceries', { aiVisibility: 'hidden' })).statusCode).toBe(400)
    expect((await send_('cat-groceries', { aiVisibility: true })).statusCode).toBe(400)
    expect((await send_('cat-groceries', {})).statusCode).toBe(400)
    expect(visibilityOf('cat-groceries')).toBe('shown')
  })

  it('answers 404 for a category Balancr has never seen', async () => {
    expect((await send_('cat-invented', { aiVisibility: 'absent' })).statusCode).toBe(404)
  })

  it('is refused for a viewer', async () => {
    // The state that decides what a paid model is shown is not a read-only concern.
    const res = await send_('cat-groceries', { aiVisibility: 'absent' }, { token: viewer })
    expect(res.statusCode).toBe(403)
    expect(visibilityOf('cat-groceries')).toBe('shown')
  })
})

describe('PATCH /api/settings/categories/:id/translation/:locale', () => {
  // The fixture never sets `actualCategorySourceLocale` explicitly, so it sits at the
  // schema's own default — the same value a fresh deployment would have on day one.
  const SOURCE_LOCALE = 'en'

  const send_ = (id: string, locale: string, body: object, options?: { token?: string }) =>
    patch(`/api/settings/categories/${id}/translation/${locale}`, body, options)

  const translationsOf = (id: string): Record<string, string> | undefined =>
    loadCategoryTranslationRows(ctx.db, tenantId).find((row) => row.categoryId === id)?.translations

  it('writes a translated name, and answers with the list saying so (#479)', async () => {
    const res = await send_('cat-groceries', 'nl', { name: 'Boodschappen' })

    expect(res.statusCode).toBe(200)
    const row = res
      .json<Settings>()
      .categoryTranslations.find((category) => category.categoryId === 'cat-groceries')
    expect(row?.translations.nl).toBe('Boodschappen')
    expect(translationsOf('cat-groceries')).toEqual({ nl: 'Boodschappen' })
  })

  it('clears a translation back to the source name when given null', async () => {
    await send_('cat-groceries', 'nl', { name: 'Boodschappen' })
    const res = await send_('cat-groceries', 'nl', { name: null })

    expect(res.statusCode).toBe(200)
    expect(translationsOf('cat-groceries')).toEqual({})
  })

  it('records the change against the translation table, not against settings', async () => {
    await send_('cat-groceries', 'nl', { name: 'Boodschappen' })
    expect(auditActions(ctx.db)).toContain('settings.category-translation')
  })

  it('refuses a body with no name key, and one with the wrong type', async () => {
    expect((await send_('cat-groceries', 'nl', {})).statusCode).toBe(400)
    expect((await send_('cat-groceries', 'nl', { name: 42 })).statusCode).toBe(400)
    expect(translationsOf('cat-groceries')).toEqual({})
  })

  it('answers 404 for a category Balancr has never seen', async () => {
    const res = await send_('cat-invented', 'nl', { name: 'Spook' })
    expect(res.statusCode).toBe(404)
  })

  it("answers 400 for the tenant's own category source locale", async () => {
    const res = await send_('cat-groceries', SOURCE_LOCALE, { name: 'Groceries 2' })
    expect(res.statusCode).toBe(400)
    expect(translationsOf('cat-groceries')).toEqual({})
  })

  it('answers 400 for a locale this deployment does not support, rather than persisting it', async () => {
    // The locale comes off the URL, not the request-body schema — a client can put
    // anything there, and the settings UI's own picker only offers supported locales,
    // so an unvalidated write would sit in the table with no way to reach it again.
    const res = await send_('cat-groceries', 'xx', { name: 'Groceries 2' })
    expect(res.statusCode).toBe(400)
    expect(translationsOf('cat-groceries')).toEqual({})
  })

  it('is refused for a viewer', async () => {
    const res = await send_('cat-groceries', 'nl', { name: 'Boodschappen' }, { token: viewer })
    expect(res.statusCode).toBe(403)
    expect(translationsOf('cat-groceries')).toEqual({})
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
    expect(loadProfile(ctx.db, tenantId).bands).toBeUndefined()
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
    expect(loadProfile(ctx.db, tenantId).bands).toBeUndefined()
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
    expect(loadProfile(ctx.db, tenantId).bands).toBeUndefined()
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
    expect(loadProfile(ctx.db, tenantId).profile).toBe('balanced')
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
    // #245: the reason has to follow the toggle in the same response, not just the
    // toggle itself — this is the field that turns "count toward net worth: off"
    // into a visible "and that's why it's not in the total".
    expect(account?.netWorthExclusionReason).toBe('not_included')
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
    // #245: the truth counts, its twin is excluded and says so — this is the exact
    // "invested shows 0 on Overview" report made visible instead of silent.
    expect(grouped.find((row) => row.isSourceOfTruth)?.netWorthExclusionReason).toBeNull()
    expect(grouped.find((row) => !row.isSourceOfTruth)?.netWorthExclusionReason).toBe('deduped')
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

  it('takes the whole pair back out of the group, not just the account named', async () => {
    // #245: the settings panel shows a linked pair as one block with one "Unlink"
    // button, and the id it sends is whichever member the block resolved to — so
    // unlinking has to free both sides, not just the one whose id happened to be
    // named. Freeing only `first` here (the non-truth side) would otherwise leave
    // `second` as the sole member of a group with no source of truth, and its money
    // would drop out of net worth with nothing on screen to explain why.
    const [first, second] = accountIds()
    await post('/api/settings/accounts/group', {
      accountMapIds: [first, second],
      sourceOfTruthId: second,
    })

    const res = await post(`/api/settings/accounts/${first}/ungroup`)
    expect(res.statusCode).toBe(200)

    const accounts = res.json<Settings>().accounts
    for (const id of [first, second]) {
      const account = accounts.find((row) => row.id === id)
      expect(account?.dedupeGroup).toBeNull()
      // Money that belongs to no group and is nobody's truth would be invisible.
      expect(account?.isSourceOfTruth).toBe(true)
    }
    // One entry per account touched, because both sides changed.
    expect(auditActions(ctx.db).filter((action) => action === 'account.map')).toHaveLength(4)
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
    const before = loadActivePrompt(ctx.db, tenantId, 'analysis.system', 'en')
    const res = await post('/api/settings/prompts', {
      key: 'analysis.system',
      locale: 'en',
      body,
      name: 'Terser pass',
      note: 'shorter',
    })
    expect(res.statusCode).toBe(200)

    const versions = res
      .json<Settings>()
      .prompts.find((p) => p.key === 'analysis.system' && p.locale === 'en')?.versions
    expect(versions).toHaveLength(1)
    expect(versions?.[0]?.active).toBe(false)
    expect(versions?.[0]?.name).toBe('Terser pass')
    expect(versions?.[0]?.note).toBe('shorter')
    expect(loadActivePrompt(ctx.db, tenantId, 'analysis.system', 'en')?.id).toBe(before?.id)
    expect(auditActions(ctx.db)).toEqual(['prompt.create'])
  })

  it('stores and activates in one gesture when asked', async () => {
    preValidate('analysis.system', body)
    const res = await post('/api/settings/prompts', {
      key: 'analysis.system',
      locale: 'en',
      body,
      activate: true,
    })
    expect(res.statusCode).toBe(200)
    expect(loadActivePrompt(ctx.db, tenantId, 'analysis.system', 'en')?.body).toBe(body)
    // Two entries: what was written, and what became active. They are separate
    // questions and an audit trail that merged them could answer neither.
    expect(auditActions(ctx.db)).toEqual(['prompt.create', 'prompt.activate'])
  })

  it('serves one version with its text', async () => {
    const created = createPromptVersion(ctx.db, tenantId, {
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

    const diff = res.json<{
      stat: { added: number; removed: number }
      lines: unknown[]
    }>()
    expect(diff.lines.length).toBeGreaterThan(0)
    expect(diff.stat.added + diff.stat.removed).toBeGreaterThan(0)
    // A POST, because a prompt does not go in a query string — but it writes nothing.
    expect(auditActions(ctx.db)).toEqual([])
  })

  it('rolls back by activating an older version, text untouched', async () => {
    const first = activateChecked('analysis.system', 'en', 'The first one.')
    activateChecked('analysis.system', 'en', body)

    const res = await post(`/api/settings/prompts/${first.id}/activate`)
    expect(res.statusCode).toBe(200)
    const active = loadActivePrompt(ctx.db, tenantId, 'analysis.system', 'en')
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
    preValidate('analysis.system', body)
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
      expect(resolvePrompt(ctx.db, tenantId, 'analysis.system', locale).body).toBe(body)
    }
  })

  it('sends a language back to the shared prompt without deleting its versions', async () => {
    activateChecked('analysis.system', SHARED_LOCALE, body)
    activateChecked('analysis.system', 'nl', 'Je rangschikt signalen.')

    const res = await post('/api/settings/prompts/analysis.system/nl/shared')
    expect(res.statusCode).toBe(200)
    expect(resolvePrompt(ctx.db, tenantId, 'analysis.system', 'nl').body).toBe(body)
    // The entry stays in the payload with its history, because nothing here destroys
    // text and reactivating a version is the ordinary rollback. What changed is what
    // the language resolves to, and the payload says so: `active.locale` is now the
    // shared one, which is how the editor knows to label it switched off.
    const settings = res.json<Settings>()
    const override = settings.prompts.find((prompt) => prompt.locale === 'nl')
    expect(override?.versions).toHaveLength(1)
    expect(override?.versions[0]?.active).toBe(false)
    expect(override?.active.locale).toBe(SHARED_LOCALE)
    expect(loadActivePrompt(ctx.db, tenantId, 'analysis.system', 'nl')).toBeNull()
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
    activateChecked('analysis.system', 'nl', 'Je rangschikt signalen.')

    const res = await post(
      '/api/settings/prompts/analysis.system/nl/shared',
      {},
      { token: viewer },
    )
    expect(res.statusCode).toBe(403)
    expect(loadActivePrompt(ctx.db, tenantId, 'analysis.system', 'nl')).not.toBeNull()
  })

  it('never reads, diffs, activates or deactivates another tenant\'s prompt (#410)', async () => {
    preValidate('analysis.system', 'Tenant A shared instructions.')
    const createdA = await post('/api/settings/prompts', {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body: 'Tenant A shared instructions.',
      activate: true,
    })
    expect(createdA.statusCode).toBe(200)
    const promptA = loadActivePrompt(ctx.db, tenantId, 'analysis.system', SHARED_LOCALE)
    if (promptA === null) throw new Error('tenant A prompt was not activated')

    preValidate('analysis.system', 'Tenant A Nederlandse instructies.')
    await post('/api/settings/prompts', {
      key: 'analysis.system',
      locale: 'nl',
      body: 'Tenant A Nederlandse instructies.',
      activate: true,
    })
    const overrideA = loadActivePrompt(ctx.db, tenantId, 'analysis.system', 'nl')
    if (overrideA === null) throw new Error('tenant A override was not activated')

    const tenantB = createSecondTenant(ctx.db)
    const ownerB = signIn(ctx.db, 'owner', 'en', tenantB)

    const settingsB = (await get('/api/settings', ownerB)).json<Settings>()
    expect(settingsB.prompts.flatMap((prompt) => prompt.versions.map((version) => version.id)))
      .not.toContain(promptA.id)
    expect((await get(`/api/settings/prompts/${promptA.id}`, ownerB)).statusCode).toBe(404)
    expect(
      (await post(`/api/settings/prompts/${promptA.id}/activate`, {}, { token: ownerB }))
        .statusCode,
    ).toBe(404)

    const diffB = await post(
      '/api/settings/prompts/diff',
      { key: 'analysis.system', locale: 'en', body: 'Tenant B candidate.' },
      { token: ownerB },
    )
    expect(diffB.statusCode).toBe(200)
    expect(diffB.json<{ active: { id: string | null } }>().active.id).toBeNull()

    preValidate('analysis.system', 'Tenant B shared instructions.', tenantB)
    const createdB = await post(
      '/api/settings/prompts',
      {
        key: 'analysis.system',
        locale: SHARED_LOCALE,
        body: 'Tenant B shared instructions.',
        activate: true,
      },
      { token: ownerB },
    )
    expect(createdB.statusCode).toBe(200)
    expect(resolvePrompt(ctx.db, tenantB, 'analysis.system', 'en').body).toBe(
      'Tenant B shared instructions.',
    )
    expect(loadActivePrompt(ctx.db, tenantId, 'analysis.system', SHARED_LOCALE)?.id).toBe(
      promptA.id,
    )

    const deactivateB = await post(
      '/api/settings/prompts/analysis.system/nl/shared',
      {},
      { token: ownerB },
    )
    expect(deactivateB.statusCode).toBe(409)
    expect(loadActivePrompt(ctx.db, tenantId, 'analysis.system', 'nl')?.id).toBe(overrideA.id)
  })
})

describe('DELETE /api/settings/prompts/:id', () => {
  it('removes the version and answers with the whole payload', async () => {
    // The shared entry, since a non-shared locale's entry disappears once its last
    // version is gone (asserted separately below) rather than staying with an empty list.
    const row = createPromptVersion(ctx.db, tenantId, {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body: 'a version nobody needs any more',
    })

    const res = await del(`/api/settings/prompts/${row.id}`)
    expect(res.statusCode).toBe(200)
    expect(loadPrompt(ctx.db, tenantId, row.id)).toBeNull()
    const versions = res
      .json<Settings>()
      .prompts.find((p) => p.key === 'analysis.system' && p.locale === SHARED_LOCALE)?.versions
    expect(versions?.map((v) => v.id)).not.toContain(row.id)
  })

  it('records what was removed, since the row is the only place it existed', async () => {
    const row = createPromptVersion(ctx.db, tenantId, {
      key: 'analysis.system',
      locale: 'en',
      body: 'a version nobody needs any more',
      note: 'trying something',
    })

    await del(`/api/settings/prompts/${row.id}`)

    expect(auditActions(ctx.db)).toEqual(['prompt.delete'])
    const entry = auditEntries(ctx.db).find((r) => r.action === 'prompt.delete')
    expect(entry?.beforeJson).toContain('analysis.system')
    expect(entry?.afterJson).toBeNull()
  })

  it('falls back to the built-in text when the active version itself is deleted', async () => {
    const active = activateChecked('analysis.system', 'en', 'the only override ever made')

    const res = await del(`/api/settings/prompts/${active.id}`)
    expect(res.statusCode).toBe(200)

    const resolved = resolvePrompt(ctx.db, tenantId, 'analysis.system', 'en')
    expect(resolved.id).toBeNull()
    expect(resolved.gate).toBe('built_in')
    const entry = res
      .json<Settings>()
      .prompts.find((p) => p.key === 'analysis.system' && p.locale === SHARED_LOCALE)
    expect(entry?.active.id).toBeNull()
  })

  it("drops a language whose last override version was just deleted, back to the shared tab", async () => {
    const override = activateChecked('analysis.system', 'nl', 'Je rangschikt signalen.')

    const res = await del(`/api/settings/prompts/${override.id}`)
    expect(res.statusCode).toBe(200)

    const settings = res.json<Settings>()
    expect(settings.prompts.find((p) => p.key === 'analysis.system' && p.locale === 'nl')).toBeUndefined()
  })

  it('is a 404 the second time, rather than pretending to delete again', async () => {
    const row = createPromptVersion(ctx.db, tenantId, {
      key: 'analysis.system',
      locale: 'en',
      body: 'a version nobody needs any more',
    })
    await del(`/api/settings/prompts/${row.id}`)

    const res = await del(`/api/settings/prompts/${row.id}`)
    expect(res.statusCode).toBe(404)
  })

  it('answers 404 for an id that never existed', async () => {
    const res = await del('/api/settings/prompts/nope')
    expect(res.statusCode).toBe(404)
  })

  it("is a 404 for another tenant's version, which stays where it is", async () => {
    const tenantB = createSecondTenant(ctx.db)
    const theirs = createPromptVersion(ctx.db, tenantB, {
      key: 'analysis.system',
      locale: 'en',
      body: 'Tenant B instructions.',
    })

    const res = await del(`/api/settings/prompts/${theirs.id}`)
    expect(res.statusCode).toBe(404)
    expect(loadPrompt(ctx.db, tenantB, theirs.id)).not.toBeNull()
  })

  it('refuses a viewer', async () => {
    const row = createPromptVersion(ctx.db, tenantId, {
      key: 'analysis.system',
      locale: 'en',
      body: 'a version nobody needs any more',
    })

    const res = await del(`/api/settings/prompts/${row.id}`, { token: viewer })
    expect(res.statusCode).toBe(403)
    expect(loadPrompt(ctx.db, tenantId, row.id)).not.toBeNull()
  })
})

describe('the narrative activation gate (#454)', () => {
  const EDITED = 'Write the month up in my own words, and never calculate anything.'

  /** A safe verdict at the current rules version, as a passing check would leave one. */
  const clear = (id: string): void => {
    storePromptValidation(ctx.db, tenantId, id, {
      verdict: 'safe',
      json: JSON.stringify({
        verdict: 'safe',
        missing: [],
        weakened: [],
        conflicts: [],
        advisory: [],
        notes: '',
      }),
      rulesVersion: VALIDATION_RULES_VERSION,
      runId: null,
      provider: 'gemini-aistudio',
      model: 'gemini-3.7-flash',
      validatedBy: null,
      validatedAt: new Date('2026-09-01T10:00:00.000Z'),
    })
  }

  it('answers 409 when activating an edited narrative body with no verdict', async () => {
    const row = createPromptVersion(ctx.db, tenantId, {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: EDITED,
    })

    const res = await post(`/api/settings/prompts/${row.id}/activate`)
    expect(res.statusCode).toBe(409)
    // A `409` rather than a `403`: nothing here is about permission, and the state is
    // fixable — press the check. The message names which state it is in, so the editor can
    // tell "not checked yet" from "checked and refused".
    expect(res.json<{ error: { message: string } }>().error.message).toMatch(/safety check/i)
    // The flag did not move, and the previous active version still runs.
    expect(loadActivePrompt(ctx.db, tenantId, 'narrative.system', SHARED_LOCALE)?.id).not.toBe(
      row.id,
    )
  })

  it('answers 409 for save-and-activate in one gesture, storing nothing', async () => {
    const before = ctx.db
      .select()
      .from(prompts)
      .all()
      .filter((row) => row.key === 'narrative.system').length

    const res = await post('/api/settings/prompts', {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: EDITED,
      activate: true,
    })

    expect(res.statusCode).toBe(409)
    // The insert lives inside the refused transaction, so there is no orphan draft either.
    expect(
      ctx.db.select().from(prompts).all().filter((row) => row.key === 'narrative.system').length,
    ).toBe(before)
  })

  it('stores an edited narrative body happily as long as it is not activated', async () => {
    // Save and activate are separate gestures, and only the second one is gated: the point of
    // versioning a prompt is that writing a draft changes nothing about tonight's output.
    const res = await post('/api/settings/prompts', {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: EDITED,
    })
    expect(res.statusCode).toBe(200)

    const entry = res
      .json<Settings>()
      .prompts.find((p) => p.key === 'narrative.system' && p.locale === SHARED_LOCALE)
    const saved = entry?.versions.find((version) => !version.active)
    expect(saved).toBeDefined()
    expect(saved?.gate).toBe('unvalidated')
    expect(saved?.validatedAt).toBeNull()
    expect(saved?.rulesVersion).toBeNull()
  })

  it('activates the same body once a safe verdict is stored', async () => {
    const row = createPromptVersion(ctx.db, tenantId, {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: EDITED,
    })
    clear(row.id)

    const res = await post(`/api/settings/prompts/${row.id}/activate`)
    expect(res.statusCode).toBe(200)
    expect(loadActivePrompt(ctx.db, tenantId, 'narrative.system', SHARED_LOCALE)?.id).toBe(row.id)

    const entry = res
      .json<Settings>()
      .prompts.find((p) => p.key === 'narrative.system' && p.locale === SHARED_LOCALE)
    expect(entry?.active.gate).toBe('safe')
    expect(entry?.active.rulesVersion).toBe(VALIDATION_RULES_VERSION)
    expect(entry?.active.validatedAt).not.toBeNull()
  })

  it('always activates the current built-in body — the exemption', async () => {
    // What makes boot-time seeding work: `seedPrompts` writes exactly this text and activates
    // it on every start, with no request behind it, so there must be no state in which Balancr
    // refuses its own current default.
    const res = await post('/api/settings/prompts', {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: DEFAULT_PROMPTS['narrative.system'],
      activate: true,
    })
    expect(res.statusCode).toBe(200)

    const entry = (await get('/api/settings'))
      .json<Settings>()
      .prompts.find((p) => p.key === 'narrative.system' && p.locale === SHARED_LOCALE)
    expect(entry?.active.gate).toBe('built_in')
  })

  it('answers 409 for a historical built-in body, which is not exempt', async () => {
    // The copy-paste bypass this closes: the repository is public, so `NARRATIVE_SYSTEM_V1`'s
    // exact text can be lifted out of git history — and it genuinely does not impose
    // `note_is_context` or `excluded_is_choice`, two of the four rules that block. Exempting it
    // let it activate with no check at all, permanently.
    const historical = SUPERSEDED_PROMPTS['narrative.system'][0]
    if (historical === undefined) throw new Error('no superseded narrative body')

    const res = await post('/api/settings/prompts', {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: historical,
      activate: true,
    })
    expect(res.statusCode).toBe(409)

    // Saving it is still fine, and it reads as needing a check rather than as Balancr's own.
    const saved = await post('/api/settings/prompts', {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: historical,
    })
    expect(saved.statusCode).toBe(200)
    const version = saved
      .json<Settings>()
      .prompts.find((p) => p.key === 'narrative.system' && p.locale === SHARED_LOCALE)
      ?.versions.find((v) => !v.active)
    expect(version?.gate).toBe('unvalidated')
  })

  it('gates the analysis prompt too, under locked, the default (#468)', async () => {
    // Before #468 this key was never gated at all. `locked` is what the test environment
    // defaults to, and under it a rewritten analysis body needs the same sign-off narrative
    // has always needed — an edit here does not get to skip the judge just because the
    // pass's output happens to be grounded against the signal table.
    const rewritten = 'Completely rewritten analysis instructions with nothing of mine left.'
    const refused = await post('/api/settings/prompts', {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body: rewritten,
      activate: true,
    })
    expect(refused.statusCode).toBe(409)

    preValidate('analysis.system', rewritten)
    const activated = await post('/api/settings/prompts', {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body: rewritten,
      activate: true,
    })
    expect(activated.statusCode).toBe(200)
  })

  it('prices a safety check on the free diff endpoint, spending nothing', async () => {
    const res = await post('/api/settings/prompts/diff', {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body: EDITED,
    })
    expect(res.statusCode).toBe(200)
    // The price a button shows before it is pressed. Local arithmetic — this endpoint
    // reaches no model, which is why it lives outside `routes/ai.ts`.
    expect(res.json<PromptDiff>().validationEstimateMicroEur).toBeGreaterThan(0)
  })
})

describe('GET /api/settings/ai/runs (#497)', () => {
  const run = (payloadHash: string, status: 'ok' | 'capped' = 'ok') => ({
    kind: 'findings' as const,
    provider: 'gemini-aistudio' as const,
    model: 'gemini-3.7-flash',
    locale: 'en',
    payload: { month: '2026-09' },
    payloadHash,
    status,
    requestText: `request for ${payloadHash}`,
    responseText: status === 'ok' ? `response for ${payloadHash}` : null,
  })

  it('refuses without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings/ai/runs' })
    expect(res.statusCode).toBe(401)
  })

  it('lists every run, newest first, with no month scoping', async () => {
    const older = recordRun(ctx.db, tenantId, run('older'))
    const newer = recordRun(ctx.db, tenantId, run('newer', 'capped'))
    ctx.db.$client
      .prepare('update ai_runs set created_at = ? where id = ?')
      .run(new Date('2026-08-01T00:00:00Z').getTime(), older)
    ctx.db.$client
      .prepare('update ai_runs set created_at = ? where id = ?')
      .run(new Date('2026-09-01T00:00:00Z').getTime(), newer)

    const res = await get('/api/settings/ai/runs')

    expect(res.statusCode).toBe(200)
    const body = res.json<{ runs: { id: string; status: string }[] }>()
    expect(body.runs.map((r) => r.id)).toEqual([newer, older])
  })

  it("does not carry another tenant's runs", async () => {
    const otherTenantId = createSecondTenant(ctx.db)
    recordRun(ctx.db, otherTenantId, run('other-tenant'))

    const body = (await get('/api/settings/ai/runs')).json<{ runs: unknown[] }>()
    expect(body.runs).toHaveLength(0)
  })

  it('is readable by a viewer, like the payload route it complements', async () => {
    recordRun(ctx.db, tenantId, run('viewer-visible'))
    const res = await get('/api/settings/ai/runs', viewer)
    expect(res.statusCode).toBe(200)
  })

  it('hands back a cursor once there are more runs than fit on one page, and paging with it reaches the rest (#502)', async () => {
    // The route's own page is 50 rows; 51 runs is the smallest fixture that
    // forces a `nextCursor` rather than returning everything on page one.
    const ids: string[] = []
    for (let i = 0; i < 51; i += 1) {
      const id = recordRun(ctx.db, tenantId, run(`run-${i}`))
      ctx.db.$client
        .prepare('update ai_runs set created_at = ? where id = ?')
        .run(new Date(2026, 7, 1, 0, 0, i).getTime(), id)
      ids.push(id)
    }
    const oldest = ids[0]!

    const firstPage = (await get('/api/settings/ai/runs')).json<{
      runs: { id: string }[]
      nextCursor: string | null
    }>()
    expect(firstPage.runs).toHaveLength(50)
    expect(firstPage.nextCursor).not.toBeNull()
    expect(firstPage.runs.map((r) => r.id)).not.toContain(oldest)

    const secondPage = (
      await get(`/api/settings/ai/runs?before=${firstPage.nextCursor}`)
    ).json<{ runs: { id: string }[]; nextCursor: string | null }>()
    expect(secondPage.runs.map((r) => r.id)).toEqual([oldest])
    expect(secondPage.nextCursor).toBeNull()
  })

  it('resolves ?before= to that run and returns everything strictly older than it (#502)', async () => {
    const older = recordRun(ctx.db, tenantId, run('older'))
    const middle = recordRun(ctx.db, tenantId, run('middle'))
    const newest = recordRun(ctx.db, tenantId, run('newest'))
    for (const [id, day] of [
      [older, '01'],
      [middle, '02'],
      [newest, '03'],
    ] as const) {
      ctx.db.$client
        .prepare('update ai_runs set created_at = ? where id = ?')
        .run(new Date(`2026-08-${day}T00:00:00Z`).getTime(), id)
    }

    const body = (await get(`/api/settings/ai/runs?before=${newest}`)).json<{
      runs: { id: string }[]
      nextCursor: string | null
    }>()
    expect(body.runs.map((r) => r.id)).toEqual([middle, older])
    expect(body.nextCursor).toBeNull()
  })

  it('treats an unresolvable cursor as the end of the log, not a fresh start (#502)', async () => {
    recordRun(ctx.db, tenantId, run('only-run'))

    const body = (await get('/api/settings/ai/runs?before=does-not-exist')).json<{
      runs: unknown[]
      nextCursor: string | null
    }>()
    expect(body.runs).toEqual([])
    expect(body.nextCursor).toBeNull()
  })

  it("does not resolve another tenant's run id as a cursor (#502)", async () => {
    const otherTenantId = createSecondTenant(ctx.db)
    const otherTenantRun = recordRun(ctx.db, otherTenantId, run('other-tenants-run'))
    recordRun(ctx.db, tenantId, run('mine'))

    const res = await get(`/api/settings/ai/runs?before=${otherTenantRun}`)
    expect(res.statusCode).toBe(200)
    expect(res.json<{ runs: unknown[] }>().runs).toEqual([])
  })

  it('rejects a non-string before', async () => {
    const res = await get('/api/settings/ai/runs?before=a&before=b')
    expect(res.statusCode).toBe(400)
  })
})
