/**
 * #216's own call: turning a cached below-threshold candidate into a real
 * `transaction_category.set` proposal, or explaining why it did not.
 *
 * The redaction allow-list itself is `ai-redact.test.ts`'s job. What belongs
 * here is the domain functions' own behaviour: every branch records exactly
 * one `aiRuns` row and one result per id asked for, grounding drops a
 * schema-valid-but-not-offered label rather than mapping it, and a per-item
 * `ProposalError` — a stale or already-categorised candidate — does not fail
 * the rest of the batch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoogleGenAI } from '@google/genai'
import { setGeminiClient } from '../../src/adapters/gemini/client.ts'
import { eurToMicroEur } from '../../src/adapters/gemini/pricing.ts'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { config } from '../../src/config.ts'
import { estimateCategoryGuess, runCategoryGuess } from '../../src/domain/ai/category-guess.ts'
import { pendingProposals } from '../../src/domain/ai/proposals.ts'
import { recentRuns, recordRun } from '../../src/domain/ai/runs.ts'
import {
  persistCategoryGuessCandidates,
  type CategoryGuessCandidate,
} from '../../src/domain/aggregate/signals-store.ts'

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

const MONTH = '2026-03'

let ctx: ReturnType<typeof createTestDb>
let db: Db

beforeEach(() => {
  vi.mocked(fetchCategories).mockReset()
  vi.mocked(fetchTransaction).mockReset()
  vi.mocked(updateTransactionCategory).mockReset()
  vi.mocked(fetchCategories).mockResolvedValue([
    { id: 'food', name: 'Groceries', is_income: false, hidden: false, group: null },
  ])
  vi.mocked(fetchTransaction).mockResolvedValue({ id: 'txn-1', categoryId: null, payeeId: 'payee-1' })

  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
})

interface Recorded {
  prompts: string[]
  models: string[]
}

function fakeGemini(reply: string | Error): Recorded {
  const recorded: Recorded = { prompts: [], models: [] }
  const client = {
    models: {
      generateContent: async (request: { contents: string; model: string }) => {
        recorded.prompts.push(request.contents)
        recorded.models.push(request.model)
        if (reply instanceof Error) throw reply
        return {
          text: reply,
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 50 },
          modelVersion: 'gemini-3.1-flash-preview-002',
        }
      },
    },
    caches: { create: async () => { throw new Error('too small to cache') } },
  }
  setGeminiClient(client as unknown as GoogleGenAI)
  return recorded
}

function candidate(overrides: Partial<CategoryGuessCandidate> = {}): CategoryGuessCandidate {
  return {
    transactionId: 'txn-1',
    payeeId: 'payee-1',
    payeeName: 'Colruyt',
    amountCents: -4_200,
    date: '2026-03-05',
    history: [{ categoryId: 'food', count: 3 }],
    ...overrides,
  }
}

/** Each call replaces the whole month's cache, so multiple candidates go in one call. */
function seedCandidates(...overrides: Partial<CategoryGuessCandidate>[]): void {
  persistCategoryGuessCandidates(db, MONTH, overrides.map((override) => candidate(override)))
}

function seedCandidate(overrides: Partial<CategoryGuessCandidate> = {}): void {
  seedCandidates(overrides)
}

describe('estimateCategoryGuess', () => {
  it('is free and refused when none of the ids has a cached candidate', async () => {
    const outcome = await estimateCategoryGuess(db, { ids: ['txn-9'] })

    expect(outcome.allowed).toBe(false)
    expect(outcome.reason).toBe('no_candidates')
    expect(outcome.payloadChars).toBeNull()
    expect(outcome.estimateMicroEur).toBe(0)
  })

  it('prices a real batch and allows it under budget', async () => {
    seedCandidate()

    const outcome = await estimateCategoryGuess(db, { ids: ['txn-1'] })

    expect(outcome.allowed).toBe(true)
    expect(outcome.reason).toBeNull()
    expect(outcome.payloadChars).toBeGreaterThan(0)
    expect(outcome.estimateMicroEur).toBeGreaterThan(0)
  })

  it('is refused once the month budget is already exceeded', async () => {
    seedCandidate()
    recordRun(db, {
      kind: 'category_guess',
      model: config.GEMINI_MODEL_FAST,
      locale: 'en',
      payload: {},
      payloadHash: 'unrelated-hash',
      status: 'ok',
      costMicroEurOverride: eurToMicroEur(500),
    })

    const outcome = await estimateCategoryGuess(db, { ids: ['txn-1'] })

    expect(outcome.allowed).toBe(false)
    expect(outcome.reason).toBe('month_budget_exceeded')
  })
})

