/**
 * Whether this instance is working, and if not, which half of it is not.
 *
 * The panel exists because of a specific failure: everything on the budget pages is
 * served out of Balancr's own SQLite, so a Ghostfolio that went away last Tuesday
 * changes nothing on screen except the age of one figure. The site looks correct. The
 * only place that can say otherwise is a page that reports on the jobs rather than on
 * their output, which is this one.
 *
 * Three differences from the five panels above it:
 *
 *  - **It fetches its own endpoint.** `/api/status` is not part of the settings
 *    payload, and should not be: the settings payload is re-read only when someone
 *    presses retry, whereas this is the one thing on the page whose value decays while
 *    it is on screen. So it carries a refresh of its own, and it is the only panel
 *    that can be the thing that failed to load while the rest of the page is fine.
 *  - **Almost nothing here writes.** Every per-job button and the reload beneath the
 *    probe section start or re-read, never change judgement, so the panel still takes
 *    `owner` only for the one control that is not like the others — see the danger
 *    zone below. A viewer sees every other button enabled: someone who cannot change a
 *    threshold is often exactly the person asking why the numbers look old.
 *  - **The text is in two registers.** A `reason` is a code, translated here; a job's
 *    `error` and a probe check's `error` are quoted, because they are what an upstream
 *    said and translating them would be inventing. Quoted strings are marked as
 *    quotations rather than styled as the application's own prose.
 *
 * `/readyz` answers the same question for a machine, in less detail and without a
 * session, and `src/server/routes/api/status.ts` explains why the detailed half needs
 * one: a probe error can carry an internal container address.
 *
 * It is also the only screen from which `probe`, `backfill` and `backup` can be started.
 * None has a page of its own — one writes no figures at all, one fills in months that are
 * already past, and one writes a file nothing on screen reads — so the panel that reports
 * on the jobs is where "run that one again" belongs. The four data jobs are startable here
 * too, and from the bar at the top of the page whose figures they produce.
 *
 * And it is the only screen with the reset control described in `ResetControl` below —
 * owner-only, because unlike every other button here it deletes rows before anything
 * starts. See `src/domain/aggregate/reset.ts` for what it deletes and what it never does.
 */
import { useState, type ReactNode } from 'react'
import { useResource } from '../api/resource.tsx'
import { useT } from '../i18n.ts'
import { formatDateTime, formatDecimal } from '../shared.ts'
import type {
  AiAvailabilityWire,
  JobHistory,
  JobStatus,
  JobStep,
  ProbeStatus,
  Status,
} from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { RefreshStatus, useRefresh, type Refresher } from '../ui/Refresh.tsx'
import { SectionNav } from '../ui/SectionNav.tsx'
import { useSubsection, type Section } from '../ui/sections.ts'
import { Panel } from './Panel.tsx'

/**
 * Services (the three at-a-glance cards, #325) versus Queue (everything that used to
 * sit under the old flat `checks` list: the job list, the reset control and the probe
 * detail). Nested one level under the page's own `general`/`status` split — `sections.ts`'s
 * own prefix matching is written to support that, so this is plain reuse rather than a
 * new mechanism.
 */
type StatusSubsectionId = 'services' | 'queue'

const STATUS_SUBSECTIONS: readonly Section<StatusSubsectionId>[] = [
  { id: 'services', path: '/settings/status', labelKey: 'settings:status.nav.services' },
  { id: 'queue', path: '/settings/status/queue', labelKey: 'settings:status.nav.queue' },
]

/**
 * The jobs `POST /api/refresh` will start, mirroring `REFRESHABLE` in
 * `src/jobs/refresh.ts` — minus `ai`, which that endpoint refuses by name because it is
 * the one job that spends money. Its control is in the panel above, priced first.
 *
 * A copy rather than an import: pulling `src/jobs/refresh.ts` into the browser bundle
 * would drag the runner, the schema and the configuration in with it. A test in
 * `test/unit/jobs-refresh.test.ts` reads this file and fails if the copy drifts, which is
 * the same arrangement `DATA_JOBS` in `ui/Freshness.tsx` has.
 */
const REFRESHABLE = [
  'probe',
  'sync',
  'portfolio',
  'networth',
  'backfill',
  'signals',
  'backup',
]

