/**
 * The refresh control: what it asks for, how it knows when it landed, and when it lies.
 *
 * The server half has its own suite — `test/unit/jobs-refresh.test.ts` for the expansion
 * and the one-at-a-time claim, `test/unit/server-api.test.ts` for the endpoint's guards.
 * What only a rendered page can show is the part #122 asks for by name:
 *
 *  - **A page asks for its own jobs.** The overview sends no list and gets the server's
 *    default; the budget page sends `sync`. A portfolio page that waited through a
 *    budget download would be the control everyone learns not to press.
 *  - **The dependents are named.** The server expands `sync` into three more jobs, and
 *    the response separates `requested` from `accepted` so the screen can say which
 *    figures moved that nobody asked about. Not naming them is the "leave it to whoever
 *    clicks" the issue forbids.
 *  - **"Done" is the job rows, not a timer.** Both halves of that test are checked here
 *    against rows that lie in each of the two ways they can: a row whose `lastRunAt` was
 *    written at the start of a run that is still going, and a queued job with no row at
 *    all. Either one taken alone would make the bar say "Refreshed" over stale figures.
 *  - **It stops waiting out loud.** Thirty seconds is the number in the issue; a minute
 *    is where this gives up, says the job is still going, and hands the button back.
 *
 * The four ways starting can fail are here too, because each has a different right
 * answer: a `409` is a sentence in the reader's own language, a rejected job name is the
 * server's sentence quoted, and a `401` is not this control's problem at all.
 *
 * Timers are faked. `POLL_MS` is two seconds and `MAX_TICKS` is thirty of them, so the
 * "gives up" test is a minute of waiting that has to cost nothing — and every advance is
 * inside `act`, because each tick is a state change React has to be allowed to commit.
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { useCallback, useState, type ReactNode } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionExpiryProvider } from '../src/api/resource.tsx'
import { StatusPanel } from '../src/settings/Status.tsx'
import type { Freshness, JobStatus, RefreshAccepted, Status } from '../src/shared.ts'
import { FreshnessBar } from '../src/ui/Refresh.tsx'
import { i18nReady, renderApp } from './helpers.tsx'

/** What the hook polls at, and how many of those before it stops. Mirrors `Refresh.tsx`. */
const POLL_MS = 2_000
const MAX_TICKS = 30

const STARTED_AT = '2026-09-03T08:00:00.000Z'
/** After the refresh began: what a finished job's row looks like. */
const AFTER = '2026-09-03T08:00:01.000Z'
/** Before it: the row a job that has not run again yet still has. */
const BEFORE = '2026-09-03T07:00:00.000Z'

type JobRowStatus = Freshness['jobs'][number]['status']

const job = (
  name: string,
  status: JobRowStatus,
  lastRunAt: string | null,
): Freshness['jobs'][number] => ({
  name,
  status,
  lastRunAt,
  lastSuccessAt: lastRunAt,
  error: null,
})

const fresh = (jobs: Freshness['jobs']): Freshness => ({
  stale: false,
  asOf: null,
  jobsEnabled: true,
  jobs,
})

