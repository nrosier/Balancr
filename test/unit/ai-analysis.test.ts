/**
 * The analysis pass, end to end, with the SDK faked.
 *
 * The tests worth having here are not about the happy path — they are about the
 * two claims the whole design rests on:
 *
 *  - **A finding the model invented cannot become a sentence.** Not filtered out
 *    of the display, not shown with a caveat: there is no code path from a model
 *    response to a rendered figure, and the dropped item is recorded so the
 *    hallucination is visible rather than merely harmless.
 *  - **Every ending is either a run row or a month that was never attempted.** A
 *    capped run, a socket failure and an unparseable answer all leave a row with
 *    the payload they would have sent, and all three still return the
 *    deterministic list, because the deterministic list was never the model's to
 *    produce.
 *
 * `setGeminiClient` stands in for Google. A test that reached the API would cost
 * money, need a key, and fail on a plane.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GoogleGenAI } from '@google/genai'
import { DATA_OPEN, setGeminiClient } from '../../src/adapters/gemini/client.ts'
import { eurToMicroEur } from '../../src/adapters/gemini/pricing.ts'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { aiFindings } from '../../src/db/schema.ts'
import { syncAccountMap } from '../../src/domain/aggregate/accounts.ts'
import type { Signal } from '../../src/domain/aggregate/overspend.ts'
import {
  analysisInstruction,
  estimateAnalysis,
  prepareMonth,
  runAnalysis,
} from '../../src/domain/ai/analysis.ts'
import { recordRun, recentRuns, loadRunPayload } from '../../src/domain/ai/runs.ts'
import type { RedactedPayload } from '../../src/domain/ai/redact.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { fact, seedMonth } from '../fixtures/month.ts'

const MONTH = '2026-03'

let ctx: ReturnType<typeof createTestDb>
let db: Db

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  ctx = createTestDb()
  applyMigrations(ctx.db as never)
  db = ctx.db
})

afterEach(() => {
  setGeminiClient(null)
})

interface Recorded {
  prompts: string[]
}

/** Replies with one canned body, and records the prompts it was sent. */
function fakeGemini(
  reply: string | Error,
  usage: Record<string, number> = { promptTokenCount: 2_000, candidatesTokenCount: 200 },
): Recorded {
  const recorded: Recorded = { prompts: [] }
  const client = {
    models: {
      generateContent: async (request: { contents: string }) => {
        recorded.prompts.push(request.contents)
        if (reply instanceof Error) throw reply
        return { text: reply, usageMetadata: usage, modelVersion: 'gemini-3.7-flash-002' }
      },
    },
    // Caching is a cost optimisation; refusing it here keeps the fake small and
    // exercises the inline-system-prompt path the real client falls back to.
    caches: { create: async () => { throw new Error('too small to cache') } },
  }
  setGeminiClient(client as unknown as GoogleGenAI)
  return recorded
}

const response = (
  findings: { code: string; label: string; severity: string; confidence: number }[],
  clarifications: { code: string; label: string; guess: string }[] = [],
): string => JSON.stringify({ findings, clarifications })

/**
 * A computed overspend. The name is the signal's own: a sentence is rendered from
 * the name the producer recorded, not from whatever the category is called now.
 */
const overspend = (categoryId: string, cents: number, name = categoryId): Signal => ({
  code: 'over_available',
  categoryId,
  categoryName: name,
  severity: 'alert',
  metrics: { overspendCents: cents },
})

const backlog = (count: number): Signal => ({
  code: 'uncategorised_backlog',
  categoryId: null,
  categoryName: null,
  severity: 'warn',
  metrics: { count },
})

/** The month every test starts from: two categories, one of them overspent. */
function seedTypicalMonth(
  signals: readonly Signal[] = [overspend('food', 8_000, 'Groceries')],
): void {
  syncAccountMap(db, [{ source: 'actual', externalId: 'acc-1', name: 'KBC Zichtrekening 0123' }])
  seedMonth(db, MONTH, {
    facts: [
      fact(MONTH, 'food', { categoryName: 'Groceries' }),
      fact(MONTH, 'rent', { categoryName: 'Rent' }),
    ],
    signals,
  })
}

/** The label the payload gave one category, which is what the model answers with. */
function labelOf(categoryId: string): string {
  const prepared = prepareMonth(db, MONTH, 'en')
  if (prepared === null) throw new Error('no month')
  for (const [label, name] of prepared.nameForLabel) {
    if (name === (prepared.nameFor.get(categoryId) ?? '')) return label
  }
  throw new Error(`no label for ${categoryId}`)
}

