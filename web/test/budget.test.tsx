/**
 * The budget page: four charts, one month, and the rules that keep it honest.
 *
 * What is worth asserting here is not that a chart appeared — jsdom draws SVG and an
 * assertion on a path is a test of ECharts — but the four decisions the page makes on
 * its own, each of which would be invisible in a screenshot:
 *
 *  - **Every figure is the server's.** The fixture carries a projection, a norm and a
 *    month-progress figure that no arithmetic here could reproduce, and the assertions
 *    are literal strings. A page that recomputed any of them would still render
 *    something plausible, which is exactly why it has to be pinned to text.
 *  - **A missing metric drops a row rather than defaulting it.** One `burn_rate_over`
 *    in the fixture arrives without its month progress, and `€ 0` in its place would be
 *    a number someone acts on. It has to vanish from the pace section entirely.
 *  - **The month is a query parameter.** Changing the picker has to re-ask the server
 *    for that month, not filter what is already on screen — there is no client-side
 *    copy of another month to filter.
 *  - **A month nobody computed is not an error.** It answers with nulls, and the page
 *    owes the reader a sentence and a working picker rather than a red box.
 *
 * The charts are checked through their accessible summaries, which is the same text a
 * screen reader gets and the only part of a chart that states figures in words.
 *
 * jsdom reports every element as zero-sized, so this file lends the charts a size the
 * way `overview.test.tsx` does — not to assert geometry, but to keep ECharts' "Can't
 * get DOM width or height" warning out of output that is about something else.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Budget } from '../src/pages/Budget.tsx'
import type { Budget as BudgetPayload, Freshness } from '../src/shared.ts'
import { i18nReady, renderApp } from './helpers.tsx'

const FRESH: Freshness = { stale: false, asOf: null, jobsEnabled: true, jobs: [] }

/** The window every `trendCents` is indexed by. Three months keeps the fixture readable. */
const TREND_MONTHS = ['2026-06', '2026-07', '2026-08']

/**
 * A month with something in every field.
 *
 * Deliberately mixed: an income category (excluded from both the bullet chart and the
 * trend wall), an envelope with money assigned and nothing spent (in the bullet chart,
 * out of the trend wall), and a category over its norm with a projection attached.
 */
const FULL: BudgetPayload = {
  freshness: FRESH,
  month: '2026-08',
  months: ['2026-08', '2026-07', '2026-06'],
  totals: {
    month: '2026-08',
    incomeCents: 420_000,
    spentCents: 310_000,
    budgetedCents: 350_000,
    toBudgetCents: -25_000,
    fromLastMonthCents: 50_000,
    balanceCents: 90_000,
    savingsRateBp: 2_619,
  },
  history: [
    { month: '2026-07', incomeCents: 420_000, spentCents: 300_000, budgetedCents: 350_000, savingsRateBp: 2_857 },
    { month: '2026-08', incomeCents: 420_000, spentCents: 310_000, budgetedCents: 350_000, savingsRateBp: 2_619 },
  ],
  trendMonths: TREND_MONTHS,
  categories: [
    {
      categoryId: 'cat-salary',
      categoryName: 'Salary',
      isIncome: true,
      hidden: false,
      spentCents: 420_000,
      budgetedCents: 0,
      availableCents: 0,
      txnCount: 1,
      baselineCents: null,
      deltaBp: null,
      trendCents: [420_000, 420_000, 420_000],
    },
    {
      categoryId: 'cat-groceries',
      categoryName: 'Groceries',
      isIncome: false,
      hidden: false,
      spentCents: 65_000,
      budgetedCents: 60_000,
      availableCents: -5_000,
      txnCount: 24,
      baselineCents: 55_000,
      deltaBp: 1_818,
      trendCents: [50_000, 52_000, 65_000],
    },
    {
      categoryId: 'cat-rent',
      categoryName: 'Rent',
      isIncome: false,
      hidden: false,
      spentCents: 120_000,
      budgetedCents: 120_000,
      availableCents: 0,
      txnCount: 1,
      baselineCents: 126_000,
      deltaBp: -476,
      trendCents: [118_000, 119_000, 120_000],
    },
    {
      categoryId: 'cat-insurance',
      categoryName: 'Insurance',
      isIncome: false,
      hidden: false,
      spentCents: 0,
      budgetedCents: 40_000,
      availableCents: 40_000,
      txnCount: 0,
      baselineCents: null,
      deltaBp: null,
      trendCents: [0, 0, 0],
    },
  ],
  signals: [
    {
      code: 'burn_rate_over',
      categoryId: 'cat-groceries',
      categoryName: 'Groceries',
      severity: 'warn',
      metrics: {
        projectedCents: 84_000,
        assignedCents: 60_000,
        spentCents: 65_000,
        projectedOverrunCents: 24_000,
        monthProgressBp: 7_742,
      },
    },
    {
      code: 'above_baseline',
      categoryId: 'cat-groceries',
      categoryName: 'Groceries',
      severity: 'alert',
      metrics: { deltaBp: 1_818, baselineCents: 55_000 },
    },
    // Enough for a sentence, not enough for a bar: no `monthProgressBp`, no spend, no
    // overrun. The pace section must drop it rather than draw it against zero.
    {
      code: 'burn_rate_over',
      categoryId: 'cat-rent',
      categoryName: 'Rent',
      severity: 'warn',
      metrics: { projectedCents: 130_000, assignedCents: 120_000 },
    },
    // A code from a server one release ahead of this bundle.
    {
      code: 'gremlins',
      categoryId: 'cat-rent',
      categoryName: 'Rent',
      severity: 'info',
      metrics: {},
    },
  ],
  uncategorised: { txnCount: 3, amountCents: 12_500 },
}

