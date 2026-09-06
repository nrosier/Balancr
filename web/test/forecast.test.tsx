/**
 * The forecast page: an empty state before the first net-worth snapshot, and — once
 * both jobs have run — a chart and a bills table built from the projection.
 *
 * jsdom reports every element as zero-sized, so this file lends the chart a size the
 * way `overview.test.tsx` does, purely to keep ECharts' size warning out of output
 * that is about something else.
 */
import { screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Forecast } from '../src/pages/Forecast.tsx'
import type { Forecast as ForecastPayload } from '../src/shared.ts'
import { i18nReady, renderApp } from './helpers.tsx'

const FRESH: ForecastPayload['freshness'] = {
  stale: false,
  asOf: '2026-09-02T05:30:00Z',
  jobsEnabled: true,
  jobs: [{ name: 'sync', status: 'ok', lastRunAt: null, lastSuccessAt: null, error: null }],
}

const MONTHS = [
  '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02',
  '2027-03', '2027-04', '2027-05', '2027-06', '2027-07', '2027-08',
]

/** A monthly income and fixed cost every month, plus a quarterly and an annual bill. */
const FULL: ForecastPayload = {
  freshness: FRESH,
  forecast: {
    startDate: '2026-08-31',
    startBalanceCents: 500_000,
    months: MONTHS.map((month) => {
      const bills =
        month === '2026-12'
          ? [{ categoryId: 'gas', name: 'gas', amountCents: 24_000 }]
          : month === '2027-03'
            ? [{ categoryId: 'insurance', name: 'insurance', amountCents: 48_000 }]
            : []
      const fixedCents = 90_000 + bills.reduce((sum, bill) => sum + bill.amountCents, 0)
      return {
        month,
        incomeCents: 300_000,
        fixedCents,
        netCents: 300_000 - fixedCents,
        balanceCents: 0, // overwritten below
        bills,
      }
    }),
  },
}
// Running balance, computed the same way the domain layer does.
FULL.forecast?.months.reduce((balance, month) => {
  const next = balance + month.netCents
  month.balanceCents = next
  return next
}, FULL.forecast.startBalanceCents)

const EMPTY: ForecastPayload = {
  freshness: { stale: false, asOf: null, jobsEnabled: true, jobs: [] },
  forecast: null,
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function serve(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(body))))
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

describe('when neither job has produced a projection yet', () => {
  it('offers a refresh rather than a page of zeroes', async () => {
    serve(EMPTY)
    renderApp(<Forecast />)

    expect(await screen.findByText('No data yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('when the projection is available', () => {
  it('titles the page and gives the horizon a headline figure', async () => {
    serve(FULL)
    renderApp(<Forecast />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Forecast')
    expect(await screen.findByText('Balance in twelve months')).toBeTruthy()
    expect(screen.getByText('€ 29.480')).toBeTruthy()
    expect(screen.getByText('Updated August 2026')).toBeTruthy()
  })

  it('gives the chart a sentence that says what the projected line does', async () => {
    serve(FULL)
    renderApp(<Forecast />)

    const chart = await screen.findByRole('img')
    const label = (chart.getAttribute('aria-label') ?? '').replaceAll(' ', ' ')
    expect(label).toBe(
      'Projected balance between 01/09/2026 and 01/08/2027: € 7.100 at the start, € 29.480 at the end.',
    )
  })

  it('lists only the bills outside the ordinary monthly rhythm, in the month they land', async () => {
    serve(FULL)
    renderApp(<Forecast />)

    expect(await screen.findByText('2 bills land in the next twelve months.')).toBeTruthy()
    expect(screen.getByText('December 2026')).toBeTruthy()
    expect(screen.getByText('gas')).toBeTruthy()
    expect(screen.getByText('€ 240')).toBeTruthy()
    expect(screen.getByText('March 2027')).toBeTruthy()
    expect(screen.getByText('insurance')).toBeTruthy()
    expect(screen.getByText('€ 480')).toBeTruthy()
  })

  it('says so when nothing outside the monthly rhythm is due', async () => {
    const forecast = FULL.forecast
    if (forecast === null) throw new Error('fixture must have a forecast')
    serve({
      freshness: FULL.freshness,
      forecast: { ...forecast, months: forecast.months.map((month) => ({ ...month, bills: [] })) },
    } satisfies ForecastPayload)
    renderApp(<Forecast />)

    expect(
      await screen.findByText('Nothing outside the usual monthly rhythm is due in the next twelve months.'),
    ).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('leaves every string translated', async () => {
    serve(FULL)
    renderApp(<Forecast />)
    await screen.findByText('Balance in twelve months')

    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\b(metric|chart|bills|empty|time)\.[a-zA-Z]/)
  })
})
