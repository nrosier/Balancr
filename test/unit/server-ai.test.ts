/**
 * The two endpoints that can spend money.
 *
 * Everything else in the HTTP layer reads SQLite, which is what makes the monthly
 * budget a limit rather than a hope. These two are the exception, so the tests are
 * about the fence rather than about the answer:
 *
 *  - **The estimate spends nothing.** No call, no ledger row. It is what the button
 *    shows before it is pressed, and a "free" estimate that quietly ran the analysis
 *    would be the most expensive tooltip ever written.
 *  - **A dry run costs money and says so.** The row is written and the cost counted
 *    whatever the outcome, including a failed call — an editor that showed a red box
 *    with no cost would hide the part that matters, and a run that skipped the
 *    ledger would be a way around the budget rather than a feature inside it.
 *  - **A dry run leaves nothing behind.** `persist: false` skips exactly what would
 *    outlive the request: the findings on the insights page and the questions in the
 *    clarification queue. Anything else it skipped would make the run a simulation
 *    of a different thing.
 *  - **A viewer cannot press it.** Reading the dashboard is reading; spending the
 *    month's allowance is not.
 *
 * `setGeminiClient` stands in for Google, as everywhere else: a test that reached the
 * API would cost money, need a key, and fail on a plane.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { GoogleGenAI } from '@google/genai'
import { setGeminiClient } from '../../src/adapters/gemini/client.ts'
import type { Db } from '../../src/db/index.ts'
import { aiFindings, aiNarratives, aiRuns, clarificationQueue, users } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { prepareMonth } from '../../src/domain/ai/analysis.ts'
import { SHARED_LOCALE } from '../../src/domain/ai/prompt-locale.ts'
import {
  createPromptVersion,
  DEFAULT_PROMPTS,
  storePromptValidation,
  VALIDATION_RULES_VERSION,
} from '../../src/domain/ai/prompts.ts'
import { ANALYSIS_RULE_IDS, NARRATIVE_RULE_IDS } from '../../src/domain/ai/schemas.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import { HttpError } from '../../src/server/errors.ts'
import { AI_RATE_LIMIT } from '../../src/server/rate-limit.ts'
import { dryRunPrompt } from '../../src/server/routes/ai.ts'
import type {
  AiDryRun,
  AiEstimate,
  AiNarrativeRun,
  PromptValidation,
} from '../../src/server/routes/api/schemas.ts'
import { apiFixture, MONTH } from '../helpers/api-fixture.ts'
import { createSecondTenant } from '../helpers/second-tenant.ts'

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
  return createSession(db, { userId: row.id, method: 'oidc', ip: undefined, userAgent: undefined })
    .token
}

/** Replies with one canned body, and counts the calls it was asked to make. */
function fakeGemini(reply: string | Error): { calls: number } {
  const recorded = { calls: 0 }
  const client = {
    models: {
      generateContent: async () => {
        recorded.calls += 1
        if (reply instanceof Error) throw reply
        return {
          text: reply,
          usageMetadata: { promptTokenCount: 2_000, candidatesTokenCount: 200 },
          modelVersion: 'gemini-3.7-flash-002',
        }
      },
    },
    caches: {
      create: async () => {
        throw new Error('too small to cache')
      },
    },
  }
  setGeminiClient(client as unknown as GoogleGenAI)
  return recorded
}

/** The opaque label the payload gave a category — what the model answers with. */
function labelFor(categoryId: string): string {
  const prepared = prepareMonth(ctx.db, getSoleTenantId(ctx.db), MONTH, 'en')
  if (prepared === null) throw new Error('the fixture month has no facts')
  const name = prepared.nameFor.get(categoryId) ?? ''
  for (const [label, candidate] of prepared.nameForLabel) {
    if (candidate === name) return label
  }
  throw new Error(`no label for ${categoryId}`)
}

const get = (url: string, token = owner) =>
  app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: token } })

