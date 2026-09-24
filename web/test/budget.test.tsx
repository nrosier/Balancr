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
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Budget } from '../src/pages/Budget.tsx'
import type { Budget as BudgetPayload, CustodyWire, Freshness } from '../src/shared.ts'
import { i18nReady, renderApp, visit } from './helpers.tsx'

const FRESH: Freshness = { stale: false, asOf: null, jobsEnabled: true, jobs: [] }

/** The window every `trendCents` is indexed by. Three months keeps the fixture readable. */
const TREND_MONTHS = ['2026-06', '2026-07', '2026-08']

/**
 * The Statbel comparison for `FULL`, on `FULL`'s own money.
 *
 * Every figure here is what `compareToBenchmark` produces from the two spending
 * categories above and the shipped `config/benchmark/be.yaml`, written out rather
 * than computed: Groceries' € 650 under food and Rent's € 1.200 under housing come to
 * € 1.850 of compared spending, and each reference line is that total times the survey's
 * published share. A fixture that computed them would agree with a card that computed
 * them, and the point of the card is that it computes nothing.
 *
 * `basis: 'mix'` because the shipped file leaves the reference household commented out,
 * and the household is one adult plus a half-time thirteen-year-old — 1,00 + 0,3 × 0,5 —
 * which is the case #43 was written for and the only one that exercises all three
 * household sentences at once.
 */
