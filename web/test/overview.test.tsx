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
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionExpiryProvider } from '../src/api/resource.tsx'
import { Overview } from '../src/pages/Overview.tsx'
import type { Freshness, Hygiene, Overview as OverviewPayload } from '../src/shared.ts'
import { FreshnessNote } from '../src/ui/Freshness.tsx'
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
  },
  history: [
    { date: '2026-06-30', totalCents: 11_000_000 },
    { date: '2026-07-31', totalCents: 11_800_000 },
    { date: '2026-08-31', totalCents: 12_345_678 },
  ],
  month: '2026-08',
  totals: {
    incomeCents: 420_000,
    spentCents: 310_000,
    budgetedCents: 350_000,
    savingsRateBp: 2_619,
  },
  emergencyFundCentimonths: 450,
  hygiene: { scoreBp: 8_750, deductions: [{ reason: 'uncategorised', bp: 750 }] },
}

/** What a deployment that has never run a job answers. Every field null, no rows. */
const EMPTY: OverviewPayload = {
  freshness: { stale: false, asOf: null, jobsEnabled: true, jobs: [] },
  netWorth: null,
  history: [],
  month: null,
  totals: null,
  emergencyFundCentimonths: null,
  hygiene: null,
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
  })

  it('prints net worth in Belgian conventions under an English UI', async () => {
    renderApp(<Overview />)

    expect(await screen.findByText('€ 123.457')).toBeTruthy()
    expect(screen.getByText('Net worth')).toBeTruthy()
    // The three parts, and the date the snapshot was taken — not today's date.
    expect(screen.getByText('€ 25.000')).toBeTruthy()
    expect(screen.getByText('€ 98.457')).toBeTruthy()
    expect(screen.getByText('€ -10.000')).toBeTruthy()
    expect(screen.getByText('Updated 31/08/2026')).toBeTruthy()
  })

  it('prints the savings rate as a percentage of basis points, over the month it covers', async () => {
    renderApp(<Overview />)

    expect(await screen.findByText('26,2%')).toBeTruthy()
    expect(screen.getByText('August 2026')).toBeTruthy()
    expect(screen.getByText('€ 4.200')).toBeTruthy()
    expect(screen.getByText('€ 3.100')).toBeTruthy()
    expect(screen.getByText('€ 3.500')).toBeTruthy()
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
    expect(text).not.toMatch(/\b(metric|hygiene|chart|freshness|empty|time)\.[a-zA-Z]/)
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
        },
      } satisfies OverviewPayload),
    )
    renderApp(<Overview />)

    await screen.findByText('€ 123.457')
    // Savings rate and emergency buffer are both null here, and both cards stay.
    expect(screen.getAllByText('Not known yet')).toHaveLength(2)
    expect(screen.getByText('Savings rate')).toBeTruthy()
    expect(screen.getByText('Emergency buffer')).toBeTruthy()
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
    })

    expect(screen.getByText('87,5%')).toBeTruthy()
    expect(screen.getByText('Uncategorised transactions')).toBeTruthy()
    expect(screen.getByText('-7,5%')).toBeTruthy()
    expect(screen.getByText('Prices past their staleness limit')).toBeTruthy()
    expect(screen.getByText('-5%')).toBeTruthy()
  })

  it('says so when nothing is', () => {
    show({ scoreBp: 10_000, deductions: [] })

    expect(screen.getByText('100%')).toBeTruthy()
    expect(screen.getByText('Nothing is costing points.')).toBeTruthy()
    expect(screen.queryByText('What is costing points')).toBeNull()
  })

  it('prints a reason it has no label for rather than dropping the deduction', () => {
    // A server ahead of the bundle — a new reason code from a later release. Showing
    // the code costs the reader a lookup; hiding the row costs them the points.
    show({ scoreBp: 9_000, deductions: [{ reason: 'gremlins', bp: 1_000 }] })

    expect(screen.getByText('gremlins')).toBeTruthy()
    expect(screen.getByText('-10%')).toBeTruthy()
  })
})
