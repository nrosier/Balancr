/**
 * The Actual/Ghostfolio/AI connection screen (#369, #422) — the one settings page whose
 * fields are secrets.
 *
 * Three claims matter here, none of which is "the form saves":
 *
 *  - **A secret is never on the wire.** Not in `GET /api/settings`, not in a PATCH
 *    response, not in the audit trail a PATCH writes. `*Configured` booleans stand in
 *    for the value everywhere a value would otherwise be echoed back.
 *  - **Omitting a secret key leaves the stored ciphertext untouched; sending `''` is
 *    refused, never treated as "clear it."** The only way a stored secret changes is
 *    a request that actually types a new one.
 *  - **A test-connection call never saves anything and never throws for a bad
 *    credential.** A wrong password is the expected outcome of a test, not a server
 *    error — and it is refused outright while a job is in flight, because Actual's
 *    client is a process-wide singleton a live sync must not share.
 *
 * Ghostfolio's test route makes a real `fetch`; Gemini's builds a real `GoogleGenAI`.
 * Both are mocked here the same way `ghostfolio-adapter.test.ts` mocks the network:
 * `vi.stubGlobal('fetch', ...)` for Ghostfolio, `vi.mock('@google/genai', ...)` for
 * Gemini. Actual's test route forks a real child process (`test-connection.ts`), which
 * a same-process mock cannot reach — so that module is mocked at its import boundary
 * instead, the same way any other adapter call a route makes is mocked when testing
 * the route rather than the adapter.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import type { Db } from '../../src/db/index.ts'
import { decryptField } from '../../src/db/field-crypto.ts'
import { auditLog, categoryMeta, tenantIntegrations, users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { loadCategoryNames } from '../../src/domain/aggregate/facts.ts'
import { saveCategoryTranslation } from '../../src/domain/i18n/category-translations.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { runJob, type Job } from '../../src/jobs/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import type { ErrorBody } from '../../src/server/errors.ts'
import type { IntegrationTest, IntegrationsSetting, Settings } from '../../src/server/routes/api/schemas.ts'
import { apiFixture } from '../helpers/api-fixture.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

const genai = vi.hoisted(() => ({
  calls: [] as unknown[],
  behavior: 'ok' as 'ok' | 'fail',
  failMessage: 'The API key is not valid.',
}))

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn().mockImplementation(function (this: unknown, options: unknown) {
    genai.calls.push(options)
    return {
      models: {
        list: async () => {
          if (genai.behavior === 'fail') throw new Error(genai.failMessage)
          return { pageSize: 1 }
        },
      },
    }
  }),
}))

vi.mock('../../src/adapters/actual/test-connection.ts', () => ({
  testActualConnection: vi.fn(),
}))

import { testActualConnection } from '../../src/adapters/actual/test-connection.ts'
import { fetchAccounts, resetGhostfolioToken } from '../../src/adapters/ghostfolio/client.ts'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string
let viewer: string

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
  return createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined }).token
}

const get = (url: string, token = owner) =>
  app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: token } })

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

/** The one `tenant_integrations` row, read fresh — never trusted from before a write. */
function row(db: Db) {
  const tenantId = getSoleTenantId(db)
  const found = db.select().from(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId)).all()[0]
  if (found === undefined) throw new Error('no tenantIntegrations row')
  return found
}

const lastAudit = (db: Db) => db.select().from(auditLog).all().at(-1)

beforeAll(async () => {
  await initI18n()
})

beforeEach(async () => {
  ctx = apiFixture()
  app = await buildApp({ db: ctx.db, web: null })
  owner = signIn(ctx.db, 'owner')
  viewer = signIn(ctx.db, 'viewer')
  genai.calls = []
  genai.behavior = 'ok'
  vi.mocked(testActualConnection).mockReset()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  resetGhostfolioToken()
  await app.close()
  ctx.sqlite.close()
})

describe('GET /api/settings', () => {
  it('describes what is stored and which secrets are set, never a secret itself', async () => {
    const settings = (await get('/api/settings')).json<Settings>()

    expect(settings.integrations).toEqual({
      actual: {
        serverUrl: 'http://actual.test:5006',
        syncId: 'test-sync-id',
        passwordConfigured: true,
        e2ePasswordConfigured: false,
        categorySourceLocale: 'en',
      },
      ghostfolio: { url: 'http://ghostfolio.test:3333', tokenConfigured: true },
      ai: {
        provider: 'gemini-aistudio',
        apiKeyConfigured: true,
        googleCloudProject: null,
        baseUrl: null,
        modelFast: 'gemini-3.7-flash',
        modelDeep: 'gemini-3.1-pro-preview',
        modelPrices: {},
        budgetEurMicro: 15_000_000,
      },
    } satisfies IntegrationsSetting)
  })

  it('never puts a raw secret anywhere in the response body', async () => {
    const body = (await get('/api/settings')).body
    expect(body).not.toContain('test-password')
    expect(body).not.toContain('test-token')
    expect(body).not.toContain('test-key')
  })
})

