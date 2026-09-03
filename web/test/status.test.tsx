/**
 * The panel that says whether this instance is working.
 *
 * It is the only panel on the settings page that writes nothing, which makes its
 * assertions a different kind from the rest of that file's. What matters here is that a
 * reader can tell four situations apart, because on screen three of them look identical:
 *
 *  - **Nothing has run yet.** A fresh deployment. Neutral, and never coloured — a first
 *    boot that looked like a fault would send someone hunting for one.
 *  - **Ghostfolio is down.** Amber. It resolves itself, the pages are still right, and
 *    the honest thing to say is that the figures are older than they look.
 *  - **Ghostfolio changed shape.** Red, and the only one of the two upstream failures
 *    that nothing but a new Balancr will fix. If these two rendered the same, a
 *    permanent break gets waited out for a week.
 *  - **A job has been failing for days.** Which is only visible because last attempt and
 *    last success are separate rows. A panel showing one timestamp would read as
 *    healthy, and that is the failure this panel exists to catch.
 *
 * The Dutch case is here rather than in `i18n.test.tsx` because this panel is where
 * server-produced text and translated text sit in the same list: a `reason` is a code and
 * has to arrive in Dutch, while a job's `error` is quoted from an upstream and must not
 * be translated or hidden. Both properties are asserted on one render.
 */
import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { StatusPanel } from '../src/settings/Status.tsx'
import type { Status } from '../src/shared.ts'
import { clickLink, i18nReady, renderApp, resetLanguage } from './helpers.tsx'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A healthy instance whose jobs have all run. The baseline every case narrows from. */
const HEALTHY: Status = {
  ready: true,
  degraded: false,
  at: '2026-09-03T12:05:00.000Z',
  version: '0.5.18',
  revision: 'abc1234',
  jobsEnabled: true,
  checks: [
    { name: 'database', status: 'ok', reason: null },
    { name: 'actual', status: 'ok', reason: null },
    { name: 'ghostfolio', status: 'ok', reason: null },
    { name: 'jobs', status: 'ok', reason: null },
  ],
  jobs: [
    {
      name: 'sync',
      status: 'ok',
      lastRunAt: '2026-09-03T12:00:00.000Z',
      lastSuccessAt: '2026-09-03T12:00:00.000Z',
      nextRunAt: '2026-09-03T13:00:00.000Z',
      lastDurationMs: 4_120,
      error: null,
      schedule: 'every 60 minutes',
    },
  ],
  probes: [
    {
      source: 'ghostfolio',
      status: 'ok',
      checkedAt: '2026-09-03T12:00:00.000Z',
      checks: [{ path: '/api/v1/health', status: 'ok', detail: 'reachable' }],
      warnings: [],
      detailAvailable: true,
    },
  ],
}

/** `dd/MM/yyyy, HH:mm` — the format, without pinning the hour to an offset. */
const BELGIAN_DATETIME = /^\d{2}\/\d{2}\/2026, \d{2}:\d{2}$/

/** `HEALTHY` with fields replaced, so each case states only what it is about. */
const status = (over: Partial<Status>): Status => ({ ...HEALTHY, ...over })

/** Renders the panel against one answer, and waits for it to land. */
async function show(body: Status | Response): Promise<ReturnType<typeof vi.fn>> {
  const mock = vi.fn(() => Promise.resolve(body instanceof Response ? body : json(body)))
  vi.stubGlobal('fetch', mock)
  renderApp(<StatusPanel />)
  await screen.findByRole('heading', { level: 2, name: /Status|status/ })
  return mock
}

beforeAll(async () => {
  await i18nReady()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await resetLanguage()
})