describe('analysisInstruction', () => {
  it('names the month and the number of signals it is ranking', () => {
    // Billed on every run, so it stays short — but it has to say which month, or a
    // cached system prompt plus a generic instruction describes any month at all.
    const instruction = analysisInstruction({
      month: MONTH,
      signals: [{ code: 'over_available', label: 'c1', severity: 'alert', metrics: {} }],
    } as unknown as RedactedPayload)

    expect(instruction).toContain(MONTH)
    expect(instruction).toContain('1 findings')
  })
})

describe('prepareMonth', () => {
  it('maps every label back to a name that never left the machine', () => {
    seedTypicalMonth()
    const prepared = prepareMonth(db, MONTH, 'en')

    expect([...(prepared?.nameForLabel.values() ?? [])]).toContain('Groceries')
    // The mapping is local: the payload holds labels, and the account name is not
    // in it at all beyond what redact decided to send.
    expect(JSON.stringify(prepared?.payload)).not.toContain('acc-1')
  })

  it('drops a signal the payload cannot explain, but keeps it for the local list', () => {
    // A signal about a category that is not in the month's facts would be sent
    // with a null label, and null is the household sentinel — so a category's
    // numbers would arrive as a household finding.
    seedTypicalMonth([overspend('food', 8_000), overspend('ghost-category', 5_000)])
    const prepared = prepareMonth(db, MONTH, 'en')

    expect(prepared?.ranked).toHaveLength(2)
    expect(prepared?.sendable).toHaveLength(1)
    expect(prepared?.payload.signals).toHaveLength(1)
  })
})

describe('runAnalysis on a month with nothing to analyse', () => {
  it('records nothing at all', () => {
    // An error row for a month that has simply not been aggregated yet would be a
    // permanent failure in the ledger for something nobody attempted.
    return runAnalysis(db, { month: '2026-01' }).then((outcome) => {
      expect(outcome.status).toBe('skipped')
      expect(outcome.reason).toBe('no_facts')
      expect(outcome.runId).toBeNull()
      expect(recentRuns(db)).toHaveLength(0)
    })
  })
})

describe('runAnalysis', () => {
  it('renders the model’s ranking as local sentences with the real names', async () => {
    seedTypicalMonth([overspend('food', 8_000, 'Groceries'), backlog(4)])
    const food = labelOf('food')
    fakeGemini(
      response([
        { code: 'uncategorised_backlog', label: 'household', severity: 'warn', confidence: 90 },
        { code: 'over_available', label: food, severity: 'alert', confidence: 70 },
      ]),
    )

    const outcome = await runAnalysis(db, { month: MONTH, locale: 'en' })

    expect(outcome.status).toBe('ok')
    expect(outcome.degraded).toBe(false)
    // The model's order, kept: it is the one thing being paid for.
    expect(outcome.findings.map((finding) => finding.code)).toEqual([
      'uncategorised_backlog',
      'over_available',
    ])
    // The sentence is rendered here, from the signal's own numbers and the real
    // name — neither of which the model was given.
    expect(outcome.findings[1]?.text).toContain('Groceries')
    expect(outcome.findings[1]?.text).toContain('80')
    expect(outcome.findings[1]?.confidence).toBe(70)
  })

  it('sends labels and never a name the payload withheld', async () => {
    seedTypicalMonth()
    const recorded = fakeGemini(response([]))

    await runAnalysis(db, { month: MONTH })

    const sent = recorded.prompts[0] ?? ''
    expect(sent).toContain(DATA_OPEN)
    expect(sent).not.toContain('acc-1')
  })

  it('discards a finding nothing was computed for, and says it did', async () => {
    // The load-bearing case: a real code about a real category with no signal
    // behind it. `above_baseline` for a month that computed no baseline.
    seedTypicalMonth()
    const food = labelOf('food')
    fakeGemini(
      response([
        { code: 'above_baseline', label: food, severity: 'alert', confidence: 95 },
        { code: 'over_available', label: food, severity: 'alert', confidence: 60 },
      ]),
    )

    const outcome = await runAnalysis(db, { month: MONTH })

    expect(outcome.findings.map((finding) => finding.code)).toEqual(['over_available'])
    expect(outcome.dropped).toEqual([
      { code: 'above_baseline', label: food, reason: 'no_signal' },
    ])
    expect(db.select().from(aiFindings).all()).toHaveLength(1)
  })

  it('lowers a severity when the model does, and never raises one', async () => {
    seedTypicalMonth([overspend('food', 8_000, 'Groceries')])
    const food = labelOf('food')
    fakeGemini(
      response([{ code: 'over_available', label: food, severity: 'info', confidence: 40 }]),
    )

    const lowered = await runAnalysis(db, { month: MONTH })
    expect(lowered.findings[0]?.severity).toBe('info')

    // And the other direction: `uncategorised_backlog` is capped at warn by its
    // spec, so the alert the model asked for does not survive. A promotion would
    // move a threshold that lives in `settings` into a sentence.
    seedTypicalMonth([{ ...backlog(4) }])
    fakeGemini(
      response([{ code: 'uncategorised_backlog', label: 'household', severity: 'alert', confidence: 80 }]),
    )
    const clamped = await runAnalysis(db, { month: MONTH })
    expect(clamped.findings[0]?.severity).toBe('warn')
  })

  it('stores the numbers rather than the sentence', async () => {
    // A stored sentence would be in one language for good. Re-rendering from the
    // metrics is what makes switching language free.
    seedTypicalMonth()
    const food = labelOf('food')
    fakeGemini(response([{ code: 'over_available', label: food, severity: 'alert', confidence: 55 }]))

    await runAnalysis(db, { month: MONTH })

    const rows = db.select().from(aiFindings).all()
    expect(rows[0]?.metric).toBe('overspendCents')
    expect(JSON.parse(rows[0]?.valueJson ?? '{}')).toEqual({ overspendCents: 8_000 })
    expect(rows[0]?.month).toBe(MONTH)
    expect(rows[0]?.categoryId).toBe('food')
  })

  it('turns a clarification into a question about a real category', async () => {
    seedTypicalMonth()
    const food = labelOf('food')
    fakeGemini(
      response(
        [],
        [{ code: 'nature_unknown', label: food, guess: 'variable' }],
      ),
    )

    const outcome = await runAnalysis(db, { month: MONTH })

    expect(outcome.clarifications).toEqual([
      { code: 'nature_unknown', categoryId: 'food', categoryName: 'Groceries', guess: 'variable' },
    ])
  })

  it('records the run with the payload, the tokens and the prompt', async () => {
    seedTypicalMonth()
    fakeGemini(response([]), { promptTokenCount: 2_500, candidatesTokenCount: 300 })

    const outcome = await runAnalysis(db, { month: MONTH, locale: 'nl' })
    const row = recentRuns(db)[0]

    expect(row?.id).toBe(outcome.runId)
    expect(row?.kind).toBe('findings')
    expect(row?.status).toBe('ok')
    expect(row?.locale).toBe('nl')
    // The model that answered, not the one asked for.
    expect(row?.model).toBe('gemini-3.7-flash-002')
    expect(row?.inputTokens).toBe(2_500)
    expect(row?.costMicroEur).toBeGreaterThan(0)
    expect(loadRunPayload(db, row?.id ?? '')).not.toBeNull()
  })
})

