/**
 * The overview page, and the four things it is the first page to have to get right.
 *
 *  - **Every state of one endpoint.** Loading, unreachable, answered-with-nothing and
 *    answered are four different screens, and the three that are not the happy path are
 *    the ones an operator meets on day one: a container still starting, a proxy pointed
 *    at nothing, a deployment whose jobs have never run. `DataState` is shared by
 *    #30–#33, so the assertions here are the contract those pages inherit.
 *  - **Belgian formatting under an English UI.** The figures are asserted as literal
 *    strings — `€ 123.457`, `26,2%`, `31/08/2026` — because that is the whole point of
 *    `format.ts` and a test that recomputed them through the same formatter would pass
 *    on `$123,457.00` too.
 *  - **A null is not a zero.** Every figure on this page can legitimately be absent,
 *    and "€ 0" for "the job has not run" is a wrong number rather than a missing one.
 *  - **A 401 is not this page's error.** The session can vanish while a dashboard sits
 *    open, and the page's job is to say so upwards, not to decide what happens next.
 *
 * jsdom reports every element as zero-sized, so this file lends the chart a size the
 * way `chart.test.tsx` does — not to assert geometry, which no test here does, but to
 * keep ECharts' "Can't get DOM width or height" warning out of output that is about
 * something else.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionExpiryProvider } from '../src/api/resource.tsx'
import { Overview } from '../src/pages/Overview.tsx'
import type { Freshness, Hygiene, Overview as OverviewPayload, OverviewGoal } from '../src/shared.ts'
import { PrivacyProvider } from '../src/privacy/PrivacyContext.tsx'
import { FreshnessNote } from '../src/ui/Freshness.tsx'
import { GoalsCard } from '../src/ui/Goals.tsx'
import { HygieneCard } from '../src/ui/Hygiene.tsx'
import { i18nReady, renderApp } from './helpers.tsx'

const FRESH: Freshness = {
  stale: false,
  asOf: '2026-09-02T05:30:00Z',
  jobsEnabled: true,
  jobs: [{ name: 'sync', status: 'ok', lastRunAt: null, lastSuccessAt: null, error: null }],
}

/** A month with something in every field, so one render can be asserted all over. */
const FULL: OverviewPayload = {
  freshness: FRESH,
  netWorth: {
    date: '2026-08-31',
    totalCents: 12_345_678,
    liquidCents: 2_500_000,
    investedCents: 9_845_678,
    debtCents: -1_000_000,
    propertyValueCents: 40_000_000,
    mortgageBalanceCents: 18_000_000,
    loanBalanceCents: 1_500_000,
    revolvingDebtBalanceCents: 250_000,
    liquidOffBudgetCents: 500_000,
  },
  history: [
    { date: '2026-06-30', totalCents: 11_000_000 },
    { date: '2026-07-31', totalCents: 11_800_000 },
    { date: '2026-08-31', totalCents: 12_345_678 },
  ],
  // Two months of flows, so the savings card has a period to sum over and a span to
  // name. Deliberately fewer than the twelve `twelve_months` asks for: the card has to
  // print the span it actually covered rather than the one it was asked for (#288, #296).
  flows: [
    {
      month: '2026-07',
      incomeCents: 400_000,
      spentCents: 320_000,
      budgetedCents: 330_000,
      savingsRateBp: 2_000,
      committedCents: 0,
      committedApproximate: false,
    },
    {
      month: '2026-08',
      incomeCents: 420_000,
      spentCents: 310_000,
      budgetedCents: 350_000,
      savingsRateBp: 2_619,
      committedCents: 0,
      committedApproximate: false,
    },
  ],
  month: '2026-08',
  months: ['2026-08', '2026-07', '2026-06'],
  totals: {
    incomeCents: 420_000,
    spentCents: 310_000,
    budgetedCents: 350_000,
    savingsRateBp: 2_619,
  },
  emergencyFundCentimonths: 450,
  hygiene: { scoreBp: 8_750, deductions: [{ reason: 'uncategorised', bp: 750 }], signals: [] },
  actualConfigured: true,
  ghostfolioConfigured: true,
  goals: [],
}