/**
 * Verdict to badge tone, for all three status vocabularies at once — the four check
 * verdicts, the job states (now including a run's own history) and the three probe
 * outcomes.
 *
 * `degraded` and `unreachable` are amber rather than red deliberately: both mean the
 * pages on screen are still correct and the cause will probably clear on its own.
 * `shape-mismatch` is red because nothing clears it but a new version of Balancr. The
 * states with no entry — `idle`, `unknown` — get the neutral badge, which is the right
 * answer for "nothing has happened yet": a new deployment is not a fault, and colouring
 * it would make every first run look like a problem.
 *
 * `partial` shares `degraded`'s amber for the same reason: a run that finished but had
 * one failing step is "still worth a look", not a failure. `queued` shares `running`'s
 * blue — nothing wrong, just not started yet. It is deliberately not called `pending`:
 * that catalogue key already means "awaiting review" for a proposal decision, and
 * reusing it here would print that sentence on a job that has never been reviewed by
 * anyone.
 */
const TONES: Record<string, 'ok' | 'info' | 'warn' | 'error'> = {
  ok: 'ok',
  running: 'info',
  queued: 'info',
  degraded: 'warn',
  partial: 'warn',
  unreachable: 'warn',
  failed: 'error',
  error: 'error',
  'shape-mismatch': 'error',
}

/** The camelCase catalogue key for a status the database spells with a hyphen. */
const statusKey = (status: string): string =>
  status.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

function Badge({ status }: { status: string }): ReactNode {
  const { t } = useT()
  const tone = TONES[status]
  return (
    <span className={tone === undefined ? 'badge' : `badge badge--${tone}`}>
      {t(`status.${statusKey(status)}`)}
    </span>
  )
}

/**
 * A string an upstream produced, shown as one.
 *
 * `<q>` rather than a styled paragraph: the sentence is not Balancr's, it is not
 * translated, and on a Dutch page it will be in English. Marking it as a quotation is
 * the one honest way to put it on the screen.
 */
function Quoted({ text }: { text: string }): ReactNode {
  return <q className="status__quote">{text}</q>
}

export function StatusPanel({
  owner,
  aiAvailability,
}: {
  owner: boolean
  aiAvailability: AiAvailabilityWire
}): ReactNode {
  const { t } = useT()
  const resource = useResource<Status>('/api/status')

  return (
    <Panel title={t('settings:status.title')} hint={t('settings:status.lede')}>
      <DataState resource={resource}>
        {(status) => (
          <Report
            status={status}
            owner={owner}
            reload={resource.reload}
            aiAvailability={aiAvailability}
          />
        )}
      </DataState>
    </Panel>
  )
}

/**
 * The panel's body, split out so it can hold the refresh hook.
 *
 * `useRefresh` cannot be called in the render callback `DataState` invokes — that is a
 * function called inside another component's render, not a component of its own, so a
 * hook there would break the order rules the first time the resource went from loading
 * to loaded. One hook for the whole list, which is also why only one job can be
 * outstanding: the server runs one refresh at a time, and a second button would spend
 * its press on a `409`.
 */
function Report({
  status,
  owner,
  reload,
  aiAvailability,
}: {
  status: Status
  owner: boolean
  reload: () => void
  aiAvailability: AiAvailabilityWire
}): ReactNode {
  const { t } = useT()
  const refresher = useRefresh(status.jobs, reload)
  const active = useSubsection(STATUS_SUBSECTIONS)

  return (
    <>
      <p
        className={status.ready ? 'status__verdict' : 'status__verdict notice notice--error'}
      >
        {status.ready ? t('settings:status.serving') : t('settings:status.notServing')}
        {status.degraded ? ` ${t('settings:status.degraded')}` : ''}
      </p>

      <SectionNav
        sections={STATUS_SUBSECTIONS}
        variant="sub"
        ariaLabel={t('settings:status.title')}
      />

      {active === 'services' ? (
        <ServicesGrid status={status} aiAvailability={aiAvailability} />
      ) : (
        <>
          <h3 className="panel__subtitle">{t('settings:status.jobs.title')}</h3>
          <RefreshStatus state={refresher.state} />
          <div className="grid-cards">
            {status.jobs.map((job) => (
              <JobRow job={job} queued={status.queued} refresher={refresher} key={job.name} />
            ))}
          </div>

          <ResetControl owner={owner} refresher={refresher} />

          <h3 className="panel__subtitle">{t('settings:status.probe.title')}</h3>
          <p className="panel__hint muted">{t('settings:status.probe.lede')}</p>
          {status.probes.length === 0 ? (
            <p className="muted">{t('settings:status.probe.notRunYet')}</p>
          ) : (
            status.probes.map((probe) => <ProbeReport probe={probe} key={probe.source} />)
          )}
        </>
      )}

      {/* Re-reads this panel's own endpoint. It starts nothing; the per-job buttons do.
          Shared across both tabs — the same request refreshes the cards and the queue. */}
      <button type="button" className="button button--quiet" onClick={reload}>
        {t('action.refresh')}
      </button>
    </>
  )
}

