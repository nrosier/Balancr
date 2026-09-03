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
import { Findings } from '../src/insights/Findings.tsx'
import { Ledger } from '../src/insights/Ledger.tsx'
import { Narrative } from '../src/insights/Narrative.tsx'
import { Proposals, Questions } from '../src/insights/Pending.tsx'
import { Insights } from '../src/pages/Insights.tsx'
import type { AiRun, Freshness, Insights as InsightsPayload } from '../src/shared.ts'
import { i18nReady, renderApp } from './helpers.tsx'

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
    model: 'gemini-3.7-flash',
    locale: 'en',
    status: 'ok',
    inputTokens: 3_120,
    outputTokens: 480,
    cachedTokens: 2_048,
    costMicroEur: 1_240,
    durationMs: 1_900,
    error: null,
    createdAt: '2026-09-01T04:12:00Z',
  },
  {
    id: 'run-narrative',
    kind: 'narrative',
    model: 'gemini-3.1-pro-preview',
    locale: 'en',
    status: 'capped',
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costMicroEur: 0,
    durationMs: null,
    error: null,
    createdAt: '2026-08-31T23:05:00Z',
  },
  {
    id: 'run-clarify',
    kind: 'clarify',
    model: 'gemini-3.7-flash',
    locale: 'nl',
    status: 'error',
    inputTokens: 900,
    outputTokens: 0,
    cachedTokens: 0,
    costMicroEur: 0,
    durationMs: 220,
    error: 'RESOURCE_EXHAUSTED: quota exceeded for this project',
    createdAt: '2026-08-30T22:00:00Z',
  },
]

