/**
 * The insights page: what the model concluded, and the receipts for it.
 *
 * Four things here are worth pinning, and each is a decision the page makes rather
 * than a shape the server handed it:
 *
 *  - **A finding this bundle cannot state is dropped, not printed.** `code` is a plain
 *    string on the wire so a server one release ahead can emit a finding this client
 *    has no sentence for, and a signal can arrive missing the metric its sentence
 *    interpolates. Both render as nothing — a sentence with `{{delta}}` in it, or a
 *    bare `gremlins`, is worse than a shorter list.
 *  - **Severity is grouped, worst first, and never carried by colour alone.** The order
 *    comes from `SEVERITY_RANK`, so this asserts the page agrees with the table the
 *    server ranked by, and every group states its severity in words.
 *  - **The ledger lists every attempt.** A `capped` run is the row that explains an
 *    answer missing from the page above it, and its payload is still readable. The
 *    payload itself arrives only when a row is opened, which is the whole reason the
 *    wire does not carry it.
 *  - **Nothing on the page can be answered or applied yet.** #43–#45 add the chat and
 *    the apply handlers; until then both queues say so on screen, and a test is the
 *    only thing that notices if that sentence goes missing while the buttons are still
 *    absent.
 *
 * The four states of the endpoint are `overview.test.tsx`'s contract and are not
 * repeated. What is repeated is emptiness, because this page's `isEmpty` is the one
 * that has to ignore a field: `spend` is on every response and reads zero of the
 * configured budget on a fresh install.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BudgetNudge } from '../src/insights/BudgetNudge.tsx'
import { Findings } from '../src/insights/Findings.tsx'
import { Ledger } from '../src/insights/Ledger.tsx'
import { Narrative } from '../src/insights/Narrative.tsx'
import { CategoryGuesses, Proposals, Questions } from '../src/insights/Pending.tsx'
import { Insights } from '../src/pages/Insights.tsx'
import { formatMoney } from '../src/shared.ts'
import type { AiBudgetNudgeRun, AiEstimate, AiRun, Freshness, Insights as InsightsPayload } from '../src/shared.ts'
import { i18nReady, renderApp, visit } from './helpers.tsx'

const FRESH: Freshness = { stale: false, asOf: null, jobsEnabled: true, jobs: [] }

/**
 * Five signals: one per severity, one that is good news, and two the bundle has to
 * refuse — an unknown code and a sentence missing half its numbers.
 */
const SIGNALS: InsightsPayload['signals'] = [
  {
    code: 'over_available',
    categoryId: 'c-groceries',
    categoryName: 'Groceries',
    severity: 'alert',
    metrics: { overspendCents: 12_500 },
  },
  {
    code: 'above_baseline',
    categoryId: 'c-restaurants',
    categoryName: 'Restaurants',
    severity: 'warn',
    metrics: { deltaBp: 1_800, baselineCents: 20_000 },
  },
  {
    code: 'below_baseline',
    categoryId: 'c-transport',
    categoryName: 'Transport',
    severity: 'info',
    metrics: { deltaBp: -900 },
  },
  // A server a release ahead of this bundle.
  { code: 'gremlins', categoryId: null, categoryName: null, severity: 'alert', metrics: {} },
  // `over_assigned` needs `assigned` as well as `spent`.
  {
    code: 'over_assigned',
    categoryId: 'c-clothing',
    categoryName: 'Clothing',
    severity: 'warn',
    metrics: { spentCents: 5_000 },
  },
]

const RUNS: AiRun[] = [
  {
    id: 'run-findings',
    kind: 'findings',
    period: '2026-08',
    model: 'gemini-3.7-flash',
    locale: 'en',
    status: 'ok',
    inputTokens: 3_120,
    outputTokens: 480,
    cachedTokens: 2_048,
    costMicroEur: 1_240,
    durationMs: 1_900,
    error: null,
    reusedFromRunId: null,
    createdAt: '2026-09-01T04:12:00Z',
  },
  {
    id: 'run-narrative',
    kind: 'narrative',
    period: '2026-08',
    model: 'gemini-3.1-pro-preview',
    locale: 'en',
    status: 'capped',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costMicroEur: 0,
    durationMs: null,
    error: null,
    reusedFromRunId: null,
    createdAt: '2026-08-31T23:05:00Z',
  },
  {
    id: 'run-clarify',
    kind: 'clarify',
    period: null,
    model: 'gemini-3.7-flash',
    locale: 'nl',
    status: 'error',
    inputTokens: 900,
    outputTokens: 0,
    cachedTokens: 0,
    costMicroEur: 0,
    durationMs: 220,
    error: 'RESOURCE_EXHAUSTED: quota exceeded for this project',
    reusedFromRunId: null,
    createdAt: '2026-08-30T22:00:00Z',
  },
]

/** The configured-and-on answer, which is what every fixture but one carries. */
const AI_ON = { enabled: true, reason: null } as const

