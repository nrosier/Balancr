/**
 * The panel that says whether this instance is working.
 *
 * Almost everything here writes nothing, which makes most of its assertions a different
 * kind from the rest of that file's. What matters in the cases below is that a reader can
 * tell four situations apart, because on screen three of them look identical:
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
 *
 * Since #325, the panel itself is split into two sub-tabs — Services (three at-a-glance
 * cards, the default landing view) and Queue (the job list, the reset control and the
 * probe detail that used to be visible immediately). `show()` always pushes an explicit
 * path rather than letting `useSubsection` fall back on whatever `window.history` was
 * left at by a previous test, and `openQueue()` is the one way any case below reaches the
 * Queue tab's content.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { StatusPanel } from '../src/settings/Status.tsx'
import type { AiAvailabilityWire, AiEstimate, RefreshAccepted, Status } from '../src/shared.ts'
import {
  clickLink,
  i18nReady,
  renderApp,
  resetLanguage,
  stubResource,
  stubSettings,
  stubSettingsState,
} from './helpers.tsx'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The AI card's default fixture: configured, on, and within budget. */
const AI_ON: AiAvailabilityWire = { enabled: true, reason: null }

/** A `<StatusPanel>` wired with the AI-on fixture, for cases below that only vary `owner`. */
function panel(owner: boolean): ReactNode {
  return (
    <StatusPanel
      settings={stubSettings(AI_ON)}
      state={stubSettingsState()}
      owner={owner}
      estimate={stubResource<AiEstimate>()}
    />
  )
}

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
  queued: [],
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

/** Renders the panel against one answer, and waits for it to land.
 *
 * `owner` defaults to true because only the reset-control cases below are actually about
 * the distinction; `aiAvailability` defaults to the AI card's "on" fixture because most
 * cases below are not about that card either. `path` always defaults to the Services
 * tab's own path — never left unset — because `useSubsection` replaces the URL it is
 * given, and letting that default to whatever a previous test's clicks left in
 * `window.history` would leak state between cases in this file. */
async function show(
  body: Status | Response,
  options: { owner?: boolean; aiAvailability?: AiAvailabilityWire; path?: string } = {},
): Promise<ReturnType<typeof vi.fn>> {
  const { owner = true, aiAvailability = AI_ON, path = '/settings/status' } = options
  const mock = vi.fn(() => Promise.resolve(body instanceof Response ? body : json(body)))
  vi.stubGlobal('fetch', mock)
  renderApp(
    <StatusPanel
      settings={stubSettings(aiAvailability)}
      state={stubSettingsState()}
      owner={owner}
      estimate={stubResource<AiEstimate>()}
    />,
    { path },
  )
  await screen.findByRole('heading', { level: 2, name: /Status|status/ })
  return mock
}

/** Switches to the Queue tab, in whichever of the two languages is active. Awaited on the
 * link itself rather than clicked straight away, because the tab strip is part of the
 * loaded state `DataState` renders and is not there yet the instant `show()` returns. */
async function openQueue(): Promise<void> {
  clickLink(await screen.findByRole('link', { name: /queue|wachtrij/i }))
}

/** The card for one service, found by its own name so a test can look inside it without
 * caring where the grid puts it. */