function dryRun(body: object = {}, token = owner) {
  const csrf = newCsrfToken()
  return app.inject({
    method: 'POST',
    url: '/api/ai/dry-run',
    payload: body,
    cookies: { [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf },
    headers: { [CSRF_HEADER]: csrf },
  })
}

function narrative(body: object, token = owner) {
  const csrf = newCsrfToken()
  return app.inject({
    method: 'POST',
    url: '/api/ai/narrative',
    payload: body,
    cookies: { [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf },
    headers: { [CSRF_HEADER]: csrf },
  })
}

const runRows = (db: Db) => db.select().from(aiRuns).all()

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
  setGeminiClient(null)
  await app.close()
  ctx.sqlite.close()
})

describe('GET /api/ai/estimate', () => {
  it('prices the latest stored month without calling anything', async () => {
    const fake = fakeGemini('{}')
    const res = await get('/api/ai/estimate')
    expect(res.statusCode).toBe(200)

    const estimate = res.json<AiEstimate>()
    // The month the dashboard is showing, not "last month" as a date calculation:
    // on a deployment whose sync last ran in March, last month is empty.
    expect(estimate.month).toBe(MONTH)
    expect(estimate.payloadChars).toBeGreaterThan(0)
    expect(estimate.estimateMicroEur).toBeGreaterThan(0)
    expect(estimate.allowed).toBe(true)
    expect(estimate.reason).toBeNull()

    // The whole point of the endpoint.
    expect(fake.calls).toBe(0)
    expect(runRows(ctx.db)).toHaveLength(0)
  })

  it('answers honestly for a month with no facts rather than guessing a price', async () => {
    const res = await get('/api/ai/estimate?month=2019-01')
    expect(res.statusCode).toBe(200)

    const estimate = res.json<AiEstimate>()
    expect(estimate.payloadChars).toBeNull()
    expect(estimate.estimateMicroEur).toBe(0)
    expect(estimate.allowed).toBe(false)
    expect(estimate.reason).toBe('no_facts')
  })

  it('refuses a month that is not a month', async () => {
    const res = await get('/api/ai/estimate?month=August')
    expect(res.statusCode).toBe(400)
  })

  it('needs a session but not the owner: it spends nothing', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/ai/estimate' })).statusCode).toBe(401)
    expect((await get('/api/ai/estimate', viewer)).statusCode).toBe(200)
  })

  it('prices the deep model for kind=narrative rather than the analysis price (#158)', async () => {
    const fake = fakeGemini('{}')
    const findingsRes = await get(`/api/ai/estimate?month=${MONTH}`)
    const narrativeRes = await get(`/api/ai/estimate?month=${MONTH}&kind=narrative`)

    expect(narrativeRes.statusCode).toBe(200)
    const findingsEstimate = findingsRes.json<AiEstimate>()
    const narrativeEstimate = narrativeRes.json<AiEstimate>()
    expect(narrativeEstimate.kind).toBe('narrative')
    expect(narrativeEstimate.allowed).toBe(true)
    // The deep model over the same payload, not the cheap one — the whole reason the
    // page needs a second price rather than reusing the findings one (#158).
    expect(narrativeEstimate.estimateMicroEur).toBeGreaterThan(findingsEstimate.estimateMicroEur)
    expect(fake.calls).toBe(0)
  })

  it('refuses a kind it does not know', async () => {
    const res = await get('/api/ai/estimate?kind=chat')
    expect(res.statusCode).toBe(400)
  })

  it('prices a narrative as free once one already exists in that language', async () => {
    fakeGemini('The month in a sentence.')
    await narrative({ period: MONTH })

    const res = await get(`/api/ai/estimate?month=${MONTH}&kind=narrative`)
    const estimate = res.json<AiEstimate>()
    expect(estimate.allowed).toBe(false)
    expect(estimate.reason).toBe('cached')
    expect(estimate.estimateMicroEur).toBe(0)
  })

  it('says there is nothing to run against on an empty deployment', async () => {
    await app.close()
    ctx.sqlite.close()
    ctx = apiFixture({ empty: true })
    app = await buildApp({ db: ctx.db, web: null })
    owner = signIn(ctx.db, 'owner')

    const res = await get('/api/ai/estimate')
    // A conflict rather than a 404: the endpoint exists, the deployment has not
    // aggregated anything yet, and the screen should say so instead of showing €0.
    expect(res.statusCode).toBe(409)
  })
})

