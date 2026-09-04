/**
 * `POST /api/ai/category-guess/estimate` and `POST /api/ai/category-guess`,
 * the fifth and sixth endpoints that can spend money (#216).
 *
 * `category-guess.ts` itself has its own domain tests
 * (`ai-category-guess.test.ts`) for grounding, redaction and the per-item
 * `ProposalError` contract. What belongs here is the HTTP fence: owner-only,
 * a body of ids rather than a month, and the same "estimate spends nothing,
 * a real run always writes a ledger row" shape as the other four.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { GoogleGenAI } from '@google/genai'
import { setGeminiClient } from '../../src/adapters/gemini/client.ts'
import { eurToMicroEur } from '../../src/adapters/gemini/pricing.ts'
import type { Db } from '../../src/db/index.ts'
import { aiRuns, users } from '../../src/db/schema.ts'
import { persistCategoryGuessCandidates } from '../../src/domain/aggregate/signals-store.ts'
import { recordRun } from '../../src/domain/ai/runs.ts'
import { config } from '../../src/config.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { buildApp } from '../../src/server/app.ts'
import { createSession } from '../../src/server/auth/sessions.ts'
import { CSRF_COOKIE, SESSION_COOKIE } from '../../src/server/cookies.ts'
import { CSRF_HEADER, newCsrfToken } from '../../src/server/csrf.ts'
import type {
  CategoryGuessEstimateWire,
  CategoryGuessRunWire,
} from '../../src/server/routes/api/schemas.ts'
import { apiFixture, MONTH } from '../helpers/api-fixture.ts'

vi.mock('../../src/adapters/actual/queries.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/actual/queries.ts')>()),
  fetchCategories: vi.fn(),
  fetchTransaction: vi.fn(),
  updateTransactionCategory: vi.fn(),
}))

import {
  fetchCategories,
  fetchTransaction,
  updateTransactionCategory,
} from '../../src/adapters/actual/queries.ts'

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

function estimate(body: object, token = owner) {
  const csrf = newCsrfToken()
  return app.inject({
    method: 'POST',
    url: '/api/ai/category-guess/estimate',
    payload: body,
    cookies: { [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf },
    headers: { [CSRF_HEADER]: csrf },
  })
}

function guess(body: object, token = owner) {
  const csrf = newCsrfToken()
  return app.inject({
    method: 'POST',
    url: '/api/ai/category-guess',
    payload: body,
    cookies: { [SESSION_COOKIE]: token, [CSRF_COOKIE]: csrf },
    headers: { [CSRF_HEADER]: csrf },
  })
}

const runRows = (db: Db) => db.select().from(aiRuns).all()

/** One cached candidate, seeded straight into the table `generateCategoryProposals` writes. */
function seedCandidate(): void {
  persistCategoryGuessCandidates(ctx.db, MONTH, [
    {
      transactionId: 'txn-guess-1',
      payeeId: 'payee-1',
      payeeName: 'Colruyt',
      amountCents: -4_200,
      date: `${MONTH}-05`,
      history: [{ categoryId: 'cat-groceries', count: 3 }],
    },
  ])
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(async () => {
  vi.mocked(fetchCategories).mockReset()
  vi.mocked(fetchTransaction).mockReset()
  vi.mocked(updateTransactionCategory).mockReset()
  vi.mocked(fetchCategories).mockResolvedValue([
    { id: 'cat-groceries', name: 'Groceries', is_income: false, hidden: false, group: null },
  ])
  vi.mocked(fetchTransaction).mockResolvedValue({
    id: 'txn-guess-1',
    categoryId: null,
    payeeId: 'payee-1',
  })

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

describe('POST /api/ai/category-guess/estimate', () => {
  it('is free and says so when none of the ids has a cached candidate', async () => {
    const fake = fakeGemini('never called')
    const res = await estimate({ ids: ['txn-nothing'] })
    expect(res.statusCode).toBe(200)

    const body = res.json<CategoryGuessEstimateWire>()
    expect(body.allowed).toBe(false)
    expect(body.reason).toBe('no_candidates')
    expect(body.payloadChars).toBeNull()
    expect(body.estimateMicroEur).toBe(0)
    expect(fake.calls).toBe(0)
    expect(runRows(ctx.db)).toHaveLength(0)
  })

  it('prices a real selection without spending anything', async () => {
    seedCandidate()
    const fake = fakeGemini('never called')

    const res = await estimate({ ids: ['txn-guess-1'] })
    expect(res.statusCode).toBe(200)

    const body = res.json<CategoryGuessEstimateWire>()
    expect(body.allowed).toBe(true)
    expect(body.payloadChars).toBeGreaterThan(0)
    expect(body.estimateMicroEur).toBeGreaterThan(0)
    expect(fake.calls).toBe(0)
    expect(runRows(ctx.db)).toHaveLength(0)
  })

  it('is refused for a viewer, who cannot spend the month s allowance', async () => {
    seedCandidate()
    const res = await estimate({ ids: ['txn-guess-1'] }, viewer)
    expect(res.statusCode).toBe(403)
  })

  it('refuses an empty selection', async () => {
    const res = await estimate({ ids: [] })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a selection over the batch cap', async () => {
    const res = await estimate({ ids: Array.from({ length: 51 }, (_, i) => `txn-${i}`) })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a field it does not know rather than ignoring it', async () => {
    const res = await estimate({ ids: ['txn-guess-1'], month: MONTH })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/ai/category-guess', () => {
  it('turns a confident guess into a real proposal and bills the fast model', async () => {
    seedCandidate()
    const fake = fakeGemini('{"guesses":[{"clientId":"t1","categoryLabel":"c1"}]}')

    const res = await guess({ ids: ['txn-guess-1'] })
    expect(res.statusCode).toBe(200)

    const body = res.json<CategoryGuessRunWire>()
    expect(body.status).toBe('ok')
    expect(body.results).toEqual([{ id: 'txn-guess-1', ok: true, reason: null }])
    expect(body.costMicroEur).toBeGreaterThan(0)
    expect(fake.calls).toBe(1)

    const rows = runRows(ctx.db).filter((row) => row.kind === 'category_guess')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.period).toBeNull()
  })

  it('tells apart a cached id and one that was never a candidate at all', async () => {
    seedCandidate()
    fakeGemini('never called')
    recordRun(ctx.db, {
      kind: 'category_guess',
      model: config.GEMINI_MODEL_FAST,
      locale: 'en',
      payload: {},
      payloadHash: 'unrelated-hash',
      status: 'ok',
      costMicroEurOverride: eurToMicroEur(500),
    })

    const res = await guess({ ids: ['txn-guess-1', 'txn-nothing'] })
    const body = res.json<CategoryGuessRunWire>()

    expect(body.status).toBe('capped')
    expect(body.results).toEqual([
      { id: 'txn-guess-1', ok: false, reason: 'month_budget_exceeded' },
      { id: 'txn-nothing', ok: false, reason: 'no_candidate' },
    ])
  })

  it('is refused for a viewer, who cannot spend the month s allowance', async () => {
    seedCandidate()
    const fake = fakeGemini('{"guesses":[]}')
    const res = await guess({ ids: ['txn-guess-1'] }, viewer)
    expect(res.statusCode).toBe(403)
    expect(fake.calls).toBe(0)
    expect(runRows(ctx.db)).toHaveLength(0)
  })

  it('refuses an empty selection', async () => {
    const res = await guess({ ids: [] })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a selection over the batch cap', async () => {
    const res = await guess({ ids: Array.from({ length: 51 }, (_, i) => `txn-${i}`) })
    expect(res.statusCode).toBe(400)
  })
})
