/**
 * The button that says "not that old, please", and the state that says one is running.
 *
 * Everything on every page is served out of Balancr's own SQLite, written by jobs that
 * run on a schedule — so the honest answer to "these figures look wrong" is often "they
 * are from last night". `FreshnessNote` next door says how old they are; this says what
 * to do about it, in the one place where the reader has just read the age.
 *
 * Four decisions, each of which has a failure it exists to prevent:
 *
 *  - **A page asks for the jobs it shows, not for all of them.** The budget page's
 *    figures come from `sync`, the portfolio page's from `portfolio`. Pressing refresh
 *    on the portfolio page and waiting through a full budget download is how a control
 *    gets described as slow. The overview shows both, so it asks for everything by
 *    sending no list at all and letting the server name its own default.
 *  - **The dependents the server added are named on screen.** `POST /api/refresh`
 *    expands what it was asked for — a `sync` invalidates net worth and the signals
 *    computed from it — and answers with `requested` and `accepted` separately. Showing
 *    only "refreshed" would leave someone who asked for the budget wondering why the
 *    portfolio page's numbers moved too. `src/jobs/refresh.ts` argues the expansion;
 *    this is the half of that argument the reader can see.
 *  - **Done is a fact about the jobs, not a timer.** The response is a `202`: it means
 *    the work was accepted, not that it happened. So this polls the page's own endpoint
 *    and treats a job as finished only when its row says something other than `running`
 *    *and* its `lastRunAt` is at or after the instant the refresh started. Both halves
 *    are needed. `runJob` writes `lastRunAt` when it *starts*, so the timestamp alone is
 *    true immediately; and a job still queued behind another has no new row at all,
 *    which is why a missing row counts as unfinished rather than as done.
 *  - **It stops polling before it stops being true.** A sync against a large budget can
 *    outlast anybody's patience, and a page that reloaded itself every two seconds for
 *    ten minutes is a page that hammers its own server. After a minute it says so and
 *    hands the reader back the button — pressing it again answers `409`, which is the
 *    truth, translated below.
 *
 * The AI pass is deliberately not startable from here. It is the one job that spends
 * money, `POST /api/refresh` refuses it by name, and the control for it lives on the
 * settings page beside the month's spend and the price of a run — see `Spend.tsx`.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ApiError, apiSend } from '../api/client.ts'
import { useCsrf } from '../api/csrf.tsx'
import { useSessionExpiry } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import type { Freshness, RefreshAccepted } from '../shared.ts'
import { FreshnessNote } from './Freshness.tsx'

/** How often the page re-reads its endpoint while a refresh is outstanding. */
const POLL_MS = 2_000

/** How many of those before it gives up waiting and says so. One minute. */
const MAX_TICKS = 30

/**
 * The part of a job row this needs, which both payloads that carry one already have.
 *
 * `/api/*` responses carry `freshness.jobs` and `/api/status` carries `jobs`; the two
 * differ in what else they hold, not in these three fields. Taking the narrow shape
 * means the hook works for both without either payload growing a field for its sake.
 */
export interface JobProgress {
  name: string
  status: string
  lastRunAt: string | null
}

type RefreshState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | {
      kind: 'running'
      /** The server's instant, compared against the server's `lastRunAt`. No client clock. */
      startedAt: number
      accepted: readonly string[]
      /** What the server added to the request. Named on screen; see the header. */
      extra: readonly string[]
      ticks: number
    }
  | { kind: 'done'; extra: readonly string[] }
  /** Still going after `MAX_TICKS`. Not an error — nothing failed, this stopped watching. */
  | { kind: 'slow' }
  /** A `409`: something else is already running. */
  | { kind: 'busy' }
  | { kind: 'failed'; message: string }

/**
 * Whether every job the server accepted has finished since the refresh began.
 *
 * See the header for why both conditions are load-bearing, and why an absent row is
 * "not yet" rather than "nothing to wait for".
 */
function finished(
  rows: readonly JobProgress[],
  startedAt: number,
  names: readonly string[],
): boolean {
  return names.every((name) => {
    const row = rows.find((candidate) => candidate.name === name)
    if (row === undefined || row.status === 'running' || row.lastRunAt === null) return false
    return Date.parse(row.lastRunAt) >= startedAt
  })
}

export interface Refresher {
  state: RefreshState
  /** True while a request or the jobs it started are outstanding. */
  busy: boolean
  /** Undefined asks for the server's default set, which is every data job. */
  start: (jobs?: readonly string[]) => void
}

/**
 * Starts a refresh and watches for it to land.
 *
 * A hook rather than a component because it has two hosts with nothing else in common:
 * the bar at the top of a page, and the per-job buttons in the settings status panel.
 * One instance per host, which is also the reason a panel of eight buttons can only
 * have one of them outstanding — the server allows one refresh at a time, and a control
 * that let two be pressed would spend the second one on a `409`.
 *
 * `rows` is read on every render rather than captured, so the poll below compares
 * against the answer that has just arrived.
 */