const BENCHMARK: Extract<BudgetPayload['benchmark'], { kind: 'ok' }> = {
  kind: 'ok',
  month: '2026-08',
  basis: 'mix',
  period: 'month',
  periodProgressBp: 10_000,
  groups: [
    { group: 'food', yourCents: 65_000, yourShareBp: 3_514, referenceShareBp: 1_400, benchmarkCents: 25_900, deltaBp: 15_097, deltaCents: 39_100, categories: 1 },
    { group: 'alcohol_tobacco', yourCents: 0, yourShareBp: 0, referenceShareBp: 170, benchmarkCents: 3_145, deltaBp: -10_000, deltaCents: -3_145, categories: 0 },
    { group: 'clothing', yourCents: 0, yourShareBp: 0, referenceShareBp: 370, benchmarkCents: 6_845, deltaBp: -10_000, deltaCents: -6_845, categories: 0 },
    { group: 'housing', yourCents: 120_000, yourShareBp: 6_486, referenceShareBp: 3_060, benchmarkCents: 56_610, deltaBp: 11_198, deltaCents: 63_390, categories: 1 },
    { group: 'furnishings', yourCents: 0, yourShareBp: 0, referenceShareBp: 500, benchmarkCents: 9_250, deltaBp: -10_000, deltaCents: -9_250, categories: 0 },
    { group: 'health', yourCents: 0, yourShareBp: 0, referenceShareBp: 480, benchmarkCents: 8_880, deltaBp: -10_000, deltaCents: -8_880, categories: 0 },
    { group: 'transport', yourCents: 0, yourShareBp: 0, referenceShareBp: 1_170, benchmarkCents: 21_645, deltaBp: -10_000, deltaCents: -21_645, categories: 0 },
    { group: 'recreation', yourCents: 0, yourShareBp: 0, referenceShareBp: 790, benchmarkCents: 14_615, deltaBp: -10_000, deltaCents: -14_615, categories: 0 },
    { group: 'hotels_restaurants', yourCents: 0, yourShareBp: 0, referenceShareBp: 730, benchmarkCents: 13_505, deltaBp: -10_000, deltaCents: -13_505, categories: 0 },
    { group: 'other', yourCents: 0, yourShareBp: 0, referenceShareBp: 1_330, benchmarkCents: 24_605, deltaBp: -10_000, deltaCents: -24_605, categories: 0 },
  ],
  comparedCents: 185_000,
  consumptionCents: 185_000,
  outsideCents: 0,
  mappedShareBp: 10_000,
  unmapped: [],
  household: { bp: 11_500, prorated: true, children: 1, members: 1 },
  referenceHouseholdBp: null,
  jurisdiction: 'BE',
  source: {
    survey: 'Household Budget Survey (HBS)',
    year: 2024,
    citation: 'Statbel, Household Budget Survey 2024 — structure of household expenditure',
    sourceUrl: 'https://statbel.fgov.be/en/themes/households/household-budget-survey-hbs',
    lastVerified: '2026-09-03',
    status: 'transcribed',
  },
  transcribed: ['source', 'equivalence'],
}

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
  owner: true,
  totals: {
    month: '2026-08',
    incomeCents: 420_000,
    spentCents: 310_000,
    budgetedCents: 350_000,
    toBudgetCents: -25_000,
    fromLastMonthCents: 50_000,
    balanceCents: 90_000,
    savingsRateBp: 2_619,
    // Insurance's direct debit plus a €30 schedule nothing assigns a category to, so
    // the month total is deliberately more than the categories below add up to (#159).
    committedCents: 44_250,
    committedUnallocatedCents: 3_000,
    committedUnallocatedCount: 1,
    committedApproximate: true,
  },
  history: [
    {
      month: '2026-07',
      incomeCents: 420_000,
      spentCents: 300_000,
      budgetedCents: 350_000,
      savingsRateBp: 2_857,
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
      committedCents: 0,
      committedApproximate: false,
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
      committedCents: 0,
      committedApproximate: false,
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
      committedCents: 0,
      committedApproximate: false,
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
      // The case #159 is for: nothing spent, everything assigned, and a direct debit
      // for more than the envelope holds still to come. `approximate` because the
      // schedule states a range and is counted at its upper bound.
      committedCents: 41_250,
      committedApproximate: true,
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
      // The envelope's own balance (-€ 50, same as its `availableCents` above) has
      // no buffer left to give, so the projected overrun would push it further
      // into the red — an alert, not a plain warn.
      severity: 'alert',
      metrics: {
        projectedCents: 84_000,
        assignedCents: 60_000,
        spentCents: 65_000,
        projectedOverrunCents: 24_000,
        monthProgressBp: 7_742,
        availableCents: -5_000,
        projectedAvailableCents: -24_000,
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
    // The fifth overspend signal: money that has not moved yet and will (#159).
    {
      code: 'committed_over_available',
      categoryId: 'cat-insurance',
      categoryName: 'Insurance',
      severity: 'warn',
      metrics: { committedCents: 41_250, availableCents: 40_000, committedShortfallCents: 1_250 },
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
  benchmark: BENCHMARK,
  // Nothing flagged as shared, which is what most budgets look like, so the
  // fixture every other test spreads stays free of a table it is not about (#44).
  custody: { kind: 'unavailable', reason: 'no_shared', paidCents: null },
  uncategorised: { txnCount: 3, amountCents: 12_500 },
  actualConfigured: true,
  goalsByCategory: [
    {
      categoryId: 'cat-groceries',
      goals: [{ id: 'goal-tv', label: 'New TV', progressBp: 4_500, pace: 'atRisk' }],
    },
  ],
}

/** A deployment whose jobs have never run: no months at all. */
const EMPTY: BudgetPayload = {
  freshness: FRESH,
  month: '2026-09',
  months: [],
  owner: true,
  totals: null,
  history: [],
  trendMonths: [],
  categories: [],
  signals: [],
  // Nothing was spent, so there is nothing to compare. This drew nothing at all until
  // #300, on the reasoning that the empty month has its own sentence above — which stopped
  // being true when #230 moved the comparison behind a tab of its own. The same gap one tab
  // over is #280, and looking for that one's siblings is how this was found.
  benchmark: { kind: 'unavailable', reason: 'no_month', mappedShareBp: null },
  // Same reason, one step earlier: nothing was spent, so there is nothing to split — and
  // the same fix, because a tab of its own has nothing else on it either (#280).
  custody: { kind: 'unavailable', reason: 'no_month', paidCents: null },
  uncategorised: null,
  actualConfigured: true,
  goalsByCategory: [],
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

/**
 * A `getByText`/`findByText` matcher for a sentence that carries a `<Money>`: testing
 * library's default matching only concatenates a node's direct text children, so a
 * string that crosses `<Money>`'s span boundary is invisible to a plain string or
 * regex target. `element.textContent` reads the whole subtree instead — the same fix
 * used elsewhere in this suite for text split across elements (see `status.test.tsx`).
 */
const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()

const withMoney = (target: string | RegExp) => {
  // `\s` also matches the non-breaking spaces `Intl.NumberFormat` puts around the
  // figure, which is what the default (single-node) matcher normalises away for free.
  const hits = (element: Element): boolean => {
    const text = normalize(element.textContent ?? '')
    return typeof target === 'string' ? text === target : target.test(text)
  }
  // Reading the whole subtree means every ancestor up to `<body>` matches too, once
  // one descendant does. Excluding any element with a matching descendant leaves only
  // the innermost one, so `getByText` sees a single hit instead of the whole chain.
  const hasMatchingDescendant = (element: Element): boolean =>
    [...element.children].some((child) => hits(child) || hasMatchingDescendant(child))

  return (_content: string, element: Element | null) =>
    element !== null && hits(element) && !hasMatchingDescendant(element)
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
  // Most tests here never set a path and rely on landing on the Overview tab by
  // default; the tab-navigation tests (#230) would otherwise leak that location into
  // whichever test runs next.
  visit('/')
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

  it('prints the totals in Belgian conventions under an English UI', async () => {
    show()

    expect(await screen.findByText('€ 3.100')).toBeTruthy()
    expect(screen.getByText('€ 4.200')).toBeTruthy()
    // The savings rate follows the page's own month/year picker on Budget (#351),
    // which opens on August alone — not the year-summed 27,4% Overview's own copy
    // of this card would show with nothing else to follow.
    expect(screen.getByText('26,2%')).toBeTruthy()
    // Over-assigned, which is a state to act on rather than a smaller number.
    expect(screen.getByText('€ -250')).toBeTruthy()

    // By heading rather than by text: the bullet chart's legend names the same three
    // things, and a bare `getByText('Spent')` matches its SVG label too.
    for (const label of ['Spent', 'Income', 'Left to assign', 'Savings rate', 'Still to come']) {
      expect(screen.getByRole('heading', { name: label, level: 2 })).toBeTruthy()
    }
    // The supporting rows, read off the cards rather than off the page: the bullet
    // chart's money axis prints round euro amounts too, and a tick that happened to
    // land on one of these would make the assertion ambiguous.
    const rows = [...document.querySelectorAll('.metric__row')].map((row) =>
      (row.textContent ?? '').replaceAll('\u00a0', ' '),
    )
    expect(rows).toEqual([
      'Assigned€ 3.500',
      'Available€ 900',
      'From last month€ 500',
      // The month's committed total is not the sum of its categories: one schedule has
      // no category, and it is reported rather than attributed to an envelope (#159).
      'Unassigned€ 30',
    ])
  })

  it('warns that the figures are incomplete while transactions have no category', async () => {
    show()
    await screen.findByText('€ 3.100')

    expect(
      screen.getByText(
        withMoney('3 transactions worth € 125 have no category, so the figures below are incomplete.'),
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
    expect(screen.getByText(withMoney('Projected month end: € 840'))).toBeTruthy()
    expect(screen.getByText(withMoney('Projected overrun € 240'))).toBeTruthy()
    expect(
      screen.getByText(
        'Groceries is on track for € 840,00 this month, against € 600,00 assigned, ' +
          'with € -240,00 left in the envelope by month end.',
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        withMoney('Buffer will not cover this — envelope projected to end at € -240.'),
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
    expect(text).not.toMatch(/\b(metric|chart|pace|picker|empty|findings|time|benchmark)\.[a-zA-Z]/)
  })
})

/**
 * The Statbel card (#43), which is mostly disclosure and is asserted as such.
 *
 * What matters is not that a table appeared but that everything qualifying it appeared
 * with it: which basis the comparison used, how much of the month it covers, how big the
 * household it divided by is, which of that is Balancr's own assumption rather than the
 * survey's, and which figures nobody has checked at the source. Each of those is a
 * sentence somebody could remove without any test failing, and the card would still look
 * right while claiming more than it can support.
 */
describe('the Belgian comparison', () => {
  it('says what it compared, what it divided by, and what nobody has checked', async () => {
    serve(json(FULL))
    renderApp(<Budget />, { path: '/budget/benchmark' })

    expect(await screen.findByText('Compared with Belgian households')).toBeTruthy()

    // The mix basis, in words rather than as a badge: shares against shares, and an
    // explicit sentence that nothing here says whether you spend more than they do.
    expect(
      screen.getByText(withMoney(/How your € 1.850 of August 2026 spending divides/)),
    ).toBeTruthy()
    expect(screen.getByText(/Shares only/)).toBeTruthy()

    // Both mapped lines are far enough above the reference to be named, and the eight
    // lines nothing feeds read as unmapped rather than as spending nothing — those are
    // opposite conclusions and the whole point of that column.
    expect(screen.getAllByText('Above reference')).toHaveLength(2)
    expect(screen.getAllByText('Nothing mapped')).toHaveLength(8)
    expect(screen.queryByText('Below reference')).toBeNull()

    // Literal, because no arithmetic on this page produced them: food's share of the
    // compared total, the reference in euros, and the signed gap.
    expect(screen.getByText('35,1%')).toBeTruthy()
    expect(screen.getByText('€ 259')).toBeTruthy()
    expect(screen.getByText('+151%')).toBeTruthy()

    // How much of the month the comparison covers, said in the same card as the figures.
    expect(
      screen.getByText(withMoney(/100% of your € 1.850 of household spending is mapped/)),
    ).toBeTruthy()

    // The household, all three sentences: the scale figure to two decimals because
    // proration produces one the published scale never does, how many count as children,
    // and that the proration is Balancr's assumption rather than the survey's.
    expect(screen.getByText('You and 1 other person: 1,15 on the equivalence scale.')).toBeTruthy()
    expect(screen.getByText('1 of them counts at the child weight.')).toBeTruthy()
    expect(screen.getByText(/That proration is Balancr's own assumption/)).toBeTruthy()

    // The provenance, and the weaker claim beside it.
    expect(
      screen.getByText(/Statbel, Household Budget Survey 2024 — structure of household/),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'Not yet confirmed at the source: the published shares and the equivalence scale.',
      ),
    ).toBeTruthy()
  })

  it('explains Difference on its own, since it does not follow from the two share columns beside it (#401)', async () => {
    serve(json(FULL))
    renderApp(<Budget />, { path: '/budget/benchmark' })
    await screen.findByText('Compared with Belgian households')

    const header = screen.getByRole('columnheader', { name: /Difference/ })
    fireEvent.click(within(header).getByRole('button', { name: 'More info' }))

    // `BENCHMARK` is a mix comparison, so the mix wording is the one that must appear —
    // the level wording would be a false claim about a euro total this fixture never had.
    expect(screen.getByRole('tooltip').textContent).toBe(
      'This applies their reported share to your own total spending, so it moves with Your share and Their share above — there is no reference total on record to compare euro amounts against.',
    )
  })

  it('switches the Difference hint to the level wording once a reference euro total is on record', async () => {
    serve(json({ ...FULL, benchmark: { ...BENCHMARK, basis: 'level' } }))
    renderApp(<Budget />, { path: '/budget/benchmark' })
    await screen.findByText('Compared with Belgian households')

    const header = screen.getByRole('columnheader', { name: /Difference/ })
    fireEvent.click(within(header).getByRole('button', { name: 'More info' }))

    expect(screen.getByRole('tooltip').textContent).toBe(
      "This compares euro amounts, not shares: it scales the reference household's total to your household's size, so it also carries any gap in how much you spend overall, not only how you split it between groups.",
    )
  })

  it('never raises a difference above information', async () => {
    serve(json(FULL))
    renderApp(<Budget />, { path: '/budget/benchmark' })
    await screen.findByText('Compared with Belgian households')

    // #43 asks for this as context and never as a verdict. Scoped to the card, because
    // the page carries a real warning of its own about uncategorised transactions: what
    // must not appear is a severity *here*, while two lines sit 150% above the reference.
    const card = screen.getByText('Compared with Belgian households').closest('section')
    expect(card).not.toBeNull()
    expect(card?.querySelectorAll('.notice--warn, .notice--error, [role="alert"]')).toHaveLength(0)
    // Nor a tone smuggled in through the state column, which is the one cell that
    // judges. jsdom loads no stylesheet, so what is checkable here is the modifier the
    // cell asks for: four states, none of them a severity. A `--alert` appearing in this
    // list is how the card would start looking like a verdict.
    const states = [...(card?.querySelectorAll('.benchmark__state') ?? [])].map((cell) =>
      cell.className.replace('benchmark__state benchmark__state--', ''),
    )
    expect(new Set(states)).toEqual(new Set(['above', 'unmapped']))
  })

  it('says what is missing and where to fix it when too little is mapped', async () => {
    // The same month with Groceries unmapped: € 1.200 of € 1.850 is 64,86%, under the
    // 70% floor `compare.ts` refuses below. What the card must not do is draw the table
    // anyway — a housing line computed on two thirds of the money is a chart about the
    // mapping.
    serve(
      json({
        ...FULL,
        benchmark: { kind: 'unavailable', reason: 'too_unmapped', mappedShareBp: 6_486 },
      } satisfies BudgetPayload),
    )
    renderApp(<Budget />, { path: '/budget/benchmark' })

    expect(
      await screen.findByText(/Only 64,9% of this month's spending is mapped .* under the 70%/),
    ).toBeTruthy()
    // "Map *more* of your categories": the distinction the shared hint could not make
    // (#300). `no_mapping` has nothing to add to, and telling somebody who has mapped two
    // thirds of their budget to map their categories reads as though none of it counted.
    expect(
      screen.getByText('Map more of your categories to a COICOP division under Settings and the comparison appears here.'),
    ).toBeTruthy()
    expect(screen.queryByText('Compared with Belgian households')).toBeNull()
  })

  it('says so on a month nothing was computed for, where the tab is all there is', async () => {
    // The case #300 was filed about. `UNCOMPUTED` has no categories either, so the guard
    // on the section hid the pane outright — and the empty-month notice lives inside the
    // overview section, which is not on screen from here.
    serve(json(UNCOMPUTED))
    renderApp(<Budget />, { path: '/budget/benchmark' })

    expect(
      await screen.findByText('Nothing has been computed for this month yet, so there is nothing to compare.'),
    ).toBeTruthy()
    expect(screen.getByText('Pick another month, or run a sync to aggregate this one.')).toBeTruthy()
    // Still no table: there is nothing to put in one.
    expect(screen.queryByText('Compared with Belgian households')).toBeNull()
    // And not the hint the shared string used to give every reason, which is the wrong
    // instruction here — nothing is unmapped, the month is simply not computed.
    expect(screen.queryByText(/Map your categories to a COICOP division/)).toBeNull()
  })

  it('sends the reader to the settings panel when the deployment ships no benchmark', async () => {
    // `no_file` is the one reason the reader of a budget page may not be able to act on:
    // it means `BENCHMARK_DIR` has nothing readable for the household's own country, which
    // is a config and a log question. So the box says the comparison is off and names where
    // that is explained,
    // rather than reprinting an operator's file path under a month's figures.
    serve(
      json({
        ...FULL,
        benchmark: { kind: 'unavailable', reason: 'no_file', mappedShareBp: null },
      } satisfies BudgetPayload),
    )
    renderApp(<Budget />, { path: '/budget/benchmark' })

    expect(
      await screen.findByText(
        'This installation has no benchmark to compare against, so no comparison is drawn anywhere.',
      ),
    ).toBeTruthy()
    expect(screen.getByText(/Settings, Benchmark names the file that is expected/)).toBeTruthy()
    // Not the operator detail itself: that lives on the panel this points at, and stating
    // a path and a log location twice is two places to update when either changes.
    expect(screen.queryByText(/be\.yaml/)).toBeNull()
    expect(screen.queryByText(/BENCHMARK_DIR/)).toBeNull()
  })

  it('says nothing is mapped yet, which is not the same as spending nothing', async () => {
    // The fourth reason, and the one the hint was originally written for — kept here so
    // all four are covered in one place after #300 split the hint per reason.
    serve(
      json({
        ...FULL,
        benchmark: { kind: 'unavailable', reason: 'no_mapping', mappedShareBp: 0 },
      } satisfies BudgetPayload),
    )
    renderApp(<Budget />, { path: '/budget/benchmark' })

    expect(
      await screen.findByText(
        "None of this month's spending is mapped to a benchmark group, so there is nothing to compare it against yet.",
      ),
    ).toBeTruthy()
    expect(
      screen.getByText('Map your categories to a COICOP division under Settings and the comparison appears here.'),
    ).toBeTruthy()
  })
})

/**
 * The comparison window (#323, #345), which used to be a control of its own on this
 * card — first a calendar popover with every cell wired to a no-op (until #389), then
 * a plain Month/Year toggle that still read as a second date picker stacked under the
 * page's own. Neither is drawn here any more: the card's window just follows whatever
 * kind the page's own "Month" picker is set to.
 */
describe("the benchmark card's comparison window", () => {
  it('asks for the full year once the page picker turns to Year, with no control of its own', async () => {
    const mock = serve({
      '/api/budget': json(FULL),
      '/api/budget?month=2026-08&benchmarkPeriod=year&custodyPeriod=year': json(FULL),
    })
    renderApp(<Budget />, { path: '/budget/benchmark' })
    await screen.findByText('Compared with Belgian households')

    expect(screen.queryByRole('group', { name: 'Period' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Year' }))

    await waitFor(() =>
      expect(paths(mock)).toContain('/api/budget?month=2026-08&benchmarkPeriod=year&custodyPeriod=year'),
    )
  })
})

/**
 * The custody card (#44, #289), which makes a claim Actual does not: that half of what you
 * paid was never yours — or that the whole cost was twice it.
 *
 * The three things worth failing over are the ones a plausible-looking card gets wrong.
 * The paid column must stay Actual's own figure, on every row and in the total, so the
 * card never disagrees with the envelope table above it; the assumption behind the derived
 * column has to be on screen, because nothing in the data can tell a school fee you paid
 * in full from a bill the co-parent invoiced you for; and the two directions must not
 * print the same numbers, because reading one as the other applies the share twice.
 */
describe('the shared-cost split', () => {
  const SPLIT: CustodyWire = {
    kind: 'ok',
    month: '2026-08',
    basis: 'roster',
    shareBp: 5_000,
    direction: 'whole_invoice',
    members: 1,
    lines: [
      {
        categoryId: 'cat-school',
        categoryName: 'School',
        paidCents: 40_000,
        totalCents: 40_000,
        yoursCents: 20_000,
        otherCents: 20_000,
      },
      {
        categoryId: 'cat-kit',
        categoryName: 'Clothing',
        paidCents: 12_000,
        totalCents: 12_000,
        yoursCents: 6_000,
        otherCents: 6_000,
      },
    ],
    paidCents: 52_000,
    totalCents: 52_000,
    yoursCents: 26_000,
    otherCents: 26_000,
    shareOfSpendBp: 1_677,
  }

  /**
   * The same month on the other arrangement: € 520 left the account and that *was* the
   * household's half, so the cost was € 1.040 and the co-parent settled their € 520
   * themselves. Same share, same paid figure, every derived figure different (#289).
   */
  const GROSSED_UP: CustodyWire = {
    ...SPLIT,
    direction: 'my_share',
    lines: [
      {
        categoryId: 'cat-school',
        categoryName: 'School',
        paidCents: 40_000,
        totalCents: 80_000,
        yoursCents: 40_000,
        otherCents: 40_000,
      },
      {
        categoryId: 'cat-kit',
        categoryName: 'Clothing',
        paidCents: 12_000,
        totalCents: 24_000,
        yoursCents: 12_000,
        otherCents: 12_000,
      },
    ],
    totalCents: 104_000,
    yoursCents: 52_000,
    otherCents: 52_000,
  }

  const withSplit = (custody: CustodyWire): BudgetPayload => ({ ...FULL, custody })

  it('prints Actual\u2019s figure beside your share, and says what it assumed', async () => {
    serve(json(withSplit(SPLIT)))
    renderApp(<Budget />, { path: '/budget/custody' })

    expect(await screen.findByText('Costs shared with a co-parent')).toBeTruthy()
    expect(
      screen.getByText(
        withMoney(/In August 2026 you paid € 520 on costs shared with a co-parent\. € 260 of that is/),
      ),
    ).toBeTruthy()

    // Actual first, yours second — in that order, because the first column is the one
    // that reconciles with the bank.
    const card = screen.getByText('Costs shared with a co-parent').closest('section')
    const headers = [...(card?.querySelectorAll('thead th') ?? [])].map((th) => th.textContent)
    expect(headers).toEqual(['Category', 'You paid', 'Yours'])

    // Largest paid first, both figures per row, and no arithmetic in the browser.
    const cells = (tr: Element): (string | null)[] =>
      [...tr.children].map((cell) => (cell.textContent ?? '').replaceAll('\u00a0', ' '))
    const rows = [...(card?.querySelectorAll('tbody tr') ?? [])].map(cells)
    expect(rows).toEqual([
      ['School', '€ 400', '€ 200'],
      ['Clothing', '€ 120', '€ 60'],
    ])

    // The totals are a footer, and they are the sums of the rows above them: the server
    // rounds per line precisely so this holds.
    const foot = [...(card?.querySelectorAll('tfoot tr') ?? [])].map(cells)
    expect(foot).toEqual([['Total', '€ 520', '€ 260']])

    // The three sentences that qualify the figure: where the share came from, how much of
    // the month it covers, and the assumption the whole column rests on.
    expect(
      screen.getByText(
        'No split has been stated, so this uses the share of the time 1 member is here: 50%.',
      ),
    ).toBeTruthy()
    expect(screen.getByText('Shared costs are 16,8% of what you spent this month.')).toBeTruthy()
    expect(screen.getByText(/This assumes the whole invoice left your account/)).toBeTruthy()
  })

  it('works the total back up when what landed here was already only your part (#289)', async () => {
    serve(json(withSplit(GROSSED_UP)))
    renderApp(<Budget />, { path: '/budget/custody' })

    // The claim the other direction cannot make: what the thing cost, of which this
    // household's books hold half. And the € 520 beside it is a figure nobody owes
    // anybody — the sentence has to say that, or the card reads as an unpaid debt.
    expect(
      await screen.findByText(
        withMoney(
          /In August 2026 you paid € 520 on costs shared with a co-parent — your part of € 1.040 in total/,
        ),
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(/was settled by the other household directly and never reached your account/),
    ).toBeTruthy()

    const card = screen.getByText('Costs shared with a co-parent').closest('section')
    // The second column is a different quantity, so it is a different heading: "Yours"
    // over a grossed-up total would be a lie about the same number.
    const headers = [...(card?.querySelectorAll('thead th') ?? [])].map((th) => th.textContent)
    expect(headers).toEqual(['Category', 'You paid', 'In total'])

    const cells = (tr: Element): (string | null)[] =>
      [...tr.children].map((cell) => (cell.textContent ?? '').replaceAll('\u00a0', ' '))
    expect([...(card?.querySelectorAll('tbody tr') ?? [])].map(cells)).toEqual([
      ['School', '€ 400', '€ 800'],
      ['Clothing', '€ 120', '€ 240'],
    ])
    expect([...(card?.querySelectorAll('tfoot tr') ?? [])].map(cells)).toEqual([
      ['Total', '€ 520', '€ 1.040'],
    ])

    // A gross-up is a weaker claim than a discount and the card says so: the total is
    // inferred from a share somebody typed, not divided out of a figure Actual holds.
    expect(
      screen.getByText(/The total is inferred rather than read: Actual has never held it/),
    ).toBeTruthy()
    // Still a fact about the bank account, so it cannot exceed the month: € 520 of what
    // was actually spent, not € 1.040 of it.
    expect(screen.getByText('Shared costs are 16,8% of what you spent this month.')).toBeTruthy()
  })

  it('says a stated share was stated, rather than implying it was derived', async () => {
    // The distinction #44 asks to be reported: one is somebody's arrangement, the other
    // is Balancr guessing at an arrangement it has never seen.
    serve(json(withSplit({ ...SPLIT, basis: 'stated', shareBp: 6_000, members: 0 })))
    renderApp(<Budget />, { path: '/budget/custody' })

    expect(
      await screen.findByText('The 60% share is the one you stated under Settings, Household.'),
    ).toBeTruthy()
    expect(screen.queryByText(/No split has been stated/)).toBeNull()
  })

  it('never raises a split above information', async () => {
    serve(json(withSplit(SPLIT)))
    renderApp(<Budget />, { path: '/budget/custody' })
    await screen.findByText('Costs shared with a co-parent')

    // Nobody has done anything wrong by paying a bill that gets split, and a red cell is
    // an alert whatever the payload calls it. The matching finding is capped at `info`.
    const card = screen.getByText('Costs shared with a co-parent').closest('section')
    expect(card?.querySelectorAll('.notice--warn, .notice--error, [role="alert"]')).toHaveLength(0)
  })

  it('asks for a share when categories are flagged and nothing implies one', async () => {
    // The one unavailable reason worth a box: the flags say somebody meant this to work.
    serve(json(withSplit({ kind: 'unavailable', reason: 'no_basis', paidCents: 52_000 })))
    renderApp(<Budget />, { path: '/budget/custody' })

    expect(
      await screen.findByText(
        withMoney(/Categories worth € 520 this month are flagged as shared with a co-parent/),
      ),
    ).toBeTruthy()
    expect(screen.getByText(/Add whoever is here part of the time under Settings, Household/))
      .toBeTruthy()
    expect(screen.queryByText('Costs shared with a co-parent')).toBeNull()
  })

  it('says a stated nought is a share it cannot divide by, not a missing one (#289)', async () => {
    // Telling somebody who typed 0 that nothing says what their share is would be the
    // card contradicting the form, so this reason has a box and a hint of its own — and
    // the hint names both ways out, because either could be what they meant.
    serve(json(withSplit({ kind: 'unavailable', reason: 'zero_share', paidCents: 52_000 })))
    renderApp(<Budget />, { path: '/budget/custody' })

    expect(
      await screen.findByText(
        withMoney(/but your stated share is 0\s?% — there is nothing to work the total back up from/),
      ),
    ).toBeTruthy()
    expect(screen.getByText(/if the whole invoice really does land here, switch the direction/))
      .toBeTruthy()
    expect(screen.queryByText('Costs shared with a co-parent')).toBeNull()
  })

  it('says nothing is flagged, and where to flag it, rather than drawing an empty tab', async () => {
    // The ordinary state of most budgets, and the case #280 was filed about: this drew
    // nothing at all, so somebody who clicked the label could not tell opt-in from broken.
    serve(json(FULL))
    renderApp(<Budget />, { path: '/budget/custody' })

    expect(
      await screen.findByText('No category is flagged as shared with a co-parent, so there is nothing to split.'),
    ).toBeTruthy()
    expect(screen.getByText(/Tick Shared beside the categories a co-parent pays part of/)).toBeTruthy()
    // Still no table: there is nothing to put in one.
    expect(screen.queryByText('Costs shared with a co-parent')).toBeNull()
  })

  it('says so on a month nothing was computed for, where the tab is all there is', async () => {
    // No categories either, so the guard on the section used to hide the pane — and the
    // empty-month notice on Overview is not on screen from here (#280). `UNCOMPUTED`
    // rather than `EMPTY`: a deployment with no months at all never reaches the sections.
    serve(json(UNCOMPUTED))
    renderApp(<Budget />, { path: '/budget/custody' })

    expect(
      await screen.findByText('Nothing has been computed for this month yet, so there is nothing to split.'),
    ).toBeTruthy()
    expect(screen.getByText('Pick another month, or run a sync to aggregate this one.')).toBeTruthy()
  })
})

/**
 * The custody card's own comparison window (#345) — no longer a control of its own
 * (see the benchmark describe block above for why): it follows the page's own Month
 * picker, in lockstep with the benchmark card's window rather than independently of it.
 */
describe("the custody card's comparison window", () => {
  const SPLIT: CustodyWire = {
    kind: 'ok',
    month: '2026-08',
    basis: 'roster',
    shareBp: 5_000,
    direction: 'whole_invoice',
    members: 1,
    lines: [
      {
        categoryId: 'cat-school',
        categoryName: 'School',
        paidCents: 40_000,
        totalCents: 40_000,
        yoursCents: 20_000,
        otherCents: 20_000,
      },
    ],
    paidCents: 40_000,
    totalCents: 40_000,
    yoursCents: 20_000,
    otherCents: 20_000,
    shareOfSpendBp: 1_677,
  }
  const withSplit = (custody: CustodyWire): BudgetPayload => ({ ...FULL, custody })

  it('asks for the full year once the page picker turns to Year, with no control of its own', async () => {
    const mock = serve({
      '/api/budget': json(withSplit(SPLIT)),
      '/api/budget?month=2026-08&benchmarkPeriod=year&custodyPeriod=year': json(withSplit(SPLIT)),
    })
    renderApp(<Budget />, { path: '/budget/custody' })
    await screen.findByText('Costs shared with a co-parent')

    expect(screen.queryByRole('group', { name: 'Period' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Year' }))

    await waitFor(() =>
      expect(paths(mock)).toContain('/api/budget?month=2026-08&benchmarkPeriod=year&custodyPeriod=year'),
    )
  })

  it('switches the lede and the share line to year wording once Year is picked', async () => {
    // Same anchor month either way — the server resolved the window, this only checks
    // that the copy follows `period` rather than staying on "this month" (#345).
    const mock = serve({
      '/api/budget': json(withSplit(SPLIT)),
      '/api/budget?month=2026-08&benchmarkPeriod=year&custodyPeriod=year': json(withSplit(SPLIT)),
    })
    renderApp(<Budget />, { path: '/budget/custody' })
    await screen.findByText(withMoney(/In August 2026 you paid € 400 on costs shared with a co-parent\./))
    expect(mock).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Year' }))

    expect(
      await screen.findByText(withMoney(/In 2026 you paid € 400 on costs shared with a co-parent\./)),
    ).toBeTruthy()
    expect(screen.getByText('Shared costs are 16,8% of what you spent this year.')).toBeTruthy()
  })
})

describe('the savings rate follows the page picker (#288, rebuilt for #345 and #351)', () => {
  // `absolutePeriodSavings` reads the real clock to sum a period, so it is pinned to
  // an instant after August — the same reasoning `overview.test.tsx` pins its own copy on.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-02T05:30:00Z'))
  })

  const show = (): void => {
    serve(json(FULL))
    renderApp(<Budget />)
  }

  /** No `.metric__head` to key off since #351 — the card has no control of its own here. */
  const savingsCard = (): Element | null => screen.getByText('Savings rate').closest('.metric')

  const rate = (): string =>
    (savingsCard()?.querySelector('.metric__value')?.textContent ?? '').replaceAll('\u00a0', ' ')

  const note = (): string =>
    (savingsCard()?.querySelector('.metric__note')?.textContent ?? '').replaceAll('\u00a0', ' ')

  /** Drives the page's own month/year picker (#351) — the card no longer has one. */
  const pickMonth = (abbrev: string): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: abbrev }))
  }

  const pickYear = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Year' }))
  }

  it('opens on the page\u2019s own current month, not a year of its own', async () => {
    show()
    await screen.findByText('€ 3.100')

    // August alone, which is the figure `totals.savingsRateBp` also holds: one code
    // path, and the shortest period agreeing with the stored quantity.
    expect(rate()).toBe('26,2%')
    expect(note()).toBe('Over August 2026')
  })

  it('sums the year, and says the span it actually covered, once the page picker turns to Year', async () => {
    // The page's own picker re-asks the server for whatever month a year resolves to,
    // even when that turns out to be the one already on screen (#345) — unlike the
    // card's former picker, which never asked at all (#288). Both paths answer alike.
    serve({ '/api/budget': json(FULL), '/api/budget?month=2026-08': json(FULL) })
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')

    pickYear()

    // Two months exist, and the card says two — the whole reason the span is printed
    // rather than the period name alone.
    await waitFor(() => expect(rate()).toBe('27,4%'))
    expect(note()).toBe('Over 2 months, July 2026 to August 2026')
  })

  it('reads the calendar month before the one on screen', async () => {
    serve({
      '/api/budget': json(FULL),
      '/api/budget?month=2026-07': json({ ...FULL, month: '2026-07' } satisfies BudgetPayload),
    })
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')

    pickMonth('Jul')
    await waitFor(() => expect(rate()).toBe('28,6%'))
    expect(note()).toBe('Over July 2026')
  })

  it('names only the span here, with no caveat and no row, even with money still to come (#397)', async () => {
    // August is the still-open month in this fixture; July already has none. This page's
    // copy of the card carries no explanation of *why* that might still move (#397) and,
    // being `showFlows: false`, no row for the amount either — unlike the Overview copy.
    const withCommitted = {
      ...FULL,
      history: FULL.history.map((entry) =>
        entry.month === '2026-08' ? { ...entry, committedCents: 40_000 } : entry,
      ),
    } satisfies BudgetPayload
    serve(json(withCommitted))
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')

    expect(note()).toBe('Over August 2026')
    expect(savingsCard()?.querySelectorAll('.metric__row').length ?? 0).toBe(0)
  })

  it('says the window is empty rather than printing a figure for no months', async () => {
    // August alone in the history, so July has nothing — and a 0% would be a number
    // somebody would act on.
    const sparse = { ...FULL, history: FULL.history.slice(-1) }
    serve({
      '/api/budget': json(sparse),
      '/api/budget?month=2026-07': json({ ...sparse, month: '2026-07' } satisfies BudgetPayload),
    })
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')

    pickMonth('Jul')
    await waitFor(() => expect(rate()).toBe('Not known yet'))
    expect(note()).toBe('No month with figures in this window')
  })

  it('leaves the flow pair off this page, where two cards already print the month\u2019s', async () => {
    // The same component draws this card on the Overview page *with* the period's summed
    // income and spend, because nothing else there carries a flow. Here the Spent and
    // Income cards are two positions to the left, and a period's pair inside this card
    // would put four figures under two labels covering two different spans (#296).
    show()
    await screen.findByText('€ 3.100')

    expect(savingsCard()?.querySelectorAll('.metric__row').length ?? 0).toBe(0)
  })

  it('has no picker of its own here, only the page-level one it follows (#351)', async () => {
    show()
    await screen.findByText('€ 3.100')

    // A control of its own is what made the figure choosable on Budget in the first
    // place (#351) — the Overview copy of this same component still carries one,
    // because there it has no other picker to follow.
    expect(savingsCard()?.querySelector('.metric__head')).toBeNull()
    expect(document.querySelectorAll('.metric .period-picker').length).toBe(0)
    expect(document.querySelectorAll('.period-picker').length).toBe(1)
  })
})

describe('Spent and Income sum the page picker’s year, too (#355)', () => {
  // `absolutePeriodSavings` reads the real clock, same as the savings-rate describe
  // block above.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-02T05:30:00Z'))
  })

  const metric = (label: string): Element | null =>
    screen.getByRole('heading', { name: label, level: 2 }).closest('.metric')

  const value = (label: string): string =>
    (metric(label)?.querySelector('.metric__value')?.textContent ?? '').replaceAll(' ', ' ')

  const note = (label: string): string =>
    (metric(label)?.querySelector('.metric__note')?.textContent ?? '').replaceAll(' ', ' ')

  const pickYear = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Year' }))
  }

  it('keeps showing one month’s own figures until Year is picked', async () => {
    serve(json(FULL))
    renderApp(<Budget />)

    expect(await screen.findByText('€ 3.100')).toBeTruthy()
    expect(value('Spent')).toBe('€ 3.100')
    expect(value('Income')).toBe('€ 4.200')
    expect(metric('Spent')?.querySelector('.metric__note')).toBeNull()
  })

  it('sums both cards over the months the year actually has, not just the anchor month', async () => {
    // The bug (#355): before this fix, turning the page picker to Year changed which
    // month `totals` answered for, but Spent and Income kept printing that one
    // month's figures instead of the year's — unlike the savings-rate card next to
    // them, which already summed `history` for the same picker.
    serve({ '/api/budget': json(FULL), '/api/budget?month=2026-08': json(FULL) })
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')

    pickYear()

    // July + August: €4.200 + €4.200 income, €3.000 + €3.100 spent.
    await waitFor(() => expect(value('Spent')).toBe('€ 6.100'))
    expect(value('Income')).toBe('€ 8.400')
    const spanText = 'Over 2 months, July 2026 to August 2026'
    expect(note('Spent')).toBe(spanText)
    expect(note('Income')).toBe(spanText)
  })

  it('leaves assigned, available and left-to-assign on the one resolved month even for a year', async () => {
    // Envelope states, not flows — SavingsRate's own header comment is why these never
    // gain a period, and that stays true now that Spent and Income do.
    serve({ '/api/budget': json(FULL), '/api/budget?month=2026-08': json(FULL) })
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')

    pickYear()

    await waitFor(() => expect(value('Spent')).toBe('€ 6.100'))
    const rows = [...document.querySelectorAll('.metric__row')].map((row) =>
      (row.textContent ?? '').replaceAll(' ', ' '),
    )
    expect(rows).toEqual([
      'Assigned€ 3.500',
      'Available€ 900',
      'From last month€ 500',
      'Unassigned€ 30',
    ])
  })

  it('says the window is empty rather than printing a figure for no months', async () => {
    // FULL's own month is already August, and picking Year while August is the anchor
    // still resolves to August (#345) — Jan–Aug has to have nothing in `history` at
    // all for the window to come up empty, not just July.
    const sparse = { ...FULL, history: [] }
    serve({ '/api/budget': json(sparse), '/api/budget?month=2026-08': json(sparse) })
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')

    pickYear()

    await waitFor(() => expect(value('Spent')).toBe('Not known yet'))
    expect(value('Income')).toBe('Not known yet')
    expect(note('Spent')).toBe('No month with figures in this window')
  })
})

describe('the section tabs (#230)', () => {
  it('marks the open tab current, and lands on Overview for a path it does not recognise', async () => {
    serve(json(FULL))
    const benchmark = renderApp(<Budget />, { path: '/budget/benchmark' })
    await screen.findByText('Compared with Belgian households')

    expect(screen.getByRole('link', { name: 'Benchmark' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBeNull()
    benchmark.unmount()

    renderApp(<Budget />, { path: '/budget/nonsense' })
    await screen.findByText('€ 3.100')
  })

  it('has its own Notes tab, separate from Overview (#270)', async () => {
    serve(json(FULL))
    renderApp(<Budget />, { path: '/budget/notes' })
    await screen.findByLabelText('Note for August 2026')

    expect(screen.getByRole('link', { name: 'Notes' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByText('€ 3.100')).toBeNull()
  })
})

describe('the month picker', () => {
  const openMonthPicker = (): HTMLElement => {
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    return screen.getByRole('dialog')
  }

  it('greys out every month with no data, and re-asks the server for the one chosen', async () => {
    const mock = serve(json(FULL))
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')

    const dialog = openMonthPicker()
    const enabled = (name: string): boolean =>
      !(within(dialog).getByRole('button', { name }) as HTMLButtonElement).disabled
    expect(enabled('Jun')).toBe(true)
    expect(enabled('Jul')).toBe(true)
    expect(enabled('Aug')).toBe(true)
    expect(enabled('May')).toBe(false)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Jul' }))
    await waitFor(() => {
      expect(paths(mock)).toEqual(['/api/budget', '/api/budget?month=2026-07'])
    })
  })

  it('stays visible with only one month to pick, and greys out the rest', async () => {
    serve(json({ ...FULL, months: ['2026-08'] } satisfies BudgetPayload))
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')

    const dialog = openMonthPicker()
    expect((within(dialog).getByRole('button', { name: 'Aug' }) as HTMLButtonElement).disabled).toBe(false)
    expect((within(dialog).getByRole('button', { name: 'Jul' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('stands aside on the Notes tab, which has a month control of its own (#281)', async () => {
    // Two controls for one concept, and this one could only ever look broken: the panel
    // takes the month as an initial value and does not follow it afterwards, so choosing
    // here left the note on screen untouched.
    serve(json(FULL))
    renderApp(<Budget />, { path: '/budget/notes' })
    await screen.findByLabelText('Note for August 2026')

    // MonthNote's own Month/Year toggle also has a "Month" button, so this checks for
    // the page-level trigger specifically, by its id.
    expect(document.getElementById('budget-month')).toBeNull()
    expect(screen.getByLabelText('Previous month')).toBeTruthy()
  })

  it('still hands the month it chose to the Notes tab as the note that opens (#281)', async () => {
    // The handoff the initial-value prop exists for, and the reason the picker is hidden
    // on that tab rather than the two months decoupled: pick July here, open Notes, and
    // July's note is what is being edited.
    serve({
      '/api/budget': json(FULL),
      '/api/budget?month=2026-07': json({ ...FULL, month: '2026-07' } satisfies BudgetPayload),
      '/api/budget/note?month=2026-07': json({ text: 'Two annual bills landed together.' }),
    })
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')

    const dialog = openMonthPicker()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Jul' }))
    // The month on screen is the server's answer, not the picker's own value, so the
    // refetch has to land before the tab switch means anything.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Month' }).textContent).toContain('July 2026')
    })
    fireEvent.click(screen.getByRole('link', { name: 'Notes' }))

    expect(await screen.findByLabelText('Note for July 2026')).toBeTruthy()
    expect(screen.getByDisplayValue('Two annual bills landed together.')).toBeTruthy()
    expect(document.getElementById('budget-month')).toBeNull()
  })
})

describe('the month note', () => {
  const noteBox = (): HTMLTextAreaElement => screen.getByLabelText('Note for August 2026') as HTMLTextAreaElement

  const saveNote = (): HTMLButtonElement =>
    within(noteBox().closest('form') ?? document.body).getByRole('button', { name: 'Save' }) as HTMLButtonElement

  const stepNext = (): HTMLButtonElement => screen.getByRole('button', { name: 'Next month' }) as HTMLButtonElement

  it('reads the stored note for the month on screen', async () => {
    const mock = serve({
      '/api/budget': json(FULL),
      '/api/budget/note?month=2026-08': json({ text: 'Replaced the dishwasher this month.' }),
    })
    renderApp(<Budget />, { path: '/budget/notes' })

    expect(await screen.findByDisplayValue('Replaced the dishwasher this month.')).toBe(noteBox())
    expect(mock.mock.calls.map((call) => String(call[0]))).toContain('/api/budget/note?month=2026-08')
  })

  it('has nothing to save until the box is touched', async () => {
    serve({
      '/api/budget': json(FULL),
      '/api/budget/note?month=2026-08': json({ text: '' }),
    })
    renderApp(<Budget />, { path: '/budget/notes' })
    await screen.findByLabelText('Note for August 2026')

    expect(saveNote().disabled).toBe(true)
  })

  it('sends the typed note, trimmed', async () => {
    const mock = serve({
      '/api/budget': json(FULL),
      '/api/budget/note?month=2026-08': json({ text: '' }),
      '/api/budget/note': json({ text: 'Replaced the dishwasher this month.' }),
    })
    renderApp(<Budget />, { path: '/budget/notes' })
    await screen.findByLabelText('Note for August 2026')

    fireEvent.change(noteBox(), { target: { value: '  Replaced the dishwasher this month.  ' } })
    expect(saveNote().disabled).toBe(false)
    fireEvent.click(saveNote())

    await waitFor(() => {
      const patchCall = mock.mock.calls.find((call) => String(call[0]) === '/api/budget/note')
      expect(patchCall).toBeDefined()
      const init = patchCall?.[1] as RequestInit
      expect(init.method).toBe('PATCH')
      expect(JSON.parse(String(init.body))).toEqual({
        month: '2026-08',
        text: 'Replaced the dishwasher this month.',
      })
    })
  })

  it('is disabled for a viewer', async () => {
    serve({
      '/api/budget': json({ ...FULL, owner: false } satisfies BudgetPayload),
      '/api/budget/note?month=2026-08': json({ text: '' }),
    })
    renderApp(<Budget />, { path: '/budget/notes' })
    await screen.findByLabelText('Note for August 2026')

    expect(screen.getByText('Only the owner can change this.')).toBeTruthy()
    expect(noteBox().disabled).toBe(true)
    expect(saveNote().disabled).toBe(true)
  })

  it('keeps the month stepper blocked until an unsaved edit is saved (#268)', async () => {
    serve({
      '/api/budget': json(FULL),
      '/api/budget/note?month=2026-08': json({ text: '' }),
      '/api/budget/note': json({ text: 'Replaced the dishwasher this month.' }),
      '/api/budget/note?month=2026-09': json({ text: '' }),
    })
    renderApp(<Budget />, { path: '/budget/notes' })
    await screen.findByLabelText('Note for August 2026')

    fireEvent.change(noteBox(), { target: { value: 'Replaced the dishwasher this month.' } })
    expect(stepNext().disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Year' }).hasAttribute('disabled')).toBe(true)

    fireEvent.click(saveNote())
    await waitFor(() => {
      expect(stepNext().disabled).toBe(false)
    })
    expect(screen.getByRole('button', { name: 'Year' }).hasAttribute('disabled')).toBe(false)
  })
})

describe('a month nobody computed', () => {
  it('says so, keeps the picker, and draws no charts', async () => {
    serve(json(UNCOMPUTED))
    renderApp(<Budget />)

    expect(await screen.findByText('Nothing has been computed for May 2026 yet.')).toBeTruthy()
    expect(screen.getByText('Pick another month, or run a sync to aggregate this one.')).toBeTruthy()

    // Still navigable — the way out of a stale bookmark is the picker, which opens on
    // the month on screen (greyed out, since it has no data) beside the months that do.
    expect(screen.getByRole('button', { name: 'Month' }).textContent).toContain('May 2026')
    fireEvent.click(screen.getByRole('button', { name: 'Month' }))
    const dialog = screen.getByRole('dialog')
    expect((within(dialog).getByRole('button', { name: 'May' }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(dialog).getByRole('button', { name: 'Jun' }) as HTMLButtonElement).disabled).toBe(false)
    expect((within(dialog).getByRole('button', { name: 'Jul' }) as HTMLButtonElement).disabled).toBe(false)
    expect((within(dialog).getByRole('button', { name: 'Aug' }) as HTMLButtonElement).disabled).toBe(false)

    // Not an error, and not four empty charts either.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryAllByRole('img')).toHaveLength(0)
  })
})

describe('a tenant with no Actual connection (#370)', () => {
  it('shows the not-configured notice, linking to Settings, instead of any figures', async () => {
    serve(json({ ...FULL, actualConfigured: false }))
    renderApp(<Budget />)

    expect(await screen.findByText("Actual isn't connected")).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Go to Settings → Integrations' }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/settings/integrations')

    // Not the ordinary "no data" empty state, and none of the real figures either.
    expect(screen.queryByText('No data yet')).toBeNull()
    expect(screen.queryAllByRole('img')).toHaveLength(0)
  })
})
