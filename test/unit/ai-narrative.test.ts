/**
 * The narrative: the one place the model writes prose, and therefore the one place
 * with no grounding step to catch it inventing something. What can still be pinned
 * down is everything around the prose:
 *
 *  - **It is written once.** A second read of the same month in the same language
 *    costs nothing, because a language toggle that quietly runs the deep model is a
 *    bug wearing a feature's clothes.
 *  - **What is stored is what the model wrote.** Labels stay in the row; the
 *    household's own names are substituted on the way to the screen. That is what
 *    makes the stored text safe to send back for a translation.
 *  - **Translating is not re-analysing.** It sends a page of text to the fast
 *    model, keeps every figure, and never produces a second opinion about the
 *    month.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GoogleGenAI } from '@google/genai'
import { setGeminiClient } from '../../src/adapters/gemini/client.ts'
import { eurToMicroEur } from '../../src/adapters/gemini/pricing.ts'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb, type Db } from '../../src/db/index.ts'
import { config } from '../../src/config.ts'
import { prepareMonth } from '../../src/domain/ai/analysis.ts'
import type { Signal } from '../../src/domain/aggregate/overspend.ts'
import {
  latestNarrative,
  loadNarrative,
  narrativeInstruction,
  narrativeLocales,
  renderNarrative,
  runNarrative,
  storeNarrative,
  substituteLabels,
  translateNarrative,
} from '../../src/domain/ai/narrative.ts'
import type { RedactedPayload } from '../../src/domain/ai/redact.ts'
import { recentRuns, recordRun } from '../../src/domain/ai/runs.ts'
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
  configs: Record<string, unknown>[]
  models: string[]
}

function fakeGemini(reply: string | Error): Recorded {
  const recorded: Recorded = { prompts: [], configs: [], models: [] }
  const client = {
    models: {
      generateContent: async (request: {
        contents: string
        config: Record<string, unknown>
        model: string
      }) => {
        recorded.prompts.push(request.contents)
        recorded.configs.push(request.config)
        recorded.models.push(request.model)
        if (reply instanceof Error) throw reply
        return {
          text: reply,
          usageMetadata: { promptTokenCount: 3_000, candidatesTokenCount: 600 },
          modelVersion: 'gemini-3.1-pro-preview-002',
        }
      },
    },
    caches: { create: async () => { throw new Error('too small to cache') } },
  }
  setGeminiClient(client as unknown as GoogleGenAI)
  return recorded
}

const overspend = (categoryId: string, name: string): Signal => ({
  code: 'over_available',
  categoryId,
  categoryName: name,
  severity: 'alert',
  metrics: { overspendCents: 8_000 },
})

function seedTypicalMonth(): void {
  seedMonth(db, MONTH, {
    facts: [
      fact(MONTH, 'food', { categoryName: 'Groceries' }),
      fact(MONTH, 'therapy', { categoryName: 'Therapy' }),
    ],
    signals: [overspend('food', 'Groceries')],
  })
}

/** The payload label for a category, which is all the model ever sees of it. */
function labelOf(name: string): string {
  const prepared = prepareMonth(db, MONTH, 'en')
  for (const [label, mapped] of prepared?.nameForLabel ?? []) {
    if (mapped === name) return label
  }
  throw new Error(`no label for ${name}`)
}

/** A run row to hang a stored narrative off, for the tests that skip the call. */
const someRun = (): string =>
  recordRun(db, {
    kind: 'narrative',
    model: config.GEMINI_MODEL_DEEP,
    locale: 'en',
    payload: {},
    status: 'ok',
  })

describe('narrativeInstruction', () => {
  it('names the month and tells the model to leave labels alone', () => {
    const instruction = narrativeInstruction({ month: MONTH } as unknown as RedactedPayload)
    expect(instruction).toContain(MONTH)
    expect(instruction).toMatch(/label/i)
  })
})

