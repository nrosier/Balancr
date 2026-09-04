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
import { aiFindings, aiRuns, clarificationQueue, users } from '../../src/db/schema.ts'
import { prepareMonth } from '../../src/domain/ai/analysis.ts'
import { createPromptVersion } from '../../src/domain/ai/prompts.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import type { AiDryRun, AiEstimate, AiNarrativeRun } from '../../src/server/routes/api/schemas.ts'
import { apiFixture, MONTH } from '../helpers/api-fixture.ts'

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string
let viewer: string

function signIn(db: Db, role: 'owner' | 'viewer'): string {
  const row = db
    .insert(users)
    .values({
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
  const prepared = prepareMonth(ctx.db, MONTH, 'en')
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
    const active = createPromptVersion(ctx.db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'The active prompt.',
      activate: true,
    })
    const draft = createPromptVersion(ctx.db, {
      key: 'analysis.system',
      locale: 'en',
      body: 'The draft under test.',
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
    const narrative = createPromptVersion(ctx.db, {
      key: 'narrative.system',
      locale: 'en',
      body: 'Write the month up.',
    })
    const fake = fakeGemini(reply('c1'))

    const res = await dryRun({ promptId: narrative.id })
    expect(res.statusCode).toBe(400)
    expect(fake.calls).toBe(0)
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
})