/** A month the AI layer has been all the way through. */
const FULL: InsightsPayload = {
  freshness: FRESH,
  ai: AI_ON,
  owner: true,
  month: '2026-08',
  factsChangedAt: null,
  months: ['2026-08', '2026-07'],
  signals: SIGNALS,
  narrative: {
    period: '2026-08',
    locale: 'en',
    html: '<p>Spending held steady, with <strong>Groceries</strong> the exception.</p>',
    generatedAt: '2026-09-01T04:12:00Z',
    model: 'gemini-3.1-pro-preview',
  },
  questions: [
    {
      id: 'q-nature',
      categoryId: 'c-therapy',
      categoryName: 'Therapy',
      code: 'nature_unknown',
      question: 'Is Therapy a fixed cost, a variable one, or free spending?',
      guess: 'fixed',
      guessLabel: 'Fixed cost',
      choices: [
        { value: 'fixed', label: 'Fixed cost' },
        { value: 'variable', label: 'Variable cost' },
      ],
      materialityBp: 420,
      createdAt: '2026-09-01T04:12:00Z',
    },
    {
      // Free text, and the model had no guess to offer.
      id: 'q-purpose',
      categoryId: 'c-hobbies',
      categoryName: 'Hobbies',
      code: 'purpose_unknown',
      question: 'What do you use Hobbies for?',
      guess: '',
      guessLabel: null,
      choices: null,
      materialityBp: 150,
      createdAt: '2026-09-01T04:12:00Z',
    },
  ],
  proposals: [
    {
      id: 'p-restaurants',
      type: 'category_meta',
      targetRef: 'c-restaurants',
      targetName: 'Restaurants',
      fields: [
        {
          field: 'nature',
          label: 'Type of cost',
          before: 'not set',
          after: 'Free spending',
          warn: null,
        },
        {
          field: 'sensitive',
          label: 'Name kept from the AI',
          before: 'Yes',
          after: 'No',
          warn: 'Applying this starts sending the category name to the AI.',
        },
      ],
      createdAt: '2026-09-01T04:13:00Z',
      expiresAt: '2026-09-08T04:13:00Z',
      amountCents: null,
    },
  ],
  categoryGuessCandidates: [
    {
      transactionId: 'txn-bakery',
      payeeName: 'Corner Bakery',
      amountCents: -1_240,
      date: '2026-08-14',
      history: [{ categoryId: 'c-groceries', categoryName: 'Groceries', count: 1 }],
    },
  ],
  spend: {
    month: '2026-09',
    spentMicroEur: 1_240,
    budgetMicroEur: 15_000_000,
    usedBp: 0,
    exceeded: false,
  },
  runs: RUNS,
}

/** What a deployment whose AI job has never run answers. */
const EMPTY: InsightsPayload = {
  freshness: FRESH,
  ai: AI_ON,
  owner: true,
  month: null,
  factsChangedAt: null,
  months: [],
  signals: [],
  narrative: null,
  questions: [],
  proposals: [],
  categoryGuessCandidates: [],
  spend: {
    month: '2026-09',
    spentMicroEur: 0,
    budgetMicroEur: 15_000_000,
    usedBp: 0,
    exceeded: false,
  },
  runs: [],
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Answers each path from a map, and fails loudly on one no test arranged. */
function serve(replies: Record<string, Response | Error>): ReturnType<typeof vi.fn> {
  const mock = vi.fn((path: string) => {
    const reply = replies[path]
    if (reply === undefined) return Promise.reject(new Error(`unstubbed request: ${path}`))
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply.clone())
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeAll(async () => {
  await i18nReady()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // Most tests here never set a path and rely on landing on the findings tab by
  // default; the few that navigate elsewhere (#228) would otherwise leak that
  // location into whichever test runs next.
  visit('/')
})

describe('the page', () => {
  it('offers a refresh rather than five empty cards when nothing has run', async () => {
    serve({ '/api/insights': json(EMPTY) })
    renderApp(<Insights />)

    expect(await screen.findByText('No data yet')).toBeTruthy()
    // `spend` is on the payload even here — a budget with nothing spent against it is
    // not content, and counting it would mean this page never says "no data yet".
    expect(screen.queryByText('What stands out')).toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps its heading and lede while the server has not answered', () => {
    serve({ '/api/insights': json(FULL) })
    renderApp(<Insights />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Insights')
    expect(
      screen.getByText('What the analysis found, and what it wants you to confirm.'),
    ).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('Loading…')
  })

  it('orders each tab conclusions, reasoning, then evidence (#228)', async () => {
    // Splitting the page into tabs (#228) moved "order" from one long scroll to each
    // tab's own content — findings and the ledger hold one card each, so it is the
    // narrative tab (review, then the nudge) and the pending tab (guesses, proposals,
    // then clarifications) where an ordering claim still means something.
    serve({ '/api/insights': json(FULL) })

    const findings = renderApp(<Insights />, { path: '/insights' })
    await screen.findByText('What stands out')
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'What stands out',
    ])
    findings.unmount()

    const narrative = renderApp(<Insights />, { path: '/insights/narrative' })
    await screen.findByText('August 2026 in words')
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'August 2026 in words',
      'Budget nudge',
    ])
    narrative.unmount()

    const pending = renderApp(<Insights />, { path: '/insights/pending' })
    await screen.findByText('Below the confidence bar')
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Below the confidence bar',
      'Proposed changes',
      'Help the assistant understand',
    ])
    pending.unmount()

    const ledger = renderApp(<Insights />, { path: '/insights/ledger' })
    await screen.findByText('What was sent')
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'What was sent',
    ])
  })

  it('marks the open tab current, and lands on Findings for a path it does not recognise (#228)', async () => {
    serve({ '/api/insights': json(FULL) })
    const narrative = renderApp(<Insights />, { path: '/insights/narrative' })
    await screen.findByText('August 2026 in words')

    expect(screen.getByRole('link', { name: 'Narrative' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByRole('link', { name: 'Findings' }).getAttribute('aria-current')).toBeNull()
    narrative.unmount()

    renderApp(<Insights />, { path: '/insights/nonsense' })
    await screen.findByText('What stands out')
  })

  it('explains an absent model and drops the sections only a model can fill (#165)', async () => {
    // The signals are deterministic TypeScript over the aggregated facts, so they are
    // exactly what a deployment without a key should still get. The other three
    // sections would each print their own "nothing yet" copy, which on this deployment
    // is a lie by omission: nothing is pending and nothing ever will be.
    serve({
      '/api/insights': json({
        ...FULL,
        ai: { enabled: false, reason: 'notConfigured' },
        narrative: null,
        questions: [],
        categoryGuessCandidates: [],
        proposals: [],
        runs: [],
      } satisfies InsightsPayload),
    })
    renderApp(<Insights />)

    await screen.findByText('What stands out')
    expect(screen.getByText('The assistant is switched off')).toBeTruthy()
    expect(screen.getByText(/No Gemini key is configured/)).toBeTruthy()
    // The variable to set, not just the fact that something is missing.
    expect(screen.getByText(/GEMINI_API_KEY/)).toBeTruthy()
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'What stands out',
    ])
  })

  it('names the switch when a key exists but the flag is false (#165)', async () => {
    // A different sentence per reason, because the fix is a different line of `.env`.
    serve({
      '/api/insights': json({
        ...FULL,
        ai: { enabled: false, reason: 'switchedOff' },
        narrative: null,
        questions: [],
        proposals: [],
        runs: [],
      } satisfies InsightsPayload),
    })
    renderApp(<Insights />)

    await screen.findByText('What stands out')
    expect(screen.getByText(/Set AI_ENABLED=true/)).toBeTruthy()
    expect(screen.queryByText(/No Gemini key is configured/)).toBeNull()
  })

  it('keeps a narrative written while the model was on (#165)', async () => {
    // Switching the model off is not a reason to throw away last month's analysis. The
    // panel explains why nothing new is arriving; what is stored still reads.
    serve({
      '/api/insights': json({
        ...FULL,
        ai: { enabled: false, reason: 'switchedOff' },
      } satisfies InsightsPayload),
    })
    renderApp(<Insights />, { path: '/insights/narrative' })

    await screen.findByText('August 2026 in words')
    expect(screen.getByText('The assistant is switched off')).toBeTruthy()
  })

  it('says nothing about a switched-off model while it is on', async () => {
    serve({ '/api/insights': json(FULL) })
    renderApp(<Insights />)

    await screen.findByText('What stands out')
    expect(screen.queryByText('The assistant is switched off')).toBeNull()
  })

  it('says nothing about the AI budget while there is any left', async () => {
    serve({ '/api/insights': json(FULL) })
    renderApp(<Insights />)

    await screen.findByText('What stands out')
    expect(screen.queryByText(/Monthly AI budget reached/)).toBeNull()
  })

  it('says once, at the top, that the month is capped', async () => {
    serve({
      '/api/insights': json({
        ...FULL,
        spend: { ...FULL.spend, spentMicroEur: 15_200_000, usedBp: 10_000, exceeded: true },
      } satisfies InsightsPayload),
    })
    renderApp(<Insights />)

    // Awaited on the content rather than on the notice: the loading state is itself a
    // live region, so a `findByRole('status')` resolves against it before the payload
    // has arrived.
    await screen.findByText('What stands out')
    // Filtered rather than picked, because this page has more than one live region: the
    // refresh bar keeps an empty one of its own so that what it says while a job runs is
    // announced. "Once" is the claim being tested, so it is counted rather than assumed.
    const capped = screen
      .getAllByRole('status')
      .filter((region) => region.textContent?.includes('Monthly AI budget reached') ?? false)
    expect(capped).toHaveLength(1)
    // The figure as well as the fact, in the same words the settings screen uses.
    // Through `getByText`, whose normaliser folds away the non-breaking space `Intl`
    // puts after the symbol — a raw `textContent` read would not.
    expect(screen.getByText('€ 15,20 of € 15,00 this month')).toBeTruthy()
  })

  it('leaves every string translated', async () => {
    serve({ '/api/insights': json(FULL) })
    renderApp(<Insights />)
    await screen.findByText('What stands out')

    // A missing key renders as itself, in any of the namespaces this page reads.
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\b(findings|narrative|clarify|proposal|privacy)\.[a-zA-Z]/)
    expect(text).not.toMatch(/\b(page|nav|empty|time|status|severity)\.[a-zA-Z]/)
  })
})