/**
 * The three services someone actually thinks about, at a glance — replacing the old
 * flat `checks` list. `database` and the `jobs` aggregate check are dropped rather than
 * shown as a fourth/fifth card: `database` is already the top banner's `ready` state,
 * and `jobs` is strictly subsumed by the per-job list on the Queue tab.
 */
function ServicesGrid({
  status,
  aiAvailability,
}: {
  status: Status
  aiAvailability: AiAvailabilityWire
}): ReactNode {
  const { t } = useT()
  const check = (name: string) => status.checks.find((c) => c.name === name) ?? null
  const job = (name: string) => status.jobs.find((j) => j.name === name) ?? null

  const actual = check('actual')
  // Actual's own job is `sync`; Ghostfolio's is `portfolio` — see `src/jobs/portfolio.ts`.
  const ghostfolio = check('ghostfolio')
  const syncedActual = job('sync')?.lastSuccessAt ?? null
  const syncedGhostfolio = job('portfolio')?.lastSuccessAt ?? null
  const aiReason = aiAvailability.reason ?? 'notConfigured'

  return (
    <div className="grid-cards">
      <ServiceCard
        name={t('settings:status.check.actual')}
        status={actual?.status ?? 'unknown'}
        reason={
          actual?.reason == null ? null : t(`settings:status.reason.${actual.reason}`)
        }
        lastSyncedAt={syncedActual}
      />
      <ServiceCard
        name={t('settings:status.check.ghostfolio')}
        status={ghostfolio?.status ?? 'unknown'}
        reason={
          ghostfolio?.reason == null ? null : t(`settings:status.reason.${ghostfolio.reason}`)
        }
        lastSyncedAt={syncedGhostfolio}
      />
      <ServiceCard
        name={t('settings:status.check.ai')}
        status={aiAvailability.enabled ? 'ok' : 'unknown'}
        reason={aiAvailability.enabled ? null : t(`ai:off.reason.${aiReason}`)}
      />
    </div>
  )
}

/**
 * One service's card: a header (name + badge), an optional "last synced" line and an
 * optional reason sentence — the same three pieces of information the old flat list
 * showed per check, reused via `.status__meta`/`.status__reason` rather than a new
 * visual vocabulary.
 *
 * `lastSyncedAt` is left `undefined` for the AI card, which has no job of its own: `null`
 * means "never", `undefined` means "not applicable" and the line is not rendered at all.
 */
function ServiceCard({
  name,
  status,
  reason,
  lastSyncedAt,
}: {
  name: string
  status: string
  reason: string | null
  lastSyncedAt?: string | null
}): ReactNode {
  const { t } = useT()

  return (
    <div className="card status__service">
      <p className="status__serviceHead">
        <span className="status__name">{name}</span>
        <Badge status={status} />
      </p>
      {lastSyncedAt === undefined ? null : (
        <dl className="status__meta">
          <dt>{t('settings:status.services.lastSynced')}</dt>
          <dd className="num">
            {lastSyncedAt === null ? t('settings:status.jobs.never') : formatDateTime(lastSyncedAt)}
          </dd>
        </dl>
      )}
      {reason === null ? null : <p className="status__reason muted">{reason}</p>}
    </div>
  )
}

/**
 * The owner's escape hatch for a computed column that shipped stale or missing.
 *
 * Two presses, the same weight `Spend.tsx`'s `Rerun` gives the one other
 * consequential button in settings — a wipe is not undoable, even though what
 * it wipes is regenerated within seconds. The warning line says what survives
 * (Actual, Ghostfolio, everything the owner has configured or decided) before
 * the button that destroys everything else, the same order `Rerun` states a
 * price before the button that spends it.
 *
 * Shares `refresher.state`/`.busy` with every per-job button in this panel —
 * see `startReset` in `ui/Refresh.tsx` for why that sharing is load-bearing
 * rather than incidental. A viewer sees the same disabled treatment `Rerun`
 * gives one: `!owner` disables the button, it does not hide the section, so
 * the person who cannot press it can still read what it would do.
 */