/** A deployment whose jobs have never run: no months at all. */
const EMPTY: BudgetPayload = {
  freshness: FRESH,
  month: '2026-09',
  months: [],
  totals: null,
  history: [],
  trendMonths: [],
  categories: [],
  signals: [],
  uncategorised: null,
}

/** A month that exists in the picker and was never aggregated. */
const UNCOMPUTED: BudgetPayload = {
  ...EMPTY,
  month: '2026-05',
  months: ['2026-08', '2026-07', '2026-06'],
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Answers whatever is asked, per path, falling back to the first reply. */
function serve(
  replies: Record<string, Response | Error> | Response | Error,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn((path: string) => {
    const reply = replies instanceof Response || replies instanceof Error ? replies : replies[path]
    if (reply === undefined) return Promise.reject(new Error(`unstubbed request: ${path}`))
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply.clone())
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/** The paths asked of the server, in order. */
const paths = (mock: ReturnType<typeof vi.fn>): string[] =>
  mock.mock.calls.map((call) => String(call[0]))

/**
 * Every chart's accessible summary, with `Intl`'s non-breaking spaces normalised.
 *
 * A `getByText` normalises those away on its own; an attribute read does not, and the
 * difference is invisible in a diff.
 */
const summaries = (): string[] =>
  screen
    .getAllByRole('img')
    .map((chart) => (chart.getAttribute('aria-label') ?? '').replaceAll(' ', ' '))

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

describe('before and instead of an answer', () => {
  it('heads the page while it waits', () => {
    serve(json(FULL))
    renderApp(<Budget />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Budget')
    expect(screen.getByRole('status').textContent).toBe('Loading…')
  })

  it('offers a retry when the server cannot be reached', async () => {
    serve(new TypeError('fetch failed'))
    renderApp(<Budget />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Balancr could not be reached.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('offers a sync rather than a page of zeroes when no month exists at all', async () => {
    serve(json(EMPTY))
    renderApp(<Budget />)

    expect(await screen.findByText('No data yet')).toBeTruthy()
    // Nothing failed; there is simply nothing yet.
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('a month with figures in it', () => {
  const show = (): ReturnType<typeof vi.fn> => {
    const mock = serve(json(FULL))
    renderApp(<Budget />)
    return mock
  }

  it('prints the four totals in Belgian conventions under an English UI', async () => {
    show()

    expect(await screen.findByText('€ 3.100')).toBeTruthy()
    expect(screen.getByText('€ 4.200')).toBeTruthy()
    expect(screen.getByText('26,2%')).toBeTruthy()
    // Over-assigned, which is a state to act on rather than a smaller number.
    expect(screen.getByText('€ -250')).toBeTruthy()

    // By heading rather than by text: the bullet chart's legend names the same three
    // things, and a bare `getByText('Spent')` matches its SVG label too.
    for (const label of ['Spent', 'Income', 'Left to assign', 'Savings rate']) {
      expect(screen.getByRole('heading', { name: label, level: 2 })).toBeTruthy()
    }
    // The supporting rows, read off the cards rather than off the page: the bullet
    // chart's money axis prints round euro amounts too, and a tick that happened to
    // land on one of these would make the assertion ambiguous.
    const rows = [...document.querySelectorAll('.metric__row')].map((row) =>
      (row.textContent ?? '').replaceAll('\u00a0', ' '),
    )
    expect(rows).toEqual(['Assigned€ 3.500', 'Available€ 900', 'From last month€ 500'])
  })

  it('warns that the figures are incomplete while transactions have no category', async () => {
    show()
    await screen.findByText('€ 3.100')

    expect(
      screen.getByText(
        '3 transactions worth € 125 have no category, so the figures below are incomplete.',
      ),
    ).toBeTruthy()
  })

  it('reads the Sankey out as what came in, what went out and the largest envelope', async () => {
    show()
    await screen.findByText('€ 3.100')

    // € 1.850 is the sum of the envelopes drawn, not `totals.spentCents` — the chart
    // states the total it actually drew.
    expect(summaries()).toContain(
      '€ 4.200 came in and € 1.850 went out. The largest envelope was Rent at € 1.200.',
    )
  })

  it('orders the bullet chart by the reach of each row, income excluded', async () => {
    show()
    await screen.findByText('€ 3.100')

    // Insurance is last but present: nothing spent from € 400 assigned is exactly the
    // question "budget versus actual" asks. Salary is absent — income is not an envelope.
    expect(summaries()).toContain(
      'Assigned against spent, largest envelope first: Rent spent € 1.200 of € 1.200; ' +
        'Groceries spent € 650 of € 600; Insurance spent € 0 of € 400.',
    )
  })

  it('draws the pace only for the signal that carried every metric', async () => {
    show()
    await screen.findByText('€ 3.100')

    // The server's month progress, not one derived from today's date.
    expect(screen.getByText('77,4% of the month has passed')).toBeTruthy()
    expect(screen.getByText('Projected month end: € 840')).toBeTruthy()
    expect(screen.getByText('Projected overrun € 240')).toBeTruthy()
    expect(
      screen.getByText(
        'Groceries is on track for € 840,00 this month, against € 600,00 assigned.',
      ),
    ).toBeTruthy()

    // Rent's burn-rate signal had no month progress, so it is dropped whole rather
    // than drawn against a zero.
    expect(document.querySelectorAll('.pace__row')).toHaveLength(1)
    expect(screen.queryByText(/€ 1\.300/)).toBeNull()
  })

  it('gives each sparkline its own figure, its delta and the norm through it', async () => {
    show()
    await screen.findByText('€ 3.100')

    expect(screen.getByText('The last 3 months, oldest first.')).toBeTruthy()
    expect(summaries()).toContain('Rent: € 1.200 in August 2026, against a norm of € 1.260.')
    expect(summaries()).toContain('Groceries: € 650 in August 2026, against a norm of € 550.')
    expect(screen.getByText('+18,2%')).toBeTruthy()
    expect(screen.getByText('-4,8%')).toBeTruthy()

    // A category with nothing but zeroes has no shape to read, and Salary is income.
    const names = [...document.querySelectorAll('.trend__name')].map((el) => el.textContent)
    expect(names).toEqual(['Rent', 'Groceries'])
  })

  it('renders the findings it can state and silently drops the ones it cannot', async () => {
    show()
    await screen.findByText('€ 3.100')

    expect(
      screen.getByText('Groceries is 18,2% above your 12-month norm of € 550,00.'),
    ).toBeTruthy()
    // A code this bundle has no sentence for is not printed as its own name.
    expect(screen.queryByText(/gremlins/)).toBeNull()
  })

  it('leaves every string translated', async () => {
    show()
    await screen.findByText('€ 3.100')

    // A missing key renders as itself, across the two namespaces this page reads.
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\b(metric|chart|pace|picker|empty|findings|time)\.[a-zA-Z]/)
  })
})

describe('the month picker', () => {
  it('offers every stored month and re-asks the server for the one chosen', async () => {
    const mock = serve(json(FULL))
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')

    const picker = screen.getByLabelText('Month')
    expect([...picker.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'August 2026',
      'July 2026',
      'June 2026',
    ])

    fireEvent.change(picker, { target: { value: '2026-07' } })
    await waitFor(() => {
      expect(paths(mock)).toEqual(['/api/budget', '/api/budget?month=2026-07'])
    })
  })

  it('is not drawn at all when there is only one month to pick', async () => {
    serve(json({ ...FULL, months: ['2026-08'] } satisfies BudgetPayload))
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')

    expect(screen.queryByLabelText('Month')).toBeNull()
  })
})

describe('a month nobody computed', () => {
  it('says so, keeps the picker, and draws no charts', async () => {
    serve(json(UNCOMPUTED))
    renderApp(<Budget />)

    expect(await screen.findByText('Nothing has been computed for May 2026 yet.')).toBeTruthy()
    expect(screen.getByText('Pick another month, or run a sync to aggregate this one.')).toBeTruthy()

    // Still navigable — the way out of a stale bookmark is the picker, which now also
    // offers the month on screen so the label above the notice matches it.
    const picker = screen.getByLabelText('Month')
    expect([...picker.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'May 2026',
      'August 2026',
      'July 2026',
      'June 2026',
    ])

    // Not an error, and not four empty charts either.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryAllByRole('img')).toHaveLength(0)
  })
})
