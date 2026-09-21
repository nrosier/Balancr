/**
 * #454 — `PROMPT_EDITING` as the HTTP layer actually enforces it.
 *
 * `promptEditingBlocks` and `requirePromptEditable` are unit-tested in
 * `server-settings.test.ts`, where they are cheap because they take the mode as an argument.
 * What that cannot prove is the *wiring*: that both prompt write routes consult the guard,
 * with the deployment's real setting, before doing anything. A pure function nobody called
 * would pass every test in the other file.
 *
 * So this one rebuilds the module graph with the variable set, the way `config-guards.test.ts`
 * does — `config.ts` validates at import and the result is frozen, so there is no cheaper way
 * to run a route under a non-default value.
 *
 * One file per mode is not worth it: `analysis_only` is the interesting one, because it has to
 * refuse one key and allow the other in the same process. `locked` differs from it only in the
 * one comparison the unit tests already cover exhaustively.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { Response as LightMyRequestResponse } from 'light-my-request'

const SHARED = '*'

interface Harness {
  app: FastifyInstance
  close: () => Promise<void>
  get: (url: string) => Promise<LightMyRequestResponse>
  post: (url: string, body?: object) => Promise<LightMyRequestResponse>
  promptEditing: string
  narrativeVersionId: () => string
}

/**
 * The app, built fresh under one `PROMPT_EDITING` value.
 *
 * Everything is imported *after* `resetModules`, so the server, the config and the fixture
 * all come from the same rebuilt graph — a module held across the reset would be talking to
 * the old frozen config.
 */
async function harnessWith(mode: string): Promise<Harness> {
  vi.resetModules()
  vi.stubEnv('PROMPT_EDITING', mode)

  const { config } = await import('../../src/config.ts')
  const { initI18n } = await import('../../src/i18n/index.ts')
  const { buildApp } = await import('../../src/server/app.ts')
  const { createSession } = await import('../../src/server/auth/sessions.ts')
  const { CSRF_COOKIE, SESSION_COOKIE } = await import('../../src/server/cookies.ts')
  const { CSRF_HEADER, newCsrfToken } = await import('../../src/server/csrf.ts')
  const { users } = await import('../../src/db/schema.ts')
  const { getSoleTenantId } = await import('../../src/db/tenant.ts')
  const { createPromptVersion } = await import('../../src/domain/ai/prompts.ts')
  const { apiFixture } = await import('../helpers/api-fixture.ts')

  await initI18n()
  const ctx = apiFixture()
  const tenantId = getSoleTenantId(ctx.db)
  const app = await buildApp({ db: ctx.db, web: null })

  const user = ctx.db
    .insert(users)
    .values({
      tenantId,
      oidcSub: `sub-${crypto.randomUUID()}`,
      email: 'owner@example.test',
      displayName: 'Owner',
      locale: 'en',
      role: 'owner',
    })
    .returning()
    .all()[0]
  if (user === undefined) throw new Error('inserting the user returned no row')
  const token = createSession(ctx.db, {
    userId: user.id,
    method: 'oidc',
    ip: undefined,
    userAgent: undefined,
  }).token

  return {
    app,
    promptEditing: config.PROMPT_EDITING,
    get: (url: string) =>
      app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: token } }),
    post: (url: string, body: object = {}) => {
      const csrf = newCsrfToken()
      return app.inject({
        method: 'POST',
        url,
        payload: body,
        cookies: { [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf },
        headers: { [CSRF_HEADER]: csrf },
      })
    },
    // A stored narrative version to try activating. Created through the domain function, so
    // it exists regardless of what the routes will allow.
    narrativeVersionId: () =>
      createPromptVersion(ctx.db, tenantId, {
        key: 'narrative.system',
        locale: SHARED,
        body: `My own narrative instructions ${crypto.randomUUID()}.`,
      }).id,
    close: async () => {
      await app.close()
      ctx.sqlite.close()
    },
  }
}

let harness: Harness

afterEach(async () => {
  await harness.close()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('PROMPT_EDITING=analysis_only', () => {
  beforeEach(async () => {
    harness = await harnessWith('analysis_only')
  })

  it('loads with the mode the environment asked for', () => {
    // Guards the harness itself: if the reset did not take, every assertion below would be
    // testing the `full` default and passing for the wrong reason.
    expect(harness.promptEditing).toBe('analysis_only')
  })

  it('refuses creating a narrative version with a 403 naming the setting', async () => {
    const res = await harness.post('/api/settings/prompts', {
      key: 'narrative.system',
      locale: SHARED,
      body: 'Instructions of my own.',
    })

    expect(res.statusCode).toBe(403)
    // `403` and not `409`: there is no state a caller can reach to make this succeed, and
    // only the deployment's operator can change it — in `.env`, not on this page.
    expect(res.json<{ error: { message: string } }>().error.message).toContain(
      'PROMPT_EDITING=analysis_only',
    )
  })

  it('refuses activating a narrative version, including one already stored', async () => {
    // The route that matters most: a version saved before the lock went on must not become
    // the one that runs.
    const id = harness.narrativeVersionId()
    const res = await harness.post(`/api/settings/prompts/${id}/activate`)
    expect(res.statusCode).toBe(403)
  })

  it('refuses a narrative version even with activate omitted, so no draft accumulates', async () => {
    // The lock is about writes, not only about activation: leaving drafts writable would fill
    // the version list with text this deployment has decided can never run.
    const res = await harness.post('/api/settings/prompts', {
      key: 'narrative.system',
      locale: 'nl',
      body: 'Mijn eigen instructies.',
      activate: false,
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses switching a narrative override off, which also changes what runs', async () => {
    // The hole this closes: `deactivateOverride` retires a language's override so
    // `resolvePrompt` falls back to the shared row — a different narrative body for that
    // language. The route even records `prompt.activate` in the audit trail, because that is
    // what it amounts to. Left unguarded, `PROMPT_EDITING=locked` would still let an owner
    // change the narrative instructions in force for a language, just from the other side.
    const res = await harness.post('/api/settings/prompts/narrative.system/nl/shared')
    expect(res.statusCode).toBe(403)
    expect(res.json<{ error: { message: string } }>().error.message).toContain(
      'PROMPT_EDITING=analysis_only',
    )
  })

  it('still allows switching an analysis override off', async () => {
    // Refused with a `409` rather than a `403`: the request is permitted, there is simply no
    // override on that language to retire. The distinction is the point — `analysis_only` has
    // not touched this key.
    const res = await harness.post('/api/settings/prompts/analysis.system/nl/shared')
    expect(res.statusCode).toBe(409)
  })

  it('still allows writing and activating an analysis version', async () => {
    // The whole reason this mode exists rather than only `locked`: the analysis pass's output
    // is grounded against the computed signals, so an edit there cannot invent a finding.
    const res = await harness.post('/api/settings/prompts', {
      key: 'analysis.system',
      locale: SHARED,
      body: 'You rank precomputed signals and never compute one.',
      activate: true,
    })
    expect(res.statusCode).toBe(200)
  })

  it('reports the mode on the settings payload, so the panel can disable the box', async () => {
    // The editor has to say why it is read-only. A panel that learned this only from a 403
    // would offer a textarea, accept typing into it, and refuse on save.
    const res = await harness.get('/api/settings')
    expect(res.statusCode).toBe(200)
    expect(res.json<{ promptEditing: string }>().promptEditing).toBe('analysis_only')
  })
})