describe('runCategoryGuess', () => {
  it('skips with one no_candidate result per id when nothing is cached', async () => {
    const recorded = fakeGemini('never called')

    const outcome = await runCategoryGuess(db, { ids: ['txn-9', 'txn-8'] })

    expect(outcome.status).toBe('skipped')
    expect(outcome.reason).toBe('no_candidates')
    expect(outcome.runId).toBeNull()
    expect(outcome.results).toEqual([
      { id: 'txn-9', ok: false, reason: 'no_candidate' },
      { id: 'txn-8', ok: false, reason: 'no_candidate' },
    ])
    expect(recorded.prompts).toHaveLength(0)
    expect(recentRuns(db)).toHaveLength(0)
  })

  it('records a capped run, telling a cached id apart from one never cached at all', async () => {
    seedCandidate()
    recordRun(db, {
      kind: 'category_guess',
      model: config.GEMINI_MODEL_FAST,
      locale: 'en',
      payload: {},
      payloadHash: 'unrelated-hash',
      status: 'ok',
      costMicroEurOverride: eurToMicroEur(500),
    })
    const recorded = fakeGemini('never called')

    const outcome = await runCategoryGuess(db, { ids: ['txn-1', 'txn-9'] })

    expect(outcome.status).toBe('capped')
    expect(outcome.reason).toBe('month_budget_exceeded')
    expect(outcome.results).toEqual([
      { id: 'txn-1', ok: false, reason: 'month_budget_exceeded' },
      { id: 'txn-9', ok: false, reason: 'no_candidate' },
    ])
    expect(recorded.prompts).toHaveLength(0)
    const rows = recentRuns(db)
    expect(rows[0]?.status).toBe('capped')
    expect(rows[0]?.kind).toBe('category_guess')
    expect(rows[0]?.period).toBeNull()
  })

  it('records a failed call without throwing', async () => {
    seedCandidate()
    fakeGemini(new Error('socket hang up'))

    const outcome = await runCategoryGuess(db, { ids: ['txn-1'] })

    expect(outcome.status).toBe('error')
    expect(outcome.reason).toBe('call_failed')
    expect(outcome.results).toEqual([{ id: 'txn-1', ok: false, reason: 'call_failed' }])
    expect(recentRuns(db)[0]?.status).toBe('error')
    expect(recentRuns(db)[0]?.error).toContain('socket hang up')
  })

  it('records a bad response without throwing', async () => {
    seedCandidate()
    fakeGemini('not json at all')

    const outcome = await runCategoryGuess(db, { ids: ['txn-1'] })

    expect(outcome.status).toBe('error')
    expect(outcome.reason).toBe('bad_response')
    expect(outcome.results).toEqual([{ id: 'txn-1', ok: false, reason: 'bad_response' }])
    expect(recentRuns(db)[0]?.status).toBe('error')
  })

  it('turns a grounded guess into a real proposal', async () => {
    seedCandidate()
    fakeGemini('{"guesses":[{"clientId":"t1","categoryLabel":"c1"}]}')

    const outcome = await runCategoryGuess(db, { ids: ['txn-1'] })

    expect(outcome.status).toBe('ok')
    expect(outcome.degraded).toBe(false)
    expect(outcome.results).toEqual([{ id: 'txn-1', ok: true, reason: null }])
    expect(outcome.dropped).toEqual([])
    const pending = pendingProposals(db)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.type).toBe('transaction_category.set')
    expect(pending[0]?.targetRef).toBe('txn-1')
    expect(JSON.parse(pending[0]?.payloadJson ?? '{}')).toMatchObject({
      categoryId: 'food',
      payeeName: 'Colruyt',
    })
    expect(recentRuns(db)[0]?.status).toBe('ok')
    expect(recentRuns(db)[0]?.kind).toBe('category_guess')
    expect(recentRuns(db)[0]?.period).toBeNull()
  })

  it('drops a guess for a label that candidate was never offered, rather than mapping it', async () => {
    seedCandidate()
    // `c9` is not one of this batch's real labels — a hallucinated or borrowed one.
    fakeGemini('{"guesses":[{"clientId":"t1","categoryLabel":"c9"}]}')

    const outcome = await runCategoryGuess(db, { ids: ['txn-1'] })

    expect(outcome.status).toBe('ok')
    expect(outcome.dropped).toEqual([{ clientId: 't1', categoryLabel: 'c9', reason: 'not_offered' }])
    expect(outcome.results).toEqual([{ id: 'txn-1', ok: false, reason: 'not_confident' }])
    expect(pendingProposals(db)).toHaveLength(0)
  })

  it('leaves a candidate the model omitted as not_confident', async () => {
    seedCandidate()
    fakeGemini('{"guesses":[]}')

    const outcome = await runCategoryGuess(db, { ids: ['txn-1'] })

    expect(outcome.status).toBe('ok')
    expect(outcome.results).toEqual([{ id: 'txn-1', ok: false, reason: 'not_confident' }])
  })

  it('does not let one ProposalError abort the rest of the batch', async () => {
    seedCandidates({ transactionId: 'txn-1' }, { transactionId: 'txn-2', payeeName: 'Delhaize' })
    // txn-1 is already categorised as `food`, so its diff is empty and
    // `createProposal` refuses it as a no-op — the other candidate must still
    // go through.
    vi.mocked(fetchTransaction).mockImplementation(async (id: string) =>
      id === 'txn-1'
        ? { id: 'txn-1', categoryId: 'food', payeeId: 'payee-1' }
        : { id: 'txn-2', categoryId: null, payeeId: 'payee-2' },
    )
    fakeGemini(
      '{"guesses":[{"clientId":"t1","categoryLabel":"c1"},{"clientId":"t2","categoryLabel":"c1"}]}',
    )

    const outcome = await runCategoryGuess(db, { ids: ['txn-1', 'txn-2'] })

    expect(outcome.status).toBe('ok')
    const byId = new Map(outcome.results.map((result) => [result.id, result]))
    expect(byId.get('txn-1')?.ok).toBe(false)
    expect(byId.get('txn-1')?.reason).toContain('would change nothing')
    expect(byId.get('txn-2')).toEqual({ id: 'txn-2', ok: true, reason: null })
    expect(pendingProposals(db)).toHaveLength(1)
    expect(pendingProposals(db)[0]?.targetRef).toBe('txn-2')
  })

  it('never sends the payee name or the transaction id to the model', async () => {
    seedCandidate()
    const recorded = fakeGemini('{"guesses":[]}')

    await runCategoryGuess(db, { ids: ['txn-1'] })

    const sent = recorded.prompts[0] ?? ''
    expect(sent).not.toContain('Colruyt')
    expect(sent).not.toContain('txn-1')
  })
})
