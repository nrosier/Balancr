/**
 * #217's own call: reading the running note beside this month's pending
 * `budget_amount.set` proposals, and turning what it names into an adjusted
 * one — or explaining why it did not.
 *
 * The redaction allow-list itself is `ai-redact.test.ts`'s job. What belongs
 * here is the domain functions' own behaviour: an empty note never even looks
 * at what is pending (`no_note` before `no_candidates`), every real attempt
 * records exactly one `aiRuns` row while the two early-outs record none, an
 * out-of-range or unknown-label adjustment is dropped rather than mapped, and
 * a per-item `ProposalError` — a no-op amount — does not fail the rest of the
 * batch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoogleGenAI } from '@google/genai'
import { setGeminiClient } from '../../src/adapters/gemini/client.ts'
import { eurToMicroEur } from '../../src/adapters/gemini/pricing.ts'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { config } from '../../src/config.ts'
import { estimateBudgetNudge, runBudgetNudge } from '../../src/domain/ai/budget-nudge.ts'
import {
  createProposal,
  encodeBudgetTarget,
  pendingBudgetProposals,
} from '../../src/domain/ai/proposals.ts'
import { recentRuns, recordRun } from '../../src/domain/ai/runs.ts'
import { saveUpcomingNote } from '../../src/domain/ai/upcoming-note.ts'
import { fact, seedMonth } from '../fixtures/month.ts'

vi.mock('../../src/adapters/actual/queries.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/adapters/actual/queries.ts')>()),
  setCategoryBudgetAmount: vi.fn(),
}))

const MONTH = '2026-03'

let ctx: ReturnType<typeof createTestDb>
let db: Db
/** A real run row: `proposals.run_id` is a foreign key. */
let runId: string

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
  runId = recordRun(db, {
    kind: 'findings',
    model: 'gemini-3.7-flash',
    locale: 'en',
    payload: {},
    payloadHash: 'unrelated-hash',
    status: 'ok',
  })
  seedMonth(db, MONTH, {
    facts: [
      fact(MONTH, 'food', { categoryName: 'Groceries', budgetedCents: 12_000 }),
      fact(MONTH, 'rent', { categoryName: 'Rent', budgetedCents: 90_000 }),
    ],
  })
})

interface Recorded {
  prompts: string[]
}