/** What a deployment that has never run a job answers. Every field null, no rows. */
const EMPTY: OverviewPayload = {
  freshness: { stale: false, asOf: null, jobsEnabled: true, jobs: [] },
  netWorth: null,
  history: [],
  flows: [],
  month: null,
  months: [],
  totals: null,
  emergencyFundCentimonths: null,
  hygiene: null,
  actualConfigured: true,
  ghostfolioConfigured: true,
  goals: [],
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Answers `/api/overview` with each queued reply in turn, repeating the last. */
function serve(first: Response | Error, ...rest: (Response | Error)[]): ReturnType<typeof vi.fn> {
  const replies = [first, ...rest]
  let call = 0
  const mock = vi.fn(() => {
    const reply = replies[Math.min(call, replies.length - 1)] ?? first
    call += 1
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply.clone())
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

const original = {
  width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
  height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
}

beforeAll(async () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { value: 300, configurable: true })
  await i18nReady()
})

afterAll(() => {
  if (original.width !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', original.width)
  }
  if (original.height !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', original.height)
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('while the server has not answered', () => {
  it('heads the page anyway and announces the wait in a live region', () => {
    serve(json(FULL))
    renderApp(<Overview />)

    // The header is not part of the resource: a page that blanks its own title while
    // loading loses the one thing that says which page you are on.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Overview')
    expect(screen.getByRole('status').textContent).toBe('Loading…')
  })
})

describe('when the server cannot be reached', () => {
  it('says so and offers a retry that actually re-asks', async () => {
    const fetchMock = serve(new TypeError('fetch failed'), json(FULL))
    renderApp(<Overview />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Balancr could not be reached.')

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('€ 123.457')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('quotes the request id, which is the only way to find the cause in the log', async () => {
    serve(
      json(
        { error: { code: 'internal_error', message: 'Something went wrong.', requestId: 'req-77' } },
        500,
      ),
    )
    renderApp(<Overview />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Something went wrong.')
    expect(alert.textContent).toContain('req-77')
  })
})

describe('when the session has gone while the page sat open', () => {
  it('reports it upwards instead of deciding what to do about it', async () => {
    serve(
      json(
        { error: { code: 'unauthenticated', message: 'Please sign in again.', requestId: null } },
        401,
      ),
    )
    const onExpired = vi.fn()
    renderApp(
      <SessionExpiryProvider onExpired={onExpired}>
        <Overview />
      </SessionExpiryProvider>,
    )

    await waitFor(() => {
      expect(onExpired).toHaveBeenCalledTimes(1)
    })
    // And still explains itself, because a re-ask that disagrees would otherwise leave
    // the reader looking at a page that changed for no stated reason.
    expect(screen.getByRole('alert').textContent).toContain('Please sign in again.')
  })
})

describe('when the jobs have never run', () => {
  it('offers a refresh rather than a page of zeroes', async () => {
    serve(json(EMPTY))
    renderApp(<Overview />)

    expect(await screen.findByText('No data yet')).toBeTruthy()
    expect(screen.getByText('Run a sync to pull in your budget and portfolio.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
    // Not an error: nothing failed, there is simply nothing yet.
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('when the server answers with a month', () => {
  beforeEach(() => {
    serve(json(FULL))
    // The savings card sums a period off the real clock (#345), so it is pinned here to
    // the same instant `FRESH.asOf` already names — after August, so July and August
    // both read as finished months rather than drifting with the day this runs.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-02T05:30:00Z'))
  })

  it('prints net worth in Belgian conventions under an English UI', async () => {
    renderApp(<Overview />)

    expect(await screen.findByText('€ 123.457')).toBeTruthy()
    expect(screen.getByText('Net worth')).toBeTruthy()
    // The three parts, and the date the snapshot was taken — not today's date.
    expect(screen.getByText('€ 25.000')).toBeTruthy()
    expect(screen.getByText('€ 98.457')).toBeTruthy()
    expect(screen.getByText('€ -10.000')).toBeTruthy()
    // "Directly available" splits into what's on- and off-budget (#353's follow-up)
    // rather than staying one figure a reader has to already know is mixed.
    expect(screen.getByText('On budget')).toBeTruthy()
    expect(screen.getByText('€ 20.000')).toBeTruthy()
    expect(screen.getByText('Off budget')).toBeTruthy()
    expect(screen.getByText('€ 5.000')).toBeTruthy()
    expect(screen.getByText('Updated 31/08/2026')).toBeTruthy()
  })

  it('opens the savings card on the current year, summed, and names the span it covered', async () => {
    // The point of #296, carried into #345's rebuild: this used to print
    // `totals.savingsRateBp` — August alone, 26,2% — while the same card on the Budget
    // page offered four relative windows. The default is now the current year, so
    // € 8.200 came in against € 6.300 out across both months on file, and the caveat
    // names how much of the year that span actually covers.
    renderApp(<Overview />)

    expect(await screen.findByText('23,2%')).toBeTruthy()
    expect(screen.getByText('Over 2 months, July 2026 to August 2026')).toBeTruthy()
    expect(screen.getByText('€ 8.200')).toBeTruthy()
    expect(screen.getByText('€ 6.300')).toBeTruthy()
    // The month's assigned figure is gone with the month: an envelope total has no
    // meaning summed over a period, so it does not belong under a period's rate.
    expect(screen.queryByText('Assigned')).toBeNull()
    // Both months in this fixture have nothing still to come, so the row that names it
    // stays off rather than printing a "Still to come: € 0,00" that says nothing (#397).
    expect(screen.queryByText('Still to come')).toBeNull()
  })

  it('adds a "still to come" row once the period has money not yet posted (#397)', async () => {
    const withCommitted: OverviewPayload = {
      ...FULL,
      flows: FULL.flows.map((entry) =>
        entry.month === '2026-08' ? { ...entry, committedCents: 40_000 } : entry,
      ),
    }
    serve(json(withCommitted))
    renderApp(<Overview />)

    // The committed money folds into the rate itself (#361) — 40 000 more effective
    // spend against the same 8 200 income drops 23,2% to 18,3%.
    expect(await screen.findByText('18,3%')).toBeTruthy()
    // The span sentence carries no caveat about why the figure might still move (#397) —
    // that reasoning is dropped, and the amount itself is now a row instead of prose.
    expect(screen.getByText('Over 2 months, July 2026 to August 2026')).toBeTruthy()
    expect(screen.getByText('Still to come')).toBeTruthy()
    expect(screen.getByText('€ 400')).toBeTruthy()
  })

  it('re-reads the same flows for another window without asking the server again', async () => {
    const mock = serve(json(FULL))
    renderApp(<Overview />)
    await screen.findByText('23,2%')
    const calls = mock.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: 'Period' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Month' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Aug' }))

    // August on its own is the reading the card used to be stuck on, and it is a fair bit
    // higher than the year-to-date one — which is the whole argument for the chooser.
    expect(await screen.findByText('26,2%')).toBeTruthy()
    expect(screen.getByText('Over August 2026')).toBeTruthy()
    expect(screen.getByText('€ 4.200')).toBeTruthy()
    expect(screen.getByText('€ 3.100')).toBeTruthy()
    expect(mock.mock.calls.length).toBe(calls)
  })


  it('turns centimonths of cover into a pluralised month count', async () => {
    renderApp(<Overview />)

    // 450 centimonths is four and a half months, and the decimal comma is Belgian too.
    expect(await screen.findByText('4,5 months')).toBeTruthy()
  })

  it('gives the chart a sentence that says what the line does', async () => {
    renderApp(<Overview />)

    const chart = await screen.findByRole('img')
    // `Intl` separates the symbol from the amount with a non-breaking space, which is
    // right in a browser and invisible in a diff. Every `getByText` above normalises it
    // away; an attribute read does not, so it is normalised here.
    const label = (chart.getAttribute('aria-label') ?? '').replaceAll('\u00a0', ' ')
    expect(label).toBe(
      'Net worth between 30/06/2026 and 31/08/2026: € 110.000 at the start, € 123.457 at the end.',
    )
  })

  it('shows the age of the figures without shouting about it', async () => {
    renderApp(<Overview />)

    // Nothing failed and the jobs are on, so this is a note, not a notice.
    expect(await screen.findByText('Updated 02/09/2026, 07:30')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('leaves every string translated', async () => {
    await i18nReady()
    renderApp(<Overview />)
    await screen.findByText('€ 123.457')

    // A missing key renders as itself, which is the failure this catches — including in
    // the three namespaces this page reads across.
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\b(metric|hygiene|chart|freshness|empty|time|goals)\.[a-zA-Z]/)
  })
})

describe('when a figure is absent', () => {
  it('says it is not known yet rather than printing a zero', async () => {
    serve(
      json({
        ...EMPTY,
        // Enough for the page not to be empty, and nothing else — the shape a first
        // net-worth run leaves behind before the budget sync has produced a month.
        netWorth: {
          date: '2026-08-31',
          totalCents: 12_345_678,
          liquidCents: 2_500_000,
          investedCents: 9_845_678,
          debtCents: 0,
          propertyValueCents: null,
          mortgageBalanceCents: null,
          loanBalanceCents: null,
          revolvingDebtBalanceCents: null,
          liquidOffBudgetCents: null,
        },
      } satisfies OverviewPayload),
    )
    renderApp(<Overview />)

    await screen.findByText('€ 123.457')
    // Savings rate and emergency buffer are both null here, and both cards stay.
    expect(screen.getAllByText('Not known yet')).toHaveLength(2)
    expect(screen.getByText('Savings rate')).toBeTruthy()
    expect(screen.getByText('Emergency buffer')).toBeTruthy()
    // And no period chooser: with no month to anchor on there is nothing any of the four
    // windows could sum, so a select offering four readings of nothing is worse than the
    // plain placeholder (#296).
    expect(screen.queryByLabelText('Period')).toBeNull()
  })
})

describe('the freshness note', () => {
  const showFreshness = (freshness: Freshness): void => {
    render(<FreshnessNote freshness={freshness} />)
  }

  it('names the job that failed and what it said', () => {
    showFreshness({
      ...FRESH,
      stale: true,
      jobs: [
        { name: 'sync', status: 'error', lastRunAt: null, lastSuccessAt: null, error: 'ECONNREFUSED' },
        { name: 'portfolio', status: 'ok', lastRunAt: null, lastSuccessAt: null, error: null },
      ],
    })

    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('A background job last failed')
    expect(notice.textContent).toContain('Budget sync — ECONNREFUSED')
    // The job that is fine is not listed; a list of everything hides the one line
    // that matters.
    expect(notice.textContent).not.toContain('Portfolio')
    expect(notice.textContent).toContain('Updated 02/09/2026, 07:30')
  })

  it('still names a job that failed without saying why', () => {
    showFreshness({
      ...FRESH,
      stale: true,
      jobs: [
        { name: 'networth', status: 'error', lastRunAt: null, lastSuccessAt: null, error: null },
      ],
    })

    expect(screen.getByRole('status').textContent).toContain('Net worth — Something went wrong.')
  })

  it('ignores a failed AI run, which does not make the figures wrong', () => {
    showFreshness({
      ...FRESH,
      stale: true,
      jobs: [{ name: 'ai', status: 'error', lastRunAt: null, lastSuccessAt: null, error: 'over budget' }],
    })

    // The banner still shows — something failed — but the AI job is not one of the
    // four that produce the numbers on this page, so it is not offered as the reason.
    const notice = screen.getByRole('status')
    expect(notice.textContent).toContain('A background job last failed')
    expect(notice.textContent).not.toContain('AI analysis')
  })

  it('explains a deployment with the scheduler switched off', () => {
    showFreshness({ ...FRESH, jobsEnabled: false })

    expect(screen.getByRole('status').textContent).toContain('Scheduled jobs are switched off')
  })

  it('says nothing at all on a new install', () => {
    // Nothing has failed, the jobs are on, and there is no age to report. A notice
    // here would be a worry about a state that is simply "not yet".
    const { container } = render(
      <FreshnessNote freshness={{ stale: false, asOf: null, jobsEnabled: true, jobs: [] }} />,
    )
    expect(container.textContent).toBe('')
  })
})

describe('the hygiene card', () => {
  const show = (hygiene: Hygiene): void => {
    render(<HygieneCard hygiene={hygiene} />)
  }

  it('scores the bookkeeping and lists what is costing points', () => {
    show({
      scoreBp: 8_750,
      deductions: [
        { reason: 'uncategorised', bp: 750 },
        { reason: 'stale_prices', bp: 500 },
      ],
      signals: [],
    })

    expect(screen.getByText('87,5%')).toBeTruthy()
    expect(screen.getByText('Uncategorised transactions')).toBeTruthy()
    expect(screen.getByText('-7,5%')).toBeTruthy()
    expect(screen.getByText('Prices past their staleness limit')).toBeTruthy()
    expect(screen.getByText('-5%')).toBeTruthy()
  })

  it('says so when nothing is', () => {
    show({ scoreBp: 10_000, deductions: [], signals: [] })

    expect(screen.getByText('100%')).toBeTruthy()
    expect(screen.getByText('Nothing is costing points.')).toBeTruthy()
    expect(screen.queryByText('What is costing points')).toBeNull()
  })

  it('prints a reason it has no label for rather than dropping the deduction', () => {
    // A server ahead of the bundle — a new reason code from a later release. Showing
    // the code costs the reader a lookup; hiding the row costs them the points.
    show({ scoreBp: 9_000, deductions: [{ reason: 'gremlins', bp: 1_000 }], signals: [] })

    expect(screen.getByText('gremlins')).toBeTruthy()
    expect(screen.getByText('-10%')).toBeTruthy()
    // No signal can be filed under a reason this bundle has no code mapping for, so
    // the row stays plain text rather than a button that would open onto nothing.
    expect(screen.queryByRole('button', { name: 'gremlins' })).toBeNull()
  })

  it('explains a deduction by expanding it into the findings behind it', () => {
    show({
      scoreBp: 9_000,
      deductions: [{ reason: 'recompute_mismatch', bp: 1_000 }],
      signals: [
        {
          code: 'recompute_mismatch',
          categoryId: 'cat-1',
          categoryName: 'Groceries',
          severity: 'alert',
          metrics: { differenceCents: 5_000, actualCents: 20_000, recomputedCents: 15_000 },
        },
      ],
    })

    // Closed until clicked: the sentence is not on the page yet.
    expect(screen.queryByText(/Groceries does not reconcile/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Recomputed totals disagree with Actual' }))

    expect(screen.getByText("Groceries does not reconcile: our own sum is € 50,00 away from Actual's.")).toBeTruthy()
  })
})

describe('the goals card', () => {
  const show = (goals: readonly OverviewGoal[]): void => {
    render(
      <PrivacyProvider>
        <GoalsCard goals={goals} />
      </PrivacyProvider>,
    )
  }

  /** Every field populated, so a single test can override just the one it is about. */
  const GOAL: OverviewGoal = {
    id: 'goal-1',
    label: 'Emergency fund',
    kind: 'liquid',
    priority: 'normal',
    categoryId: null,
    targetCents: 500_000,
    targetDate: '2027-06-01',
    status: 'active',
    doneAt: null,
    currentCents: 250_000,
    progressBp: 5_000,
    met: false,
    monthlyRateCents: 10_000,
    monthsToTarget: 3,
    etaMonth: '2027-03',
    trendMonths: 6,
    trendFrom: '2026-03',
    trendTo: '2026-08',
    requiredMonthlyCents: 20_833,
    pace: 'onTrack',
    categoryName: null,
    categorySiblingCount: 0,
  }

  it('says so when there are no goals', () => {
    show([])

    expect(screen.getByText('No savings goals yet. Add one in Settings to track progress here.')).toBeTruthy()
  })

  it('shows the label, the percentage and the amounts', () => {
    show([GOAL])

    expect(screen.getByText('Emergency fund')).toBeTruthy()
    expect(screen.getByText('50%')).toBeTruthy()
    expect(screen.getByText('€ 2.500,00 of € 5.000,00')).toBeTruthy()
  })

  it('says progress is not known rather than printing a percentage it does not have', () => {
    show([{ ...GOAL, currentCents: null, progressBp: null }])

    expect(screen.getByText('Not enough data yet')).toBeTruthy()
    expect(screen.getByText('Not synced yet.')).toBeTruthy()
  })

  it('states the trend window behind a projection', () => {
    show([GOAL])

    expect(screen.getByText('Based on the last 6 months of net worth, March 2026 to August 2026.')).toBeTruthy()
  })

  it('credits a category goal\'s trend to the category, not net worth', () => {
    show([{ ...GOAL, kind: 'category', categoryId: 'cat-tv', categoryName: 'TV fund' }])

    expect(
      screen.getByText("Based on the last 6 months of this category's balance, March 2026 to August 2026."),
    ).toBeTruthy()
  })

  it('leaves out the trend line when there is not enough history for one', () => {
    show([{ ...GOAL, trendMonths: 0, trendFrom: null, trendTo: null }])

    expect(screen.queryByText(/Based on the last/)).toBeNull()
  })

  it('acknowledges a done goal instead of showing its frozen, dataless progress', () => {
    show([
      {
        ...GOAL,
        status: 'done',
        doneAt: '2026-09-20',
        currentCents: null,
        progressBp: null,
        requiredMonthlyCents: null,
        pace: null,
        trendMonths: 0,
        trendFrom: null,
        trendTo: null,
        etaMonth: null,
      },
    ])

    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.getByText('Marked done on 20/09/2026.')).toBeTruthy()
    expect(screen.queryByText('Not enough data yet')).toBeNull()
    expect(screen.queryByText('Not synced yet.')).toBeNull()
  })

  it('says a goal that has been reached is reached, not projected', () => {
    show([{ ...GOAL, met: true }])

    expect(screen.getByText('Target reached.')).toBeTruthy()
  })

  it('compares the projected date against the target when the eta is ahead of it', () => {
    show([{ ...GOAL, etaMonth: '2027-03', targetDate: '2027-06-01' }])

    expect(
      screen.getByText('On pace to reach it around March 2027, ahead of the 01/06/2027 target.'),
    ).toBeTruthy()
  })

  it('compares the projected date against the target when the eta lands on it', () => {
    show([{ ...GOAL, etaMonth: '2027-06', targetDate: '2027-06-01' }])

    expect(
      screen.getByText('On pace to reach it around June 2027, on track for the 01/06/2027 target.'),
    ).toBeTruthy()
  })

  it('compares the projected date against the target when the eta is behind it', () => {
    show([{ ...GOAL, etaMonth: '2027-09', targetDate: '2027-06-01' }])

    expect(
      screen.getByText('On pace to reach it around September 2027, behind the 01/06/2027 target.'),
    ).toBeTruthy()
  })

  it('gives an eta with no comparison when no target date was set', () => {
    show([{ ...GOAL, etaMonth: '2027-03', targetDate: null }])

    expect(screen.getByText('On pace to reach it around March 2027.')).toBeTruthy()
  })

  it('leaves out the eta line entirely when the trend does not support one', () => {
    show([{ ...GOAL, etaMonth: null, monthlyRateCents: null, monthsToTarget: null }])

    expect(screen.queryByText(/On pace|reached/)).toBeNull()
  })
})

describe('a tenant missing Actual and/or Ghostfolio (#370)', () => {
  it('shows only the Actual notice when Ghostfolio is connected but Actual is not', async () => {
    serve(json({ ...FULL, actualConfigured: false }))
    renderApp(<Overview />)

    expect(await screen.findByText("Actual isn't connected")).toBeTruthy()
    expect(screen.queryByText("Ghostfolio isn't connected")).toBeNull()

    const link = screen.getByRole('link', { name: 'Go to Settings → Integrations' }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/settings/integrations')
    expect(screen.queryAllByRole('link', { name: 'Go to Settings → Integrations' })).toHaveLength(1)
  })

  it('shows only the Ghostfolio notice when Actual is connected but Ghostfolio is not', async () => {
    serve(json({ ...FULL, ghostfolioConfigured: false }))
    renderApp(<Overview />)

    expect(await screen.findByText("Ghostfolio isn't connected")).toBeTruthy()
    expect(screen.queryByText("Actual isn't connected")).toBeNull()
  })

  it('shows both notices, and no figures, when neither is connected', async () => {
    serve(json({ ...FULL, actualConfigured: false, ghostfolioConfigured: false }))
    renderApp(<Overview />)

    expect(await screen.findByText("Actual isn't connected")).toBeTruthy()
    expect(screen.getByText("Ghostfolio isn't connected")).toBeTruthy()
    expect(screen.queryAllByRole('link', { name: 'Go to Settings → Integrations' })).toHaveLength(2)

    expect(screen.queryByText('No data yet')).toBeNull()
    expect(screen.queryAllByRole('img')).toHaveLength(0)
  })
})