function ResetControl({ owner, refresher }: { owner: boolean; refresher: Refresher }): ReactNode {
  const { t } = useT()
  const [armed, setArmed] = useState(false)

  const started = refresher.state.kind === 'done' || refresher.state.kind === 'running'

  return (
    <section className="rerun">
      <h3 className="panel__subtitle">{t('settings:status.reset.title')}</h3>
      <p className="muted">{t('settings:status.reset.warning')}</p>

      {armed ? (
        <div className="rerun__confirm">
          <button
            type="button"
            className="button"
            disabled={!owner || refresher.busy}
            onClick={() => {
              refresher.startReset()
            }}
          >
            {refresher.state.kind === 'starting'
              ? t('settings:status.reset.starting')
              : t('settings:status.reset.confirm')}
          </button>
          <button
            type="button"
            className="button button--quiet"
            disabled={refresher.busy}
            onClick={() => setArmed(false)}
          >
            {t('settings:status.reset.cancel')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button button--quiet"
          disabled={!owner || refresher.busy}
          onClick={() => setArmed(true)}
        >
          {t('settings:status.reset.start')}
        </button>
      )}

      {started ? (
        <p className="muted">{t('settings:status.reset.started')}</p>
      ) : null}
    </section>
  )
}

/**
 * `job.status` plus what `job.status` cannot say: a job third in the queue has not
 * written a `running` row yet (see `jobsInFlight`'s own comment in `runner.ts` for why
 * that gap exists), so a name in `queued` whose row is not already `running` reads as
 * `queued` rather than as whatever it said before it was asked to run again.
 */
function displayStatus(job: JobStatus, queued: readonly string[]): string {
  if (job.status !== 'running' && queued.includes(job.name)) return 'queued'
  return job.status
}

/**
 * One job, with both of its timestamps.
 *
 * Last attempt and last success are separate rows because the difference between them
 * is the whole point: a job that has been failing for a week has a recent attempt and
 * a stale success, and a panel showing only "last run" would read as healthy.
 *
 * The button appears only for a job this build knows `/api/refresh` will accept. A row
 * exists for whatever the database holds — including `ai`, and including a name written
 * by a later version of Balancr — and offering to start something the server answers
 * `400` for is worse than offering nothing.
 *
 * History is fetched only once expanded — `armed`, same toggle `ResetControl` uses
 * above, mounts `JobHistory` on demand rather than every row fetching its own history on
 * every poll of this panel.
 */
function JobRow({
  job,
  queued,
  refresher,
}: {
  job: JobStatus
  queued: readonly string[]
  refresher: Refresher
}): ReactNode {
  const { t } = useT()
  const [expanded, setExpanded] = useState(false)

  // i18next answers an unknown key with the key. A `jobs` row is written by whichever
  // build last ran, so a name this bundle has no string for is a real possibility —
  // and its own name is a better label than `job.whatever`.
  const key = `job.${job.name}`
  const label = t(key)

  const never = t('settings:status.jobs.never')
  const when = (iso: string | null): string => (iso === null ? never : formatDateTime(iso))

  return (
    <div className="card status__job">
      <p className="status__jobHead">
        <span className="status__name">{label === key ? job.name : label}</span>
        <Badge status={displayStatus(job, queued)} />
      </p>
      <dl className="status__meta">
        <dt>{t('settings:status.jobs.lastRun')}</dt>
        <dd className="num">{when(job.lastRunAt)}</dd>
        <dt>{t('settings:status.jobs.lastSuccess')}</dt>
        <dd className="num">{when(job.lastSuccessAt)}</dd>
        <dt>{t('settings:status.jobs.nextRun')}</dt>
        <dd className="num">{when(job.nextRunAt)}</dd>
        {job.lastDurationMs === null ? null : (
          <>
            <dt>{t('settings:status.jobs.took')}</dt>
            <dd className="num">
              {t('settings:status.jobs.seconds', {
                value: formatDecimal(job.lastDurationMs / 1000, 1),
              })}
            </dd>
          </>
        )}
        {job.schedule === null ? null : (
          <>
            <dt>{t('settings:status.jobs.schedule')}</dt>
            <dd>{job.schedule}</dd>
          </>
        )}
      </dl>
      {job.error === null ? null : (
        <p className="status__error">
          <Quoted text={job.error} />
        </p>
      )}
      <div className="status__jobActions">
        {REFRESHABLE.includes(job.name) ? (
          <button
            type="button"
            className="button button--quiet status__run"
            disabled={refresher.busy}
            onClick={() => {
              refresher.start([job.name])
            }}
          >
            {t('refresh.job')}
          </button>
        ) : null}
        <button
          type="button"
          className="button button--quiet"
          onClick={() => setExpanded((was) => !was)}
        >
          {expanded
            ? t('settings:status.history.hide')
            : t('settings:status.history.show')}
        </button>
      </div>
      {expanded ? <JobHistory jobName={job.name} /> : null}
    </div>
  )
}

/**
 * One job's past attempts, fetched only once its row is expanded.
 *
 * A separate request from `/api/status` on purpose — see that endpoint's own header:
 * the panel above is polled broadly and stays light, and history is bounded, paged, and
 * only wanted on demand. Mounting on demand is what makes the fetch on demand:
 * `useResource` itself fetches on mount and needs no change for that.
 */
function JobHistory({ jobName }: { jobName: string }): ReactNode {
  const { t } = useT()
  const resource = useResource<JobHistory>(
    `/api/status/history?job=${encodeURIComponent(jobName)}`,
  )

  return (
    <div className="status__history">
      <DataState resource={resource}>
        {(history) =>
          history.runs.length === 0 ? (
            <p className="muted">{t('settings:status.history.empty')}</p>
          ) : (
            <ul className="status__runs">
              {history.runs.map((run) => (
                <li className="status__historyRun" key={run.startedAt}>
                  <p className="status__historyRunHead">
                    <Badge status={run.status} />
                    <span className="muted num">{formatDateTime(run.startedAt)}</span>
                    {run.durationMs === null ? null : (
                      <span className="muted num">
                        {t('settings:status.jobs.seconds', {
                          value: formatDecimal(run.durationMs / 1000, 1),
                        })}
                      </span>
                    )}
                  </p>
                  {run.error === null ? null : (
                    <p className="status__error">
                      <Quoted text={run.error} />
                    </p>
                  )}
                  {run.steps.length === 0 ? null : (
                    <ul className="status__steps">
                      {run.steps.map((step) => (
                        <JobStepRow step={step} key={step.name} />
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </DataState>
    </div>
  )
}

/** One named sub-step of a run — same shape as `ProbeReport`'s per-path checks below. */
function JobStepRow({ step }: { step: JobStep }): ReactNode {
  const { t } = useT()

  const key = `step.${step.name}`
  const label = t(key)

  return (
    <li className="status__step">
      <span className="status__name">{label === key ? step.name : label}</span>
      <Badge status={step.status} />
      <span className="muted num">
        {t('settings:status.jobs.seconds', { value: formatDecimal(step.durationMs / 1000, 1) })}
      </span>
      {step.error === null ? null : <Quoted text={step.error} />}
    </li>
  )
}

/**
 * The per-path detail behind one upstream's verdict.
 *
 * Which path broke is the actionable part — three of the four endpoints Balancr reads
 * from Ghostfolio are its frontend's internal API, so "the holdings endpoint changed
 * shape" and "Ghostfolio is down" are the same status to a container and completely
 * different afternoons to a person.
 */
function ProbeReport({ probe }: { probe: ProbeStatus }): ReactNode {
  const { t } = useT()

  return (
    <div className="card status__probe">
      <p className="status__probeHead">
        <span className="status__name">{t(`source.${probe.source}`)}</span>
        <Badge status={probe.status} />
        <span className="muted num">
          {t('settings:status.probe.checkedAt', { when: formatDateTime(probe.checkedAt) })}
        </span>
      </p>

      {probe.detailAvailable ? null : (
        <p className="muted">{t('settings:status.probe.noDetail')}</p>
      )}

      {probe.checks.length === 0 ? null : (
        <ul className="status__paths">
          {probe.checks.map((check) => (
            <li className="status__path" key={check.path}>
              <code>{check.path}</code>
              <Badge status={check.status} />
              <span className="muted">{check.detail}</span>
              {check.error === undefined ? null : <Quoted text={check.error} />}
            </li>
          ))}
        </ul>
      )}

      {probe.warnings.length === 0 ? null : (
        <>
          <p className="status__warnHead">{t('settings:status.probe.warnings')}</p>
          <ul className="status__warnings">
            {probe.warnings.map((warning) => (
              <li key={warning}>
                <Quoted text={warning} />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
