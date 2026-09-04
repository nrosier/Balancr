/**
 * `GET /api/ai/estimate?kind=budget_nudge` and `POST /api/ai/budget-nudge`,
 * the seventh and eighth endpoints that can spend money (#217).
 *
 * `budget-nudge.ts` itself has its own domain tests (`ai-budget-nudge.test.ts`)
 * for grounding, redaction and the per-item `ProposalError` contract. What
 * belongs here is the HTTP fence: the estimate is free even for a viewer, the
 * run is owner-only, capped when the month's budget is spent, and an empty
 * note produces no proposal at all.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { GoogleGenAI } from '@google/genai'
import { setGeminiClient } from '../../src/adapters/gemini/client.ts'
import { eurToMicroEur } from '../../src/adapters/gemini/pricing.ts'
import { config } from '../../src/config.ts'
import type { Db } from '../../src/db/index.ts'
import { aiRuns, users } from '../../src/db/schema.ts'
import { createProposal, encodeBudgetTarget, pendingBudgetProposals } from '../../src/domain/ai/proposals.ts'
import { recordRun } from '../../src/domain/ai/runs.ts'
import { saveUpcomingNote } from '../../src/domain/ai/upcoming-note.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import type { AiBudgetNudgeRun, AiEstimate } from '../../src/server/routes/api/schemas.ts'
import { apiFixture, MONTH } from '../helpers/api-fixture.ts'

vi.mock('../../src/adapters/actual/queries.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/actual/queries.ts')>()),
  setCategoryBudgetAmount: vi.fn(),
}))

let ctx: ReturnType<typeof apiFixture>
let app: FastifyInstance
let owner: string
let viewer: string
/** A real run row: `proposals.run_id` is a foreign key. */
let runId: string

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

function fakeGemini(reply: string | Error): { calls: number } {
  const recorded = { calls: 0 }
  const client = {
    models: {
      generateContent: async () => {
        recorded.calls += 1
        if (reply instanceof Error) throw reply
        return {
          text: reply,
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 50 },
          modelVersion: 'gemini-3.7-flash-002',
        }
      },
    },
    caches: { create: async () => { throw new Error('too small to cache') } },
  }
  setGeminiClient(client as unknown as GoogleGenAI)
  return recorded
}

function estimate(query: string, token = owner) {
  return app.inject({
    method: 'GET',
    url: `/api/ai/estimate?kind=budget_nudge${query}`,
    cookies: { [SESSION_COOKIE]: token },
  })
}