describe('PATCH /api/settings/integrations/actual', () => {
  it('updates the plain fields and answers with the whole settings payload', async () => {
    const res = await patch('/api/settings/integrations/actual', {
      serverUrl: 'http://actual2.test:5006',
      syncId: 'sync-id-2',
      categorySourceLocale: 'en',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().integrations.actual.serverUrl).toBe('http://actual2.test:5006')
    expect(row(ctx.db).actualSyncId).toBe('sync-id-2')
  })

  it('leaves the stored password untouched when the key is omitted and the host is unchanged', async () => {
    await patch('/api/settings/integrations/actual', {
      serverUrl: 'http://actual.test:5006',
      syncId: 'test-sync-id',
      categorySourceLocale: 'en',
    })

    expect(decryptField(row(ctx.db).actualPasswordEnc)).toBe('test-password')
  })

  it('invalidates the stored password and e2e password when the server URL host changes without a new one (#535)', async () => {
    const res = await patch('/api/settings/integrations/actual', {
      serverUrl: 'http://actual2.test:5006',
      syncId: 'test-sync-id',
      categorySourceLocale: 'en',
    })

    expect(res.statusCode).toBe(200)
    const settings = res.json<Settings>().integrations.actual
    expect(settings.passwordConfigured).toBe(false)
    expect(settings.e2ePasswordConfigured).toBe(false)
    expect(row(ctx.db).actualPasswordEnc).toBe('')
    expect(row(ctx.db).actualE2ePasswordEnc).toBeNull()
  })

  it('does not invalidate the stored password when the server URL changes without changing host', async () => {
    await patch('/api/settings/integrations/actual', {
      serverUrl: 'http://actual.test:5006/',
      syncId: 'test-sync-id',
      categorySourceLocale: 'en',
    })

    expect(decryptField(row(ctx.db).actualPasswordEnc)).toBe('test-password')
  })

  it('replaces the stored password only when one is typed', async () => {
    const res = await patch('/api/settings/integrations/actual', {
      serverUrl: 'http://actual.test:5006',
      syncId: 'test-sync-id',
      categorySourceLocale: 'en',
      password: 'new-password',
    })

    expect(res.json<Settings>().integrations.actual.passwordConfigured).toBe(true)
    expect(decryptField(row(ctx.db).actualPasswordEnc)).toBe('new-password')
  })

  it('sets, then clears back to unconfigured is not possible — an e2e password can only be replaced', async () => {
    const res = await patch('/api/settings/integrations/actual', {
      serverUrl: 'http://actual.test:5006',
      syncId: 'test-sync-id',
      categorySourceLocale: 'en',
      e2ePassword: 'e2e-secret',
    })

    expect(res.json<Settings>().integrations.actual.e2ePasswordConfigured).toBe(true)
    expect(decryptField(row(ctx.db).actualE2ePasswordEnc as string)).toBe('e2e-secret')
  })

  it('updates the category source locale', async () => {
    const res = await patch('/api/settings/integrations/actual', {
      serverUrl: 'http://actual.test:5006',
      syncId: 'test-sync-id',
      categorySourceLocale: 'nl',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().integrations.actual.categorySourceLocale).toBe('nl')
    expect(row(ctx.db).actualCategorySourceLocale).toBe('nl')
  })

  it('drops stale translations for a locale that becomes the new source locale', async () => {
    const tenantId = getSoleTenantId(ctx.db)
    ctx.db
      .insert(categoryMeta)
      .values({ tenantId, categoryId: 'groceries', nameSnapshot: 'Groceries', isIncome: false, hidden: false })
      .run()
    saveCategoryTranslation(ctx.db, tenantId, 'groceries', 'nl', 'Boodschappen')

    const res = await patch('/api/settings/integrations/actual', {
      serverUrl: 'http://actual.test:5006',
      syncId: 'test-sync-id',
      categorySourceLocale: 'nl',
    })

    expect(res.statusCode).toBe(200)
    // The now-source locale's name is the Actual snapshot; the stale override cannot be
    // left standing, since a translation for the source locale can no longer be written
    // (or cleared) through the ordinary route.
    expect(loadCategoryNames(ctx.db, tenantId, 'nl').get('groceries')).toBe('Groceries')
  })

  it('leaves other locales\' translations alone when the source locale changes', async () => {
    const tenantId = getSoleTenantId(ctx.db)
    ctx.db
      .insert(categoryMeta)
      .values({ tenantId, categoryId: 'groceries', nameSnapshot: 'Groceries', isIncome: false, hidden: false })
      .run()
    saveCategoryTranslation(ctx.db, tenantId, 'groceries', 'fr', 'Courses')

    await patch('/api/settings/integrations/actual', {
      serverUrl: 'http://actual.test:5006',
      syncId: 'test-sync-id',
      categorySourceLocale: 'nl',
    })

    expect(loadCategoryNames(ctx.db, tenantId, 'fr').get('groceries')).toBe('Courses')
  })

  it('refuses an unsupported category source locale', async () => {
    const res = await patch('/api/settings/integrations/actual', {
      serverUrl: 'http://actual.test:5006',
      syncId: 'test-sync-id',
      categorySourceLocale: 'xx',
    })

    expect(res.statusCode).toBe(400)
    expect(row(ctx.db).actualCategorySourceLocale).toBe('en')
  })

  it('refuses an empty server URL rather than storing a blank one', async () => {
    const res = await patch('/api/settings/integrations/actual', {
      serverUrl: '',
      syncId: 'test-sync-id',
      categorySourceLocale: 'en',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues?.map((issue) => issue.path)).toEqual(['serverUrl'])
    expect(row(ctx.db).actualServerUrl).toBe('http://actual.test:5006')
  })

  it('refuses a server URL that does not parse, rather than reading it as a host change (#535)', async () => {
    const res = await patch('/api/settings/integrations/actual', {
      serverUrl: 'not a url',
      syncId: 'test-sync-id',
      categorySourceLocale: 'en',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues?.map((issue) => issue.path)).toEqual(['serverUrl'])
    // The bug this guards: a malformed value used to fail `sameHost`'s `new URL`
    // the same way an actual host change would, wiping the stored secret over a
    // typo that never touched the DB.
    expect(row(ctx.db).actualServerUrl).toBe('http://actual.test:5006')
    expect(decryptField(row(ctx.db).actualPasswordEnc)).toBe('test-password')
  })

  it('refuses an empty password rather than treating it as "clear it"', async () => {
    const res = await patch('/api/settings/integrations/actual', {
      serverUrl: 'http://actual.test:5006',
      syncId: 'test-sync-id',
      categorySourceLocale: 'en',
      password: '',
    })
    expect(res.statusCode).toBe(400)
    expect(decryptField(row(ctx.db).actualPasswordEnc)).toBe('test-password')
  })

  it('records before/after as the configured-shape, never a secret', async () => {
    await patch('/api/settings/integrations/actual', {
      serverUrl: 'http://actual2.test:5006',
      syncId: 'test-sync-id',
      categorySourceLocale: 'en',
      password: 'new-password',
    })

    const entry = lastAudit(ctx.db)
    expect(entry?.action).toBe('settings.integrations')
    const afterJson = entry?.afterJson ?? '{}'
    expect(afterJson).not.toContain('new-password')
    expect(JSON.parse(afterJson)).toEqual({
      serverUrl: 'http://actual2.test:5006',
      syncId: 'test-sync-id',
      passwordConfigured: true,
      e2ePasswordConfigured: false,
      categorySourceLocale: 'en',
    })
  })

  it('is refused for a viewer', async () => {
    const res = await patch(
      '/api/settings/integrations/actual',
      { serverUrl: 'http://actual2.test:5006', syncId: 'test-sync-id', categorySourceLocale: 'en' },
      { token: viewer },
    )
    expect(res.statusCode).toBe(403)
    expect(row(ctx.db).actualServerUrl).toBe('http://actual.test:5006')
  })
})

describe('PATCH /api/settings/integrations/ghostfolio', () => {
  it('updates the URL and leaves the token untouched when omitted and the host is unchanged', async () => {
    const res = await patch('/api/settings/integrations/ghostfolio', { url: 'http://ghostfolio.test:3333/' })

    expect(res.statusCode).toBe(200)
    // Trailing slash normalized away (#535's shared `integrationUrl` validator) — the
    // origin, not the exact string, is what `sameHost` below judges "unchanged" by.
    expect(res.json<Settings>().integrations.ghostfolio.url).toBe('http://ghostfolio.test:3333')
    expect(decryptField(row(ctx.db).ghostfolioSecurityTokenEnc)).toBe('test-token')
  })

  it('invalidates the stored token when the URL host changes without a new one (#535)', async () => {
    const res = await patch('/api/settings/integrations/ghostfolio', { url: 'http://ghostfolio2.test:3333' })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().integrations.ghostfolio.tokenConfigured).toBe(false)
    expect(row(ctx.db).ghostfolioSecurityTokenEnc).toBe('')
  })

  it('drops the cached JWT on a host change, so a stale token is never sent to the new host (#535)', async () => {
    const tenantId = getSoleTenantId(ctx.db)
    let authCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const path = new URL(String(input)).pathname
        if (path === '/api/v1/auth/anonymous') {
          authCalls += 1
          return Response.json({ authToken: 'jwt' })
        }
        return Response.json({ accounts: [] })
      }),
    )

    await fetchAccounts(ctx.db, tenantId)
    expect(authCalls).toBe(1)
    // Still cached — a second read of the same tenant must not re-authenticate.
    await fetchAccounts(ctx.db, tenantId)
    expect(authCalls).toBe(1)

    const res = await patch('/api/settings/integrations/ghostfolio', {
      url: 'http://ghostfolio2.test:3333',
      securityToken: 'new-token',
    })
    expect(res.statusCode).toBe(200)

    // The bug this guards: without the PATCH handler dropping the in-memory cache
    // alongside the DB row, this read would reuse the JWT minted for the old host
    // and hand it to the new, unverified one instead of authenticating fresh.
    await fetchAccounts(ctx.db, tenantId)
    expect(authCalls).toBe(2)
  })

  it('replaces the stored token only when one is typed', async () => {
    await patch('/api/settings/integrations/ghostfolio', {
      url: 'http://ghostfolio.test:3333',
      securityToken: 'new-token',
    })

    expect(decryptField(row(ctx.db).ghostfolioSecurityTokenEnc)).toBe('new-token')
  })

  it('refuses an empty URL', async () => {
    const res = await patch('/api/settings/integrations/ghostfolio', { url: '' })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues?.map((issue) => issue.path)).toEqual(['url'])
  })

  it('refuses a URL that does not parse, rather than reading it as a host change (#535)', async () => {
    const res = await patch('/api/settings/integrations/ghostfolio', { url: 'not a url' })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues?.map((issue) => issue.path)).toEqual(['url'])
    expect(row(ctx.db).ghostfolioUrl).toBe('http://ghostfolio.test:3333')
    expect(decryptField(row(ctx.db).ghostfolioSecurityTokenEnc)).toBe('test-token')
  })

  it('is refused for a viewer', async () => {
    const res = await patch(
      '/api/settings/integrations/ghostfolio',
      { url: 'http://ghostfolio2.test:3333' },
      { token: viewer },
    )
    expect(res.statusCode).toBe(403)
    expect(row(ctx.db).ghostfolioUrl).toBe('http://ghostfolio.test:3333')
  })
})