describe('the findings', () => {
  it('groups by severity, worst first, and says the severity in words', () => {
    renderApp(<Findings signals={SIGNALS} month="2026-08" />)

    // The order is `SEVERITY_RANK`'s, not this file's: a page that sorted its own way
    // could disagree with the ranking that chose which findings to keep.
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Action needed',
      'Attention',
      'Info',
    ])
  })

  it('renders each sentence from the catalogue with the server’s numbers', () => {
    renderApp(<Findings signals={SIGNALS} month="2026-08" />)

    expect(screen.getByText('Groceries is € 125,00 over its available balance.')).toBeTruthy()
    expect(
      screen.getByText('Restaurants is 18% above your 12-month norm of € 200,00.'),
    ).toBeTruthy()
    // The delta arrives negative and the sentence already says "below", so its
    // magnitude is what prints — "−9% below" would say it twice.
    expect(screen.getByText('Transport is 9% below your usual level.')).toBeTruthy()
  })

  it('drops a code it has no sentence for rather than printing the code', () => {
    renderApp(<Findings signals={SIGNALS} month="2026-08" />)

    expect(screen.queryByText(/gremlins/)).toBeNull()
  })

  it('drops a finding missing a number rather than leaving a hole in the sentence', () => {
    renderApp(<Findings signals={SIGNALS} month="2026-08" />)

    expect(screen.queryByText(/Clothing/)).toBeNull()
    expect(document.body.textContent ?? '').not.toContain('{{')
  })

  it('styles good news apart from a problem', () => {
    renderApp(<Findings signals={SIGNALS} month="2026-08" />)

    // `below_baseline` is an `info` finding whose whole point is that nothing is
    // wrong, so it must not inherit the stripe of one that needs reading.
    const good = screen.getByText('Transport is 9% below your usual level.')
    expect(good.className).toBe('finding finding--positive')
    const bad = screen.getByText('Groceries is € 125,00 over its available balance.')
    expect(bad.className).toBe('finding finding--alert')
  })

  it('names the month, because it is not always the current one', () => {
    renderApp(<Findings signals={SIGNALS} month="2026-08" />)

    expect(screen.getByText('For August 2026')).toBeTruthy()
  })

  it('says nothing needs attention when the analysis found nothing statable', () => {
    // Only the two unrenderable signals: the server had findings, this bundle has
    // nothing faithful to say about them, and that is the honest sentence.
    renderApp(<Findings signals={SIGNALS.slice(3)} month={null} />)

    expect(screen.getByText('Nothing needs your attention.')).toBeTruthy()
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull()
    expect(screen.queryByText(/^For /)).toBeNull()
  })
})