describe('runAnalysis when it cannot ask the model', () => {
  it('degrades to the deterministic list when the month’s budget is gone', async () => {
    seedTypicalMonth([overspend('food', 8_000), backlog(4)])
    recordRun(db, {
      kind: 'findings',
      model: 'gemini-3.7-flash',
      locale: 'en',
      payload: {},
      payloadHash: 'unrelated-hash',
      status: 'ok',
      costMicroEurOverride: eurToMicroEur(500),
    })
    const recorded = fakeGemini(response([]))

    const outcome = await runAnalysis(db, { month: MONTH })

    expect(outcome.status).toBe('capped')
    expect(outcome.reason).toBe('month_budget_exceeded')
    expect(outcome.degraded).toBe(true)
    // Real findings in a defensible order, just not the model's order.
    expect(outcome.findings).toHaveLength(2)
    expect(recorded.prompts).toHaveLength(0)

    const row = recentRuns(db)[0]
    expect(row?.status).toBe('capped')
    // Nothing was sent, so nothing is billed — but the payload is stored, so the
    // audit view shows what would have gone out.
    expect(row?.costMicroEur).toBe(0)
    expect(loadRunPayload(db, row?.id ?? '')).not.toBeNull()
  })

  it('degrades on a transport failure without throwing', async () => {
    // A nightly job that dies on a socket error leaves no trace of having tried.
    seedTypicalMonth()
    fakeGemini(new Error('socket hang up'))

    const outcome = await runAnalysis(db, { month: MONTH })

    expect(outcome.status).toBe('error')
    expect(outcome.reason).toBe('call_failed')
    expect(outcome.findings).toHaveLength(1)
    const row = recentRuns(db)[0]
    expect(row?.status).toBe('error')
    expect(row?.error).toContain('socket hang up')
  })

  it('bills the tokens of an answer it then rejects', async () => {
    // The response did not parse, but it was generated: the guard has to see the
    // cost or a model stuck in a loop is free.
    seedTypicalMonth()
    fakeGemini('I have reviewed your budget and think you should cut back.', {
      promptTokenCount: 2_000,
      candidatesTokenCount: 400,
    })

    const outcome = await runAnalysis(db, { month: MONTH })

    expect(outcome.reason).toBe('bad_response')
    expect(outcome.costMicroEur).toBeGreaterThan(0)
    const row = recentRuns(db)[0]
    expect(row?.status).toBe('error')
    expect(row?.outputTokens).toBe(400)
    expect(row?.costMicroEur).toBeGreaterThan(0)
  })

  it('rejects a well-formed answer with an invented code', async () => {
    seedTypicalMonth()
    fakeGemini(response([{ code: 'spending_too_high', label: 'c1', severity: 'alert', confidence: 99 }]))

    const outcome = await runAnalysis(db, { month: MONTH })

    expect(outcome.reason).toBe('bad_response')
    expect(outcome.findings).toHaveLength(1)
    expect(db.select().from(aiFindings).all()).toHaveLength(0)
  })
})