describe('PATCH /api/settings/integrations/ai', () => {
  const modelFields = { modelFast: 'gemini-3.7-flash', modelDeep: 'gemini-3.1-pro-preview', budgetEur: 15 }

  it('replaces the stored API key only when one is typed', async () => {
    const res = await patch('/api/settings/integrations/ai', {
      provider: 'gemini-aistudio',
      googleCloudProject: null,
      apiKey: 'new-key',
      ...modelFields,
    })

    expect(res.statusCode).toBe(200)
    expect(decryptField(row(ctx.db).aiApiKeyEnc as string)).toBe('new-key')
  })

  it('leaves the stored API key untouched when omitted', async () => {
    await patch('/api/settings/integrations/ai', {
      provider: 'gemini-aistudio',
      googleCloudProject: null,
      ...modelFields,
    })
    expect(decryptField(row(ctx.db).aiApiKeyEnc as string)).toBe('test-key')
  })

  it('sends null, not an empty string, to clear the Google Cloud project', async () => {
    await patch('/api/settings/integrations/ai', {
      provider: 'gemini-vertex',
      googleCloudProject: 'my-project',
      ...modelFields,
    })
    expect(row(ctx.db).googleCloudProject).toBe('my-project')

    await patch('/api/settings/integrations/ai', {
      provider: 'gemini-aistudio',
      googleCloudProject: null,
      ...modelFields,
    })
    expect(row(ctx.db).googleCloudProject).toBeNull()
  })

  it('refuses an empty-string Google Cloud project rather than storing a blank one', async () => {
    const res = await patch('/api/settings/integrations/ai', {
      provider: 'gemini-vertex',
      googleCloudProject: '',
      ...modelFields,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json<ErrorBody>().error.issues?.map((issue) => issue.path)).toEqual(['googleCloudProject'])
  })

  it('updates the model names and the monthly budget', async () => {
    const res = await patch('/api/settings/integrations/ai', {
      provider: 'gemini-aistudio',
      googleCloudProject: null,
      modelFast: 'gemini-flash-lite',
      modelDeep: 'gemini-pro',
      modelPrices: {
        'gemini-flash-lite': { inputEur: 0.1, cachedInputEur: 0.01, cacheWriteInputEur: 0.1, outputEur: 0.2 },
        'gemini-pro': { inputEur: 1, cachedInputEur: 0.1, cacheWriteInputEur: 1, outputEur: 2 },
      },
      budgetEur: 42,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().integrations.ai).toMatchObject({
      modelFast: 'gemini-flash-lite',
      modelDeep: 'gemini-pro',
      budgetEurMicro: 42_000_000,
    })
    expect(row(ctx.db).aiModelFast).toBe('gemini-flash-lite')
    expect(row(ctx.db).aiModelDeep).toBe('gemini-pro')
    expect(row(ctx.db).aiMonthlyBudgetEurMicro).toBe(42_000_000)
  })

  it('stores an OpenAI preset with its fixed official URL and a provider-scoped key', async () => {
    const res = await patch('/api/settings/integrations/ai', {
      provider: 'openai',
      apiKey: 'openai-key',
      googleCloudProject: null,
      baseUrl: null,
      modelFast: 'gpt-5.4-mini',
      modelDeep: 'gpt-5.4',
      modelPrices: {},
      budgetEur: 25,
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().integrations.ai).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyConfigured: true,
    })
    expect(row(ctx.db).aiBaseUrl).toBeNull()
    expect(decryptField(row(ctx.db).aiApiKeyEnc as string)).toBe('openai-key')
  })

  it('stores the Anthropic preset while keeping its key out of responses and audit records', async () => {
    const res = await patch('/api/settings/integrations/ai', {
      provider: 'anthropic',
      apiKey: 'anthropic-key',
      googleCloudProject: null,
      baseUrl: null,
      modelFast: 'claude-sonnet-5',
      modelDeep: 'claude-opus-5',
      modelPrices: {},
      budgetEur: 25,
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('anthropic-key')
    expect(res.json<Settings>().integrations.ai).toMatchObject({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKeyConfigured: true,
      modelFast: 'claude-sonnet-5',
      modelDeep: 'claude-opus-5',
    })
    expect(row(ctx.db).aiBaseUrl).toBeNull()
    expect(row(ctx.db).aiApiKeyEnc).not.toBe('anthropic-key')
    expect(decryptField(row(ctx.db).aiApiKeyEnc as string)).toBe('anthropic-key')
    expect(lastAudit(ctx.db)?.beforeJson).not.toContain('anthropic-key')
    expect(lastAudit(ctx.db)?.afterJson).not.toContain('anthropic-key')
  })

  it('refuses to override a certified preset URL', async () => {
    const res = await patch('/api/settings/integrations/ai', {
      provider: 'xai',
      apiKey: 'xai-key',
      googleCloudProject: null,
      baseUrl: 'https://proxy.example/v1',
      modelFast: 'grok-4.3',
      modelDeep: 'grok-4.3',
      modelPrices: {},
      budgetEur: 15,
    })
    expect(res.statusCode).toBe(400)
  })

  it('clears the old provider key when switching without typing a replacement', async () => {
    const res = await patch('/api/settings/integrations/ai', {
      provider: 'xai',
      googleCloudProject: null,
      baseUrl: null,
      modelFast: 'grok-4.3',
      modelDeep: 'grok-4.3',
      modelPrices: {},
      budgetEur: 15,
    })
    expect(res.statusCode).toBe(200)
    expect(row(ctx.db).aiApiKeyEnc).toBeNull()
  })

  it('requires an explicit price for unknown models and permits an explicit zero', async () => {
    const candidate = {
      provider: 'openai' as const,
      apiKey: 'openai-key',
      googleCloudProject: null,
      baseUrl: null,
      modelFast: 'private-free-model',
      modelDeep: 'private-free-model',
      budgetEur: 15,
    }
    const refused = await patch('/api/settings/integrations/ai', { ...candidate, modelPrices: {} })
    expect(refused.statusCode).toBe(400)
    expect(refused.json<ErrorBody>().error.message).toContain('explicit price')

    const accepted = await patch('/api/settings/integrations/ai', {
      ...candidate,
      modelPrices: {
        'private-free-model': { inputEur: 0, cachedInputEur: 0, cacheWriteInputEur: 0, outputEur: 0 },
      },
    })
    expect(accepted.statusCode).toBe(200)
    expect(JSON.parse(row(ctx.db).aiModelPricesJson)).toMatchObject({
      'private-free-model': { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0 },
    })
  })

  it('is refused for a viewer', async () => {
    const res = await patch(
      '/api/settings/integrations/ai',
      { provider: 'gemini-vertex', googleCloudProject: 'my-project', ...modelFields },
      { token: viewer },
    )
    expect(res.statusCode).toBe(403)
    expect(row(ctx.db).aiProvider).toBe('gemini-aistudio')
  })
})

// No cross-tenant isolation test for the three PATCH handlers above (actual/
// ghostfolio/gemini): #376 phase 3 correctly scopes each handler's own write to
// `user.tenantId`, but every one of them ends `return buildSettings(db, request)`,
// which transitively calls `loadParams(db)` (`domain/aggregate/params.ts`) — still
// calling `getSoleTenantId(db)` internally, and it throws the moment a second tenant
// exists, regardless of which tenant made the request. That's phase 4 scope. A test
// asserting isolation here would fail on that throw, not on anything phase 3 changed.

describe('POST /api/settings/integrations/actual/test', () => {
  it('reports success without writing anything to the stored row', async () => {
    vi.mocked(testActualConnection).mockResolvedValue({ ok: true, message: null })

    const res = await post('/api/settings/integrations/actual/test', {
      serverUrl: 'http://actual2.test:5006',
      syncId: 'other-sync',
      password: 'candidate-password',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<IntegrationTest>()).toEqual({ ok: true, message: null })
    expect(row(ctx.db).actualServerUrl).toBe('http://actual.test:5006')
    expect(vi.mocked(testActualConnection)).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'http://actual2.test:5006', password: 'candidate-password' }),
    )
  })

  it('reports the failure message rather than throwing', async () => {
    vi.mocked(testActualConnection).mockResolvedValue({ ok: false, message: 'Wrong password.' })

    const res = await post('/api/settings/integrations/actual/test', {
      serverUrl: 'http://actual.test:5006',
      syncId: 'test-sync-id',
      password: 'wrong',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<IntegrationTest>()).toEqual({ ok: false, message: 'Wrong password.' })
  })

  it('refuses with 409 while a job is in flight, naming what is busy', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fakeJob: Job = {
      name: 'sync',
      schedule: { kind: 'interval', minutes: 60 },
      run: async () => {
        await gate
      },
    }
    const running = runJob(ctx.db, fakeJob, getSoleTenantId(ctx.db))

    const res = await post('/api/settings/integrations/actual/test', {
      serverUrl: 'http://actual.test:5006',
      syncId: 'test-sync-id',
      password: 'candidate',
    })

    expect(res.statusCode).toBe(409)
    expect(res.json<ErrorBody>().error.code).toBe('conflict')
    expect(vi.mocked(testActualConnection)).not.toHaveBeenCalled()

    release()
    await running
  })

  it("checks the requester's own tenant for a busy job, not another tenant's (#376 phase 3)", async () => {
    vi.mocked(testActualConnection).mockResolvedValue({ ok: true, message: null })
    const tenantB = createSecondTenant(ctx.db)

    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fakeJob: Job = {
      name: 'sync',
      schedule: { kind: 'interval', minutes: 60 },
      run: async () => {
        await gate
      },
    }
    // Tenant B has a job running. Before #376 phase 3, this route asked
    // `getSoleTenantId(db)` — which throws the moment a second tenant exists at all,
    // rather than silently checking the wrong tenant's jobs.
    const running = runJob(ctx.db, fakeJob, tenantB)

    const res = await post(
      '/api/settings/integrations/actual/test',
      { serverUrl: 'http://actual.test:5006', syncId: 'test-sync-id', password: 'candidate' },
      { token: owner },
    )

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(testActualConnection)).toHaveBeenCalled()

    release()
    await running
  })

  it('is refused for a viewer', async () => {
    const res = await post(
      '/api/settings/integrations/actual/test',
      { serverUrl: 'http://actual.test:5006', syncId: 'test-sync-id', password: 'candidate' },
      { token: viewer },
    )
    expect(res.statusCode).toBe(403)
    expect(vi.mocked(testActualConnection)).not.toHaveBeenCalled()
  })

  it('falls back to the stored password when none is typed and the candidate host matches the stored one (#382)', async () => {
    vi.mocked(testActualConnection).mockResolvedValue({ ok: true, message: null })

    const res = await post('/api/settings/integrations/actual/test', {
      serverUrl: 'http://actual.test:5006',
      syncId: 'other-sync',
    })

    expect(res.statusCode).toBe(200)
    expect(vi.mocked(testActualConnection)).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: 'http://actual.test:5006', password: 'test-password' }),
    )
  })

  it('refuses when neither a typed nor a stored password exists (#382)', async () => {
    ctx.db
      .update(tenantIntegrations)
      .set({ actualPasswordEnc: '' })
      .where(eq(tenantIntegrations.tenantId, getSoleTenantId(ctx.db)))
      .run()

    const res = await post('/api/settings/integrations/actual/test', {
      serverUrl: 'http://actual.test:5006',
      syncId: 'test-sync-id',
    })

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(testActualConnection)).not.toHaveBeenCalled()
  })

  it('never falls back to the stored password for a candidate host that does not match the stored one (#534)', async () => {
    vi.mocked(testActualConnection).mockResolvedValue({ ok: true, message: null })

    const res = await post('/api/settings/integrations/actual/test', {
      serverUrl: 'http://actual2.test:5006',
      syncId: 'other-sync',
    })

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(testActualConnection)).not.toHaveBeenCalled()
  })

  it('never falls back to the stored password for a candidate that only changes scheme (#534)', async () => {
    vi.mocked(testActualConnection).mockResolvedValue({ ok: true, message: null })

    const res = await post('/api/settings/integrations/actual/test', {
      serverUrl: 'https://actual.test:5006',
      syncId: 'other-sync',
    })

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(testActualConnection)).not.toHaveBeenCalled()
  })

  it('refuses a candidate server URL that embeds credentials (#534)', async () => {
    const res = await post('/api/settings/integrations/actual/test', {
      serverUrl: 'http://user:pass@actual.test:5006',
      syncId: 'test-sync-id',
      password: 'candidate',
    })

    expect(res.statusCode).toBe(400)
    expect(vi.mocked(testActualConnection)).not.toHaveBeenCalled()
  })
})