/** What `GET /api/ai/estimate?kind=narrative` prices August 2026's review at. */
const NARRATIVE_ESTIMATE: AiEstimate = {
  kind: 'narrative',
  month: '2026-08',
  model: 'gemini-3.1-pro-preview',
  payloadChars: 3_100,
  estimateMicroEur: 2_100,
  allowed: true,
  reason: null,
}

/** Every prop `Narrative` needs besides `narrative`, for a test that renders it in isolation. */
const NARRATIVE_PROPS = {
  month: '2026-08',
  ended: true,
  owner: true,
  aiEnabled: true,
  factsChangedAt: null,
  onWritten: () => {},
}

describe('the narrative', () => {
  it('inserts the HTML the server sanitised, and names who wrote it and when', () => {
    renderApp(<Narrative narrative={FULL.narrative} {...NARRATIVE_PROPS} />)

    // The markup survives, which is the point of rendering it as HTML rather than as
    // text: `util/markdown.ts` escaped the model's words before emitting these tags.
    expect(document.querySelector('.prose strong')?.textContent).toBe('Groceries')
    expect(
      screen.getByText('Written 01/09/2026, 06:12 by gemini-3.1-pro-preview'),
    ).toBeTruthy()
  })

  it('prints the date alone rather than the word null when the run is gone', () => {
    renderApp(
      <Narrative narrative={{ ...FULL.narrative!, model: null }} {...NARRATIVE_PROPS} />,
    )

    expect(screen.getByText('Updated 01/09/2026, 06:12')).toBeTruthy()
    expect(document.body.textContent ?? '').not.toContain('null')
  })

  it('says none has been written yet rather than showing an empty card', () => {
    // `month: null` also keeps the offer from mounting, so this stays a render test
    // rather than one that needs a `/api/ai/estimate` stub.
    renderApp(
      <Narrative narrative={null} {...NARRATIVE_PROPS} month={null} />,
    )

    expect(screen.getByText('No narrative has been written for this month yet.')).toBeTruthy()
    expect(document.querySelector('.prose')).toBeNull()
  })

  it('names the month in the heading rather than saying "this month" (#158)', () => {
    renderApp(<Narrative narrative={FULL.narrative} {...NARRATIVE_PROPS} />)

    expect(screen.getByText('August 2026 in words')).toBeTruthy()
  })

  it('says nothing about staleness when the facts have not moved since the review', () => {
    renderApp(<Narrative narrative={FULL.narrative} {...NARRATIVE_PROPS} />)

    expect(screen.queryByText(/Based on data from/)).toBeNull()
  })

  it('offers a re-run once the facts move past the review that already ran (#162)', async () => {
    serve({ '/api/ai/estimate?kind=narrative&month=2026-08': json(NARRATIVE_ESTIMATE) })
    renderApp(
      <Narrative
        narrative={FULL.narrative}
        {...NARRATIVE_PROPS}
        factsChangedAt="2026-09-02T00:00:00Z"
      />,
    )

    expect(screen.getByText('Based on data from 02/09/2026, 02:00.')).toBeTruthy()
    // Same offer as the "no narrative yet" case — priced, and mounted for a rewrite.
    await screen.findByText('Writing one for August 2026 would cost about € 0,0021.')
  })

  it('says a month still in progress has no review yet, without offering one', () => {
    renderApp(
      <Narrative narrative={null} {...NARRATIVE_PROPS} ended={false} />,
    )

    expect(
      screen.getByText('August 2026 is not over yet. A review is written once a month is ' +
        'complete, so that it describes all of it.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('offers no review to a viewer who is not the owner', async () => {
    serve({ '/api/ai/estimate?kind=narrative&month=2026-08': json(NARRATIVE_ESTIMATE) })
    renderApp(<Narrative narrative={null} {...NARRATIVE_PROPS} owner={false} />)

    await screen.findByText('Writing one for August 2026 would cost about € 0,0021.')
    expect(screen.getByText('Only the owner can write one.')).toBeTruthy()
    // The button stays on screen rather than vanishing, so the sentence next to it
    // still makes sense — it is disabled, which is what actually stops the press.
    expect(
      (screen.getByRole('button', { name: 'Write the review' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('prices the review, then writes it on a second press', async () => {
    const fetchMock = serve({
      '/api/ai/estimate?kind=narrative&month=2026-08': json(NARRATIVE_ESTIMATE),
      '/api/ai/narrative': json({
        status: 'ok',
        reason: 'ok',
        runId: 'run-narrative-2',
        period: '2026-08',
        locale: 'en',
        degraded: false,
        costMicroEur: 2_100,
      }),
    })
    const onWritten = vi.fn()

    renderApp(<Narrative narrative={null} {...NARRATIVE_PROPS} onWritten={onWritten} />)

    await screen.findByText('Writing one for August 2026 would cost about € 0,0021.')
    fireEvent.click(screen.getByRole('button', { name: 'Write the review' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Spend € 0,0021' }))

    await screen.findByText('Written, for € 0,0021. The page has been reloaded.')
    expect(onWritten).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/ai/narrative', expect.objectContaining({
      method: 'POST',
    }))
  })
})

const NUDGE_ESTIMATE: AiEstimate = {
  kind: 'budget_nudge',
  month: '2026-08',
  model: 'gemini-3.7-flash',
  payloadChars: 400,
  estimateMicroEur: 2_500,
  allowed: true,
  reason: null,
}

describe('the budget nudge', () => {
  it('shows the price once it has loaded, and lets the owner arm then confirm it', async () => {
    const fetchMock = serve({
      '/api/ai/estimate?kind=budget_nudge&month=2026-08': json(NUDGE_ESTIMATE),
      '/api/ai/budget-nudge': json({
        status: 'ok',
        reason: 'ok',
        runId: 'run-nudge-1',
        month: '2026-08',
        locale: 'en',
        degraded: false,
        costMicroEur: 2_500,
      } satisfies AiBudgetNudgeRun),
    })
    const onAdjusted = vi.fn()

    renderApp(<BudgetNudge month="2026-08" owner={true} onAdjusted={onAdjusted} />)

    await screen.findByText(/Checking August 2026 against the note would cost about €.?0,0025\./)
    fireEvent.click(screen.getByRole('button', { name: 'Check the note' }))
    fireEvent.click(await screen.findByRole('button', { name: /Spend €.?0,0025 and check the note/ }))

    await screen.findByText('Done. Check the suggested budgets below for what changed.')
    expect(onAdjusted).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/ai/budget-nudge', expect.objectContaining({
      method: 'POST',
    }))
  })

  it('names the reason it cannot run, such as an empty note, beside the price', async () => {
    serve({
      '/api/ai/estimate?kind=budget_nudge&month=2026-08': json({
        ...NUDGE_ESTIMATE,
        allowed: false,
        reason: 'no_note',
        estimateMicroEur: 0,
      }),
    })

    renderApp(<BudgetNudge month="2026-08" owner={true} onAdjusted={() => {}} />)

    await screen.findByText(
      "The “what's coming up” note is empty, so there is nothing to check it against.",
    )
  })

  it('is disabled for a viewer, who is told only the owner can run it', async () => {
    serve({ '/api/ai/estimate?kind=budget_nudge&month=2026-08': json(NUDGE_ESTIMATE) })

    renderApp(<BudgetNudge month="2026-08" owner={false} onAdjusted={() => {}} />)

    await screen.findByText('Only the owner can run this.')
    expect(
      (screen.getByRole('button', { name: 'Check the note' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})

describe('the clarification queue', () => {
  it('leads with the guess, so confirming is one decision rather than an interview', () => {
    renderApp(<Questions questions={FULL.questions} scoped={false} />)

    expect(
      screen.getByText('Is Therapy a fixed cost, a variable one, or free spending?'),
    ).toBeTruthy()
    // The translated label, not the stored `fixed` the model answered with.
    expect(screen.getByText('Best guess: Fixed cost')).toBeTruthy()
  })

  it('offers no guess line at all when there is no guess', () => {
    renderApp(<Questions questions={FULL.questions} scoped={false} />)

    expect(screen.getByText('What do you use Hobbies for?')).toBeTruthy()
    expect(screen.getAllByText(/^Best guess:/)).toHaveLength(1)
  })

  it('shows the share of the month, which is why the card exists at all', () => {
    renderApp(<Questions questions={FULL.questions} scoped={false} />)

    expect(screen.getByText('4,2% of this month’s spending')).toBeTruthy()
    expect(screen.getByText('1,5% of this month’s spending')).toBeTruthy()
  })

  it('says answering comes later rather than leaving a queue with no buttons', () => {
    renderApp(<Questions questions={FULL.questions} scoped={false} />)

    expect(screen.getByText(/Answering these comes with the assistant’s chat/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says nothing needs clarifying when the queue is empty', () => {
    renderApp(<Questions questions={[]} scoped={false} />)

    expect(screen.getByText('Nothing needs clarifying.')).toBeTruthy()
    expect(screen.queryByText(/Answering these comes/)).toBeNull()
  })

  it('warns the queue is not filtered once a month picker is on screen (#158)', () => {
    renderApp(<Questions questions={FULL.questions} scoped={true} />)

    expect(
      screen.getByText(
        'Standing work, not filtered to the month above: a question stays here until it is answered.',
      ),
    ).toBeTruthy()
  })

  it('says nothing about filtering when there is no month picker to be confused by', () => {
    renderApp(<Questions questions={FULL.questions} scoped={false} />)

    expect(screen.queryByText(/Standing work, not filtered/)).toBeNull()
  })
})

/** A second candidate, distinct from `FULL.categoryGuessCandidates[0]`, for the bulk-selection test. */
const TWO_CANDIDATES: InsightsPayload['categoryGuessCandidates'] = [
  FULL.categoryGuessCandidates[0]!,
  { ...FULL.categoryGuessCandidates[0]!, transactionId: 'txn-cafe', payeeName: 'Cafe Nero' },
]

describe('the guess queue', () => {
  it('shows a payee, its amount, its date, and the history it was cached with', () => {
    renderApp(
      <CategoryGuesses candidates={FULL.categoryGuessCandidates} owner={true} onGuessed={vi.fn()} />,
    )

    expect(screen.getByText(/Corner Bakery/)).toBeTruthy()
    expect(screen.getByText(/€ -12,40/)).toBeTruthy()
    expect(screen.getByText('14/08/2026')).toBeTruthy()
    expect(screen.getByText('Groceries × 1')).toBeTruthy()
  })

  it('says nothing is waiting when the queue is empty', () => {
    renderApp(<CategoryGuesses candidates={[]} owner={true} onGuessed={vi.fn()} />)

    expect(screen.getByText('Nothing is waiting on a guess.')).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('says only the owner can ask for a guess, and disables the checkboxes', () => {
    renderApp(
      <CategoryGuesses candidates={FULL.categoryGuessCandidates} owner={false} onGuessed={vi.fn()} />,
    )

    expect(screen.getByText('Only the owner can ask for a guess.')).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: 'Select all' }) as HTMLInputElement).disabled).toBe(
      true,
    )
  })

  it('prices the selection, then guesses on a second press, with mixed per-id results', async () => {
    const fetchMock = serve({
      '/api/ai/category-guess/estimate': json({
        ids: ['txn-bakery', 'txn-cafe'],
        model: 'gemini-3.7-flash',
        payloadChars: 240,
        estimateMicroEur: 2_100,
        allowed: true,
        reason: null,
      }),
      '/api/ai/category-guess': json({
        status: 'ok',
        reason: 'ok',
        runId: 'run-guess-1',
        locale: 'en',
        degraded: false,
        costMicroEur: 2_100,
        results: [
          { id: 'txn-bakery', ok: true, reason: null },
          { id: 'txn-cafe', ok: false, reason: 'not_confident' },
        ],
        dropped: [],
      }),
    })
    const onGuessed = vi.fn()
    renderApp(<CategoryGuesses candidates={TWO_CANDIDATES} owner={true} onGuessed={onGuessed} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Estimate (2 selected)' }))

    await screen.findByText('Guessing 2 would cost about € 0,0021.')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/category-guess/estimate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: ['txn-bakery', 'txn-cafe'] }),
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Guess' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Spend € 0,0021' }))

    await screen.findByText('Guessed — now waiting for a decision below.')
    expect(
      screen.getByText('The model was not confident enough about this one to guess.'),
    ).toBeTruthy()
    expect(onGuessed).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ai/category-guess',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: ['txn-bakery', 'txn-cafe'] }),
      }),
    )
  })

  it('shows a raw, untranslated reason verbatim when it is not one of the known codes', async () => {
    serve({
      '/api/ai/category-guess/estimate': json({
        ids: ['txn-bakery'],
        model: 'gemini-3.7-flash',
        payloadChars: 120,
        estimateMicroEur: 2_100,
        allowed: true,
        reason: null,
      }),
      '/api/ai/category-guess': json({
        status: 'ok',
        reason: 'ok',
        runId: 'run-guess-2',
        locale: 'en',
        degraded: false,
        costMicroEur: 2_100,
        results: [{ id: 'txn-bakery', ok: false, reason: 'This proposal would change nothing.' }],
        dropped: [],
      }),
    })
    renderApp(
      <CategoryGuesses candidates={FULL.categoryGuessCandidates} owner={true} onGuessed={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Corner Bakery' }))
    fireEvent.click(screen.getByRole('button', { name: 'Estimate (1 selected)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Guess' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Spend € 0,0021' }))

    await screen.findByText('This proposal would change nothing.')
  })
})

/** A second proposal, distinct from `FULL.proposals[0]`, for the bulk-selection tests. */
const TWO_PROPOSALS: InsightsPayload['proposals'] = [
  FULL.proposals[0]!,
  { ...FULL.proposals[0]!, id: 'p-groceries', targetRef: 'c-groceries', targetName: 'Groceries' },
]

/** A `budget_amount.set` proposal, the one type whose card carries an editable amount (#220). */
const BUDGET_PROPOSAL: InsightsPayload['proposals'][number] = {
  id: 'p-budget-food',
  type: 'budget_amount.set',
  targetRef: 'food:2026-08',
  targetName: 'Groceries (2026-08)',
  fields: [{ field: 'amount', label: 'Budgeted amount', before: '€ 120,00', after: '€ 150,00', warn: null }],
  createdAt: '2026-09-01T04:13:00Z',
  expiresAt: '2026-09-08T04:13:00Z',
  amountCents: 15_000,
}

describe('the proposal queue', () => {
  it('shows what would change, field by field, before and after', () => {
    renderApp(<Proposals proposals={FULL.proposals} scoped={false} owner={true} onDecided={vi.fn()} />)

    expect(screen.getByText('Restaurants')).toBeTruthy()
    expect(screen.getByText('Type of cost')).toBeTruthy()
    expect(screen.getByText('not set')).toBeTruthy()
    expect(screen.getByText('Free spending')).toBeTruthy()
    expect(screen.getByText('Now / proposed · Expires 08/09/2026, 06:13')).toBeTruthy()
  })

  it('warns where applying would send a name to the model', () => {
    renderApp(<Proposals proposals={FULL.proposals} scoped={false} owner={true} onDecided={vi.fn()} />)

    expect(
      screen.getByText('Applying this starts sending the category name to the AI.'),
    ).toBeTruthy()
  })

  it('hides the arrow from a screen reader, which the order already tells', () => {
    renderApp(<Proposals proposals={FULL.proposals} scoped={false} owner={true} onDecided={vi.fn()} />)

    const arrows = [...document.querySelectorAll('.change__arrow')]
    expect(arrows).toHaveLength(2)
    expect(arrows.every((a) => a.getAttribute('aria-hidden') === 'true')).toBe(true)
  })

  it('drops the expiry from the meta line when there is none', () => {
    renderApp(
      <Proposals
        proposals={[{ ...FULL.proposals[0]!, expiresAt: null }]}
        scoped={false}
        owner={true}
        onDecided={vi.fn()}
      />,
    )

    expect(screen.getByText('Now / proposed')).toBeTruthy()
    expect(screen.queryByText(/Expires/)).toBeNull()
  })

  it('offers apply and reject for every proposal, with no confirmation step for either', () => {
    renderApp(<Proposals proposals={FULL.proposals} scoped={false} owner={true} onDecided={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy()
  })

  it('applies one proposal on a single press, then reloads the queue', async () => {
    const fetchMock = serve({
      '/api/proposals/p-restaurants/apply': json({ id: 'p-restaurants', status: 'applied' }),
    })
    const onDecided = vi.fn()
    renderApp(<Proposals proposals={FULL.proposals} scoped={false} owner={true} onDecided={onDecided} />)

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/proposals/p-restaurants/apply',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('rejects one proposal on a single press, without touching Actual', async () => {
    const fetchMock = serve({
      '/api/proposals/p-restaurants/reject': json({ id: 'p-restaurants', status: 'rejected' }),
    })
    const onDecided = vi.fn()
    renderApp(<Proposals proposals={FULL.proposals} scoped={false} owner={true} onDecided={onDecided} />)

    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))

    await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/proposals/p-restaurants/reject',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('shows a press that failed inline on its own row, without disturbing the rest', async () => {
    serve({
      '/api/proposals/p-restaurants/apply': json(
        { error: { code: 'conflict', message: 'This proposal has expired.' } },
        409,
      ),
    })
    renderApp(<Proposals proposals={FULL.proposals} scoped={false} owner={true} onDecided={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await screen.findByText('This proposal has expired.')
    expect(screen.getByText('Restaurants')).toBeTruthy()
  })

  it('disables every control for a viewer, and says why', () => {
    renderApp(<Proposals proposals={FULL.proposals} scoped={false} owner={false} onDecided={vi.fn()} />)

    expect((screen.getByRole('checkbox', { name: 'Select Restaurants' }) as HTMLInputElement).disabled).toBe(
      true,
    )
    expect((screen.getByRole('checkbox', { name: 'Select all' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Only the owner can apply or reject a proposal.')).toBeTruthy()
  })

  it('selects all, then applies the selection only after a confirming second press', async () => {
    const fetchMock = serve({
      '/api/proposals/apply-batch': json({
        results: [
          { id: 'p-restaurants', ok: true, reason: null },
          { id: 'p-groceries', ok: true, reason: null },
        ],
      }),
    })
    const onDecided = vi.fn()
    renderApp(<Proposals proposals={TWO_PROPOSALS} scoped={false} owner={true} onDecided={onDecided} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected (2)' }))
    // Not applied yet — the bulk action is the one press this queue still confirms.
    expect(onDecided).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Apply 2 to Actual?' }))

    await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/proposals/apply-batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: ['p-restaurants', 'p-groceries'] }),
      }),
    )
  })

  it('reports a stale id from the batch inline, rather than losing the rest of it', async () => {
    serve({
      '/api/proposals/apply-batch': json({
        results: [
          { id: 'p-restaurants', ok: true, reason: null },
          { id: 'p-groceries', ok: false, reason: 'This proposal has expired.' },
        ],
      }),
    })
    const onDecided = vi.fn()
    renderApp(<Proposals proposals={TWO_PROPOSALS} scoped={false} owner={true} onDecided={onDecided} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply selected (2)' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply 2 to Actual?' }))

    await screen.findByText('This proposal has expired.')
    expect(onDecided).toHaveBeenCalledTimes(1)
    // The failed one stays checked; the one that went through does not.
    expect(
      (screen.getByRole('checkbox', { name: 'Select Groceries' }) as HTMLInputElement).checked,
    ).toBe(true)
    expect(
      (screen.getByRole('checkbox', { name: 'Select Restaurants' }) as HTMLInputElement).checked,
    ).toBe(false)
  })

  it('rejects the selection on a single press, with no confirm step', async () => {
    const fetchMock = serve({
      '/api/proposals/p-restaurants/reject': json({ id: 'p-restaurants', status: 'rejected' }),
      '/api/proposals/p-groceries/reject': json({ id: 'p-groceries', status: 'rejected' }),
    })
    const onDecided = vi.fn()
    renderApp(<Proposals proposals={TWO_PROPOSALS} scoped={false} owner={true} onDecided={onDecided} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject selected (2)' }))

    await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/proposals/p-restaurants/reject',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/proposals/p-groceries/reject',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('says nothing is waiting when the queue is empty', () => {
    renderApp(<Proposals proposals={[]} scoped={false} owner={true} onDecided={vi.fn()} />)

    expect(screen.getByText('Nothing is waiting to be applied.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('warns the queue is not filtered once a month picker is on screen (#158)', () => {
    renderApp(<Proposals proposals={FULL.proposals} scoped={true} owner={true} onDecided={vi.fn()} />)

    expect(
      screen.getByText(
        'Standing work, not filtered to the month above: a proposal stays here until it is reviewed.',
      ),
    ).toBeTruthy()
  })

  it('says nothing about filtering when there is no month picker to be confused by', () => {
    renderApp(<Proposals proposals={FULL.proposals} scoped={false} owner={true} onDecided={vi.fn()} />)

    expect(screen.queryByText(/Standing work, not filtered/)).toBeNull()
  })

  it('shows an editable amount field, pre-filled with the proposed figure, only on a budget_amount.set card (#220)', () => {
    renderApp(<Proposals proposals={[BUDGET_PROPOSAL, ...FULL.proposals]} scoped={false} owner={true} onDecided={vi.fn()} />)

    expect((screen.getByLabelText('Budget amount') as HTMLInputElement).value).toBe(formatMoney(15_000))
    // `FULL.proposals[0]` is a `category_meta` card, which has nothing to adjust.
    expect(screen.getAllByLabelText('Budget amount')).toHaveLength(1)
  })

  it('disables the amount field for a viewer, same as every other control on the card', () => {
    renderApp(<Proposals proposals={[BUDGET_PROPOSAL]} scoped={false} owner={false} onDecided={vi.fn()} />)

    expect((screen.getByLabelText('Budget amount') as HTMLInputElement).disabled).toBe(true)
  })

  it('applies the proposed amount directly, with no adjust call, when the owner leaves it unedited', async () => {
    const fetchMock = serve({
      '/api/proposals/p-budget-food/apply': json({ id: 'p-budget-food', status: 'applied' }),
    })
    const onDecided = vi.fn()
    renderApp(<Proposals proposals={[BUDGET_PROPOSAL]} scoped={false} owner={true} onDecided={onDecided} />)

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/proposals/p-budget-food/apply',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).not.toHaveBeenCalledWith('/api/proposals/p-budget-food/adjust', expect.anything())
  })

  it('adjusts, then applies the proposal the adjustment produced, when the owner edits the amount', async () => {
    const fetchMock = serve({
      '/api/proposals/p-budget-food/adjust': json({ id: 'p-budget-food-2', status: 'pending' }),
      '/api/proposals/p-budget-food-2/apply': json({ id: 'p-budget-food-2', status: 'applied' }),
    })
    const onDecided = vi.fn()
    renderApp(<Proposals proposals={[BUDGET_PROPOSAL]} scoped={false} owner={true} onDecided={onDecided} />)

    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '160,00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/proposals/p-budget-food/adjust',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ amountCents: 16_000 }) }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/proposals/p-budget-food-2/apply',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('stops at the adjustment and never applies when the edited amount matches what is already budgeted', async () => {
    const fetchMock = serve({
      '/api/proposals/p-budget-food/adjust': json({ id: 'p-budget-food', status: 'rejected' }),
    })
    const onDecided = vi.fn()
    renderApp(<Proposals proposals={[BUDGET_PROPOSAL]} scoped={false} owner={true} onDecided={onDecided} />)

    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: '120,00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(onDecided).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/proposals/p-budget-food/adjust',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetchMock).not.toHaveBeenCalledWith('/api/proposals/p-budget-food/apply', expect.anything())
  })

  it('shows a validation message and calls nothing when the edited amount does not parse', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderApp(<Proposals proposals={[BUDGET_PROPOSAL]} scoped={false} owner={true} onDecided={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Budget amount'), { target: { value: 'not a number' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await screen.findByText('Enter a valid amount.')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the ledger', () => {
  it('lists every attempt, including the ones that produced nothing', () => {
    renderApp(<Ledger runs={RUNS} month={null} />)

    // Three runs plus the header row. A `capped` run is the row that explains why an
    // answer is missing from the page above, so it is not filtered out.
    expect(screen.getAllByRole('row')).toHaveLength(4)
    expect(screen.getByText('Budget cap reached')).toBeTruthy()
    expect(screen.getByText('Narrative')).toBeTruthy()
  })

  it('quotes the upstream failure verbatim', () => {
    renderApp(<Ledger runs={RUNS} month={null} />)

    // The only text on this page Balancr did not write. A failure that will not say
    // why is indistinguishable from a run that never happened.
    expect(
      screen.getByText('RESOURCE_EXHAUSTED: quota exceeded for this project'),
    ).toBeTruthy()
    expect(screen.getByText('Error')).toBeTruthy()
  })

  it('writes tokens and cost the Belgian way, down to a fraction of a cent', () => {
    renderApp(<Ledger runs={RUNS} month={null} />)

    expect(screen.getByText('3.120 in / 480 out')).toBeTruthy()
    // A model call can cost less than a cent, and rounding it to € 0,00 would hide
    // the whole ledger's worth of spend.
    expect(screen.getByText('€ 0,0012')).toBeTruthy()
    expect(screen.getByText('01/09/2026, 06:12')).toBeTruthy()
  })

  it('counts the calls in the caption', () => {
    renderApp(<Ledger runs={RUNS} month={null} />)

    expect(
      screen.getByText('The 3 most recent calls to the model, newest first.'),
    ).toBeTruthy()
  })

  it('uses the singular for one call', () => {
    renderApp(<Ledger runs={[RUNS[0]!]} month={null} />)

    expect(screen.getByText('The most recent call to the model.')).toBeTruthy()
  })

  it('fetches a payload only when its row is opened', async () => {
    const fetchMock = serve({
      '/api/insights/runs/run-findings/payload': json({
        ...RUNS[0]!,
        payload: { month: '2026-08', categories: [{ name: 'Groceries', spentCents: 42_500 }] },
      }),
    })
    renderApp(<Ledger runs={RUNS} month={null} />)

    // Twenty redacted bundles on every page load is what this avoids, so nothing is
    // asked for until somebody wants to read one.
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getAllByRole('button', { name: 'Show the exact payload' })[0]!)
    await screen.findByText(/"Groceries"/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/insights/runs/run-findings/payload')
  })

  it('keeps one payload open at a time', async () => {
    serve({
      '/api/insights/runs/run-findings/payload': json({ ...RUNS[0]!, payload: { a: 1 } }),
      '/api/insights/runs/run-narrative/payload': json({ ...RUNS[1]!, payload: { b: 2 } }),
    })
    renderApp(<Ledger runs={RUNS} month={null} />)

    const buttons = (): HTMLElement[] => screen.getAllByRole('button')
    fireEvent.click(buttons()[0]!)
    await screen.findByText(/"a": 1/)
    expect(buttons()[0]?.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(buttons()[1]!)
    await screen.findByText(/"b": 2/)
    // A table with four open JSON blobs in it is unreadable, and nobody reads two
    // payloads side by side.
    expect(screen.queryByText(/"a": 1/)).toBeNull()
    expect(buttons()[0]?.getAttribute('aria-expanded')).toBe('false')
  })

  it('closes a payload it had opened', async () => {
    serve({ '/api/insights/runs/run-findings/payload': json({ ...RUNS[0]!, payload: { a: 1 } }) })
    renderApp(<Ledger runs={RUNS} month={null} />)

    fireEvent.click(screen.getAllByRole('button')[0]!)
    await screen.findByText(/"a": 1/)

    fireEvent.click(screen.getByRole('button', { name: 'Hide the payload' }))
    expect(screen.queryByText(/"a": 1/)).toBeNull()
  })

  it('reports an unparseable payload as a finding rather than as an error', async () => {
    serve({ '/api/insights/runs/run-findings/payload': json({ ...RUNS[0]!, payload: null }) })
    renderApp(<Ledger runs={RUNS} month={null} />)

    fireEvent.click(screen.getAllByRole('button')[0]!)
    // The row around it is still true, so a red box would be the audit view lying
    // about itself.
    expect(await screen.findByText('The stored payload could not be read.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a payload that could not be fetched, without losing the table', async () => {
    serve({ '/api/insights/runs/run-findings/payload': new TypeError('fetch failed') })
    renderApp(<Ledger runs={RUNS} month={null} />)

    fireEvent.click(screen.getAllByRole('button')[0]!)
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Balancr could not be reached.')
    })
    // The rest of the ledger is still on screen: the failure is about one payload.
    expect(screen.getByText('RESOURCE_EXHAUSTED: quota exceeded for this project')).toBeTruthy()
  })

  it('says no calls have been made rather than drawing an empty table', () => {
    renderApp(<Ledger runs={[]} month={null} />)

    expect(screen.getByText('No calls have been made yet.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    // The claim itself stays, because it is true of a deployment that has sent
    // nothing just as much as of one that has.
    expect(
      screen.getByText('Category names and amounts only. No payees, no transactions.'),
    ).toBeTruthy()
  })

  it('names the selected month, since the ledger is not filtered to it (#158)', () => {
    renderApp(<Ledger runs={RUNS} month="2026-08" />)

    expect(
      screen.getByText('Calls about August 2026, and any that were about no month at all.'),
    ).toBeTruthy()
  })

  it('says nothing about a month when the page has no picker to name one', () => {
    renderApp(<Ledger runs={RUNS} month={null} />)

    expect(screen.queryByText(/Calls about/)).toBeNull()
  })
})
