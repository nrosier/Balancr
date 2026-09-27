/**
 * The tags page: a single read-only table of per-tag net cost/gain totals (#663),
 * with the same fetch-once/empty-state contract every other page follows.
 */
import { screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Tags } from '../src/pages/Tags.tsx'
import { formatMoney, type TagTotals } from '../src/shared.ts'
import { i18nReady, renderApp } from './helpers.tsx'

const FRESH: TagTotals['freshness'] = {
  stale: false,
  asOf: '2026-09-02T05:30:00Z',
  jobsEnabled: true,
  jobs: [{ name: 'sync', status: 'ok', lastRunAt: null, lastSuccessAt: null, error: null }],
}

const FULL: TagTotals = {
  freshness: FRESH,
  tags: [
    {
      id: 't1',
      tag: 'rental-a',
      color: '#ff0000',
      allTimeNetCents: -125_000,
      rolling12NetCents: -60_000,
      thisYearNetCents: -30_000,
      byMonth: [
        { month: '2026-08', netCents: -30_000, txnCount: 2 },
        { month: '2026-09', netCents: 5_000, txnCount: 1 },
      ],
    },
    {
      id: 't2',
      tag: 'side-gig',
      color: null,
      allTimeNetCents: 42_000,
      rolling12NetCents: 42_000,
      thisYearNetCents: 42_000,
      byMonth: [{ month: '2026-09', netCents: 42_000, txnCount: 3 }],
    },
  ],
}

const EMPTY: TagTotals = {
  freshness: { stale: false, asOf: null, jobsEnabled: true, jobs: [] },
  tags: [],
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function serve(body: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(() => Promise.resolve(json(body)))
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

describe('when tags have real totals behind them', () => {
  it('titles the page and lists a row per tag with its three money columns', async () => {
    serve(FULL)
    renderApp(<Tags />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Tags')
    expect(await screen.findByRole('heading', { name: 'Per-tag totals' })).toBeTruthy()

    const rows = screen.getAllByRole('row')
    // Header row plus one row per tag.
    expect(rows).toHaveLength(3)

    const rentalRow = screen.getByRole('row', { name: /rental-a/ })
    expect(rentalRow.textContent).toContain(formatMoney(-30_000, { whole: true }))
    expect(rentalRow.textContent).toContain(formatMoney(-60_000, { whole: true }))
    expect(rentalRow.textContent).toContain(formatMoney(-125_000, { whole: true }))

    const sideGigRow = screen.getByRole('row', { name: /side-gig/ })
    expect(sideGigRow.textContent).toContain(formatMoney(42_000, { whole: true }))
  })

  it('leaves every string translated', async () => {
    serve(FULL)
    renderApp(<Tags />)
    await screen.findByRole('heading', { name: 'Per-tag totals' })

    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\b(tags|nav|page)\.[a-zA-Z]/)
  })
})

describe('when no tag has been registered yet', () => {
  it('shows the empty state instead of an empty table', async () => {
    serve(EMPTY)
    renderApp(<Tags />)

    expect(await screen.findByText('No data yet')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