function fakeGemini(reply: string | Error): Recorded {
  const recorded: Recorded = { prompts: [] }
  const client = {
    models: {
      generateContent: async (request: { contents: string; model: string }) => {
        recorded.prompts.push(request.contents)
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

/** A pending `budget_amount.set` suggestion for one category — #45's own trailing-average proposal. */
async function seedBudgetProposal(categoryId: string, month: string, amountCents: number): Promise<void> {
  await createProposal(db, {
    type: 'budget_amount.set',
    targetRef: encodeBudgetTarget(categoryId, month),
    payload: { amountCents },
    runId,
  })
}

describe('estimateBudgetNudge', () => {
  it('is free and refused when the note is empty, even with a proposal pending', async () => {
    await seedBudgetProposal('food', MONTH, 15_000)

    const outcome = estimateBudgetNudge(db, { month: MONTH })

    expect(outcome.allowed).toBe(false)
    expect(outcome.reason).toBe('no_note')
    expect(outcome.payloadChars).toBeNull()
    expect(outcome.estimateMicroEur).toBe(0)
  })

  it('is free and refused when the note is set but nothing is pending', () => {
    saveUpcomingNote(db, { text: 'Dentist bill in March.' })

    const outcome = estimateBudgetNudge(db, { month: MONTH })

    expect(outcome.allowed).toBe(false)
    expect(outcome.reason).toBe('no_candidates')
    expect(outcome.payloadChars).toBeNull()
  })

  it('prices a real batch and allows it under budget', async () => {
    saveUpcomingNote(db, { text: 'Dentist bill in March.' })
    await seedBudgetProposal('food', MONTH, 15_000)

    const outcome = estimateBudgetNudge(db, { month: MONTH })

    expect(outcome.allowed).toBe(true)
    expect(outcome.reason).toBeNull()
    expect(outcome.payloadChars).toBeGreaterThan(0)
    expect(outcome.estimateMicroEur).toBeGreaterThan(0)
  })

  it('is refused once the month budget is already exceeded', async () => {
    saveUpcomingNote(db, { text: 'Dentist bill in March.' })
    await seedBudgetProposal('food', MONTH, 15_000)
    recordRun(db, {
      kind: 'budget_nudge',
      model: config.GEMINI_MODEL_FAST,
      locale: 'en',
      payload: {},
      payloadHash: 'unrelated-hash',
      status: 'ok',
      costMicroEurOverride: eurToMicroEur(500),
    })

    const outcome = estimateBudgetNudge(db, { month: MONTH })

    expect(outcome.allowed).toBe(false)
    expect(outcome.reason).toBe('month_budget_exceeded')
  })
})

describe('runBudgetNudge', () => {
  it('skips with no aiRuns row when the note is empty, even with a proposal pending', async () => {
    await seedBudgetProposal('food', MONTH, 15_000)
    const recorded = fakeGemini('never called')

    const outcome = await runBudgetNudge(db, { month: MONTH })

    expect(outcome.status).toBe('skipped')
    expect(outcome.reason).toBe('no_note')
    expect(outcome.runId).toBeNull()
    expect(outcome.degraded).toBe(true)
    expect(outcome.adjusted).toBe(0)
    expect(recorded.prompts).toHaveLength(0)
    expect(recentRuns(db).filter((row) => row.kind === 'budget_nudge')).toHaveLength(0)
  })

  it('skips with no aiRuns row when the note is set but nothing is pending', async () => {
    saveUpcomingNote(db, { text: 'Dentist bill in March.' })
    const recorded = fakeGemini('never called')

    const outcome = await runBudgetNudge(db, { month: MONTH })

    expect(outcome.status).toBe('skipped')
    expect(outcome.reason).toBe('no_candidates')
    expect(outcome.runId).toBeNull()
    expect(recorded.prompts).toHaveLength(0)
    expect(recentRuns(db).filter((row) => row.kind === 'budget_nudge')).toHaveLength(0)
  })

  it('records a capped run and makes no call', async () => {
    saveUpcomingNote(db, { text: 'Dentist bill in March.' })
    await seedBudgetProposal('food', MONTH, 15_000)
    recordRun(db, {
      kind: 'budget_nudge',
      model: config.GEMINI_MODEL_FAST,
      locale: 'en',
      payload: {},
      payloadHash: 'unrelated-hash',
      status: 'ok',
      costMicroEurOverride: eurToMicroEur(500),
    })
    const recorded = fakeGemini('never called')

    const outcome = await runBudgetNudge(db, { month: MONTH })

    expect(outcome.status).toBe('capped')
    expect(outcome.reason).toBe('month_budget_exceeded')
    expect(recorded.prompts).toHaveLength(0)
    const rows = recentRuns(db)
    expect(rows[0]?.status).toBe('capped')
    expect(rows[0]?.kind).toBe('budget_nudge')
    expect(rows[0]?.period).toBe(MONTH)
  })

  it('records a failed call without throwing', async () => {
    saveUpcomingNote(db, { text: 'Dentist bill in March.' })
    await seedBudgetProposal('food', MONTH, 15_000)
    fakeGemini(new Error('socket hang up'))

    const outcome = await runBudgetNudge(db, { month: MONTH })

    expect(outcome.status).toBe('error')
    expect(outcome.reason).toBe('call_failed')
    expect(outcome.adjusted).toBe(0)
    expect(recentRuns(db)[0]?.status).toBe('error')
    expect(recentRuns(db)[0]?.error).toContain('socket hang up')
  })

  it('records a bad response without throwing', async () => {
    saveUpcomingNote(db, { text: 'Dentist bill in March.' })
    await seedBudgetProposal('food', MONTH, 15_000)
    fakeGemini('not json at all')

    const outcome = await runBudgetNudge(db, { month: MONTH })

    expect(outcome.status).toBe('error')
    expect(outcome.reason).toBe('bad_response')
    expect(recentRuns(db)[0]?.status).toBe('error')
  })

  it('turns a grounded adjustment into a real, superseding proposal', async () => {
    saveUpcomingNote(db, { text: 'Dentist bill in March, about 150 euros.' })
    await seedBudgetProposal('food', MONTH, 15_000)
    fakeGemini('{"adjustments":[{"label":"c1","amountCents":18000}]}')

    const outcome = await runBudgetNudge(db, { month: MONTH })

    expect(outcome.status).toBe('ok')
    expect(outcome.degraded).toBe(false)
    expect(outcome.adjusted).toBe(1)
    expect(outcome.dropped).toEqual([])
    const pending = pendingBudgetProposals(db, MONTH)
    expect(pending).toHaveLength(1)
    expect(JSON.parse(pending[0]?.payloadJson ?? '{}')).toEqual({ amountCents: 18_000 })
    expect(recentRuns(db)[0]?.status).toBe('ok')
    expect(recentRuns(db)[0]?.kind).toBe('budget_nudge')
    expect(recentRuns(db)[0]?.period).toBe(MONTH)
  })

  it('drops an adjustment outside the magnitude bound, rather than clamping it', async () => {
    saveUpcomingNote(db, { text: 'Dentist bill in March.' })
    await seedBudgetProposal('food', MONTH, 15_000)
    // Ten times the suggested amount — well outside [suggested/3, suggested*3].
    fakeGemini('{"adjustments":[{"label":"c1","amountCents":150000}]}')

    const outcome = await runBudgetNudge(db, { month: MONTH })

    expect(outcome.status).toBe('ok')
    expect(outcome.adjusted).toBe(0)
    expect(outcome.dropped).toEqual([{ label: 'c1', amountCents: 150_000, reason: 'out_of_range' }])
    expect(pendingBudgetProposals(db, MONTH)).toHaveLength(1)
    expect(JSON.parse(pendingBudgetProposals(db, MONTH)[0]?.payloadJson ?? '{}')).toEqual({
      amountCents: 15_000,
    })
  })

  it('drops an adjustment for a label that candidate was never offered, rather than mapping it', async () => {
    saveUpcomingNote(db, { text: 'Dentist bill in March.' })
    await seedBudgetProposal('food', MONTH, 15_000)
    // `c9` is not one of this batch's real labels — a hallucinated or borrowed one.
    fakeGemini('{"adjustments":[{"label":"c9","amountCents":18000}]}')

    const outcome = await runBudgetNudge(db, { month: MONTH })

    expect(outcome.status).toBe('ok')
    expect(outcome.dropped).toEqual([{ label: 'c9', amountCents: 18_000, reason: 'unknown_label' }])
    expect(outcome.adjusted).toBe(0)
  })

  it('does not let one ProposalError abort the rest of the batch', async () => {
    saveUpcomingNote(db, { text: 'Dentist bill and car insurance both due in March.' })
    // `food`'s current budgeted amount (12 000, from the fixture) is exactly what
    // the model answers below — a no-op `createProposal` refuses, while `rent`'s
    // adjustment is a real change and must still go through.
    await seedBudgetProposal('food', MONTH, 15_000)
    await seedBudgetProposal('rent', MONTH, 100_000)
    fakeGemini(
      '{"adjustments":[{"label":"c1","amountCents":12000},{"label":"c2","amountCents":120000}]}',
    )

    const outcome = await runBudgetNudge(db, { month: MONTH })

    expect(outcome.status).toBe('ok')
    expect(outcome.adjusted).toBe(1)
    expect(outcome.dropped).toEqual([])
    const pending = pendingBudgetProposals(db, MONTH)
    expect(pending.map((row) => JSON.parse(row.payloadJson))).toEqual(
      expect.arrayContaining([{ amountCents: 15_000 }, { amountCents: 120_000 }]),
    )
  })

  it('never sends the category name to the model when the category is sensitive', async () => {
    db.$client.exec(
      `UPDATE category_meta SET sensitive = 1 WHERE category_id = 'food'`,
    )
    saveUpcomingNote(db, { text: 'Dentist bill in March.' })
    await seedBudgetProposal('food', MONTH, 15_000)
    const recorded = fakeGemini('{"adjustments":[]}')

    await runBudgetNudge(db, { month: MONTH })

    expect(recorded.prompts[0] ?? '').not.toContain('Groceries')
  })
})
