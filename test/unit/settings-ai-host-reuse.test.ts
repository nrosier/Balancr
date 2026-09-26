/**
 * #579 (S1): a stored AI API key must not survive a changed `openai-compatible`
 * base-url host, the same way #535 already treats a changed Actual/Ghostfolio
 * host as secret-invalidating — a key verified against one operator-approved
 * endpoint must not follow the connection to a different one, even though the
 * provider itself (`openai-compatible`) hasn't changed.
 *
 * Exercising this needs two distinct hosts in `EGRESS_EXTRA_HOSTS`, which
 * `config.ts` only reads once at import time — so, like
 * `openai-compatible-client.test.ts`'s own test for the same setting, this file
 * stubs the env and reloads the whole module graph via `vi.resetModules()`
 * before importing anything that reads it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import type { Db } from '../../src/db/index.ts'
import type { Settings } from '../../src/server/routes/api/schemas.ts'

type IntegrationTest = { ok: boolean; message: string | null }

vi.stubEnv('EGRESS_EXTRA_HOSTS', 'proxy1.internal,proxy2.internal')
vi.resetModules()

const { tenantIntegrations, users } = await import('../../src/db/schema.ts')
const { decryptField } = await import('../../src/db/field-crypto.ts')
const { getSoleTenantId } = await import('../../src/db/tenant.ts')
const { buildApp } = await import('../../src/server/app.ts')
const { createSession } = await import('../../src/server/auth/sessions.ts')
const { CSRF_COOKIE, SESSION_COOKIE } = await import('../../src/server/cookies.ts')
const { CSRF_HEADER, newCsrfToken } = await import('../../src/server/csrf.ts')
const { initI18n } = await import('../../src/i18n/index.ts')
const { apiFixture } = await import('../helpers/api-fixture.ts')

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string

function signIn(db: Db): string {
  const row = db
    .insert(users)
    .values({
      tenantId: getSoleTenantId(db),
      oidcSub: `sub-${crypto.randomUUID()}`,
      email: 'owner@example.test',
      displayName: 'owner',
      locale: 'en',
      role: 'owner',
    })
    .returning()
    .all()[0]
  if (row === undefined) throw new Error('inserting the user returned no row')
  return createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined }).token
}

function patch(url: string, body: object) {
  const csrf = newCsrfToken()
  return app.inject({
    method: 'PATCH',
    url,
    payload: body,
    cookies: { [SESSION_COOKIE]: owner, [CSRF_COOKIE]: csrf },
    headers: { [CSRF_HEADER]: csrf },
  })
}

function post(url: string, body: object) {
  const csrf = newCsrfToken()
  return app.inject({
    method: 'POST',
    url,
    payload: body,
    cookies: { [SESSION_COOKIE]: owner, [CSRF_COOKIE]: csrf },
    headers: { [CSRF_HEADER]: csrf },
  })
}

/** The one `tenant_integrations` row, read fresh — never trusted from before a write. */
function row(db: Db) {
  const tenantId = getSoleTenantId(db)
  const found = db.select().from(tenantIntegrations).where(eq(tenantIntegrations.tenantId, tenantId)).all()[0]
  if (found === undefined) throw new Error('no tenantIntegrations row')
  return found
}

const openaiCompatibleBody = (baseUrl: string, apiKey?: string) => ({
  provider: 'openai-compatible' as const,
  ...(apiKey === undefined ? {} : { apiKey }),
  googleCloudProject: null,
  baseUrl,
  modelFast: 'local-model',
  modelDeep: 'local-model',
  modelPrices: {
    'local-model': { inputEur: 0, cachedInputEur: 0, cacheWriteInputEur: 0, outputEur: 0 },
  },
  budgetEur: 15,
})

beforeAll(async () => {
  await initI18n()
})