describe('POST /api/settings/integrations/ghostfolio/test', () => {
  function stubFetch(behavior: 'ok' | 'health-down' | 'auth-down'): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input))
        if (url.pathname === '/api/v1/health') {
          return new Response(JSON.stringify({ status: 'OK' }), {
            status: behavior === 'health-down' ? 503 : 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (url.pathname === '/api/v1/auth/anonymous') {
          return new Response(JSON.stringify({ authToken: 'jwt-1' }), {
            status: behavior === 'auth-down' ? 401 : 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(null, { status: 404 })
      }),
    )
  }

  it('reports success for a reachable, authenticating server', async () => {
    stubFetch('ok')

    const res = await post('/api/settings/integrations/ghostfolio/test', {
      url: 'http://ghostfolio2.test:3333',
      securityToken: 'candidate-token',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<IntegrationTest>()).toEqual({ ok: true, message: null })
    expect(row(ctx.db).ghostfolioUrl).toBe('http://ghostfolio.test:3333')
  })

  it('reports why the health check failed rather than throwing', async () => {
    stubFetch('health-down')

    const res = await post('/api/settings/integrations/ghostfolio/test', {
      url: 'http://ghostfolio2.test:3333',
      securityToken: 'candidate-token',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<IntegrationTest>()
    expect(body.ok).toBe(false)
    expect(body.message).toContain('503')
  })

  it('reports an authentication failure', async () => {
    stubFetch('auth-down')

    const res = await post('/api/settings/integrations/ghostfolio/test', {
      url: 'http://ghostfolio2.test:3333',
      securityToken: 'wrong-token',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<IntegrationTest>()
    expect(body.ok).toBe(false)
    expect(body.message).toContain('Authentication failed')
  })

  it('is refused for a viewer', async () => {
    stubFetch('ok')
    const res = await post(
      '/api/settings/integrations/ghostfolio/test',
      { url: 'http://ghostfolio2.test:3333', securityToken: 'candidate-token' },
      { token: viewer },
    )
    expect(res.statusCode).toBe(403)
  })

  it('falls back to the stored token when none is typed and the candidate host matches the stored one (#382)', async () => {
    stubFetch('ok')

    const res = await post('/api/settings/integrations/ghostfolio/test', {
      url: 'http://ghostfolio.test:3333',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<IntegrationTest>()).toEqual({ ok: true, message: null })
  })

  it('refuses when neither a typed nor a stored token exists (#382)', async () => {
    ctx.db
      .update(tenantIntegrations)
      .set({ ghostfolioSecurityTokenEnc: '' })
      .where(eq(tenantIntegrations.tenantId, getSoleTenantId(ctx.db)))
      .run()

    const res = await post('/api/settings/integrations/ghostfolio/test', {
      url: 'http://ghostfolio.test:3333',
    })

    expect(res.statusCode).toBe(400)
  })

  it('never falls back to the stored token for a candidate host that does not match the stored one (#534)', async () => {
    stubFetch('ok')

    const res = await post('/api/settings/integrations/ghostfolio/test', {
      url: 'http://ghostfolio2.test:3333',
    })

    expect(res.statusCode).toBe(400)
  })

  it('never falls back to the stored token for a candidate that only changes scheme (#534)', async () => {
    stubFetch('ok')

    const res = await post('/api/settings/integrations/ghostfolio/test', {
      url: 'https://ghostfolio.test:3333',
    })

    expect(res.statusCode).toBe(400)
  })

  it('refuses a candidate URL that embeds credentials (#534)', async () => {
    stubFetch('ok')

    const res = await post('/api/settings/integrations/ghostfolio/test', {
      url: 'http://user:pass@ghostfolio.test:3333',
      securityToken: 'candidate-token',
    })

    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/settings/integrations/ai/test', () => {
  it('reports success for a working AI Studio key', async () => {
    genai.behavior = 'ok'

    const res = await post('/api/settings/integrations/ai/test', {
      provider: 'gemini-aistudio',
      apiKey: 'candidate-key',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<IntegrationTest>()).toEqual({ ok: true, message: null })
    expect(genai.calls).toContainEqual({ apiKey: 'candidate-key' })
  })

  it('reports the SDK failure message rather than throwing', async () => {
    genai.behavior = 'fail'
    genai.failMessage = 'The API key is not valid.'

    const res = await post('/api/settings/integrations/ai/test', {
      provider: 'gemini-aistudio',
      apiKey: 'bad-key',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<IntegrationTest>()).toEqual({ ok: false, message: 'The API key is not valid.' })
  })

  it('requires a project to test a Vertex connection', async () => {
    const res = await post('/api/settings/integrations/ai/test', { provider: 'gemini-vertex' })
    expect(res.statusCode).toBe(400)
  })

  it('requires an API key to test an AI Studio connection when none is stored either', async () => {
    ctx.db
      .update(tenantIntegrations)
      .set({ aiApiKeyEnc: null })
      .where(eq(tenantIntegrations.tenantId, getSoleTenantId(ctx.db)))
      .run()

    const res = await post('/api/settings/integrations/ai/test', { provider: 'gemini-aistudio' })
    expect(res.statusCode).toBe(400)
  })

  it('falls back to the stored API key when none is typed (#382)', async () => {
    genai.behavior = 'ok'

    const res = await post('/api/settings/integrations/ai/test', { provider: 'gemini-aistudio' })

    expect(res.statusCode).toBe(200)
    expect(genai.calls).toContainEqual({ apiKey: 'test-key' })
  })

  it('builds a Vertex client from the candidate project, not the stored one', async () => {
    genai.behavior = 'ok'
    await post('/api/settings/integrations/ai/test', {
      provider: 'gemini-vertex',
      googleCloudProject: 'candidate-project',
    })
    expect(genai.calls).toContainEqual(
      expect.objectContaining({ vertexai: true, project: 'candidate-project' }),
    )
  })

  it('runs a minimal strict structured-output probe for OpenAI-compatible presets', async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => Response.json({
      model: 'gpt-5.4-mini',
      choices: [{ message: { content: '{"balancr_probe":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }))
    vi.stubGlobal('fetch', fetch)

    const res = await post('/api/settings/integrations/ai/test', {
      provider: 'openai',
      apiKey: 'candidate-key',
      baseUrl: null,
      model: 'gpt-5.4-mini',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<IntegrationTest>()).toEqual({ ok: true, message: null })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    expect(JSON.parse(String(init?.body)).response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true },
    })
  })

  it('runs Anthropic\'s native structured-output probe with a candidate key', async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => Response.json({
      model: 'claude-sonnet-5-20260901',
      content: [{ type: 'text', text: '{"balancr_probe":true}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }))
    vi.stubGlobal('fetch', fetch)

    const res = await post('/api/settings/integrations/ai/test', {
      provider: 'anthropic',
      apiKey: 'candidate-key',
      baseUrl: null,
      model: 'claude-sonnet-5',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<IntegrationTest>()).toEqual({ ok: true, message: null })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(new Headers(init?.headers).get('x-api-key')).toBe('candidate-key')
    expect(JSON.parse(String(init?.body)).output_config).toEqual({
      format: {
        type: 'json_schema',
        schema: expect.objectContaining({ required: ['balancr_probe'] }),
      },
    })
  })

  it('uses a stored Anthropic key only when Anthropic is the stored provider', async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => Response.json({
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: '{"balancr_probe":true}' }],
      stop_reason: 'end_turn',
      usage: {},
      seenKey: new Headers(init?.headers).get('x-api-key'),
    }))
    vi.stubGlobal('fetch', fetch)

    const wrongProvider = await post('/api/settings/integrations/ai/test', {
      provider: 'anthropic',
      baseUrl: null,
      model: 'claude-sonnet-5',
    })
    expect(wrongProvider.statusCode).toBe(400)
    expect(fetch).not.toHaveBeenCalled()

    await patch('/api/settings/integrations/ai', {
      provider: 'anthropic',
      apiKey: 'stored-anthropic-key',
      googleCloudProject: null,
      baseUrl: null,
      modelFast: 'claude-sonnet-5',
      modelDeep: 'claude-opus-5',
      modelPrices: {},
      budgetEur: 15,
    })
    const sameProvider = await post('/api/settings/integrations/ai/test', {
      provider: 'anthropic',
      baseUrl: null,
      model: 'claude-sonnet-5',
    })

    expect(sameProvider.statusCode).toBe(200)
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('x-api-key')).toBe('stored-anthropic-key')
  })

  it('reports when Anthropic ignores the required JSON schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'unsupported' }],
      stop_reason: 'end_turn',
      usage: {},
    })))

    const res = await post('/api/settings/integrations/ai/test', {
      provider: 'anthropic',
      apiKey: 'candidate-key',
      baseUrl: null,
      model: 'claude-sonnet-5',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<IntegrationTest>()).toMatchObject({ ok: false })
    expect(res.json<IntegrationTest>().message).toContain('Structured-output capability probe failed')
  })

  it('fails clearly when an endpoint ignores the strict response schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      model: 'grok-4.3',
      choices: [{ message: { content: 'unsupported' }, finish_reason: 'stop' }],
    })))

    const res = await post('/api/settings/integrations/ai/test', {
      provider: 'xai',
      apiKey: 'candidate-key',
      baseUrl: null,
      model: 'grok-4.3',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<IntegrationTest>()).toMatchObject({ ok: false })
    expect(res.json<IntegrationTest>().message).toContain('Structured-output capability probe failed')
  })

  it('is refused for a viewer', async () => {
    const res = await post(
      '/api/settings/integrations/ai/test',
      { provider: 'gemini-aistudio', apiKey: 'candidate-key' },
      { token: viewer },
    )
    expect(res.statusCode).toBe(403)
    expect(genai.calls).toHaveLength(0)
  })
})