describe('a healthy instance', () => {
  it('reads its own endpoint, not the settings payload', async () => {
    const mock = await show(HEALTHY)
    expect(mock.mock.calls.map((call) => String(call[0]))).toEqual(['/api/status'])
  })

  it('says it is serving, and colours nothing', async () => {
    await show(HEALTHY)
    await screen.findByText('This instance is serving pages.')

    const badges = [...document.querySelectorAll('.badge')]
    expect(badges.length).toBeGreaterThan(0)
    for (const badge of badges) expect(badge.className).not.toContain('badge--error')
  })

  it('prints both timestamps and the duration through the shared formatters', async () => {
    await show(HEALTHY)

    // `dd/MM/yyyy`, Belgian regardless of the interface language: `format.ts` is the
    // only place this application writes a date, and a panel doing its own arithmetic
    // would print `9/3/2026`. The clock is matched loosely and the fixture instants are
    // midday, so the assertion is about the format rather than about the timezone the
    // suite happens to run in.
    expect(screen.getAllByText(BELGIAN_DATETIME)).toHaveLength(3)
    expect(screen.getByText('Last success')).toBeTruthy()
    expect(screen.getByText('4,1 s')).toBeTruthy()
    expect(screen.getByText('every 60 minutes')).toBeTruthy()
  })

  it('refreshes on demand, because the answer decays while the page is open', async () => {
    const mock = await show(HEALTHY)
    clickLink(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => {
      expect(mock).toHaveBeenCalledTimes(2)
    })
  })
})

describe('a deployment where nothing has run', () => {
  it('says so without calling it a fault', async () => {
    await show(
      status({
        degraded: true,
        checks: [
          { name: 'database', status: 'ok', reason: null },
          { name: 'actual', status: 'unknown', reason: 'neverRun' },
          { name: 'ghostfolio', status: 'unknown', reason: 'neverRun' },
          { name: 'jobs', status: 'unknown', reason: 'neverRun' },
        ],
        jobs: [],
        probes: [],
      }),
    )

    expect(screen.getAllByText('Not known')).toHaveLength(3)
    const nothingYet = 'Nothing has run yet, so there is nothing to report.'
    expect(screen.getAllByText(nothingYet)).toHaveLength(3)
    expect(screen.getByText('Ghostfolio has not been checked yet.')).toBeTruthy()
    // Neutral: no tone class at all on the three unknowns.
    for (const badge of document.querySelectorAll('.badge')) {
      if (badge.textContent === 'Not known') expect(badge.className.trim()).toBe('badge')
    }
  })
})

describe('the two ways Ghostfolio breaks', () => {
  const withProbe = (probeStatus: 'unreachable' | 'shape-mismatch'): Status =>
    status({
      degraded: true,
      checks: [
        { name: 'database', status: 'ok', reason: null },
        { name: 'actual', status: 'ok', reason: null },
        {
          name: 'ghostfolio',
          status: probeStatus === 'unreachable' ? 'degraded' : 'failed',
          reason: probeStatus === 'unreachable' ? 'unreachable' : 'shapeMismatch',
        },
        { name: 'jobs', status: 'ok', reason: null },
      ],
      probes: [
        {
          source: 'ghostfolio',
          status: probeStatus,
          checkedAt: '2026-09-03T12:00:00.000Z',
          checks: [
            {
              path: '/api/v1/portfolio/holdings',
              status: probeStatus,
              detail: 'unparseable',
              error: 'holdings.0.valueInBaseCurrency: expected number',
            },
          ],
          warnings: [],
          detailAvailable: true,
        },
      ],
    })

  it('shows an outage as amber and says it will pass', async () => {
    await show(withProbe('unreachable'))

    expect(screen.getByText(/could not be reached/)).toBeTruthy()
    const badge = [...document.querySelectorAll('.badge')].find(
      (node) => node.textContent === 'Unreachable',
    )
    expect(badge?.className).toContain('badge--warn')
  })

  it('shows a contract change as red and names the path', async () => {
    await show(withProbe('shape-mismatch'))

    expect(screen.getByText(/needs a Balancr update/)).toBeTruthy()
    expect(screen.getByText('/api/v1/portfolio/holdings')).toBeTruthy()
    // The upstream's own words, quoted rather than paraphrased: it is not translated,
    // and on a Dutch page it will still be in English.
    const quote = screen.getByText(/expected number/)
    expect(quote.tagName).toBe('Q')

    const badge = [...document.querySelectorAll('.badge')].find(
      (node) => node.textContent === 'Unexpected shape',
    )
    expect(badge?.className).toContain('badge--error')
  })
})

