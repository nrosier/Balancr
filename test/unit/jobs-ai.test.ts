/**
 * The nightly AI pass.
 *
 * This is the only job that spends money, so the tests are mostly about
 * restraint rather than output:
 *
 *  - **A page load never pays.** Everything the Insights view reads is written
 *    here, and the narrative is written once per month however many nights run.
 *  - **An unavailable model is off, not capped and not failed.** No key, `AI_ENABLED=false`
 *    or a budget of zero: no call, no ledger row, the reason on the job detail, and the
 *    local housekeeping still happens (#165).
 *  - **A provider fault reaches the `jobs` row.** A month with no facts and a
 *    capped budget do not: those are states, and a nightly job stuck in `error`
 *    because the budget worked is a status nobody believes.
 *
 * `setGeminiClient` stands in for Google. A test that reached the API would cost
 * money, need a key, and fail on a plane.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { GoogleGenAI } from '@google/genai'
import { setGeminiClient } from '../../src/adapters/gemini/client.ts'
import { eurToMicroEur } from '../../src/adapters/gemini/pricing.ts'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { aiFindings, aiRuns, proposals } from '../../src/db/schema.ts'
import type { Signal } from '../../src/domain/aggregate/overspend.ts'
import { prepareMonth } from '../../src/domain/ai/analysis.ts'
import { openQuestionCount } from '../../src/domain/ai/clarify.ts'
import { loadNarrative } from '../../src/domain/ai/narrative.ts'
import { initI18n } from '../../src/i18n/index.ts'
import { logger } from '../../src/logger.ts'
import { aiJob, CATCHUP_NIGHTS, monthsToAnalyse, narrativePeriod } from '../../src/jobs/ai.ts'
import { registry } from '../../src/jobs/index.ts'
import { runJob, type JobDetail } from '../../src/jobs/runner.ts'
import { fact, seedMonth } from '../fixtures/month.ts'

const LAST = '2026-02'
const MONTH = '2026-03'
/** Mid-month, so only the current month is analysed unless a test says otherwise. */
const NIGHT = new Date('2026-03-12T02:00:00Z')

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

const overspend = (categoryId: string, cents: number, name = categoryId): Signal => ({
  code: 'over_available',
  categoryId,
  categoryName: name,
  severity: 'alert',
  metrics: { overspendCents: cents },
})

/** Two months of facts, the later one overspent, so both passes have something. */
function seedTwoMonths(): void {
  for (const month of [LAST, MONTH]) {
    seedMonth(db, month, {
      facts: [
        fact(month, 'food', { categoryName: 'Groceries' }),
        fact(month, 'rent', { categoryName: 'Rent' }),
      ],
      signals: [overspend('food', 8_000, 'Groceries')],
    })
  }
}

/** The label the payload gave a category, which is what the model answers with. */
function labelOf(month: string, categoryId: string): string {
  const prepared = prepareMonth(db, month, 'en')
  if (prepared === null) throw new Error(`no month ${month}`)
  const name = prepared.nameFor.get(categoryId) ?? ''
  for (const [label, mapped] of prepared.nameForLabel) if (mapped === name) return label
  throw new Error(`no label for ${categoryId}`)
}

interface Recorded {
  analysis: number
  narrative: number
}

/**
 * A stand-in for the SDK that answers each pass in its own shape.
 *
 * Dispatching on the response schema rather than replying with one canned body:
 * the narrative pass asks for prose and the analysis pass for JSON, and a fake
 * that returned JSON to both would let a narrative store a findings object.
 */