export function useRefresh(rows: readonly JobProgress[], onRefreshed: () => void): Refresher {
  const csrf = useCsrf()
  const expired = useSessionExpiry()
  const [state, setState] = useState<RefreshState>({ kind: 'idle' })

  const landed = state.kind === 'running' && finished(rows, state.startedAt, state.accepted)

  useEffect(() => {
    if (state.kind !== 'running') return
    if (landed) {
      setState({ kind: 'done', extra: state.extra })
      return
    }
    if (state.ticks >= MAX_TICKS) {
      setState({ kind: 'slow' })
      return
    }
    const timer = setTimeout(() => {
      // The counter and the reload together: the effect re-runs on the new tick count,
      // by which time the request it just asked for is on its way.
      setState((current) =>
        current.kind === 'running' ? { ...current, ticks: current.ticks + 1 } : current,
      )
      onRefreshed()
    }, POLL_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [state, landed, onRefreshed])

  const start = useCallback(
    (jobs?: readonly string[]): void => {
      setState({ kind: 'starting' })
      // No body at all rather than an empty list: the server reads a missing body as
      // "every data job", and an empty array as the mistake it is.
      const body = jobs === undefined ? undefined : { jobs: [...jobs] }

      void apiSend<RefreshAccepted>('POST', '/api/refresh', body, csrf)
        .then((accepted) => {
          setState({
            kind: 'running',
            startedAt: Date.parse(accepted.startedAt),
            accepted: accepted.accepted,
            extra: accepted.accepted.filter((name) => !accepted.requested.includes(name)),
            ticks: 0,
          })
        })
        .catch((cause: unknown) => {
          const failure =
            cause instanceof ApiError
              ? cause
              : new ApiError('network_error', 'Balancr could not be reached.', 0, null)
          // A vanished session is the application's problem rather than this control's,
          // exactly as it is for a read. See `useResource`.
          if (failure.code === 'unauthenticated') expired()
          setState(
            failure.code === 'conflict'
              ? { kind: 'busy' }
              : // The server's sentence, which is English on a Dutch page. Every other
                // outcome here has a catalogue string; this one cannot, because a rate
                // limit and a rejected job name are not the same message and only the
                // server knows which arrived.
                { kind: 'failed', message: failure.message },
          )
        })
    },
    [csrf, expired],
  )

  return { state, busy: state.kind === 'starting' || state.kind === 'running', start }
}

/**
 * What a refresh is doing, in one line, for a screen reader as much as for a reader.
 *
 * `role="status"` on the wrapper rather than on each branch: the states replace one
 * another, and a live region that is created and destroyed announces nothing in some
 * browsers. Idle renders the region empty rather than removing it, for the same reason.
 */
export function RefreshStatus({ state }: { state: RefreshState }): ReactNode {
  const { t } = useT()

  return (
    <div className="freshbar__status" role="status">
      {state.kind === 'starting' || state.kind === 'running' ? (
        <p className="freshbar__line muted">{t('refresh.started')}</p>
      ) : null}

      {state.kind === 'done' ? (
        <p className="freshbar__line muted">{t('refresh.finished')}</p>
      ) : null}

      {(state.kind === 'running' || state.kind === 'done') && state.extra.length > 0 ? (
        <p className="freshbar__line muted">
          {t('refresh.alsoRan', {
            jobs: state.extra.map((name) => t(`job.${name}`)).join(', '),
          })}
        </p>
      ) : null}

      {state.kind === 'slow' ? <p className="freshbar__line muted">{t('refresh.slow')}</p> : null}

      {state.kind === 'busy' ? <p className="freshbar__line muted">{t('refresh.busy')}</p> : null}

      {state.kind === 'failed' ? (
        <div className="freshbar__line notice notice--error">
          <p className="notice__lead">{t('refresh.failed')}</p>
          <p className="notice__meta">{state.message}</p>
        </div>
      ) : null}
    </div>
  )
}

export interface FreshnessBarProps {
  freshness: Freshness
  /**
   * The jobs whose output this page shows, or omitted for every data job.
   *
   * A module constant at the call site rather than a literal in the JSX, so the
   * identity is stable and `start` is not rebuilt on every render.
   */
  jobs?: readonly string[]
  /** Re-reads the page's own endpoint. `resource.reload`, threaded down from the page. */
  onRefreshed: () => void
}

/**
 * The age of the figures and the button that changes it, as one block.
 *
 * A wrapper rather than a button added inside `FreshnessNote`, because that component
 * renders *nothing* on a deployment where no job has ever run — which is exactly the
 * installation whose owner most wants something to press.
 *
 * Hidden entirely when this instance schedules nothing: `JOBS_ENABLED=false` means a
 * second instance or a copy of the database, `/api/refresh` answers `403` there, and a
 * button whose only outcome is that is worse than no button. The note explains the age
 * in that case, which is what it is for.
 */
export function FreshnessBar({ freshness, jobs, onRefreshed }: FreshnessBarProps): ReactNode {
  const { t } = useT()
  const refresher = useRefresh(freshness.jobs, onRefreshed)

  return (
    <div className="freshbar">
      <div className="freshbar__note">
        <FreshnessNote freshness={freshness} />
        <RefreshStatus state={refresher.state} />
      </div>

      {freshness.jobsEnabled ? (
        <button
          type="button"
          className="button button--quiet"
          disabled={refresher.busy}
          onClick={() => {
            refresher.start(jobs)
          }}
        >
          {refresher.busy ? t('refresh.running') : t('action.refresh')}
        </button>
      ) : null}
    </div>
  )
}