describe('a job that has been failing', () => {
  const failing = status({
    degraded: true,
    checks: [
      { name: 'database', status: 'ok', reason: null },
      { name: 'actual', status: 'failed', reason: 'jobFailed' },
      { name: 'ghostfolio', status: 'ok', reason: null },
      { name: 'jobs', status: 'degraded', reason: 'jobFailed' },
    ],
    jobs: [
      {
        name: 'sync',
        status: 'error',
        lastRunAt: '2026-09-03T12:00:00.000Z',
        // Six days behind the last attempt. The whole reason for two columns.
        lastSuccessAt: '2026-08-28T12:00:00.000Z',
        nextRunAt: '2026-09-03T13:00:00.000Z',
        lastDurationMs: 210,
        error: 'connect ECONNREFUSED 172.19.0.4:5006',
        schedule: 'every 60 minutes',
      },
    ],
  })

  it('shows the gap between the last attempt and the last success', async () => {
    await show(failing)

    expect(screen.getAllByText(/^03\/09\/2026, \d{2}:\d{2}$/)).toHaveLength(2)
    expect(screen.getByText(/^28\/08\/2026, \d{2}:\d{2}$/)).toBeTruthy()
    expect(screen.getByText('Budget sync')).toBeTruthy()
  })

  it('quotes the error rather than rewording it', async () => {
    await show(failing)
    const quote = screen.getByText('connect ECONNREFUSED 172.19.0.4:5006')
    expect(quote.tagName).toBe('Q')
  })

  it('still says the instance is serving, because it is', async () => {
    await show(failing)
    expect(screen.getByText(/This instance is serving pages/)).toBeTruthy()
  })
})

describe('a job this build has no name for', () => {
  it('prints the row’s own name rather than the i18n key', async () => {
    // The `jobs` table is written by whichever build last ran, so a name with no string
    // in this bundle is a real possibility — and `job.whatever` on screen is worse than
    // `whatever`.
    await show(
      status({
        jobs: [
          {
            name: 'reconcile',
            status: 'idle',
            lastRunAt: null,
            lastSuccessAt: null,
            nextRunAt: null,
            lastDurationMs: null,
            error: null,
            schedule: null,
          },
        ],
      }),
    )

    expect(screen.getByText('reconcile')).toBeTruthy()
    expect(screen.queryByText('job.reconcile')).toBeNull()
    expect(screen.getAllByText('Never')).toHaveLength(3)
  })
})

describe('when the endpoint itself fails', () => {
  it('reports it inside the panel and leaves the rest of the page alone', async () => {
    await show(
      json(
        { error: { code: 'internal_error', message: 'Something went wrong.', requestId: 'req-9' } },
        500,
      ),
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Something went wrong.')
    expect(alert.textContent).toContain('req-9')
    // The heading is still there: this panel failing is not the page failing.
    expect(screen.getByRole('heading', { level: 2 })).toBeTruthy()
  })
})

describe('in Dutch', () => {
  it('translates the reasons and leaves the upstream’s words alone', async () => {
    const { setLanguage } = await import('../src/i18n.ts')
    await setLanguage('nl')

    await show(
      status({
        degraded: true,
        checks: [
          { name: 'database', status: 'ok', reason: null },
          { name: 'actual', status: 'failed', reason: 'jobFailed' },
          { name: 'ghostfolio', status: 'failed', reason: 'shapeMismatch' },
          { name: 'jobs', status: 'degraded', reason: 'jobFailed' },
        ],
        jobs: [
          {
            name: 'sync',
            status: 'error',
            lastRunAt: '2026-09-03T12:00:00.000Z',
            lastSuccessAt: null,
            nextRunAt: null,
            lastDurationMs: null,
            error: 'connect ECONNREFUSED 172.19.0.4:5006',
            schedule: 'every 60 minutes',
          },
        ],
      }),
    )

    expect(screen.getByText('Status van deze instantie')).toBeTruthy()
    // Twice: Actual and Ghostfolio are both `failed`.
    expect(screen.getAllByText('Mislukt')).toHaveLength(2)
    expect(screen.getAllByText(/bij de laatste poging mislukt/)).toHaveLength(2)
    expect(screen.getByText(/update van Balancr nodig/)).toBeTruthy()
    // Untranslated on purpose: Balancr did not write this sentence.
    expect(screen.getByText('connect ECONNREFUSED 172.19.0.4:5006')).toBeTruthy()
    // And the dates stay Belgian, which they were in English too: the interface language
    // and the formatting locale are separate settings, and this is where that shows.
    expect(screen.getByText(BELGIAN_DATETIME)).toBeTruthy()
  })
})
