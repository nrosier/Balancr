/**
 * The portfolio page: two figures, two charts and a table of positions.
 *
 * What is worth asserting is what the page decides on its own, since jsdom draws the
 * charts and an assertion on an SVG path would be a test of ECharts:
 *
 *  - **Quantity is the provider's own string, formatted and not parsed.** The fixture
 *    carries `0.12345678` and `1.50`, which is where a page that ran the value through
 *    a float or a fixed precision would show itself.
 *  - **Weight is the one figure the page computes**, and a total of zero has to yield
 *    no weight rather than a division. The others are literal strings from the payload,
 *    so a page that recomputed a share would still render something plausible.
 *  - **A missing name falls back to the identity the row already has**, never to an
 *    empty cell — a nameless row is still a position worth money.
 *  - **An empty portfolio is not a failure**, and a portfolio worth nothing on paper is
 *    not an empty portfolio: the two states read differently on purpose.
 *
 * The charts are checked through their accessible summaries, which is the same text a
 * screen reader gets and the only part of a chart that states figures in words.
 *
 * jsdom reports every element as zero-sized, so this file lends the charts a size the
 * way `budget.test.tsx` does — not to assert geometry, but to keep ECharts' "Can't get
 * DOM width or height" warning out of output that is about something else.
 */
import { screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Portfolio } from '../src/pages/Portfolio.tsx'
import { formatQuantity } from '../src/ui/HoldingsTable.tsx'
import type { Advice, Freshness, Portfolio as PortfolioPayload } from '../src/shared.ts'
import { i18nReady, renderApp, visit } from './helpers.tsx'

/**
 * Every Unicode space separator, normalised to a plain one.
 *
 * `Intl` groups thousands and separates a currency symbol with a non-breaking space,
 * and which one — U+00A0 or the narrow U+202F — is the runtime's choice and not a
 * decision this file should encode. Matching the class means an ICU update that
 * changes the separator does not fail a test about market values.
 */
const SPACES = /\p{Zs}/gu

const FRESH: Freshness = { stale: false, asOf: null, jobsEnabled: true, jobs: [] }

const FULL: PortfolioPayload = {
  freshness: FRESH,
  date: '2026-09-01',
  // The three holdings, summed by the server. Round on purpose: a reader checking
  // this fixture by hand should not have to trust a rounding.
  totalValueCents: 5_000_000,
  // All of it in positions: the ordinary case, and the one where the split has
  // nothing to say beyond repeating the total.
  investedValueCents: 5_000_000,
  cashValueCents: 0,
  twrBp: 742,
  allocation: [
    { assetClass: 'EQUITY', valueCents: 3_800_000, shareBp: 7_600 },
    { assetClass: 'unknown', valueCents: 700_000, shareBp: 1_400 },
    { assetClass: 'FIXED_INCOME', valueCents: 500_000, shareBp: 1_000 },
  ],
  holdings: [
    {
      instrument: 'IE00B4L5Y983',
      symbol: 'IWDA.AS',
      isin: 'IE00B4L5Y983',
      name: 'iShares Core MSCI World',
      // A trailing zero the provider sent, which prints as `400` and not `400,00`.
      quantity: '400.00',
      priceCents: 9_500,
      priceCurrency: 'EUR',
      valueCents: 3_800_000,
      currency: 'EUR',
    },
    {
      instrument: 'BTC',
      symbol: 'BTC',
      isin: null,
      // No name: the row falls back to the identity it already has.
      name: null,
      // Eight decimals, which is a real quantity and not a rounding artefact.
      quantity: '0.12345678',
      priceCents: 5_670_000,
      // Quoted in dollars, which is what Ghostfolio reports for crypto — while the
      // value beside it is already converted. One row, two currencies, which is the
      // whole reason `priceCurrency` exists.
      priceCurrency: 'USD',
      valueCents: 700_000,
      currency: 'EUR',
    },
    {
      instrument: 'BE0974293251',
      symbol: null,
      isin: 'BE0974293251',
      name: 'Anheuser-Busch InBev',
      quantity: '100',
      priceCents: 5_000,
      priceCurrency: 'EUR',
      valueCents: 500_000,
      currency: 'EUR',
    },
  ],
  history: [
    { date: '2026-08-01', totalCents: 4_200_000 },
    { date: '2026-09-01', totalCents: 5_000_000 },
  ],
  advice: null,
}