describe('runAnalysis reuse (#160)', () => {
  it('serves a second call on the same bundle for free, without asking the model again', async () => {
    seedTypicalMonth([overspend('food', 8_000, 'Groceries')])
    const food = labelOf('food')
    const recorded = fakeGemini(
      response([{ code: 'over_available', label: food, severity: 'alert', confidence: 70 }]),
    )

    const first = await runAnalysis(db, { month: MONTH })
    expect(first.status).toBe('ok')
    expect(recorded.prompts).toHaveLength(1)

    const second = await runAnalysis(db, { month: MONTH })

    expect(recorded.prompts).toHaveLength(1)
    expect(second.status).toBe('ok')
    expect(second.reason).toBe('reused')
    expect(second.costMicroEur).toBe(0)
    expect(second.findings).toEqual(first.findings)

    const row = recentRuns(db)[0]
    expect(row?.status).toBe('reused')
    expect(row?.reusedFromRunId).toBe(first.runId)
  })

  it('calls again when the bundle actually changed', async () => {
    seedTypicalMonth([overspend('food', 8_000, 'Groceries')])
    const food = labelOf('food')
    const recorded = fakeGemini(
      response([{ code: 'over_available', label: food, severity: 'alert', confidence: 70 }]),
    )
    await runAnalysis(db, { month: MONTH })

    seedTypicalMonth([overspend('food', 12_000, 'Groceries')])
    fakeGemini(response([{ code: 'over_available', label: food, severity: 'alert', confidence: 70 }]))
    const second = await runAnalysis(db, { month: MONTH })

    expect(recorded.prompts).toHaveLength(1)
    expect(second.reason).not.toBe('reused')
    expect(second.status).toBe('ok')
  })

  it('force calls the model again even though a matching run exists', async () => {
    seedTypicalMonth([overspend('food', 8_000, 'Groceries')])
    const food = labelOf('food')
    const recorded = fakeGemini(
      response([{ code: 'over_available', label: food, severity: 'alert', confidence: 70 }]),
    )
    await runAnalysis(db, { month: MONTH })

    const second = await runAnalysis(db, { month: MONTH, force: true })

    expect(recorded.prompts).toHaveLength(2)
    expect(second.reason).not.toBe('reused')
    expect(second.status).toBe('ok')
  })

  it('reuses even when the month budget is exhausted — the ordering the issue exists for', async () => {
    // The load-bearing case: a reuse is free, so it must never be turned away by
    // a budget check that runs before the reuse lookup does.
    seedTypicalMonth([overspend('food', 8_000, 'Groceries')])
    const food = labelOf('food')
    fakeGemini(response([{ code: 'over_available', label: food, severity: 'alert', confidence: 70 }]))
    const first = await runAnalysis(db, { month: MONTH })
    expect(first.status).toBe('ok')

    recordRun(db, {
      kind: 'findings',
      model: 'gemini-3.7-flash',
      locale: 'en',
      payload: {},
      payloadHash: 'unrelated-hash',
      status: 'ok',
      costMicroEurOverride: eurToMicroEur(500),
    })

    const recorded = fakeGemini(
      response([{ code: 'over_available', label: food, severity: 'alert', confidence: 70 }]),
    )
    const second = await runAnalysis(db, { month: MONTH })

    expect(recorded.prompts).toHaveLength(0)
    expect(second.status).toBe('ok')
    expect(second.reason).toBe('reused')
    expect(second.costMicroEur).toBe(0)
  })
})

describe('estimateAnalysis reuse (#160)', () => {
  it('prices a reuse at zero and allows it, even over budget', async () => {
    seedTypicalMonth([overspend('food', 8_000, 'Groceries')])
    const food = labelOf('food')
    fakeGemini(response([{ code: 'over_available', label: food, severity: 'alert', confidence: 70 }]))
    await runAnalysis(db, { month: MONTH })

    recordRun(db, {
      kind: 'findings',
      model: 'gemini-3.7-flash',
      locale: 'en',
      payload: {},
      payloadHash: 'unrelated-hash',
      status: 'ok',
      costMicroEurOverride: eurToMicroEur(500),
    })

    const estimate = estimateAnalysis(db, { month: MONTH })

    expect(estimate.allowed).toBe(true)
    expect(estimate.estimateMicroEur).toBe(0)
    expect(estimate.reason).toBe('reused')
  })
})