const accepted = (requested: string[], all: string[]): RefreshAccepted => ({
  requested,
  accepted: all,
  startedAt: STARTED_AT,
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const fail = (status: number, code: string, message: string): Response =>
  json({ error: { code, message, requestId: 'req-1' } }, status)

/** One reply per path, and a rejection for anything a component asks for unexpectedly. */
function serve(replies: Record<string, Response | Error>): ReturnType<typeof vi.fn> {
  const mock = vi.fn((path: string) => {
    const reply = replies[path]
    if (reply === undefined) return Promise.reject(new Error(`unstubbed request: ${path}`))
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply.clone())
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

/** The body of the nth call, parsed. `undefined` when that call sent none. */
function sentBody(mock: ReturnType<typeof vi.fn>, index: number): unknown {
  const call: unknown[] = mock.mock.calls[index] ?? []
  const init = call[1]
  if (typeof init !== 'object' || init === null) return undefined
  const body = (init as { body?: unknown }).body
  return typeof body === 'string' ? JSON.parse(body) : undefined
}

/** Lets React commit whatever the elapsed timers set in motion. */
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

interface HostProps {
  /** The rows the bar starts with. */
  start: Freshness
  /** What a re-read answers with, if the test wants the jobs to land. */
  next?: Freshness
  jobs?: readonly string[]
}

/**
 * A page, reduced to the one thing the bar needs from it: an endpoint it can re-read.
 *
 * `onRefreshed` is memoised because the real one is `resource.reload`, which is stable —
 * a fresh identity every render would reset the poll timer on every commit, and a test
 * running against that would be testing a page no page is.
 */
function Host({ start, next, jobs }: HostProps): ReactNode {
  const [freshness, setFreshness] = useState(start)
  const onRefreshed = useCallback(() => {
    if (next !== undefined) setFreshness(next)
  }, [next])

  return (
    <FreshnessBar
      freshness={freshness}
      onRefreshed={onRefreshed}
      {...(jobs === undefined ? {} : { jobs })}
    />
  )
}

const button = (): HTMLElement => screen.getByRole('button', { name: /Refresh|Refreshing/ })

beforeAll(async () => {
  await i18nReady()
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('what a page asks for', () => {
  it('sends no list at all when it shows every figure', async () => {
    // The overview. A missing body is what the server reads as "the four data jobs",
    // and an empty array is the mistake it rejects — so this asserts the absence.
    const mock = serve({ '/api/refresh': json(accepted(['sync'], ['sync']), 202) })
    renderApp(<Host start={fresh([])} />)

    fireEvent.click(button())
    await tick()

    expect(mock.mock.calls[0]?.[0]).toBe('/api/refresh')
    expect(sentBody(mock, 0)).toBeUndefined()
  })

  it('names only its own jobs when it shows one source', async () => {
    const mock = serve({ '/api/refresh': json(accepted(['sync'], ['sync']), 202) })
    renderApp(<Host start={fresh([])} jobs={['sync']} />)

    fireEvent.click(button())
    await tick()

    expect(sentBody(mock, 0)).toEqual({ jobs: ['sync'] })
  })

  it('is not offered at all where the scheduler is switched off', () => {
    serve({})
    renderApp(<Host start={{ ...fresh([]), jobsEnabled: false }} />)

    // `/api/refresh` answers 403 on such a deployment. A button whose only possible
    // outcome is that is worse than the note explaining the age on its own.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('cannot be pressed twice while the jobs it started are running', async () => {
    serve({ '/api/refresh': json(accepted(['sync'], ['sync']), 202) })
    renderApp(<Host start={fresh([job('sync', 'running', STARTED_AT)])} />)

    fireEvent.click(button())
    await tick()

    expect(button().textContent).toBe('Refreshing…')
    expect(button().hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('status').textContent).toContain('The jobs are running')
  })
})

describe('waiting for the jobs to land', () => {
  it('says so once every accepted job has run since the refresh began', async () => {
    serve({ '/api/refresh': json(accepted(['sync'], ['sync', 'networth']), 202) })
    renderApp(
      <Host
        start={fresh([job('sync', 'running', STARTED_AT), job('networth', 'idle', BEFORE)])}
        next={fresh([job('sync', 'ok', AFTER), job('networth', 'ok', AFTER)])}
      />,
    )

    fireEvent.click(button())
    await tick()
    expect(screen.getByRole('status').textContent).toContain('The jobs are running')

    // The poll: one tick re-reads the endpoint, and the rows that come back are the
    // answer. Nothing here counts seconds towards "probably finished by now".
    await tick(POLL_MS)

    expect(screen.getByRole('status').textContent).toContain('Refreshed.')
    expect(button().textContent).toBe('Refresh')
    expect(button().hasAttribute('disabled')).toBe(false)
  })

  it('keeps waiting on a row still marked running, however new its timestamp', async () => {
    // The first of the two ways a row lies: `runJob` writes `lastRunAt` when a job
    // *starts*, so this row is newer than the refresh and the work is not done.
    serve({ '/api/refresh': json(accepted(['sync'], ['sync']), 202) })
    renderApp(
      <Host
        start={fresh([job('sync', 'idle', BEFORE)])}
        next={fresh([job('sync', 'running', AFTER)])}
      />,
    )

    fireEvent.click(button())
    await tick()
    await tick(POLL_MS)

    expect(screen.getByRole('status').textContent).toContain('The jobs are running')
    expect(screen.getByRole('status').textContent).not.toContain('Refreshed.')
  })

  it('keeps waiting on a job that is still queued behind another', async () => {
    // The second: a job the server accepted but has not started has written no row,
    // and an absent row read as "nothing to wait for" would end the wait early.
    serve({ '/api/refresh': json(accepted(['sync'], ['sync', 'signals']), 202) })
    renderApp(
      <Host
        start={fresh([job('sync', 'running', STARTED_AT)])}
        next={fresh([job('sync', 'ok', AFTER)])}
      />,
    )

    fireEvent.click(button())
    await tick()
    await tick(POLL_MS)

    expect(screen.getByRole('status').textContent).not.toContain('Refreshed.')
    expect(button().hasAttribute('disabled')).toBe(true)
  })

  it('names the jobs the server added to the request', async () => {
    serve({
      '/api/refresh': json(accepted(['sync'], ['sync', 'networth', 'signals']), 202),
    })
    renderApp(<Host start={fresh([])} jobs={['sync']} />)

    fireEvent.click(button())
    await tick()

    const line = screen.getByRole('status').textContent ?? ''
    expect(line).toContain('Net worth, Signals ran as well')
    // And not the job that was asked for: the sentence explains what nobody chose.
    expect(line).not.toContain('Budget sync ran as well')
  })

  it('gives up after a minute, says the job is still going, and hands the button back', async () => {
    serve({ '/api/refresh': json(accepted(['sync'], ['sync']), 202) })
    // No `next`: the rows never settle, which is what a long sync looks like from here.
    renderApp(<Host start={fresh([job('sync', 'running', STARTED_AT)])} />)

    fireEvent.click(button())
    await tick()
    for (let elapsed = 0; elapsed < MAX_TICKS; elapsed += 1) await tick(POLL_MS)

    const line = screen.getByRole('status').textContent ?? ''
    expect(line).toContain('Still running')
    expect(line).toContain('reload it to see the result')
    // Pressable again on purpose. It answers 409 while the job is still going, which
    // is the truth and is translated — see the test below.
    expect(button().hasAttribute('disabled')).toBe(false)
  })

  it('stops polling once it has given up', async () => {
    const mock = serve({ '/api/refresh': json(accepted(['sync'], ['sync']), 202) })
    renderApp(<Host start={fresh([job('sync', 'running', STARTED_AT)])} />)

    fireEvent.click(button())
    await tick()
    for (let elapsed = 0; elapsed < MAX_TICKS; elapsed += 1) await tick(POLL_MS)
    const settled = mock.mock.calls.length

    await tick(POLL_MS * 10)

    // The reason the limit exists: a page that kept asking every two seconds would
    // hammer its own server for as long as the tab stayed open.
    expect(mock.mock.calls.length).toBe(settled)
  })
})

describe('when it cannot start at all', () => {
  it('translates a refusal that something else is already running', async () => {
    serve({ '/api/refresh': fail(409, 'conflict', 'A refresh is already running.') })
    renderApp(<Host start={fresh([])} />)

    fireEvent.click(button())
    await tick()

    // The one failure with a catalogue string of its own, because it is the one whose
    // meaning the client knows: wait, then press it again.
    expect(screen.getByRole('status').textContent).toContain('Something is already running')
    expect(button().hasAttribute('disabled')).toBe(false)
  })

  it("quotes the server's own sentence for a job name it will not take", async () => {
    serve({ '/api/refresh': fail(400, 'bad_request', 'Unknown job: gremlins.') })
    renderApp(<Host start={fresh([])} jobs={['gremlins']} />)

    fireEvent.click(button())
    await tick()

    const line = screen.getByRole('status').textContent ?? ''
    expect(line).toContain('The refresh could not be started.')
    // Quoted rather than translated: a rate limit and a rejected name are not the same
    // message, and only the server knows which of them arrived.
    expect(line).toContain('Unknown job: gremlins.')
  })

  it('hands a vanished session to the application rather than reporting it', async () => {
    serve({ '/api/refresh': fail(401, 'unauthenticated', 'Sign in again.') })
    const onExpired = vi.fn()
    renderApp(
      <SessionExpiryProvider onExpired={onExpired}>
        <Host start={fresh([])} />
      </SessionExpiryProvider>,
    )

    fireEvent.click(button())
    await tick()

    expect(onExpired).toHaveBeenCalled()
  })
})

const jobRow = (name: string, status: JobRowStatus): JobStatus => ({
  name,
  status,
  lastRunAt: BEFORE,
  lastSuccessAt: BEFORE,
  nextRunAt: null,
  lastDurationMs: null,
  schedule: null,
  error: null,
})

const STATUS: Status = {
  ready: true,
  degraded: false,
  at: STARTED_AT,
  version: null,
  revision: null,
  jobsEnabled: true,
  checks: [{ name: 'database', status: 'ok', reason: null }],
  jobs: [
    jobRow('probe', 'ok'),
    jobRow('sync', 'ok'),
    jobRow('ai', 'ok'),
    // A row written by a version of Balancr this bundle has never seen.
    jobRow('gremlins', 'ok'),
  ],
  probes: [],
}

/** The list item a job's label sits in, so a click lands on that row's own button. */
function row(label: string): HTMLElement {
  const item = screen.getByText(label).closest('li')
  if (item === null) throw new Error(`no row for ${label}`)
  return item
}

describe('the per-job buttons on the status panel', () => {
  it('offers a run for the jobs the endpoint takes, and for no others', async () => {
    serve({ '/api/status': json(STATUS) })
    renderApp(<StatusPanel />)
    await tick()

    // `probe` and `sync`. Not `ai`, which has a priced control of its own on the panel
    // above, and not a name this build has never heard of — offering either would be a
    // button whose answer is an error.
    expect(screen.getAllByRole('button', { name: 'Run now' })).toHaveLength(2)
    expect(within(row('AI analysis')).queryByRole('button')).toBeNull()
    expect(within(row('gremlins')).queryByRole('button')).toBeNull()
  })

  it('asks for that job alone', async () => {
    const mock = serve({
      '/api/status': json(STATUS),
      '/api/refresh': json(accepted(['sync'], ['sync', 'networth', 'signals']), 202),
    })
    renderApp(<StatusPanel />)
    await tick()

    fireEvent.click(within(row('Budget sync')).getByRole('button', { name: 'Run now' }))
    await tick()

    expect(sentBody(mock, 1)).toEqual({ jobs: ['sync'] })
    // One hook for the whole list, so the rest of the panel cannot spend a press on a
    // 409 while this one is outstanding.
    for (const control of screen.getAllByRole('button', { name: 'Run now' })) {
      expect(control.hasAttribute('disabled')).toBe(true)
    }
  })
})