function serviceCard(name: string): HTMLElement {
  const card = screen.getByText(name).closest('.status__service')
  if (card === null) throw new Error(`no service card found for "${name}"`)
  return card as HTMLElement
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
    await openQueue()

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

describe('the Services/Queue split (#325)', () => {
  it('shows the cards by default, and the queue only once asked for', async () => {
    await show(HEALTHY)

    expect(screen.getByText('Actual Budget')).toBeTruthy()
    expect(screen.queryByText('Budget sync')).toBeNull()

    await openQueue()
    expect(screen.getByText('Budget sync')).toBeTruthy()
    expect(screen.queryByText('Actual Budget')).toBeNull()

    clickLink(screen.getByRole('link', { name: 'Services' }))
    await screen.findByText('Actual Budget')
    expect(screen.queryByText('Budget sync')).toBeNull()
  })
})

describe('the AI card (#325)', () => {
  it('shows enabled without a reason, from the settings payload rather than a fetch', async () => {
    const mock = await show(HEALTHY, { aiAvailability: AI_ON })
    expect(mock.mock.calls.map((call) => String(call[0]))).toEqual(['/api/status'])

    const card = serviceCard('AI assistant')
    const badge = card.querySelector('.badge')
    expect(badge?.className).not.toContain('badge--error')
    expect(card.querySelector('.status__reason')).toBeNull()
  })

  it.each<[AiAvailabilityWire['reason'], RegExp]>([
    ['notConfigured', /No Gemini key is configured/],
    ['switchedOff', /AI_ENABLED is set to false/],
    ['budgetZero', /monthly AI budget is set to zero/],
  ])('explains why when disabled: %s', async (reason, expected) => {
    await show(HEALTHY, { aiAvailability: { enabled: false, reason } })

    const card = serviceCard('AI assistant')
    expect(card.querySelector('.badge')?.textContent).toBe('Not known')
    expect(card.textContent).toMatch(expected)
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

    // Two, not the four the old flat list showed: `database` is the top banner's own
    // `ready` state and the `jobs` aggregate is dropped, so only Actual and Ghostfolio
    // are left as cards (#325).
    expect(screen.getAllByText('Not known')).toHaveLength(2)
    const nothingYet = 'Nothing has run yet, so there is nothing to report.'
    expect(screen.getAllByText(nothingYet)).toHaveLength(2)
    // Neutral: no tone class at all on the two unknowns.
    for (const badge of document.querySelectorAll('.badge')) {
      if (badge.textContent === 'Not known') expect(badge.className.trim()).toBe('badge')
    }

    await openQueue()
    expect(screen.getByText('Ghostfolio has not been checked yet.')).toBeTruthy()
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

    // The card shows the *check*'s own verdict (`degraded`), not the probe's — the
    // probe's own "Unreachable" badge is Queue-tab detail, checked below.
    expect(screen.getByText(/could not be reached/)).toBeTruthy()
    const card = serviceCard('Ghostfolio')
    const badge = card.querySelector('.badge')
    expect(badge?.textContent).toBe('Degraded')
    expect(badge?.className).toContain('badge--warn')

    await openQueue()
    const probeBadge = [...document.querySelectorAll('.badge')].find(
      (node) => node.textContent === 'Unreachable',
    )
    expect(probeBadge?.className).toContain('badge--warn')
  })

  it('shows a contract change as red and names the path', async () => {
    await show(withProbe('shape-mismatch'))

    expect(screen.getByText(/needs a Balancr update/)).toBeTruthy()
    const card = serviceCard('Ghostfolio')
    const badge = card.querySelector('.badge')
    expect(badge?.textContent).toBe('Failed')
    expect(badge?.className).toContain('badge--error')

    // The probe's own path-level detail is Queue-tab content now — the card above only
    // carries the verdict and the reason sentence.
    await openQueue()
    expect(screen.getByText('/api/v1/portfolio/holdings')).toBeTruthy()
    const probeBadge = [...document.querySelectorAll('.badge')].find(
      (node) => node.textContent === 'Unexpected shape',
    )
    expect(probeBadge?.className).toContain('badge--error')
    // The upstream's own words, quoted rather than paraphrased: it is not translated,
    // and on a Dutch page it will still be in English.
    const quote = screen.getByText(/expected number/)
    expect(quote.tagName).toBe('Q')
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
    await openQueue()

    expect(screen.getAllByText(/^03\/09\/2026, \d{2}:\d{2}$/)).toHaveLength(2)
    expect(screen.getByText(/^28\/08\/2026, \d{2}:\d{2}$/)).toBeTruthy()
    expect(screen.getByText('Budget sync')).toBeTruthy()
  })

  it('quotes the error rather than rewording it', async () => {
    await show(failing)
    await openQueue()
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
    await openQueue()

    expect(screen.getByText('reconcile')).toBeTruthy()
    expect(screen.queryByText('job.reconcile')).toBeNull()
    expect(screen.getAllByText('Never')).toHaveLength(3)
  })
})

describe('a job third in the queue', () => {
  it('reads as pending — er, queued — rather than as whatever it said before', async () => {
    await show(
      status({
        jobs: [
          {
            name: 'backfill',
            status: 'idle',
            lastRunAt: null,
            lastSuccessAt: null,
            nextRunAt: null,
            lastDurationMs: null,
            error: null,
            schedule: null,
          },
        ],
        queued: ['backfill'],
      }),
    )
    await openQueue()

    const badge = await screen.findByText('Queued')
    expect(badge.className).toContain('badge--info')
    // Never "Idle": once queued, the job's stale idle status is not the story.
    expect(screen.queryByText('Idle')).toBeNull()
  })

  it('leaves a job that is already running alone', async () => {
    await show(
      status({
        jobs: [
          {
            name: 'sync',
            status: 'running',
            lastRunAt: '2026-09-03T12:00:00.000Z',
            lastSuccessAt: null,
            nextRunAt: null,
            lastDurationMs: null,
            error: null,
            schedule: null,
          },
        ],
        // The job that just started is still in the in-flight set alongside its own
        // `running` row — the row wins, and the badge must not flicker to "Queued".
        queued: ['sync'],
      }),
    )
    await openQueue()

    await screen.findByText('Running')
    expect(screen.queryByText('Queued')).toBeNull()
  })
})

describe('a job’s run history', () => {
  /** A reply per path, mirroring the danger zone's own helper below. */
  function serveHistory(replies: Record<string, Response>): void {
    const mock = vi.fn((path: string) => {
      const reply = replies[path]
      if (reply === undefined) return Promise.reject(new Error(`unstubbed request: ${path}`))
      return Promise.resolve(reply.clone())
    })
    vi.stubGlobal('fetch', mock)
  }

  const oneJob = status({
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
  })

  it('is not fetched until the row is expanded', async () => {
    const mock = vi.fn((path: string) => {
      if (path === '/api/status') return Promise.resolve(json(oneJob))
      if (path === '/api/status/history?job=sync') {
        return Promise.resolve(json({ jobName: 'sync', runs: [] }))
      }
      return Promise.reject(new Error(`unstubbed request: ${path}`))
    })
    vi.stubGlobal('fetch', mock)
    renderApp(panel(true), {
      path: '/settings/status/queue',
    })
    await screen.findByText('Budget sync')

    expect(mock.mock.calls.map((call) => String(call[0]))).toEqual(['/api/status'])

    fireEvent.click(screen.getByRole('button', { name: 'Show history' }))
    await waitFor(() => {
      expect(mock).toHaveBeenCalledWith('/api/status/history?job=sync', expect.anything())
    })
    await screen.findByText('No runs recorded yet.')
  })

  it('shows each run with its own steps, and folds back away on collapse', async () => {
    serveHistory({
      '/api/status': json(oneJob),
      '/api/status/history?job=sync': json({
        jobName: 'sync',
        runs: [
          {
            status: 'partial',
            startedAt: '2026-09-03T12:00:00.000Z',
            finishedAt: '2026-09-03T12:00:04.000Z',
            durationMs: 4_120,
            error: null,
            steps: [
              { name: 'connect', status: 'ok', durationMs: 40, error: null },
              {
                name: 'fetch',
                status: 'error',
                durationMs: 900,
                error: 'Ghostfolio timed out after 30000ms',
              },
            ],
          },
        ],
      }),
    })
    renderApp(panel(true), {
      path: '/settings/status/queue',
    })
    await screen.findByText('Budget sync')

    fireEvent.click(screen.getByRole('button', { name: 'Show history' }))
    await screen.findByText('Connect')
    expect(screen.getByText('Fetch')).toBeTruthy()
    expect(screen.getByText('Ghostfolio timed out after 30000ms').tagName).toBe('Q')
    const partial = [...document.querySelectorAll('.badge')].find(
      (node) => node.textContent === 'Partially succeeded',
    )
    expect(partial?.className).toContain('badge--warn')

    fireEvent.click(screen.getByRole('button', { name: 'Hide history' }))
    expect(screen.queryByText('Connect')).toBeNull()
  })

  it('says so plainly when a job has never run', async () => {
    serveHistory({
      '/api/status': json(oneJob),
      '/api/status/history?job=sync': json({ jobName: 'sync', runs: [] }),
    })
    renderApp(panel(true), {
      path: '/settings/status/queue',
    })
    await screen.findByText('Budget sync')

    fireEvent.click(screen.getByRole('button', { name: 'Show history' }))
    await screen.findByText('No runs recorded yet.')
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

describe('the danger zone', () => {
  /** A reply per path, for the two endpoints this section's tests need together. */
  function serve(replies: Record<string, Response>): ReturnType<typeof vi.fn> {
    const mock = vi.fn((path: string) => {
      const reply = replies[path]
      if (reply === undefined) return Promise.reject(new Error(`unstubbed request: ${path}`))
      return Promise.resolve(reply.clone())
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  const resetAccepted: RefreshAccepted = {
    requested: ['sync', 'portfolio', 'networth', 'backfill', 'signals'],
    accepted: ['sync', 'portfolio', 'networth', 'backfill', 'signals'],
    startedAt: '2026-09-03T12:00:00.000Z',
  }

  it('disables the control for a viewer, without hiding what it would do', async () => {
    serve({ '/api/status': json(HEALTHY) })
    renderApp(panel(false), {
      path: '/settings/status/queue',
    })
    await screen.findByRole('heading', { level: 2, name: /Status|status/ })

    expect(screen.getByText(/Wipes every figure Balancr has computed/)).toBeTruthy()
    const start = screen.getByRole('button', { name: 'Reset all calculated data' })
    expect(start.hasAttribute('disabled')).toBe(true)
  })

  it('arms, confirms, and reports itself started', async () => {
    serve({
      '/api/status': json(HEALTHY),
      '/api/refresh/reset': json(resetAccepted, 202),
    })
    renderApp(panel(true), {
      path: '/settings/status/queue',
    })
    await screen.findByRole('heading', { level: 2, name: /Status|status/ })

    fireEvent.click(screen.getByRole('button', { name: 'Reset all calculated data' }))
    const confirm = screen.getByRole('button', { name: 'Yes, wipe and recompute' })
    expect(confirm.hasAttribute('disabled')).toBe(false)

    fireEvent.click(confirm)
    await screen.findByText('Started. The panel above will update as each job finishes.')
  })

  it('shares one busy state with the per-job buttons', async () => {
    serve({
      '/api/status': json(HEALTHY),
      '/api/refresh/reset': json(resetAccepted, 202),
    })
    renderApp(panel(true), {
      path: '/settings/status/queue',
    })
    await screen.findByRole('heading', { level: 2, name: /Status|status/ })

    fireEvent.click(screen.getByRole('button', { name: 'Reset all calculated data' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, wipe and recompute' }))

    await waitFor(() => {
      for (const control of screen.getAllByRole('button', { name: 'Run now' })) {
        expect(control.hasAttribute('disabled')).toBe(true)
      }
    })
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
    // Twice: Actual and Ghostfolio are both `failed` — unaffected by dropping the `jobs`
    // aggregate card, which was never `failed` in this fixture.
    expect(screen.getAllByText('Mislukt')).toHaveLength(2)
    // Once, not twice: only Actual's own reason is `jobFailed` among the two cards left.
    // The old `jobs` aggregate also carried `jobFailed`, but it is no longer shown (#325).
    expect(screen.getByText(/bij de laatste poging mislukt/)).toBeTruthy()
    expect(screen.getByText(/update van Balancr nodig/)).toBeTruthy()

    // The job's own error and its timestamp are Queue-tab content now.
    await openQueue()
    // Untranslated on purpose: Balancr did not write this sentence.
    expect(screen.getByText('connect ECONNREFUSED 172.19.0.4:5006')).toBeTruthy()
    // And the dates stay Belgian, which they were in English too: the interface language
    // and the formatting locale are separate settings, and this is where that shows.
    expect(screen.getByText(BELGIAN_DATETIME)).toBeTruthy()
  })
})
