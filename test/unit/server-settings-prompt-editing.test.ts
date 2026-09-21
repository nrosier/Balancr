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
    // A stored narrative version to try activating. Created through the domain function, so
    // it exists regardless of what the routes will allow.
    narrativeVersionId: () =>
      createPromptVersion(ctx.db, tenantId, {
        key: 'narrative.system',
        locale: SHARED,
        body: `My own narrative instructions ${crypto.randomUUID()}.`,
      }).id,
    // A stored analysis version, for the dry-run route's own refusal under `locked` (#455).
    analysisVersionId: () =>
      createPromptVersion(ctx.db, tenantId, {
        key: 'analysis.system',
        locale: SHARED,
        body: `You rank precomputed signals ${crypto.randomUUID()}.`,
      }).id,
    // An *active*, edited, unchecked narrative row, inserted the way a build before #454 left
    // one — which is the state the read-time pin (#455) exists for and the only state in
    // which the pin is observable. `createPromptVersion(activate: true)` cannot produce it:
    // the save-time gate refuses, correctly.
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

  it('reports the lock on the insights payload, so the review card can say why (#455)', async () => {
    // The banner slot in `Narrative.tsx` reads this. The active narrative row here is
    // somebody's own unchecked wording, and `gate` comes back `built_in` anyway — which is the
    // read-time pin working end to end: `resolvePrompt` answered with `DEFAULT_PROMPTS`, so
    // "written from the built-in instructions" is a true sentence about what will run rather
    // than a claim the UI makes on the deployment's behalf.
    harness.activateLegacyNarrative('My own unchecked narrative instructions.')

    const res = await harness.get('/api/insights')

    expect(res.statusCode).toBe(200)
    expect(
      res.json<{ narrativePrompt: { gate: string; locked: boolean } }>().narrativePrompt,
    ).toEqual({ gate: 'built_in', locked: true })
  })

  it('reports the mode on the settings payload, so the panel can disable the box', async () => {
    // The editor has to say why it is read-only. A panel that learned this only from a 403
    // would offer a textarea, accept typing into it, and refuse on save.
    const res = await harness.get('/api/settings')
    expect(res.statusCode).toBe(200)
    expect(res.json<{ promptEditing: string }>().promptEditing).toBe('analysis_only')
  })

  it('still dry-runs a named analysis version, because this mode has not touched that key', async () => {
    // The mirror of the `locked` case below. A `409` here is the fresh-fixture answer — no
    // aggregated month to price a run against — and what matters is that it is not a `403`.
    const res = await harness.post('/api/ai/dry-run', { promptId: harness.analysisVersionId() })
    expect(res.statusCode).not.toBe(403)
  })
})

/**
 * `locked`, which after #455 has behaviour of its own rather than being `analysis_only` with
 * one more comparison: both keys are pinned at read time, and the one route that reaches a
 * stored prompt without going through `resolvePrompt` has to refuse.
 */
describe('PROMPT_EDITING=locked', () => {
  beforeEach(async () => {
    harness = await harnessWith('locked')
  })

  it('loads with the mode the environment asked for', () => {
    expect(harness.promptEditing).toBe('locked')
  })

  it('refuses a dry run of a named analysis version (#455)', async () => {
    // The last door the read-time pin would otherwise leave open: `/api/ai/dry-run` accepts a
    // `promptId` and loads that row directly, so without this an owner of a locked deployment
    // could still send their own instructions to a model. `403`, naming the setting, rather
    // than silently answering about the built-in text — a dry run is a question about one
    // specific version, and quietly answering about a different one would be worse.
    const res = await harness.post('/api/ai/dry-run', { promptId: harness.analysisVersionId() })

    expect(res.statusCode).toBe(403)
    expect(res.json<{ error: { message: string } }>().error.message).toContain(
      'PROMPT_EDITING=locked',
    )
  })

  it('pins the analysis prompt too, not only the narrative one', async () => {
    // `locked` means every key, and the dry run with no `promptId` asks what the nightly job
    // would do — which is now the built-in text. A `409` for having no month is fine; a `403`
    // would mean the unnamed form had been caught by the guard above, which it must not be.
    const res = await harness.post('/api/ai/dry-run', {})
    expect(res.statusCode).not.toBe(403)
  })

  it('still reports a stored active version on the settings payload, not just the built-in text (#459)', async () => {
    // `active.body` is the built-in constant here — the pin working as intended. `storedBody`
    // is the separate fact the editor needs to avoid showing that as if it were the only thing
    // there is: something genuinely was saved, the lock just keeps it from running.
    harness.activateLegacyNarrative('My own unchecked narrative instructions.')

    const res = await harness.get('/api/settings')
    expect(res.statusCode).toBe(200)
    const narrative = res
      .json<{ prompts: { key: string; locale: string; active: { body: string }; storedBody: string | null }[] }>()
      .prompts.find((entry) => entry.key === 'narrative.system' && entry.locale === SHARED)

    expect(narrative?.active.body).not.toBe('My own unchecked narrative instructions.')
    expect(narrative?.storedBody).toBe('My own unchecked narrative instructions.')
  })

  it('reports storedBody as null when nothing was ever saved for a key', async () => {
    const res = await harness.get('/api/settings')
    expect(res.statusCode).toBe(200)
    const analysis = res
      .json<{ prompts: { key: string; locale: string; storedBody: string | null }[] }>()
      .prompts.find((entry) => entry.key === 'analysis.system' && entry.locale === SHARED)

    expect(analysis?.storedBody).toBeNull()
  })
})