describe('substituteLabels', () => {
  it('puts the household’s own names back', () => {
    const names = new Map([
      ['c1', 'Groceries'],
      ['a2', 'KBC Zichtrekening'],
    ])
    expect(substituteLabels('Spending in c1 rose, and a2 is unreconciled.', names, 'en')).toBe(
      'Spending in Groceries rose, and KBC Zichtrekening is unreconciled.',
    )
  })

  it('says so plainly for a label whose category has since disappeared', () => {
    // A narrative outlives the bundle it was written from: a category deleted in
    // April must not leave a bare `c9` in March's review.
    expect(substituteLabels('c9 went up.', new Map(), 'en')).toBe('an unnamed category went up.')
    expect(substituteLabels('a9 is stale.', new Map(), 'en')).toBe('an unnamed account is stale.')
  })

  it('translates the placeholder too', () => {
    expect(substituteLabels('c9 steeg.', new Map(), 'nl')).toContain('naamloze categorie')
  })

  it('does not rescan a substituted name for labels', () => {
    // A category genuinely called "c1" would otherwise loop or double-substitute.
    expect(substituteLabels('c1 rose.', new Map([['c1', 'c2 Savings']]), 'en')).toBe(
      'c2 Savings rose.',
    )
  })

  it('leaves ordinary prose alone', () => {
    const text = 'Nothing much happened in March; the account balance held.'
    expect(substituteLabels(text, new Map(), 'en')).toBe(text)
  })
})

describe('the store', () => {
  it('keeps one narrative per period and locale', () => {
    const first = someRun()
    storeNarrative(db, { runId: first, period: MONTH, locale: 'en', bodyMd: 'first' })
    storeNarrative(db, { runId: someRun(), period: MONTH, locale: 'en', bodyMd: 'second' })

    expect(loadNarrative(db, MONTH, 'en')?.bodyMd).toBe('second')
    expect(narrativeLocales(db, MONTH)).toEqual(['en'])
  })

  it('keeps the two languages of one month apart', () => {
    storeNarrative(db, { runId: someRun(), period: MONTH, locale: 'en', bodyMd: 'english' })
    storeNarrative(db, { runId: someRun(), period: MONTH, locale: 'nl', bodyMd: 'nederlands' })

    expect(narrativeLocales(db, MONTH)).toEqual(['en', 'nl'])
    expect(loadNarrative(db, MONTH, 'nl')?.bodyMd).toBe('nederlands')
  })

  it('finds the newest month in one language, for the degraded view', () => {
    storeNarrative(db, { runId: someRun(), period: '2026-01', locale: 'en', bodyMd: 'january' })
    storeNarrative(db, { runId: someRun(), period: '2026-03', locale: 'en', bodyMd: 'march' })
    storeNarrative(db, { runId: someRun(), period: '2026-04', locale: 'nl', bodyMd: 'april' })

    expect(latestNarrative(db, 'en')?.bodyMd).toBe('march')
    expect(latestNarrative(db, 'nl')?.bodyMd).toBe('april')
    expect(latestNarrative(db, 'fr')).toBeNull()
  })
})