/** Nothing has ever been snapshotted. */
const EMPTY: PortfolioPayload = {
  freshness: FRESH,
  date: null,
  totalValueCents: null,
  investedValueCents: null,
  cashValueCents: null,
  twrBp: null,
  allocation: [],
  holdings: [],
  history: [],
  advice: null,
}

/**
 * The same positions with € 5.000 sitting in the broker's cash account.
 *
 * The figures are the server's, and the point of the fixture is that they do *not*
 * all agree: the total is € 55.000, the allocation still adds up to € 50.000, and
 * the difference is a bank balance a syncing tool wrote into Ghostfolio. A page that
 * treated the allocation as a picture of the total would put equities at 69% here
 * instead of the 76% the server computed over the invested half.
 */
const MIXED: PortfolioPayload = {
  ...FULL,
  totalValueCents: 5_500_000,
  investedValueCents: 5_000_000,
  cashValueCents: 500_000,
  holdings: [
    ...FULL.holdings,
    {
      // Ghostfolio reports the broker's cash as a holding of the currency itself,
      // one unit priced at the balance. It is in the table because it is money the
      // account holds; it is out of the allocation because cash is not an asset
      // class you chose.
      instrument: 'EUR',
      symbol: 'EUR',
      isin: null,
      name: 'Cash EUR',
      quantity: '1',
      priceCents: 500_000,
      priceCurrency: 'EUR',
      valueCents: 500_000,
      currency: 'EUR',
    },
  ],
}

/**
 * A beurstaks line as `estimateTrade` produces one: a rate, a base, and who says so.
 *
 * Written out rather than imported from the domain, because the point of these tests is
 * that the page renders what the *wire* carries — snake_case fields and all — and a
 * fixture built by calling the estimator would pass even if the schema and the page had
 * drifted apart. 0,12% of € 10.000 is € 12,00, which is arithmetic a reader can check.
 */
const BUY_TAX: NonNullable<Advice['suggestions'][number]['tax']> = {
  lines: [
    {
      rule: 'tob',
      amount_cents: 1_200,
      basis: {
        rate_bp: 12,
        base_cents: 1_000_000,
        cap_cents: 400_000,
        capped: false,
        citation: 'WDRT art. 120',
        last_verified: '2026-01-15',
        status: 'confirmed',
        effective_from: '2025-01-01',
      },
      assumptions: [],
    },
  ],
  total_cents: 1_200,
  total_min_cents: 1_200,
  total_max_cents: 1_200,
  complete: true,
  transcribed: [],
  effective_from: '2025-01-01',
  last_verified: '2026-01-15',
}

/** The same rule on the sale, still transcribed — which is what raises the caveat. */
const SELL_TAX: NonNullable<Advice['suggestions'][number]['tax']> = {
  ...BUY_TAX,
  lines: [
    {
      ...BUY_TAX.lines[0]!,
      amount_cents: 660,
      basis: { ...BUY_TAX.lines[0]!.basis!, base_cents: 550_000, status: 'transcribed' },
    },
  ],
  total_cents: 660,
  total_min_cents: 660,
  total_max_cents: 660,
  transcribed: ['tob'],
}

/**
 * The advice for `FULL`, computed by hand against the invested € 50.000.
 *
 * Every figure here is one the server would have produced, and they are worth checking
 * by hand because the page must not recompute any of them: equities are 7.600 bp of the
 * invested value against a 7.500 ceiling, so 100 bp outside; bonds are 1.000 bp against
 * a 2.000 floor, so 1.000 bp outside and € 10.000 short of the 3.000 bp target.
 *
 * The bands are the balanced preset with a floor added under property, which is why
 * `isPreset` is false — and it makes property a third line outside its band whose € 2.500
 * correction falls under the € 3.000 minimum trade. So one fixture carries all four
 * outcomes at once: a sale, a purchase, a line suppressed by a threshold, and a class
 * Ghostfolio holds that the profile has no band for.
 */
