/**
 * #468 — `PROMPT_EDITING` as the HTTP layer actually enforces it.
 *
 * `isGatedKey` and `assertActivatable` are unit-tested in `ai-prompts.test.ts`, where they
 * are cheap because they take the mode as an argument. What that cannot prove is the
 * *wiring*: that the write routes and the analysis pass consult the guard with the
 * deployment's real setting, before doing anything. A pure function nobody called would
 * pass every test in that other file.
 *
 * So this one rebuilds the module graph with the variable set, the way `config-guards.test.ts`
 * does — `config.ts` validates at import and the result is frozen, so there is no cheaper way
 * to run a route under a non-default value.
 *
 * Since #468, neither mode blocks a write or pins a read: `full` and `locked` differ only in
 * which keys the judge gate applies to (`narrative.system` always; `analysis.system` only
 * under `locked`, the default) — never in whether a key is editable. There is no more
 * write-time `403` to test, so this file is about the gate's `409` on activation and the
 * analysis pass's own use-time refusal, not about a lock on the textarea.
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
  analysisVersionId: () => string
  activateLegacyNarrative: (body: string) => void
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
  const { prompts, users } = await import('../../src/db/schema.ts')
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
    // A stored, unverdicted narrative draft to try activating. Created through the domain
    // function with no `activate`, so it exists — unactivated — regardless of what the mode
    // will allow once activation is attempted.
    narrativeVersionId: () =>
      createPromptVersion(ctx.db, tenantId, {
        key: 'narrative.system',
        locale: SHARED,
        body: `My own narrative instructions ${crypto.randomUUID()}.`,
      }).id,
    // Same, for `analysis.system` — the key whose gate is the point of this file (#468).
    analysisVersionId: () =>
      createPromptVersion(ctx.db, tenantId, {
        key: 'analysis.system',
        locale: SHARED,
        body: `You rank precomputed signals ${crypto.randomUUID()}.`,
      }).id,
    // An *active*, edited, unchecked narrative row, inserted the way a build before #454 left
    // one — the state a legacy installation can be in and the only state in which the read
    // path's truthful (non-pinned) `gate` reporting is observable at all.
    // `createPromptVersion(activate: true)` cannot produce it: the save-time gate refuses,
    // correctly.
    activateLegacyNarrative: (body: string) => {
      ctx.db.insert(prompts).values({
        tenantId,
        key: 'narrative.system',
        locale: SHARED,
        version: 900,
        body,
        active: true,
      }).run()
    },
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

describe('PROMPT_EDITING=full', () => {
  beforeEach(async () => {
    harness = await harnessWith('full')
  })

  it('loads with the mode the environment asked for', () => {
    // Guards the harness itself: if the reset did not take, every assertion below would be
    // testing the `locked` default and passing for the wrong reason.
    expect(harness.promptEditing).toBe('full')
  })

  it('activates a fresh analysis version with no verdict, because full does not gate it (#468)', async () => {
    // "God mode": the one thing `full` is for. A body nobody has run past the judge still
    // becomes active.
    const id = harness.analysisVersionId()
    const res = await harness.post(`/api/settings/prompts/${id}/activate`)
    expect(res.statusCode).toBe(200)
  })

  it('still refuses activating a fresh narrative version with no verdict', async () => {
    // `narrative.system` is gated unconditionally — `full` only lifts the gate `locked`
    // adds on top for analysis, it does not touch the one key that was always gated.
    const id = harness.narrativeVersionId()
    const res = await harness.post(`/api/settings/prompts/${id}/activate`)
    expect(res.statusCode).toBe(409)
  })

  it('reports the mode on the settings payload', async () => {
    const res = await harness.get('/api/settings')
    expect(res.statusCode).toBe(200)
    expect(res.json<{ promptEditing: string }>().promptEditing).toBe('full')
  })

  it('dry-runs a named, unverdicted analysis version for real, because full does not gate it', async () => {
    const id = harness.analysisVersionId()
    const res = await harness.post('/api/ai/dry-run', { promptId: id })
    expect(res.statusCode).toBe(200)
    // Not the refusal reason `locked` would give the same request below — whatever this
    // returns, it tried to run rather than skipping on the gate.
    expect(res.json<{ reason: string | null }>().reason).not.toBe('prompt_unvalidated')
  })
})

describe('PROMPT_EDITING=locked', () => {
  beforeEach(async () => {
    harness = await harnessWith('locked')
  })

  it('loads with the mode the environment asked for', () => {
    expect(harness.promptEditing).toBe('locked')
  })

  it('refuses activating a fresh analysis version with no verdict (#468)', async () => {
    // The default's whole point: an edited analysis prompt needs the judge's sign-off
    // before it can run, same as narrative always has.
    const id = harness.analysisVersionId()
    const res = await harness.post(`/api/settings/prompts/${id}/activate`)
    expect(res.statusCode).toBe(409)
  })

  it('refuses activating a fresh narrative version with no verdict', async () => {
    const id = harness.narrativeVersionId()
    const res = await harness.post(`/api/settings/prompts/${id}/activate`)
    expect(res.statusCode).toBe(409)
  })

  it('reports the mode on the settings payload', async () => {
    const res = await harness.get('/api/settings')
    expect(res.statusCode).toBe(200)
    expect(res.json<{ promptEditing: string }>().promptEditing).toBe('locked')
  })

  it('skips a dry run of an unvalidated analysis version rather than blocking it', async () => {
    // There is no more write-time lock to bounce off — the id loads and the route runs.
    // What refuses is the analysis pass itself, at use time, the same way it always
    // refused an unsafe or unvalidated narrative: a `200` reporting `skipped`, not a `403`.
    const id = harness.analysisVersionId()
    const res = await harness.post('/api/ai/dry-run', { promptId: id })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ status: string; reason: string | null; promptId: string | null }>()
    expect(body.status).toBe('skipped')
    expect(body.reason).toBe('prompt_unvalidated')
    // The id it answers about is the one that was asked for, even though it refused to run
    // it — a dry run is a question about one specific version, and answering about a
    // different one (the built-in text) would be worse.
    expect(body.promptId).toBe(id)
  })

  it('reports a truthful, non-pinned gate for a legacy unvalidated active narrative row', async () => {
    // Before #454 an installation could have an active narrative row nobody ever ran past
    // the judge. #468 dropped the read-time pin that used to make this report `built_in`
    // regardless — the insights page now says what is actually going to run, unvalidated
    // included, since the judge gate (not a read-time substitution) is the only guard left.
    harness.activateLegacyNarrative('My own unchecked narrative instructions.')

    const res = await harness.get('/api/insights')
    expect(res.statusCode).toBe(200)
    expect(res.json<{ narrativePrompt: { gate: string } }>().narrativePrompt).toEqual({
      gate: 'unvalidated',
    })
  })
})
