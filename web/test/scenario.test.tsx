/**
 * The scenario page: a calculator that always renders, with inline hints when a seed
 * field has no real figure behind it, and a projection that recomputes on every input
 * change without a second request to the server.
 *
 * jsdom sizing workaround copied from `forecast.test.tsx` for the same reason — ECharts'
 * size warning is not what these tests are about.
 */
import { fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Scenario } from '../src/pages/Scenario.tsx'
import {
  DEFAULT_GROWTH_RATE_BP,
  DEFAULT_HORIZON_MONTHS,
  formatMoney,
  projectScenario,
  type Scenario as ScenarioPayload,
} from '../src/shared.ts'
import { i18nReady, renderApp } from './helpers.tsx'

const FRESH: ScenarioPayload['freshness'] = {
  stale: false,
  asOf: '2026-09-02T05:30:00Z',
  jobsEnabled: true,
  jobs: [{ name: 'sync', status: 'ok', lastRunAt: null, lastSuccessAt: null, error: null }],
}

const FULL: ScenarioPayload = {
  freshness: FRESH,
  scenario: {
    month: '2026-08',
    baselineCents: 50_000,
    snapshotDate: '2026-08-31',
    startingValueCents: 10_000_000,
  },
}

const EMPTY: ScenarioPayload = {
  freshness: { stale: false, asOf: null, jobsEnabled: true, jobs: [] },
  scenario: { month: null, baselineCents: null, snapshotDate: null, startingValueCents: null },
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function serve(body: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(() => Promise.resolve(json(body)))
  vi.stubGlobal('fetch', mock)
  return mock
}

/** The figure under a `<Metric>` card's title, scoped so two cards sharing a label never collide. */
function metricValue(name: string): string | null {
  const heading = screen.getByRole('heading', { name })
  return heading.closest('.metric')?.querySelector('.metric__value')?.textContent ?? null
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

describe('when neither seed figure has a real value behind it', () => {
  it('explains why the starting point is a typed figure, not a real one', async () => {
    serve(EMPTY)
    renderApp(<Scenario />)

    expect(
      await screen.findByText(/No category is tagged Investments yet/),
    ).toBeTruthy()
    expect(screen.getByText(/No net-worth snapshot yet/)).toBeTruthy()
  })
})

describe('when the seed figures are real', () => {
  it('titles the page and shows the real monthly contribution with no hint', async () => {
    serve(FULL)
    renderApp(<Scenario />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Scenario')
    expect(await screen.findByRole('heading', { name: 'Current monthly contribution' })).toBeTruthy()
    expect(metricValue('Current monthly contribution')).toBe(formatMoney(50_000))
    expect(screen.queryByText(/No category is tagged Investments yet/)).toBeNull()
    expect(screen.queryByText(/No net-worth snapshot yet/)).toBeNull()
  })

  it('starts the projection from the real seed with no hypothetical change', async () => {
    serve(FULL)
    renderApp(<Scenario />)
    await screen.findByRole('heading', { name: 'Projected value' })

    const months = projectScenario({
      startingValueCents: 10_000_000,
      baselineCents: 50_000,
      changeCents: 0,
      recurring: true,
      growthRateBp: DEFAULT_GROWTH_RATE_BP,
      horizonMonths: DEFAULT_HORIZON_MONTHS,
    })
    const last = months.at(-1)
    if (last === undefined) throw new Error('fixture horizon must produce months')

    expect(metricValue('Projected value, as-is')).toBe(formatMoney(last.baselineValueCents, { whole: true }))
    expect(metricValue('Projected value, with the change')).toBe(
      formatMoney(last.scenarioValueCents, { whole: true }),
    )
    expect(metricValue('Difference at the end')).toBe(formatMoney(0, { whole: true, signed: true }))
  })

  it('recomputes every metric and the chart as the change amount is edited, without a second request', async () => {
    const fetchMock = serve(FULL)
    renderApp(<Scenario />)
    await screen.findByRole('heading', { name: 'Projected value' })

    fireEvent.change(screen.getByLabelText('Monthly change'), { target: { value: '200' } })
    fireEvent.change(screen.getByLabelText('Expected annual growth'), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText('Horizon (years)'), { target: { value: '5' } })

    const months = projectScenario({
      startingValueCents: 10_000_000,
      baselineCents: 50_000,
      changeCents: 20_000,
      recurring: true,
      growthRateBp: 400,
      horizonMonths: 60,
    })
    const last = months.at(-1)
    if (last === undefined) throw new Error('edited horizon must produce months')

    expect(metricValue('Projected value, with the change')).toBe(
      formatMoney(last.scenarioValueCents, { whole: true }),
    )
    expect(metricValue('Projected value, as-is')).toBe(formatMoney(last.baselineValueCents, { whole: true }))
    expect(metricValue('Difference at the end')).toBe(
      formatMoney(last.deltaCents, { whole: true, signed: true }),
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('gives a one-time change a different trajectory than a recurring one', async () => {
    serve(FULL)
    renderApp(<Scenario />)
    await screen.findByRole('heading', { name: 'Projected value' })

    fireEvent.change(screen.getByLabelText('Monthly change'), { target: { value: '1200' } })
    await screen.findByRole('heading', { name: 'Projected value, with the change' })
    const recurringValue = metricValue('Projected value, with the change')

    fireEvent.change(screen.getByLabelText('How the change applies'), { target: { value: 'lumpSum' } })
    const lumpSumValue = metricValue('Projected value, with the change')

    expect(lumpSumValue).not.toBe(recurringValue)
  })

  it('leaves every string translated', async () => {
    serve(FULL)
    renderApp(<Scenario />)
    await screen.findByRole('heading', { name: 'Projected value' })

    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\b(metric|chart|input|hint|empty|time)\.[a-zA-Z]/)
  })
})