const ADVICE: Advice = {
  profile: 'balanced',
  isPreset: false,
  toleranceBp: 50,
  minTradeCents: 300_000,
  drift: {
    investedValueCents: 5_000_000,
    worstOutsideBp: 1_000,
    // Worst first, in the server's own order. The page does not re-sort.
    lines: [
      {
        assetClass: 'FIXED_INCOME',
        valueCents: 500_000,
        shareBp: 1_000,
        minBp: 2_000,
        targetBp: 3_000,
        maxBp: 4_000,
        driftBp: -2_000,
        state: 'below',
        outsideBp: 1_000,
        gapCents: 1_000_000,
      },
      {
        assetClass: 'REAL_ESTATE',
        valueCents: 0,
        shareBp: 0,
        minBp: 500,
        targetBp: 500,
        maxBp: 1_500,
        driftBp: -500,
        state: 'below',
        outsideBp: 500,
        gapCents: 250_000,
      },
      {
        assetClass: 'EQUITY',
        valueCents: 3_800_000,
        shareBp: 7_600,
        minBp: 5_500,
        targetBp: 6_500,
        maxBp: 7_500,
        driftBp: 1_100,
        state: 'above',
        outsideBp: 100,
        gapCents: -550_000,
      },
      {
        assetClass: 'COMMODITY',
        valueCents: 0,
        shareBp: 0,
        minBp: 0,
        targetBp: 0,
        maxBp: 1_000,
        driftBp: 0,
        state: 'inside',
        outsideBp: 0,
        gapCents: 0,
      },
    ],
    unmapped: [{ assetClass: 'unknown', valueCents: 700_000, shareBp: 1_400 }],
  },
  suggestions: [
    {
      action: 'buy',
      assetClass: 'FIXED_INCOME',
      amountCents: 1_000_000,
      funding: 'paired',
      reason: {
        assetClass: 'FIXED_INCOME',
        valueCents: 500_000,
        shareBp: 1_000,
        minBp: 2_000,
        targetBp: 3_000,
        maxBp: 4_000,
        driftBp: -2_000,
        state: 'below',
        outsideBp: 1_000,
        gapCents: 1_000_000,
      },
      fund: {
        isin: 'IE00B3F81R35',
        name: 'iShares Core Euro Aggregate Bond',
        terPercent: 0.09,
        alternatives: 2,
      },
      position: null,
      tax: BUY_TAX,
      taxOmits: [],
    },
    {
      action: 'sell',
      assetClass: 'EQUITY',
      amountCents: 550_000,
      funding: 'paired',
      reason: {
        assetClass: 'EQUITY',
        valueCents: 3_800_000,
        shareBp: 7_600,
        minBp: 5_500,
        targetBp: 6_500,
        maxBp: 7_500,
        driftBp: 1_100,
        state: 'above',
        outsideBp: 100,
        gapCents: -550_000,
      },
      fund: null,
      position: {
        isin: 'IE00B4L5Y983',
        name: 'iShares Core MSCI World',
        valueCents: 3_800_000,
        alternatives: 1,
      },
      tax: SELL_TAX,
      taxOmits: ['capital_gains'],
    },
  ],
  skipped: [
    {
      assetClass: 'REAL_ESTATE',
      outsideBp: 500,
      amountCents: 250_000,
      reason: 'below_min_trade',
    },
  ],
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function serve(reply: Response | Error): ReturnType<typeof vi.fn> {
  const mock = vi.fn(() =>
    reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply.clone()),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

/** Every chart's accessible summary, with `Intl`'s non-breaking spaces normalised. */
const summaries = (): string[] =>
  screen
    .getAllByRole('img')
    .map((chart) => (chart.getAttribute('aria-label') ?? '').replace(SPACES, ' '))

/**
 * The big figure on one metric card, found by that card's own heading.
 *
 * Two cards can honestly carry the same amount — a portfolio with nothing idle has a
 * total and an invested figure that agree — so a query by text alone stops being able
 * to say which card it read, and starts failing on the agreement rather than on a bug.
 */
function metric(name: string): string {
  const heading = screen.getByRole('heading', { level: 2, name })
  const value = heading.parentElement?.querySelector('.metric__value')
  return (value?.textContent ?? '').replace(SPACES, ' ')
}

/** One row's cells as text, found by the name in its row header. */
function row(name: string): string[] {
  const header = screen.getByRole('rowheader', { name })
  const cells = header.closest('tr')?.querySelectorAll('th, td') ?? []
  return [...cells].map((cell) => (cell.textContent ?? '').replace(SPACES, ' '))
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
  // Most tests here never set a path and rely on landing on the overview tab by
  // default; the few that navigate elsewhere (#229) would otherwise leak that
  // location into whichever test runs next.
  visit('/')
})

describe('before and instead of an answer', () => {
  it('heads the page while it waits', () => {
    serve(json(FULL))
    renderApp(<Portfolio />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Portfolio')
    expect(screen.getByRole('status').textContent).toBe('Loading…')
  })

  it('offers a retry when the server cannot be reached', async () => {
    serve(new TypeError('fetch failed'))
    renderApp(<Portfolio />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Balancr could not be reached.')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('asks for a sync rather than drawing an empty table when nothing is stored', async () => {
    serve(json(EMPTY))
    renderApp(<Portfolio />)

    expect(await screen.findByText('No data yet')).toBeTruthy()
    // Nothing failed; there is simply nothing yet.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('is not empty just because the portfolio is worth nothing', async () => {
    // A real distinction: someone who sold everything has a history and holdings of
    // zero, and telling them to configure Ghostfolio would be wrong.
    serve(json({ ...EMPTY, date: '2026-09-01', totalValueCents: 0 }))
    renderApp(<Portfolio />)

    expect(await screen.findByText('Market value')).toBeTruthy()
    // `empty.noData` also labels each card's own fallback, so the hint — which only
    // the empty state renders — is what tells the two apart.
    expect(screen.queryByText(/Run a sync|nog geen/i)).toBeNull()
  })
})

describe('a portfolio with positions in it', () => {
  const show = (): void => {
    serve(json(FULL))
    renderApp(<Portfolio />)
  }

  it('reads the total and the return from the payload', async () => {
    show()

    // By heading, not by text: `portfolio:metric.value` labels the metric card *and*
    // the table's value column, and only one of them is a heading.
    await screen.findByRole('heading', { level: 2, name: 'Market value' })

    // Whole euro on the total; the decimals and the sign are the server's.
    expect(metric('Market value')).toBe('€ 50.000')
    // One decimal, which is `formatBp`'s ceiling for every percentage in the app.
    expect(metric('Time-weighted return')).toBe('7,4%')
  })

  it('dates the total from the snapshot rather than from today', async () => {
    show()
    expect(await screen.findByText('Updated 01/09/2026')).toBeTruthy()
  })

  it('speaks both charts, naming the series the page asked for', async () => {
    show()
    // Both charts live on Overview; waiting for them both to have spoken (rather than
    // for a table, which is on its own tab (#229) now) is what settles the render.
    await screen.findAllByRole('img')

    const spoken = summaries()
    // The value series says "market value", not "net worth": one chart, two subjects.
    expect(spoken.some((text) => text.startsWith('Market value between'))).toBe(true)
    expect(spoken.some((text) => text.includes('01/08/2026') && text.includes('€ 42.000'))).toBe(
      true,
    )
    // The treemap names its largest slice and that slice's share, both server-computed.
    expect(spoken.some((text) => text.includes('Equities') && text.includes('76%'))).toBe(true)
  })
})

describe('the holdings table (#229)', () => {
  const show = (payload: PortfolioPayload = FULL): void => {
    serve(json(payload))
    renderApp(<Portfolio />, { path: '/portfolio/holdings' })
  }

  it('captions the table with how many rows there are and how they are ordered', async () => {
    show()
    const table = await screen.findByRole('table')
    expect(table.querySelector('caption')?.textContent).toBe('3 holdings, largest first.')
  })

  it('prints the quantity the provider sent, neither padded nor rounded', async () => {
    show()
    await screen.findByRole('table')

    // Eight decimals kept; a parse-then-fixed-precision path would show 0,12 here.
    expect(row('BTC')[2]).toBe('0,12345678')
    // The provider's trailing zeros drop: precision is capped, never padded.
    expect(row('iShares Core MSCI World')[2]).toBe('400')
  })

  it('falls back to the identity a nameless row already has', async () => {
    show()
    await screen.findByRole('table')
    // Its own symbol in both the label and the ISIN column: it has no name and no
    // ISIN, and an empty cell would read as a rendering failure rather than as a
    // position identified by something else.
    expect(row('BTC')[0]).toBe('BTC')
    expect(row('BTC')[1]).toBe('BTC')
  })

  it('shows a weight per row as a share of the total the server sent', async () => {
    show()
    await screen.findByRole('table')

    // 3.800.000 of 5.000.000 — the one arithmetic on the page.
    expect(row('iShares Core MSCI World')[5]).toBe('76%')
    expect(row('Anheuser-Busch InBev')[5]).toBe('10%')
  })

  it('keeps the cents on a price and drops them on a value', async () => {
    show()
    await screen.findByRole('table')

    // Cents on a € 95,00 unit price are the difference between two funds; cents on
    // a € 38.000 position are noise.
    expect(row('iShares Core MSCI World')[3]).toBe('€ 95,00')
    expect(row('iShares Core MSCI World')[4]).toBe('€ 38.000')
  })

  it('prices each row in its own currency while every value stays in base', async () => {
    show()
    await screen.findByRole('table')

    // The BTC row is quoted in dollars and valued in euro. Rendering the quote with a
    // euro sign would understate it by whatever the rate happens to be that day — a
    // wrong number that looks like a right one, which is the only kind worth a test.
    expect(row('BTC')[3]).toBe('US$ 56.700,00')
    expect(row('BTC')[4]).toBe('€ 7.000')

    // And no currency leaks between rows: the euro-quoted ones are unaffected by the
    // dollar one having been formatted first.
    expect(row('iShares Core MSCI World')[3]).toBe('€ 95,00')
    expect(row('Anheuser-Busch InBev')[3]).toBe('€ 50,00')
  })

  it('leaves the table reachable by keyboard, since six columns cannot reflow', async () => {
    show()
    const table = await screen.findByRole('table')
    expect(table.parentElement?.getAttribute('tabindex')).toBe('0')
  })

  it('names that focus stop, so it announces as something rather than as nothing', async () => {
    // A `tabIndex` on a bare `div` is a stop a screen reader reaches and cannot
    // describe. The caption already names the table; the region borrows it rather than
    // inventing a second name that could drift from the first.
    show()
    const region = await screen.findByRole('region', { name: '3 holdings, largest first.' })
    expect(region.className).toBe('table-scroll')
    expect(region.querySelector('table')).not.toBeNull()
  })
})

describe('the section tabs (#229)', () => {
  it('marks the open tab current, and lands on Overview for a path it does not recognise', async () => {
    serve(json(FULL))
    const holdings = renderApp(<Portfolio />, { path: '/portfolio/holdings' })
    await screen.findByRole('table')

    expect(screen.getByRole('link', { name: 'Holdings' }).getAttribute('aria-current')).toBe(
      'page',
    )
    expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBeNull()
    holdings.unmount()

    renderApp(<Portfolio />, { path: '/portfolio/nonsense' })
    await screen.findByRole('heading', { level: 2, name: 'Market value' })
  })
})

describe('the risk profile and the drift from it', () => {
  const show = (advice: Advice | null): void => {
    serve(json({ ...FULL, advice }))
    renderApp(<Portfolio />, { path: '/portfolio/advice' })
  }

  it('says there is nothing to measure rather than dropping the section', async () => {
    // `advice: null` means no invested value, which is a state to explain and not a
    // reason to hide a feature — a missing section reads as one nobody built.
    show(null)
    expect(await screen.findByText(/nothing invested to measure/)).toBeTruthy()
    // And no suggestions section at all: there is nothing to suggest against.
    expect(screen.queryByRole('heading', { level: 2, name: 'What would bring it back' })).toBeNull()
  })

  it('names the profile, the denominator, and that the bands were edited', async () => {
    show(ADVICE)
    // The invested € 50.000, not the € 50.000 total — they agree in this fixture, and
    // the sentence says which one it is so the reader of `MIXED` is not left guessing.
    const line = await screen.findByText(/Measured against the Balanced profile/)
    expect(line.textContent?.replace(SPACES, ' ')).toBe(
      'Measured against the Balanced profile, over € 50.000 invested. · bands edited',
    )
  })

  it('keeps the preset name unqualified when the numbers still match it', async () => {
    show({ ...ADVICE, isPreset: true })
    const line = await screen.findByText(/Measured against the Balanced profile/)
    expect(line.textContent).not.toContain('bands edited')
  })

  it('gives every band class a row, including the ones worth nothing', async () => {
    show(ADVICE)
    await screen.findByRole('region', { name: /Each asset class as a share/ })

    // Four rows for four bands. A table built from the slices Ghostfolio returned
    // would have two, and the missing bonds are the most actionable line on the page.
    const names = screen
      .getAllByRole('rowheader')
      .map((cell) => cell.textContent)
      .slice(0, 4)
    expect(names).toEqual(['Bonds', 'Property', 'Equities', 'Commodities'])
  })

  it('leaves the server order alone, which is worst drift first', async () => {
    show(ADVICE)
    await screen.findByRole('region', { name: /Each asset class as a share/ })
    // Bonds are 1.000 bp outside and equities 100, so bonds lead — even though equities
    // are the larger holding and the larger distance from target.
    expect(screen.getAllByRole('rowheader')[0]?.textContent).toBe('Bonds')
  })

  it('prints the share, the target and the band as the server sent them', async () => {
    show(ADVICE)
    await screen.findByRole('region', { name: /Each asset class as a share/ })

    const cells = row('Bonds').map((cell) => cell.replace(SPACES, ' '))
    expect(cells[1]).toBe('10%')
    expect(cells[2]).toBe('30%')
    // The band, not just the target: a share between target and ceiling is fine, and
    // against a bare target it would read as an error.
    expect(cells[3]).toBe('20% to 40%')
  })

  it('shows the gap as signed money, so a sale reads as one', async () => {
    show(ADVICE)
    await screen.findByRole('region', { name: /Each asset class as a share/ })

    // € 10.000 short of target in bonds, € 5.500 too much in equities. The sign is the
    // direction, and the caption says the last column is what would move.
    expect(row('Bonds')[4]?.replace(SPACES, ' ')).toBe('+€ 10.000')
    expect(row('Equities')[4]?.replace(SPACES, ' ')).toBe('€ -5.500')
  })

  it('badges on the distance past the edge, not on the distance from target', async () => {
    show(ADVICE)
    await screen.findByRole('region', { name: /Each asset class as a share/ })

    // Both hold nothing. Property has a floor under it and commodities do not, so one
    // is a problem and the other is exactly what the profile asked for — a table that
    // badged on "is it held" or on `driftBp` would call them the same thing.
    expect(row('Property')[5]).toBe('Below')
    expect(row('Commodities')[5]).toBe('In band')
    // And equities are above their ceiling by 100 bp while being 1.100 bp from target.
    expect(row('Equities')[5]).toBe('Above')
  })

  it('reports a class the profile has no band for instead of folding it in', async () => {
    show(ADVICE)
    // 14% of the invested value with no target. Counting it as equities — or dropping it
    // from the denominator — would make every other share on the page slightly wrong.
    const line = await screen.findByText(/Unclassified: /)
    expect(line.textContent?.replace(SPACES, ' ')).toBe(
      'Unclassified: € 7.000, 14% of what is invested',
    )
  })

  it('says so when every class is inside its band', async () => {
    const balanced: Advice = {
      ...ADVICE,
      drift: {
        ...ADVICE.drift,
        worstOutsideBp: 0,
        lines: ADVICE.drift.lines.map((line) => ({ ...line, state: 'inside', outsideBp: 0 })),
      },
      suggestions: [],
      skipped: [],
    }
    show(balanced)
    expect(await screen.findByText('Every asset class is inside its band. Nothing to do.'))
      .toBeTruthy()
  })

  it('keeps the drift table reachable by keyboard and named by its caption', async () => {
    show(ADVICE)
    const region = await screen.findByRole('region', { name: /Each asset class as a share/ })
    expect(region.getAttribute('tabindex')).toBe('0')
  })
})

describe('the trades that would close the drift', () => {
  const show = (advice: Advice): void => {
    serve(json({ ...FULL, advice }))
    renderApp(<Portfolio />, { path: '/portfolio/advice' })
  }

  /** One suggestion card's text, with `Intl`'s spaces normalised. */
  const card = (index: number): string => {
    const items = document.querySelectorAll('.suggestion-list > .suggestion')
    return (items[index]?.textContent ?? '').replace(SPACES, ' ')
  }

  it('leads each card with the action, the amount and the class', async () => {
    show(ADVICE)
    await screen.findByRole('heading', { level: 2, name: 'What would bring it back' })

    expect(card(0)).toContain('Buy')
    expect(card(0)).toContain('€ 10.000')
    expect(card(0)).toContain('Bonds')
    expect(card(1)).toContain('Sell')
    expect(card(1)).toContain('€ 5.500')
    expect(card(1)).toContain('Equities')
  })

  it('carries the drift figure that motivates it, in the table\'s own words', async () => {
    show(ADVICE)
    await screen.findByRole('heading', { level: 2, name: 'What would bring it back' })

    // #41's requirement, asserted: no suggestion without the drift that produced it.
    // The same sentence the row would give, because both call one function on one line.
    expect(card(0)).toContain('10% below its floor of 20%')
    expect(card(1)).toContain('1% above its ceiling of 75%')
  })

  it('says where the money comes from, since that is what sized the trade', async () => {
    show(ADVICE)
    await screen.findByRole('heading', { level: 2, name: 'What would bring it back' })
    // Paired, so the amount is the gap itself rather than the larger figure a purchase
    // out of cash would need — a distinction worth a factor of three at a 65% target.
    expect(card(0)).toContain('the invested total does not move')
  })

  it('names the fund a purchase would go into, with its cost and its alternatives', async () => {
    show(ADVICE)
    await screen.findByRole('heading', { level: 2, name: 'What would bring it back' })

    expect(card(0)).toContain('iShares Core Euro Aggregate Bond')
    expect(card(0)).toContain('IE00B3F81R35')
    // Two decimals on a TER: 0,09% and 0,19% differ by the digit somebody compares.
    expect(card(0)).toContain('TER 0,09%')
    expect(card(0)).toContain('one of 2 funds in your list')
  })

  it('names the position a sale would come out of, and how much of it is held', async () => {
    show(ADVICE)
    await screen.findByRole('heading', { level: 2, name: 'What would bring it back' })

    expect(card(1)).toContain('iShares Core MSCI World')
    expect(card(1)).toContain('€ 38.000 held')
    expect(card(1)).toContain('the only position in this class')
  })

  it('prices the trade and cites the rule it priced it with', async () => {
    show(ADVICE)
    await screen.findByRole('heading', { level: 2, name: 'What would bring it back' })

    // € 12,00 is 0,12% of € 10.000 — the page prints the server's figure and the base.
    expect(card(0)).toContain('€ 12,00 in tax')
    expect(card(0)).toContain('0,12% of € 10.000')
    expect(card(0)).toContain('WDRT art. 120 · checked 15/01/2026')
  })

  it('admits what the tax figure leaves out, on the sale only', async () => {
    show(ADVICE)
    await screen.findByRole('heading', { level: 2, name: 'What would bring it back' })

    // The realised gain needs a cost base this app never sees. A total that quietly
    // excluded a 10% tax would read as a complete one.
    expect(card(1)).toContain('Capital gains are not in this figure')
    expect(card(0)).not.toContain('Capital gains are not in this figure')
  })

  it('flags a rate nobody has checked against the law', async () => {
    show(ADVICE)
    await screen.findByRole('heading', { level: 2, name: 'What would bring it back' })
    // The sale's rule is `transcribed`, the purchase's is `confirmed`. Presenting both
    // with the same confidence would overstate what anyone has verified.
    expect(card(1)).toContain('nobody has checked them against the law')
    expect(card(0)).not.toContain('nobody has checked them against the law')
  })

  it('says a trade cannot be named rather than naming something plausible', async () => {
    const blocked: Advice = {
      ...ADVICE,
      suggestions: [{ ...ADVICE.suggestions[0]!, fund: null, unavailable: 'no_fund_in_universe' }],
    }
    show(blocked)
    await screen.findByRole('heading', { level: 2, name: 'What would bring it back' })

    expect(card(0)).toContain('Nothing in your fund list covers this class')
    // The drift is still stated: the class is still outside its band.
    expect(card(0)).toContain('10% below its floor of 20%')
  })

  it('reports a band it left alone, and against which threshold', async () => {
    show(ADVICE)
    await screen.findByRole('heading', { level: 2, name: 'What would bring it back' })

    // A red band with nothing under it is a bug report waiting to happen, so the
    // sentence names the figure and the floor it fell under.
    const skipped = await screen.findByText(/Property is 5% past its edge/)
    expect(skipped.textContent?.replace(SPACES, ' ')).toBe(
      'Property is 5% past its edge, but closing it takes only € 2.500 — under the € 3.000 you set as the smallest trade worth making.',
    )
  })

  it('explains an empty list rather than leaving a heading over nothing', async () => {
    show({ ...ADVICE, suggestions: [], skipped: [] })
    await screen.findByRole('heading', { level: 2, name: 'What would bring it back' })
    expect(screen.getByText(/Nothing worth trading/)).toBeTruthy()
  })
})

describe('money at the broker that is not invested', () => {
  it('names the two halves, so the total and the allocation can differ in public', async () => {
    serve(json(MIXED))
    renderApp(<Portfolio />)

    await screen.findByRole('heading', { level: 2, name: 'Invested' })
    expect(metric('Market value')).toBe('€ 55.000')
    expect(metric('Invested')).toBe('€ 50.000')
    expect(metric('Cash at broker')).toBe('€ 5.000')
  })

  it('keeps the treemap a picture of the invested half, not of the total', async () => {
    serve(json(MIXED))
    renderApp(<Portfolio />)
    await screen.findAllByRole('img')

    // 76%, which is 3.800.000 of the invested 5.000.000. Over the € 55.000 total the
    // same slice would be 69% — the number a page that fed it the total would show.
    const spoken = summaries()
    expect(spoken.some((text) => text.includes('Equities') && text.includes('76%'))).toBe(true)
    expect(spoken.some((text) => text.includes('69%'))).toBe(false)
  })

  it('shows a zero rather than hiding the card when nothing is idle', async () => {
    // Cash of nothing is an answer: every euro is working. Hiding the card would
    // leave the reader unable to tell that from a version that cannot say.
    serve(json(FULL))
    renderApp(<Portfolio />)

    await screen.findByRole('heading', { level: 2, name: 'Cash at broker' })
    expect(metric('Cash at broker')).toBe('€ 0')
    // And the total is not quietly the same card twice: both figures are drawn.
    expect(metric('Invested')).toBe('€ 50.000')
  })

  it('says the split is not known when it was never recorded', async () => {
    // A snapshot from before the columns existed, or one the history backfill wrote:
    // the total is real and the split is genuinely absent, which is not zero.
    serve(json({ ...FULL, investedValueCents: null, cashValueCents: null }))
    renderApp(<Portfolio />)

    await screen.findByRole('heading', { level: 2, name: 'Invested' })
    // Both halves, and neither the total nor the return: those are still known.
    expect(metric('Invested')).toBe('Not known yet')
    expect(metric('Cash at broker')).toBe('Not known yet')
    expect(metric('Market value')).toBe('€ 50.000')
    expect(metric('Time-weighted return')).toBe('7,4%')
  })
})

describe('a weight with no total to be a share of', () => {
  it('says the weight is not known rather than dividing by zero', async () => {
    serve(json({ ...FULL, totalValueCents: 0 }))
    renderApp(<Portfolio />, { path: '/portfolio/holdings' })
    await screen.findByRole('table')

    expect(row('BTC')[5]).toBe('Not known yet')
  })
})

describe('formatQuantity', () => {
  // A unit test because the interesting inputs are the ones a fixture cannot show:
  // a provider sending text where a number belongs.
  it('prints an unparseable quantity verbatim rather than as NaN', () => {
    expect(formatQuantity('about ten')).toBe('about ten')
    expect(formatQuantity('')).toBe('')
  })

  it('keeps an integer an integer', () => {
    expect(formatQuantity('12')).toBe('12')
  })

  it('groups thousands the Belgian way', () => {
    expect(formatQuantity('1234.5').replace(SPACES, ' ')).toBe('1.234,5')
  })
})