function fakeGemini(json: string, prose = '## March\n\nA quiet month.'): Recorded {
  const recorded: Recorded = { analysis: 0, narrative: 0 }
  const client = {
    models: {
      generateContent: async (request: { config?: { responseJsonSchema?: unknown } }) => {
        const structured = request.config?.responseJsonSchema !== undefined
        if (structured) recorded.analysis += 1
        else recorded.narrative += 1
        return {
          text: structured ? json : prose,
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

const response = (
  findings: { code: string; label: string; severity: string; confidence: number }[] = [],
  clarifications: { code: string; label: string; guess: string }[] = [],
): string => JSON.stringify({ findings, clarifications })

/** The pass, through the runner, so the `jobs` row is asserted too. */
const night = (now = NIGHT) => runJob(db, aiJob, now)

const runsOf = (kind: 'findings' | 'narrative') =>
  db.select().from(aiRuns).all().filter((row) => row.kind === kind)

describe('monthsToAnalyse', () => {
  it('is the latest stored month in the middle of a month', () => {
    expect(monthsToAnalyse(MONTH, NIGHT, 'Europe/Brussels')).toEqual([MONTH])
  })

  it('adds the month that just ended on the first nights of a new month', () => {
    // Its final days of spend arrived after the last night's run, so the figures
    // it was judged on were never its final ones.
    expect(monthsToAnalyse(MONTH, new Date('2026-03-01T02:00:00Z'), 'Europe/Brussels')).toEqual([
      LAST,
      MONTH,
    ])
    expect(
      monthsToAnalyse(MONTH, new Date(`2026-03-0${CATCHUP_NIGHTS}T02:00:00Z`), 'Europe/Brussels'),
    ).toEqual([LAST, MONTH])
  })

  it('stops after the catch-up nights', () => {
    const after = new Date(`2026-03-0${CATCHUP_NIGHTS + 1}T02:00:00Z`)
    expect(monthsToAnalyse(MONTH, after, 'Europe/Brussels')).toEqual([MONTH])
  })

  it('never reaches back from a month that is already in the past', () => {
    // A container that was off for a while: re-analysing January because today is
    // the 2nd of March would be paying for the wrong month.
    expect(monthsToAnalyse('2026-01', new Date('2026-03-02T02:00:00Z'), 'Europe/Brussels')).toEqual(
      ['2026-01'],
    )
  })

  it('reads the day in the configured zone', () => {
    // 23:30 UTC on the 3rd is already the 4th in Brussels, so the catch-up window
    // closes on local time rather than on UTC.
    const instant = new Date('2026-03-03T23:30:00Z')
    expect(monthsToAnalyse(MONTH, instant, 'Europe/Brussels')).toEqual([MONTH])
    expect(monthsToAnalyse(MONTH, instant, 'UTC')).toEqual([LAST, MONTH])
  })
})

describe('narrativePeriod', () => {
  it('is the last month that has fully ended', () => {
    expect(narrativePeriod(NIGHT)).toBe(LAST)
    expect(narrativePeriod(new Date('2026-01-04T02:00:00Z'))).toBe('2025-12')
  })
})

describe('the nightly pass', () => {
  it('writes the findings and the narrative a page will read', async () => {
    seedTwoMonths()
    const recorded = fakeGemini(
      response([
        { code: 'over_available', label: labelOf(MONTH, 'food'), severity: 'alert', confidence: 70 },
      ]),
    )

    const run = await night()

    expect(run.status).toBe('ok')
    expect(run.detail).toMatchObject({
      enabled: true,
      months: 1,
      analysisMonth: MONTH,
      analysisStatus: 'ok',
      degraded: false,
      narrativePeriod: LAST,
      narrativeStatus: 'ok',
    })
    expect(db.select().from(aiFindings).all()).toHaveLength(1)
    expect(loadNarrative(db, LAST, 'en')).not.toBeNull()
    expect(recorded).toEqual({ analysis: 1, narrative: 1 })
    expect(run.detail['costMicroEur']).toBeGreaterThan(0)
  })

  it('queues the questions the model asked about a real category', async () => {
    seedTwoMonths()
    fakeGemini(
      response([], [{ code: 'nature_unknown', label: labelOf(MONTH, 'food'), guess: 'variable' }]),
    )

    const run = await night()

    expect(run.detail['queued']).toBe(1)
    expect(openQuestionCount(db)).toBe(1)
  })

  it('pays for the narrative once, and the analysis once, however many nights run', async () => {
    // The narrative is cached per (period, locale): the deep model is the
    // expensive one, and nothing about a closed month changes. The analysis has
    // no such cache of its own, but a second night on an unchanged month reuses
    // the first night's answer for free rather than asking again (#160) — which
    // is the whole reason CATCHUP_NIGHTS re-runs the same month at all.
    seedTwoMonths()
    const recorded = fakeGemini(response())

    await night()
    await night(new Date('2026-03-13T02:00:00Z'))

    expect(recorded).toEqual({ analysis: 1, narrative: 1 })
    expect(runsOf('narrative')).toHaveLength(1)
    const analyses = runsOf('findings')
    expect(analyses).toHaveLength(2)
    expect(analyses[0]?.status).toBe('ok')
    expect(analyses[1]?.status).toBe('reused')
  })

  it('force reaches both the analysis and the narrative, so neither is served free (#160)', async () => {
    seedTwoMonths()
    const recorded = fakeGemini(response())

    await night()
    await runJob(db, aiJob, new Date('2026-03-13T02:00:00Z'), { force: true })

    // Without force this would be the reused/cached pass above: {analysis: 1, narrative: 1}.
    expect(recorded).toEqual({ analysis: 2, narrative: 2 })
    expect(runsOf('narrative')).toHaveLength(2)
    expect(runsOf('findings').every((row) => row.status === 'ok')).toBe(true)
  })

  it('analyses the month that just ended on the first night of a new one', async () => {
    seedTwoMonths()
    fakeGemini(response())

    const run = await night(new Date('2026-03-02T02:00:00Z'))

    expect(run.detail['months']).toBe(2)
    expect(runsOf('findings')).toHaveLength(2)
  })

  it('retires proposals nobody decided on', async () => {
    seedTwoMonths()
    fakeGemini(response())
    db.insert(proposals)
      .values({
        id: 'prop-1',
        type: 'category_meta.set',
        targetRef: 'food',
        payloadJson: '{"nature":"variable"}',
        expiresAt: new Date('2026-02-01T00:00:00Z'),
      })
      .run()

    const run = await night()

    expect(run.detail['expired']).toBe(1)
    expect(db.select().from(proposals).where(eq(proposals.id, 'prop-1')).get()?.status).toBe(
      'expired',
    )
  })

  it('reports a database with no facts rather than failing on it', async () => {
    // Before the first sync there is nothing to analyse, and an error row for that
    // would be a permanent false failure in the ops table.
    fakeGemini(response())

    const run = await night()

    expect(run.status).toBe('ok')
    expect(run.detail).toMatchObject({ months: 0, findings: 0 })
    expect(db.select().from(aiRuns).all()).toHaveLength(0)
  })

  it('treats a spent budget as a state, not a failure', async () => {
    seedTwoMonths()
    // Dated inside the night's own budget month: the guard reads the spend of the
    // month it is running in, not of the month the machine happens to be in.
    db.insert(aiRuns)
      .values({
        kind: 'findings',
        model: 'gemini-3.7-flash',
        locale: 'en',
        payloadJson: '{}',
        status: 'ok',
        costMicroEur: eurToMicroEur(500),
        createdAt: new Date('2026-03-05T02:00:00Z'),
      })
      .run()
    const recorded = fakeGemini(response())

    const run = await night()

    expect(run.status).toBe('ok')
    expect(run.detail['analysisStatus']).toBe('capped')
    expect(run.detail['degraded']).toBe(true)
    expect(recorded).toEqual({ analysis: 0, narrative: 0 })
  })

  it('fails the job when the call itself could not be made', async () => {
    // The one AI failure the ops table has to show: "no findings for four days" is
    // only visible if a broken integration is an error rather than a quiet detail.
    seedTwoMonths()
    setGeminiClient({
      models: {
        generateContent: async () => {
          throw new Error('socket hang up')
        },
      },
      caches: {
        create: async () => {
          throw new Error('too small to cache')
        },
      },
    } as unknown as GoogleGenAI)

    const run = await night()

    expect(run.status).toBe('error')
    expect(run.error).toContain('call_failed')
    // The ledger still has the attempt, with the transport message.
    expect(runsOf('findings')[0]?.error).toContain('socket hang up')
  })

  it('fails the job when the answer could not be grounded', async () => {
    seedTwoMonths()
    fakeGemini('I have reviewed your budget and think you should cut back.')

    const run = await night()

    expect(run.status).toBe('error')
    expect(run.error).toContain('bad_response')
  })
})

describe('with the model unavailable', () => {
  /**
   * The three ways an owner can end up with no model, and the environment for each.
   *
   * All three are the owner's own configuration, so all three behave identically —
   * which is the point of testing them together rather than testing the one that
   * happens to be implemented. The distinction that matters is only the reason code,
   * because that is what decides which sentence the pages print and which variable
   * the ops log names (#165).
   */
  const off = [
    { reason: 'notConfigured', env: { GEMINI_API_KEY: undefined } },
    { reason: 'switchedOff', env: { AI_ENABLED: 'false' } },
    { reason: 'budgetZero', env: { GEMINI_MONTHLY_BUDGET_EUR: '0' } },
  ] as const

  /**
   * A fresh module graph: `config` validates and freezes at import, so the only
   * way to test the switch a user actually turns is to rebuild the graph with it
   * turned off.
   */
  async function freshJob(env: Record<string, string | undefined>): Promise<typeof aiJob> {
    vi.resetModules()
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    const fresh = await import('../../src/jobs/ai.ts')
    return fresh.aiJob
  }

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  for (const { reason, env } of off) {
    it(`reports ${reason} without calling the model or logging a capped run`, async () => {
      seedTwoMonths()
      const job = await freshJob(env)

      const detail = (await job.run({ db, now: NIGHT, log: logger })) as JobDetail

      expect(detail).toMatchObject({ enabled: false, reason, months: 0 })
      // Not a `capped` row every 24 hours: none of the three is an incident.
      expect(db.select().from(aiRuns).all()).toHaveLength(0)
    })
  }

  it('still does the local housekeeping', async () => {
    seedTwoMonths()
    db.insert(proposals)
      .values({
        id: 'prop-1',
        type: 'category_meta.set',
        targetRef: 'food',
        payloadJson: '{"nature":"variable"}',
        expiresAt: new Date('2026-02-01T00:00:00Z'),
      })
      .run()
    const job = await freshJob({ GEMINI_MONTHLY_BUDGET_EUR: '0' })

    const detail = (await job.run({ db, now: NIGHT, log: logger })) as JobDetail

    expect(detail['expired']).toBe(1)
  })
})

describe('the registry', () => {
  it('runs the AI pass after the job whose output it reads', () => {
    // One shared queue, so registry order *is* the sequencing: an AI pass that ran
    // before `signals` would rank last night's judgements.
    const names = registry.map((job) => job.name)
    expect(names.indexOf('ai')).toBeGreaterThan(names.indexOf('signals'))
  })

  it('names each job once, because the jobs table is keyed by name', () => {
    const names = registry.map((job) => job.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