describe('POST /api/ai/dry-run', () => {
  const reply = (label: string): string =>
    JSON.stringify({
      findings: [{ code: 'above_baseline', label, severity: 'warn', confidence: 80 }],
      clarifications: [],
    })

  it('runs for real and answers with what the version would say', async () => {
    const fake = fakeGemini(reply(labelFor('cat-groceries')))
    const res = await dryRun()
    expect(res.statusCode).toBe(200)

    const outcome = res.json<AiDryRun>()
    expect(fake.calls).toBe(1)
    expect(outcome.status).toBe('ok')
    expect(outcome.month).toBe(MONTH)
    expect(outcome.degraded).toBe(false)
    expect(outcome.findings.length).toBeGreaterThan(0)
    // The prompt actually used, so the editor can see whether it tested the draft or
    // the active version. Nothing has been edited on this deployment, so it is the
    // built-in text — version 0, no row — which is also what the nightly job runs.
    expect(outcome.promptId).toBeNull()
    expect(outcome.promptVersion).toBe(0)
    expect(outcome.costMicroEur).toBeGreaterThan(0)
  })

  it('stores the ledger row and nothing else', async () => {
    fakeGemini(reply(labelFor('cat-groceries')))
    await dryRun()

    const runs = runRows(ctx.db)
    expect(runs).toHaveLength(1)
    // A dry run is billed like any other run, and the row says which kind it was.
    expect(runs[0]?.kind).toBe('dryrun')
    expect(runs[0]?.costMicroEur).toBeGreaterThan(0)

    // The two things that would outlive the request, and the reason `persist` exists:
    // a rehearsal must not put findings on the insights page or questions in the queue.
    expect(ctx.db.select().from(aiFindings).all()).toHaveLength(0)
    expect(ctx.db.select().from(clarificationQueue).all()).toHaveLength(0)
  })

  it('tests the version it was given rather than the active one', async () => {
    // The active row is left on the built-in text, which needs no verdict to activate —
    // the point under test is which *id* a dry run reads, not which body is active.
    const active = createPromptVersion(ctx.db, getSoleTenantId(ctx.db), {
      key: 'analysis.system',
      locale: 'en',
      body: DEFAULT_PROMPTS['analysis.system'],
      activate: true,
    })
    const draft = createPromptVersion(ctx.db, getSoleTenantId(ctx.db), {
      key: 'analysis.system',
      locale: 'en',
      body: 'The draft under test.',
    })
    // A dry run under `locked`, the default, still refuses an unvalidated analysis body
    // (#468) — give the draft the verdict an owner would have gotten from the checker.
    storePromptValidation(ctx.db, getSoleTenantId(ctx.db), draft.id, {
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
      validatedAt: new Date(),
    })

    fakeGemini(reply(labelFor('cat-groceries')))
    const res = await dryRun({ promptId: draft.id })
    expect(res.statusCode).toBe(200)

    const outcome = res.json<AiDryRun>()
    expect(outcome.promptId).toBe(draft.id)
    expect(outcome.promptVersion).toBe(draft.version)
    expect(outcome.promptId).not.toBe(active.id)
    // Testing a draft does not activate it.
    expect(ctx.db.select().from(aiRuns).all()).toHaveLength(1)
  })

  it('answers 404 for a version id that no longer exists', async () => {
    // A stale editor tab, which is a mistake the caller can act on — unlike the 500
    // it would be if the id reached `runAnalysis`.
    const fake = fakeGemini(reply('c1'))
    const res = await dryRun({ promptId: 'gone' })
    expect(res.statusCode).toBe(404)
    expect(fake.calls).toBe(0)
  })

  it('refuses a narrative prompt sent to the analysis pass', async () => {
    const narrative = createPromptVersion(ctx.db, getSoleTenantId(ctx.db), {
      key: 'narrative.system',
      locale: 'en',
      body: 'Write the month up.',
    })
    const fake = fakeGemini(reply('c1'))

    const res = await dryRun({ promptId: narrative.id })
    expect(res.statusCode).toBe(400)
    expect(fake.calls).toBe(0)
  })

  /**
   * A pin, not an ordinary regression test.
   *
   * `dryRunPrompt` is the only thing standing between "the prompt editor can run a
   * dry run" and "the prompt editor can run a dry run against the one prompt with
   * no output-grounding and, as of #453, no code-owned backstop appended in this
   * code path at all" — a dry run calls `runAnalysis`, not `runNarrative`, so it
   * never goes near `composeNarrativeSystemPrompt`. That gap is exactly why prompt
   * *activation* has to stay the only path that puts an unvalidated narrative body
   * into use: `runNarrative` is where the backstop and (per #452) the future
   * use-time refusal live, and a dry run that could exercise a narrative body would
   * let an owner preview it without ever going through either.
   *
   * If a future "narrative dry run" feature needs this to change, that is a
   * deliberate product decision requiring its own guardrail story — delete this
   * test on purpose, with that reasoning in the commit, rather than letting a
   * refactor of `dryRunPrompt` silently widen what it accepts.
   */
  it('pins that a narrative prompt can never be dry-run — see the comment above (#453)', () => {
    const tenantId = getSoleTenantId(ctx.db)
    const narrative = createPromptVersion(ctx.db, tenantId, {
      key: 'narrative.system',
      locale: 'en',
      body: 'Write the month up.',
    })

    let thrown: unknown
    try {
      dryRunPrompt(ctx.db, tenantId, 'en', narrative.id)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(HttpError)
    const error = thrown as HttpError
    expect(error.statusCode).toBe(400)
    expect(error.details).toEqual({ key: 'narrative.system' })
  })

  it('reports a failed call with its cost instead of a bare error', async () => {
    fakeGemini(new Error('socket hang up'))
    const res = await dryRun()
    // 200: the run happened, and what the editor needs to know is that it failed and
    // what it cost — not an error envelope with the cost thrown away.
    expect(res.statusCode).toBe(200)

    const outcome = res.json<AiDryRun>()
    expect(outcome.status).toBe('error')
    expect(outcome.degraded).toBe(true)
    // Still the deterministic list: it was never the model's to produce.
    expect(outcome.findings.length).toBeGreaterThan(0)
    expect(runRows(ctx.db)).toHaveLength(1)
  })

  it('records what the model invented rather than rendering it', async () => {
    fakeGemini(
      JSON.stringify({
        findings: [
          { code: 'above_baseline', label: 'c99', severity: 'warn', confidence: 90 },
        ],
        clarifications: [],
      }),
    )
    const res = await dryRun()

    const outcome = res.json<AiDryRun>()
    // The trust boundary the whole design rests on: a claim with no computed signal
    // behind it cannot become a sentence, whatever it claims — and the drop is
    // recorded rather than swallowed, so the editor sees the model made it up.
    expect(outcome.dropped).toEqual([
      { code: 'above_baseline', label: 'c99', reason: 'no_signal' },
    ])
    // And nothing is rendered in its place. The call succeeded, so the ranking is
    // the model's, and it ranked nothing that survived grounding — the deterministic
    // list is the fallback for a call that *failed*, which the test above covers.
    expect(outcome.findings).toEqual([])
    expect(outcome.status).toBe('ok')
  })

  it('is refused for a viewer, who cannot spend the month s allowance', async () => {
    const fake = fakeGemini(reply('c1'))
    const res = await dryRun({}, viewer)
    expect(res.statusCode).toBe(403)
    expect(fake.calls).toBe(0)
    expect(runRows(ctx.db)).toHaveLength(0)
  })

  it('refuses a locale the deployment does not serve', async () => {
    const fake = fakeGemini(reply('c1'))
    const res = await dryRun({ locale: 'fr' })
    expect(res.statusCode).toBe(400)
    expect(fake.calls).toBe(0)
  })

  it('refuses a field it does not know rather than ignoring it', async () => {
    // `strictObject`: a body carrying `prompt_id` would otherwise run the active
    // prompt and report success, which is the one answer the button must not give.
    const res = await dryRun({ prompt_id: 'x' })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/ai/narrative', () => {
  it('writes the review for a month that has ended, and bills the deep model (#158)', async () => {
    const fake = fakeGemini('Groceries ran hot; energy stayed put.')
    const res = await narrative({ period: MONTH })
    expect(res.statusCode).toBe(200)

    const outcome = res.json<AiNarrativeRun>()
    expect(outcome.status).toBe('ok')
    expect(outcome.period).toBe(MONTH)
    expect(outcome.costMicroEur).toBeGreaterThan(0)
    expect(fake.calls).toBe(1)

    const rows = runRows(ctx.db).filter((row) => row.kind === 'narrative')
    expect(rows).toHaveLength(1)
  })

  it('answers the cached review for free on a second press, without calling anything', async () => {
    const fake = fakeGemini('Groceries ran hot; energy stayed put.')
    await narrative({ period: MONTH })
    const res = await narrative({ period: MONTH })

    const outcome = res.json<AiNarrativeRun>()
    expect(outcome.status).toBe('cached')
    expect(outcome.costMicroEur).toBe(0)
    expect(fake.calls).toBe(1)
  })

  it('refuses a month that has not ended, so a partial month is never cached forever', async () => {
    const fake = fakeGemini('Too early to say.')
    const res = await narrative({ period: '2099-01' })
    expect(res.statusCode).toBe(409)
    expect(fake.calls).toBe(0)
  })

  it('is refused for a viewer, since writing a review spends the deep model', async () => {
    const fake = fakeGemini('Groceries ran hot.')
    const res = await narrative({ period: MONTH }, viewer)
    expect(res.statusCode).toBe(403)
    expect(fake.calls).toBe(0)
  })

  it('needs a period; there is no latest-month default for this one', async () => {
    const res = await narrative({})
    expect(res.statusCode).toBe(400)
  })

  it('caches per locale, so asking in Dutch does not reuse the English review', async () => {
    fakeGemini('Groceries ran hot; energy stayed put.')
    await narrative({ period: MONTH })
    const res = await narrative({ period: MONTH, locale: 'nl' })

    const outcome = res.json<AiNarrativeRun>()
    expect(outcome.status).toBe('ok')
    expect(outcome.locale).toBe('nl')

    const rows = runRows(ctx.db).filter((row) => row.kind === 'narrative')
    expect(rows).toHaveLength(2)
  })

  it('rewrites a month that already has a review when force is set (#226)', async () => {
    const fake = fakeGemini('Groceries ran hot; energy stayed put.')
    await narrative({ period: MONTH })
    const res = await narrative({ period: MONTH, force: true })

    const outcome = res.json<AiNarrativeRun>()
    expect(outcome.status).toBe('ok')
    expect(fake.calls).toBe(2)

    // Two calls, two logged runs — but the second call replaced the stored review
    // rather than adding a second one, since `storeNarrative` upserts per (period, locale).
    const rows = runRows(ctx.db).filter((row) => row.kind === 'narrative')
    expect(rows).toHaveLength(2)
    expect(ctx.db.select().from(aiNarratives).all()).toHaveLength(1)
  })

  it('still refuses a month that has not ended when force is set', async () => {
    const fake = fakeGemini('Too early to say.')
    const res = await narrative({ period: '2099-01', force: true })
    expect(res.statusCode).toBe(409)
    expect(fake.calls).toBe(0)
  })
})

describe('POST /api/ai/prompt-validate (#454)', () => {
  const validate = (body: object, token = owner) => {
    const csrf = newCsrfToken()
    return app.inject({
      method: 'POST',
      url: '/api/ai/prompt-validate',
      payload: body,
      cookies: { [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf },
      headers: { [CSRF_HEADER]: csrf },
    })
  }

  /** A judge answer reporting every narrative rule imposed and intact. */
  const SAFE_REPLY = JSON.stringify({
    rules: NARRATIVE_RULE_IDS.map((id) => ({ id, present: true, weakened: false })),
    conflicts: [],
    notes: 'Reads like the built-in rules in different words.',
  })

  /** The analysis rubric's version of `SAFE_REPLY` (#468). */
  const ANALYSIS_SAFE_REPLY = JSON.stringify({
    rules: ANALYSIS_RULE_IDS.map((id) => ({ id, present: true, weakened: false })),
    conflicts: [],
    notes: 'Reads like the built-in rules in different words.',
  })

  const saveNarrative = (body: string, tenantId = getSoleTenantId(ctx.db)) =>
    createPromptVersion(ctx.db, tenantId, {
      key: 'narrative.system',
      locale: SHARED_LOCALE,
      body,
    })

  it('checks a saved narrative version and answers the new schema', async () => {
    const fake = fakeGemini(SAFE_REPLY)
    const row = saveNarrative('My own narrative instructions, rules and all.')

    const res = await validate({ promptId: row.id })
    expect(res.statusCode).toBe(200)

    const outcome = res.json<PromptValidation>()
    expect(outcome.status).toBe('safe')
    expect(outcome.gate).toBe('safe')
    expect(outcome.promptId).toBe(row.id)
    expect(outcome.key).toBe('narrative.system')
    expect(outcome.verdict?.missing).toEqual([])
    expect(outcome.runId).not.toBeNull()
    expect(outcome.costMicroEur).toBeGreaterThan(0)
    expect(fake.calls).toBe(1)
    expect(runRows(ctx.db).filter((run) => run.kind === 'prompt_validation')).toHaveLength(1)
  })

  it('refuses a viewer: a check spends the month’s allowance', async () => {
    const fake = fakeGemini(SAFE_REPLY)
    const row = saveNarrative('Somebody else’s instructions.')

    expect((await validate({ promptId: row.id }, viewer)).statusCode).toBe(403)
    expect(fake.calls).toBe(0)
  })

  it('answers 404 for an id that does not exist', async () => {
    const fake = fakeGemini(SAFE_REPLY)
    expect((await validate({ promptId: 'nope' })).statusCode).toBe(404)
    expect(fake.calls).toBe(0)
  })

  it('trips the AI rate limit on a real route without ever reaching the model (#47)', async () => {
    // The 404 above proves this request never calls out; bursting it past
    // `AI_RATE_LIMIT.max` proves the limiter trips on a real production route,
    // through the real owner/CSRF path, at zero AI cost — not just on the synthetic
    // stand-in route in server-rate-limit.test.ts. Bound to that constant rather than
    // to `config.RATE_LIMIT_AI_PER_HOUR` directly: it's the exact number this route was
    // actually built with, so the burst can never drift from what's enforced (#527).
    const fake = fakeGemini(SAFE_REPLY)
    for (let i = 0; i < AI_RATE_LIMIT.max; i += 1) {
      expect((await validate({ promptId: 'nope' })).statusCode).toBe(404)
    }

    const blocked = await validate({ promptId: 'nope' })
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json<{ error: { code: string } }>().error.code).toBe('rate_limited')
    expect(fake.calls).toBe(0)
  })

  it('checks a saved analysis version under locked, the default (#468)', async () => {
    // `analysis.system` is gated only under `locked`, which is what the test environment
    // defaults to — so this endpoint now genuinely validates it, the new capability #468
    // added, rather than refusing it the way it used to when analysis was never gated.
    const fake = fakeGemini(ANALYSIS_SAFE_REPLY)
    const row = createPromptVersion(ctx.db, getSoleTenantId(ctx.db), {
      key: 'analysis.system',
      locale: SHARED_LOCALE,
      body: 'Rewritten analysis instructions.',
    })

    const res = await validate({ promptId: row.id })
    expect(res.statusCode).toBe(200)

    const outcome = res.json<PromptValidation>()
    expect(outcome.status).toBe('safe')
    expect(outcome.gate).toBe('safe')
    expect(outcome.key).toBe('analysis.system')
    expect(fake.calls).toBe(1)
  })

  it('answers 404 for another tenant’s id — tenant-scoped loading, not authorization', async () => {
    // A `403` would confirm that some other household has a version by that id. From inside
    // this request the row genuinely does not exist, because `loadPrompt` narrows by tenant.
    const fake = fakeGemini(SAFE_REPLY)
    const other = createSecondTenant(ctx.db)
    const row = saveNarrative('Another household’s instructions.', other)

    expect((await validate({ promptId: row.id })).statusCode).toBe(404)
    expect(fake.calls).toBe(0)
  })

  it('refuses a body that is not a string, and an unknown field', async () => {
    expect((await validate({})).statusCode).toBe(400)
    expect((await validate({ promptId: '' })).statusCode).toBe(400)
    // `strictObject`: the body being checked is deliberately not on the wire, so a request
    // that tried to send one is a mistake worth naming rather than silently ignoring.
    const row = saveNarrative('Instructions.')
    expect((await validate({ promptId: row.id, body: 'something else' })).statusCode).toBe(400)
  })
})