describe('renderNarrative', () => {
  it('substitutes before rendering, so a hostile name is escaped', () => {
    // Order is the whole safety argument: substituting into finished HTML would
    // inject the name unescaped.
    seedMonth(db, MONTH, {
      facts: [fact(MONTH, 'x', { categoryName: '<script>alert(1)</script>' })],
    })
    const label = labelOf('<script>alert(1)</script>')
    const row = storeNarrative(db, {
      runId: someRun(),
      period: MONTH,
      locale: 'en',
      bodyMd: `Spending in ${label} rose.`,
    })

    const html = renderNarrative(db, row)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('renders a narrative whose month has been dropped since', () => {
    const row = storeNarrative(db, {
      runId: someRun(),
      period: '2025-12',
      locale: 'en',
      bodyMd: 'c1 was the largest category.',
    })
    expect(renderNarrative(db, row)).toBe('<p>an unnamed category was the largest category.</p>')
  })
})

describe('runNarrative', () => {
  it('writes the month, stores it with the labels intact, and renders the names', async () => {
    seedTypicalMonth()
    const label = labelOf('Groceries')
    fakeGemini(`## March\n\nSpending in ${label} ran over its balance.`)

    const outcome = await runNarrative(db, { period: MONTH, locale: 'en' })

    expect(outcome.status).toBe('ok')
    expect(outcome.degraded).toBe(false)
    // Stored as written: a name in this row would be a name the translate action
    // then sends back to Google.
    expect(outcome.bodyMd).toContain(label)
    expect(loadNarrative(db, MONTH, 'en')?.bodyMd).toContain(label)
    // Rendered with the name, and the heading flattened to h3 by the renderer.
    expect(outcome.html).toContain('Groceries')
    expect(outcome.html).toContain('<h3>March</h3>')
  })

  it('uses the deep model, asks for prose rather than JSON, and bounds the length', async () => {
    seedTypicalMonth()
    const recorded = fakeGemini('A quiet month.')

    await runNarrative(db, { period: MONTH })

    expect(recorded.models[0]).toBe(config.GEMINI_MODEL_DEEP)
    expect(recorded.configs[0]?.['responseJsonSchema']).toBeUndefined()
    expect(recorded.configs[0]?.['maxOutputTokens']).toBeGreaterThan(0)
  })

  it('serves the cached month rather than paying twice', async () => {
    seedTypicalMonth()
    const recorded = fakeGemini('A quiet month.')

    await runNarrative(db, { period: MONTH, locale: 'en' })
    const second = await runNarrative(db, { period: MONTH, locale: 'en' })

    expect(recorded.prompts).toHaveLength(1)
    expect(second.status).toBe('cached')
    expect(second.reason).toBe('cached')
    expect(second.costMicroEur).toBe(0)
    expect(second.html).toContain('quiet month')
  })

  it('rewrites the month when asked explicitly', async () => {
    seedTypicalMonth()
    fakeGemini('First take.')
    await runNarrative(db, { period: MONTH, locale: 'en' })

    const recorded = fakeGemini('Second take.')
    const forced = await runNarrative(db, { period: MONTH, locale: 'en', force: true })

    expect(recorded.prompts).toHaveLength(1)
    expect(forced.status).toBe('ok')
    expect(loadNarrative(db, MONTH, 'en')?.bodyMd).toBe('Second take.')
    // Still one row: regenerating replaces, it does not accumulate.
    expect(narrativeLocales(db, MONTH)).toEqual(['en'])
  })

  it('asks separately for each language, and keeps both', async () => {
    seedTypicalMonth()
    fakeGemini('An English month.')
    await runNarrative(db, { period: MONTH, locale: 'en' })
    fakeGemini('Een Nederlandse maand.')
    await runNarrative(db, { period: MONTH, locale: 'nl' })

    expect(narrativeLocales(db, MONTH)).toEqual(['en', 'nl'])
  })

  it('records nothing for a month with no facts', async () => {
    const outcome = await runNarrative(db, { period: '2026-01' })

    expect(outcome.status).toBe('skipped')
    expect(outcome.reason).toBe('no_facts')
    expect(recentRuns(db)).toHaveLength(0)
  })

  it('records a capped run and returns nothing to render', async () => {
    // Deliberately not "yesterday's answer": the page composes that from
    // `latestNarrative` with a banner, so a stale month can never be mistaken for
    // this one.
    seedTypicalMonth()
    recordRun(db, {
      kind: 'narrative',
      model: config.GEMINI_MODEL_DEEP,
      locale: 'en',
      payload: {},
      status: 'ok',
      costMicroEurOverride: eurToMicroEur(500),
    })
    const recorded = fakeGemini('Never sent.')

    const outcome = await runNarrative(db, { period: MONTH, locale: 'en' })

    expect(outcome.status).toBe('capped')
    expect(outcome.reason).toBe('month_budget_exceeded')
    expect(outcome.html).toBeNull()
    expect(recorded.prompts).toHaveLength(0)
    expect(recentRuns(db)[0]?.status).toBe('capped')
    expect(loadNarrative(db, MONTH, 'en')).toBeNull()
  })

  it('records a failed call without throwing', async () => {
    seedTypicalMonth()
    fakeGemini(new Error('socket hang up'))

    const outcome = await runNarrative(db, { period: MONTH })

    expect(outcome.status).toBe('error')
    expect(outcome.reason).toBe('call_failed')
    expect(recentRuns(db)[0]?.error).toContain('socket hang up')
  })

  it('refuses to store text that renders to nothing', async () => {
    // A bare quote marker is text the client accepts and the renderer empties. An
    // empty panel carrying a timestamp and a cost is worse than no panel.
    seedTypicalMonth()
    fakeGemini('>')

    const outcome = await runNarrative(db, { period: MONTH })

    expect(outcome.reason).toBe('empty_response')
    expect(loadNarrative(db, MONTH, config.DEFAULT_LOCALE)).toBeNull()
    const row = recentRuns(db)[0]
    expect(row?.status).toBe('error')
    // The tokens were spent, so they are billed.
    expect(row?.outputTokens).toBe(600)
    expect(row?.costMicroEur).toBeGreaterThan(0)
  })
})

describe('translateNarrative', () => {
  it('sends the stored text and stores the translation under the new language', async () => {
    seedTypicalMonth()
    storeNarrative(db, {
      runId: someRun(),
      period: MONTH,
      locale: 'en',
      bodyMd: 'Spending in c1 ran over.',
    })
    const recorded = fakeGemini('Uitgaven in c1 liepen over.')

    const outcome = await translateNarrative(db, { period: MONTH, from: 'en', to: 'nl' })

    expect(outcome.status).toBe('ok')
    expect(outcome.locale).toBe('nl')
    expect(loadNarrative(db, MONTH, 'nl')?.bodyMd).toBe('Uitgaven in c1 liepen over.')
    // The label form is what goes out: the English row holds no name, so the
    // translation cannot leak one either.
    expect(recorded.prompts[0]).toContain('Spending in c1 ran over.')
    expect(recorded.prompts[0]).not.toContain('Groceries')
    // The fast model, not the deep one: this is a page of text, not a month of facts.
    expect(recorded.models[0]).toBe(config.GEMINI_MODEL_FAST)
    expect(recorded.configs[0]?.['temperature']).toBe(0)
  })

  it('renders the translation with the local names', async () => {
    seedTypicalMonth()
    const label = labelOf('Groceries')
    storeNarrative(db, { runId: someRun(), period: MONTH, locale: 'en', bodyMd: `In ${label}.` })
    fakeGemini(`In ${label}.`)

    const outcome = await translateNarrative(db, { period: MONTH, from: 'en', to: 'nl' })
    expect(outcome.html).toContain('Groceries')
  })

  it('does nothing when there is nothing to translate', async () => {
    const recorded = fakeGemini('never called')
    const outcome = await translateNarrative(db, { period: MONTH, from: 'en', to: 'nl' })

    expect(outcome.status).toBe('skipped')
    expect(outcome.reason).toBe('no_source')
    expect(recorded.prompts).toHaveLength(0)
    expect(recentRuns(db)).toHaveLength(0)
  })

  it('refuses to translate a month into its own language', async () => {
    storeNarrative(db, { runId: someRun(), period: MONTH, locale: 'en', bodyMd: 'text' })
    const recorded = fakeGemini('never called')

    const outcome = await translateNarrative(db, { period: MONTH, from: 'en', to: 'en' })

    expect(outcome.reason).toBe('same_locale')
    expect(recorded.prompts).toHaveLength(0)
  })

  it('serves an existing translation rather than paying again', async () => {
    seedTypicalMonth()
    storeNarrative(db, { runId: someRun(), period: MONTH, locale: 'en', bodyMd: 'english' })
    storeNarrative(db, { runId: someRun(), period: MONTH, locale: 'nl', bodyMd: 'nederlands' })
    const recorded = fakeGemini('never called')

    const outcome = await translateNarrative(db, { period: MONTH, from: 'en', to: 'nl' })

    expect(outcome.status).toBe('cached')
    expect(outcome.bodyMd).toBe('nederlands')
    expect(recorded.prompts).toHaveLength(0)
  })

  it('is capped by the same budget as an analysis', async () => {
    storeNarrative(db, { runId: someRun(), period: MONTH, locale: 'en', bodyMd: 'english' })
    recordRun(db, {
      kind: 'narrative',
      model: config.GEMINI_MODEL_FAST,
      locale: 'en',
      payload: {},
      status: 'ok',
      costMicroEurOverride: eurToMicroEur(500),
    })
    const recorded = fakeGemini('never called')

    const outcome = await translateNarrative(db, { period: MONTH, from: 'en', to: 'nl' })

    expect(outcome.status).toBe('capped')
    expect(recorded.prompts).toHaveLength(0)
    expect(loadNarrative(db, MONTH, 'nl')).toBeNull()
  })
})
