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
import type { Budget as BudgetPayload, CustodyWire, Freshness } from '../src/shared.ts'
import { i18nReady, renderApp } from './helpers.tsx'

const FRESH: Freshness = { stale: false, asOf: null, jobsEnabled: true, jobs: [] }

/** The window every `trendCents` is indexed by. Three months keeps the fixture readable. */
const TREND_MONTHS = ['2026-06', '2026-07', '2026-08']

/**
 * The Statbel comparison for `FULL`, on `FULL`'s own money.
 *
 * Every figure here is what `compareToBenchmark` produces from the two spending
 * categories above and the shipped `config/statbel-benchmark.yaml`, written out rather
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
  benchmark: BENCHMARK,
  // Nothing flagged as shared: the card draws nothing at all in that case, so the
  // fixture every other test spreads stays free of a table it is not about (#44).
  custody: { kind: 'unavailable', reason: 'no_shared', paidCents: null },
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
  // Nothing was spent, so there is nothing to compare — and the card renders nothing at
  // all for this reason rather than a box saying so, because the empty month already has
  // its own sentence above.
  benchmark: { kind: 'unavailable', reason: 'no_month', mappedShareBp: null },
  // Same reason, one step earlier: nothing was spent, so there is nothing to split.
  custody: { kind: 'unavailable', reason: 'no_month', paidCents: null },
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
    renderApp(<Budget />)

    expect(await screen.findByText('Compared with Belgian households')).toBeTruthy()

    // The mix basis, in words rather than as a badge: shares against shares, and an
    // explicit sentence that nothing here says whether you spend more than they do.
    expect(screen.getByText(/How your € 1.850 of August 2026 spending divides/)).toBeTruthy()
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
    expect(screen.getByText(/100% of your € 1.850 of household spending is mapped/)).toBeTruthy()

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

  it('never raises a difference above information', async () => {
    serve(json(FULL))
    renderApp(<Budget />)
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
    renderApp(<Budget />)

    expect(
      await screen.findByText(/Only 64,9% of this month's spending is mapped .* under the 70%/),
    ).toBeTruthy()
    expect(
      screen.getByText('Map your categories to a COICOP division under Settings and the comparison appears here.'),
    ).toBeTruthy()
    expect(screen.queryByText('Compared with Belgian households')).toBeNull()
  })

  it('draws nothing at all for a month with no spending in it', async () => {
    serve(json(UNCOMPUTED))
    renderApp(<Budget />)
    await screen.findByText('Nothing has been computed for May 2026 yet.')

    // `no_month` and `no_file` are both supported states rather than problems, and a box
    // on every budget page saying so would be noise on a page that already says the month
    // is empty. Asserted through the card's own sentences rather than through the notice
    // classes, because the empty month has a notice of its own two lines up.
    expect(screen.queryByText('Compared with Belgian households')).toBeNull()
    expect(screen.queryByText(/Map your categories to a COICOP division/)).toBeNull()
  })
})

/**
 * The custody card (#44), which makes a claim Actual does not: that half of what you paid
 * was never yours.
 *
 * The two things worth failing over are the ones a plausible-looking card gets wrong. The
 * paid column must stay Actual's own figure, on every row and in the total, so the card
 * never disagrees with the envelope table above it; and the assumption behind the borne
 * column has to be on screen, because nothing in the data can tell a school fee you paid
 * in full from a bill the co-parent invoiced you for.
 */
describe('the shared-cost split', () => {
  const SPLIT: CustodyWire = {
    kind: 'ok',
    month: '2026-08',
    basis: 'roster',
    shareBp: 5_000,
    members: 1,
    lines: [
      { categoryId: 'cat-school', categoryName: 'School', paidCents: 40_000, borneCents: 20_000 },
      { categoryId: 'cat-kit', categoryName: 'Clothing', paidCents: 12_000, borneCents: 6_000 },
    ],
    paidCents: 52_000,
    borneCents: 26_000,
    offsetCents: 26_000,
    shareOfSpendBp: 1_677,
  }

  const withSplit = (custody: CustodyWire): BudgetPayload => ({ ...FULL, custody })

  it('prints Actual\u2019s figure beside your share, and says what it assumed', async () => {
    serve(json(withSplit(SPLIT)))
    renderApp(<Budget />)

    expect(await screen.findByText('Costs shared with a co-parent')).toBeTruthy()
    expect(
      screen.getByText(
        /In August 2026 you paid € 520 on costs shared with a co-parent\. € 260 of that is/,
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

  it('says a stated share was stated, rather than implying it was derived', async () => {
    // The distinction #44 asks to be reported: one is somebody's arrangement, the other
    // is Balancr guessing at an arrangement it has never seen.
    serve(json(withSplit({ ...SPLIT, basis: 'stated', shareBp: 6_000, members: 0 })))
    renderApp(<Budget />)

    expect(
      await screen.findByText('The 60% share is the one you stated under Settings, Household.'),
    ).toBeTruthy()
    expect(screen.queryByText(/No split has been stated/)).toBeNull()
  })

  it('never raises a split above information', async () => {
    serve(json(withSplit(SPLIT)))
    renderApp(<Budget />)
    await screen.findByText('Costs shared with a co-parent')

    // Nobody has done anything wrong by paying a bill that gets split, and a red cell is
    // an alert whatever the payload calls it. The matching finding is capped at `info`.
    const card = screen.getByText('Costs shared with a co-parent').closest('section')
    expect(card?.querySelectorAll('.notice--warn, .notice--error, [role="alert"]')).toHaveLength(0)
  })

  it('asks for a share when categories are flagged and nothing implies one', async () => {
    // The one unavailable reason worth a box: the flags say somebody meant this to work.
    serve(json(withSplit({ kind: 'unavailable', reason: 'no_basis', paidCents: 52_000 })))
    renderApp(<Budget />)

    expect(
      await screen.findByText(
        /Categories worth € 520 this month are flagged as shared with a co-parent/,
      ),
    ).toBeTruthy()
    expect(screen.getByText(/Add whoever is here part of the time under Settings, Household/))
      .toBeTruthy()
    expect(screen.queryByText('Costs shared with a co-parent')).toBeNull()
  })

  it('draws nothing when nothing is flagged, and nothing for an empty month', async () => {
    // The ordinary state of most budgets. A card explaining an absence nobody asked about
    // is noise, and the empty month already has a notice of its own.
    serve(json(FULL))
    renderApp(<Budget />)
    await screen.findByText('€ 3.100')
    expect(screen.queryByText('Costs shared with a co-parent')).toBeNull()
    expect(screen.queryByText(/are flagged as shared with a co-parent/)).toBeNull()
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