/** A month the AI layer has been all the way through. */
const FULL: InsightsPayload = {
  freshness: FRESH,
  month: '2026-08',
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
  month: null,
  signals: [],
  narrative: null,
  questions: [],
  proposals: [],
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

  it('orders the sections conclusions, reasoning, then evidence', async () => {
    serve({ '/api/insights': json(FULL) })
    renderApp(<Insights />)

    await screen.findByText('What stands out')
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'What stands out',
      'This month in words',
      'Help the assistant understand',
      'Proposed changes',
      'What was sent',
    ])
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

describe('the narrative', () => {
  it('inserts the HTML the server sanitised, and names who wrote it and when', () => {
    renderApp(<Narrative narrative={FULL.narrative} />)

    // The markup survives, which is the point of rendering it as HTML rather than as
    // text: `util/markdown.ts` escaped the model's words before emitting these tags.
    expect(document.querySelector('.prose strong')?.textContent).toBe('Groceries')
    expect(
      screen.getByText('Written 01/09/2026, 06:12 by gemini-3.1-pro-preview'),
    ).toBeTruthy()
  })

  it('prints the date alone rather than the word null when the run is gone', () => {
    renderApp(
      <Narrative narrative={{ ...FULL.narrative!, model: null }} />,
    )

    expect(screen.getByText('Updated 01/09/2026, 06:12')).toBeTruthy()
    expect(document.body.textContent ?? '').not.toContain('null')
  })

  it('says none has been written yet rather than showing an empty card', () => {
    renderApp(<Narrative narrative={null} />)

    expect(screen.getByText('No narrative has been written for this month yet.')).toBeTruthy()
    expect(document.querySelector('.prose')).toBeNull()
  })
})

describe('the clarification queue', () => {
  it('leads with the guess, so confirming is one decision rather than an interview', () => {
    renderApp(<Questions questions={FULL.questions} />)

    expect(
      screen.getByText('Is Therapy a fixed cost, a variable one, or free spending?'),
    ).toBeTruthy()
    // The translated label, not the stored `fixed` the model answered with.
    expect(screen.getByText('Best guess: Fixed cost')).toBeTruthy()
  })

  it('offers no guess line at all when there is no guess', () => {
    renderApp(<Questions questions={FULL.questions} />)

    expect(screen.getByText('What do you use Hobbies for?')).toBeTruthy()
    expect(screen.getAllByText(/^Best guess:/)).toHaveLength(1)
  })

  it('shows the share of the month, which is why the card exists at all', () => {
    renderApp(<Questions questions={FULL.questions} />)

    expect(screen.getByText('4,2% of this month’s spending')).toBeTruthy()
    expect(screen.getByText('1,5% of this month’s spending')).toBeTruthy()
  })

  it('says answering comes later rather than leaving a queue with no buttons', () => {
    renderApp(<Questions questions={FULL.questions} />)

    expect(screen.getByText(/Answering these comes with the assistant’s chat/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says nothing needs clarifying when the queue is empty', () => {
    renderApp(<Questions questions={[]} />)

    expect(screen.getByText('Nothing needs clarifying.')).toBeTruthy()
    expect(screen.queryByText(/Answering these comes/)).toBeNull()
  })
})

describe('the proposal queue', () => {
  it('shows what would change, field by field, before and after', () => {
    renderApp(<Proposals proposals={FULL.proposals} />)

    expect(screen.getByText('Restaurants')).toBeTruthy()
    expect(screen.getByText('Type of cost')).toBeTruthy()
    expect(screen.getByText('not set')).toBeTruthy()
    expect(screen.getByText('Free spending')).toBeTruthy()
    expect(screen.getByText('Now / proposed · Expires 08/09/2026, 06:13')).toBeTruthy()
  })

  it('warns where applying would send a name to the model', () => {
    renderApp(<Proposals proposals={FULL.proposals} />)

    expect(
      screen.getByText('Applying this starts sending the category name to the AI.'),
    ).toBeTruthy()
  })

  it('hides the arrow from a screen reader, which the order already tells', () => {
    renderApp(<Proposals proposals={FULL.proposals} />)

    const arrows = [...document.querySelectorAll('.change__arrow')]
    expect(arrows).toHaveLength(2)
    expect(arrows.every((a) => a.getAttribute('aria-hidden') === 'true')).toBe(true)
  })

  it('drops the expiry from the meta line when there is none', () => {
    renderApp(
      <Proposals proposals={[{ ...FULL.proposals[0]!, expiresAt: null }]} />,
    )

    expect(screen.getByText('Now / proposed')).toBeTruthy()
    expect(screen.queryByText(/Expires/)).toBeNull()
  })

  it('says applying comes later rather than leaving a diff with no buttons', () => {
    renderApp(<Proposals proposals={FULL.proposals} />)

    expect(screen.getByText(/Applying a change comes in a later version/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says nothing is waiting when the queue is empty', () => {
    renderApp(<Proposals proposals={[]} />)

    expect(screen.getByText('Nothing is waiting to be applied.')).toBeTruthy()
    expect(screen.queryByText(/Applying a change comes/)).toBeNull()
  })
})

describe('the ledger', () => {
  it('lists every attempt, including the ones that produced nothing', () => {
    renderApp(<Ledger runs={RUNS} />)

    // Three runs plus the header row. A `capped` run is the row that explains why an
    // answer is missing from the page above, so it is not filtered out.
    expect(screen.getAllByRole('row')).toHaveLength(4)
    expect(screen.getByText('Budget cap reached')).toBeTruthy()
    expect(screen.getByText('Narrative')).toBeTruthy()
  })

  it('quotes the upstream failure verbatim', () => {
    renderApp(<Ledger runs={RUNS} />)

    // The only text on this page Balancr did not write. A failure that will not say
    // why is indistinguishable from a run that never happened.
    expect(
      screen.getByText('RESOURCE_EXHAUSTED: quota exceeded for this project'),
    ).toBeTruthy()
    expect(screen.getByText('Error')).toBeTruthy()
  })

  it('writes tokens and cost the Belgian way, down to a fraction of a cent', () => {
    renderApp(<Ledger runs={RUNS} />)

    expect(screen.getByText('3.120 in / 480 out')).toBeTruthy()
    // A model call can cost less than a cent, and rounding it to € 0,00 would hide
    // the whole ledger's worth of spend.
    expect(screen.getByText('€ 0,0012')).toBeTruthy()
    expect(screen.getByText('01/09/2026, 06:12')).toBeTruthy()
  })

  it('counts the calls in the caption', () => {
    renderApp(<Ledger runs={RUNS} />)

    expect(
      screen.getByText('The 3 most recent calls to the model, newest first.'),
    ).toBeTruthy()
  })

  it('uses the singular for one call', () => {
    renderApp(<Ledger runs={[RUNS[0]!]} />)

    expect(screen.getByText('The most recent call to the model.')).toBeTruthy()
  })

  it('fetches a payload only when its row is opened', async () => {
    const fetchMock = serve({
      '/api/insights/runs/run-findings/payload': json({
        ...RUNS[0]!,
        payload: { month: '2026-08', categories: [{ name: 'Groceries', spentCents: 42_500 }] },
      }),
    })
    renderApp(<Ledger runs={RUNS} />)

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
    renderApp(<Ledger runs={RUNS} />)

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
    renderApp(<Ledger runs={RUNS} />)

    fireEvent.click(screen.getAllByRole('button')[0]!)
    await screen.findByText(/"a": 1/)

    fireEvent.click(screen.getByRole('button', { name: 'Hide the payload' }))
    expect(screen.queryByText(/"a": 1/)).toBeNull()
  })

  it('reports an unparseable payload as a finding rather than as an error', async () => {
    serve({ '/api/insights/runs/run-findings/payload': json({ ...RUNS[0]!, payload: null }) })
    renderApp(<Ledger runs={RUNS} />)

    fireEvent.click(screen.getAllByRole('button')[0]!)
    // The row around it is still true, so a red box would be the audit view lying
    // about itself.
    expect(await screen.findByText('The stored payload could not be read.')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a payload that could not be fetched, without losing the table', async () => {
    serve({ '/api/insights/runs/run-findings/payload': new TypeError('fetch failed') })
    renderApp(<Ledger runs={RUNS} />)

    fireEvent.click(screen.getAllByRole('button')[0]!)
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('Balancr could not be reached.')
    })
    // The rest of the ledger is still on screen: the failure is about one payload.
    expect(screen.getByText('RESOURCE_EXHAUSTED: quota exceeded for this project')).toBeTruthy()
  })

  it('says no calls have been made rather than drawing an empty table', () => {
    renderApp(<Ledger runs={[]} />)

    expect(screen.getByText('No calls have been made yet.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    // The claim itself stays, because it is true of a deployment that has sent
    // nothing just as much as of one that has.
    expect(
      screen.getByText('Category names and amounts only. No payees, no transactions.'),
    ).toBeTruthy()
  })
})