beforeEach(async () => {
  ctx = apiFixture({ empty: true })
  app = await buildApp({ db: ctx.db, web: null })
  owner = signIn(ctx.db)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await app.close()
  ctx.sqlite.close()
})

describe('PATCH /api/settings/integrations/ai (#579)', () => {
  it('drops the stored key when the openai-compatible base URL host changes without a new one', async () => {
    const first = await patch(
      '/api/settings/integrations/ai',
      openaiCompatibleBody('https://proxy1.internal/v1', 'first-key'),
    )
    expect(first.statusCode).toBe(200)
    expect(decryptField(row(ctx.db).aiApiKeyEnc as string)).toBe('first-key')

    const second = await patch('/api/settings/integrations/ai', openaiCompatibleBody('https://proxy2.internal/v1'))

    expect(second.statusCode).toBe(200)
    // The bug this guards: before #579, only a provider change cleared the stored
    // key — a base-url change within the same `openai-compatible` provider left it
    // in place, so the key typed for proxy1 would be sent to proxy2 on the next run.
    expect(row(ctx.db).aiApiKeyEnc).toBeNull()
  })

  it('keeps the stored key when the openai-compatible base URL is unchanged', async () => {
    await patch('/api/settings/integrations/ai', openaiCompatibleBody('https://proxy1.internal/v1', 'first-key'))
    await patch('/api/settings/integrations/ai', openaiCompatibleBody('https://proxy1.internal/v1'))

    expect(decryptField(row(ctx.db).aiApiKeyEnc as string)).toBe('first-key')
  })
})

describe('POST /api/settings/integrations/ai/test (#579)', () => {
  it('does not fall back to a key stored for a different openai-compatible host', async () => {
    await patch('/api/settings/integrations/ai', openaiCompatibleBody('https://proxy1.internal/v1', 'stored-key'))
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      model: 'local-model',
      choices: [{ message: { content: '{"balancr_probe":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }))
    vi.stubGlobal('fetch', fetch)

    const res = await post('/api/settings/integrations/ai/test', {
      provider: 'openai-compatible',
      baseUrl: 'https://proxy2.internal/v1',
      model: 'local-model',
    })

    expect(res.statusCode).toBe(200)
    // The bug this guards: before #579, a stored key was reused whenever the
    // provider matched, regardless of host — this call would otherwise carry
    // `Authorization: Bearer stored-key`, verified only against proxy1, straight to
    // proxy2 instead of going out unauthenticated as a genuinely unconfigured
    // connection should.
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBeNull()
  })

  it('falls back to the stored key for a candidate that keeps the same openai-compatible host', async () => {
    await patch('/api/settings/integrations/ai', openaiCompatibleBody('https://proxy1.internal/v1', 'stored-key'))
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({
      model: 'local-model',
      choices: [{ message: { content: '{"balancr_probe":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }))
    vi.stubGlobal('fetch', fetch)

    const res = await post('/api/settings/integrations/ai/test', {
      provider: 'openai-compatible',
      baseUrl: 'https://proxy1.internal/v1',
      model: 'local-model',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json<IntegrationTest>()).toEqual({ ok: true, message: null })
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer stored-key')
  })
})

// Confirms the settings payload itself still parses after both PATCHes above — the
// class of bug #578 fixed for `budgetEur`/`modelPrices` would show up here too if it
// ever regressed for the AI base URL/key fields.
describe('GET /api/settings (#579)', () => {
  it('still parses after a host change clears the stored key', async () => {
    await patch('/api/settings/integrations/ai', openaiCompatibleBody('https://proxy1.internal/v1', 'first-key'))
    await patch('/api/settings/integrations/ai', openaiCompatibleBody('https://proxy2.internal/v1'))

    const res = await app.inject({ method: 'GET', url: '/api/settings', cookies: { [SESSION_COOKIE]: owner } })
    expect(res.statusCode).toBe(200)
    expect(res.json<Settings>().integrations.ai.apiKeyConfigured).toBe(false)
  })
})