function nudge(body: object, token = owner) {
  const csrf = newCsrfToken()
  return app.inject({
    method: 'POST',
    url: '/api/ai/budget-nudge',
    payload: body,
    cookies: { [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf },
    headers: { [CSRF_HEADER]: csrf },
  })
}

/** A pending `budget_amount.set` suggestion for `cat-groceries`, #45's own trailing-average proposal. */
async function seedPendingProposal(amountCents = 80_000): Promise<void> {
  await createProposal(ctx.db, {
    type: 'budget_amount.set',
    targetRef: encodeBudgetTarget('cat-groceries', MONTH),
    payload: { amountCents },
    runId,
  })
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(async () => {
  ctx = apiFixture()
  app = await buildApp({ db: ctx.db, web: null })
  owner = signIn(ctx.db, 'owner')
  viewer = signIn(ctx.db, 'viewer')
  runId = recordRun(ctx.db, {
    kind: 'findings',
    model: 'gemini-3.7-flash',
    locale: 'en',
    payload: {},
    payloadHash: 'unrelated-hash',
    status: 'ok',
  })
})

afterEach(async () => {
  setGeminiClient(null)
  await app.close()
  ctx.sqlite.close()
})

describe('GET /api/ai/estimate?kind=budget_nudge', () => {
  it('is free and says so when the note is empty', async () => {
    await seedPendingProposal()
    const res = await estimate('')
    expect(res.statusCode).toBe(200)

    const body = res.json<AiEstimate>()
    expect(body.allowed).toBe(false)
    expect(body.reason).toBe('no_note')
    expect(body.estimateMicroEur).toBe(0)
  })

  it('prices a real batch without spending anything', async () => {
    saveUpcomingNote(ctx.db, { text: 'Dentist bill in March.' })
    await seedPendingProposal()

    const res = await estimate('')
    const body = res.json<AiEstimate>()
    expect(body.allowed).toBe(true)
    expect(body.estimateMicroEur).toBeGreaterThan(0)
  })

  it('is visible to a viewer too, since it is free', async () => {
    saveUpcomingNote(ctx.db, { text: 'Dentist bill in March.' })
    await seedPendingProposal()
    const res = await estimate('', viewer)
    expect(res.statusCode).toBe(200)
    expect(res.json<AiEstimate>().allowed).toBe(true)
  })

  it('refuses an unrecognized kind', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ai/estimate?kind=bogus',
      cookies: { [SESSION_COOKIE]: owner },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/ai/budget-nudge', () => {
  it('turns a grounded adjustment into a real proposal and bills the fast model', async () => {
    saveUpcomingNote(ctx.db, { text: 'Dentist bill in March, about 150 euros.' })
    await seedPendingProposal()
    const fake = fakeGemini('{"adjustments":[{"label":"c1","amountCents":95000}]}')

    const res = await nudge({ month: MONTH })
    expect(res.statusCode).toBe(200)

    const body = res.json<AiBudgetNudgeRun>()
    expect(body.status).toBe('ok')
    expect(body.month).toBe(MONTH)
    expect(body.costMicroEur).toBeGreaterThan(0)
    expect(fake.calls).toBe(1)

    const pending = pendingBudgetProposals(ctx.db, MONTH)
    expect(pending).toHaveLength(1)
    expect(JSON.parse(pending[0]?.payloadJson ?? '{}')).toEqual({ amountCents: 95_000 })
  })

  it('is capped once the month budget is already exceeded', async () => {
    saveUpcomingNote(ctx.db, { text: 'Dentist bill in March.' })
    await seedPendingProposal()
    recordRun(ctx.db, {
      kind: 'budget_nudge',
      model: config.GEMINI_MODEL_FAST,
      locale: 'en',
      payload: {},
      payloadHash: 'unrelated-hash',
      status: 'ok',
      costMicroEurOverride: eurToMicroEur(500),
    })
    const fake = fakeGemini('never called')

    const res = await nudge({ month: MONTH })
    const body = res.json<AiBudgetNudgeRun>()
    expect(body.status).toBe('capped')
    expect(body.reason).toBe('month_budget_exceeded')
    expect(fake.calls).toBe(0)
  })

  it('produces no proposal when the note is empty', async () => {
    await seedPendingProposal()
    const fake = fakeGemini('never called')

    const res = await nudge({ month: MONTH })
    const body = res.json<AiBudgetNudgeRun>()
    expect(body.status).toBe('skipped')
    expect(body.reason).toBe('no_note')
    expect(fake.calls).toBe(0)
    expect(pendingBudgetProposals(ctx.db, MONTH).map((row) => JSON.parse(row.payloadJson))).toEqual([
      { amountCents: 80_000 },
    ])
  })

  it('is refused for a viewer', async () => {
    saveUpcomingNote(ctx.db, { text: 'Dentist bill in March.' })
    await seedPendingProposal()
    const fake = fakeGemini('{"adjustments":[]}')

    const res = await nudge({ month: MONTH }, viewer)
    expect(res.statusCode).toBe(403)
    expect(fake.calls).toBe(0)
    expect(ctx.db.select().from(aiRuns).all()).toHaveLength(1)
  })

  it('refuses a field it does not know rather than ignoring it', async () => {
    const res = await nudge({ month: MONTH, extra: true })
    expect(res.statusCode).toBe(400)
  })
})
