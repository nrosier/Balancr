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
import { Link } from '../router.tsx'
import {
  formatBp,
  formatDateTime,
  formatDecimal,
  formatMicroEur,
  formatMonth,
} from '../shared.ts'
import type {
  AiAvailabilityWire,
  AiEstimate,
  JobHistory,
  JobStatus,
  JobStep,
  ProbeStatus,
  RefreshAccepted,
  Settings,
  Status,
} from '../shared.ts'
import { DataState } from '../ui/DataState.tsx'
import { Metric } from '../ui/Metric.tsx'
import { RefreshStatus, useRefresh, type Refresher } from '../ui/Refresh.tsx'
import { SectionNav } from '../ui/SectionNav.tsx'
import { useSubsection, type Section } from '../ui/sections.ts'
import { Panel } from './Panel.tsx'
import type { SettingsPanelProps } from './state.ts'

/**
 * Services (the three at-a-glance cards, #325) versus Queue (everything that used to
 * sit under the old flat `checks` list: the job list, the reset control and the probe
 * detail) versus AI (the cost/usage monitoring that used to be its own Settings tab —
 * reached only by clicking the AI service card, since nothing on it is a setting).
 * Nested one level under the page's own `general`/`status` split — `sections.ts`'s
 * own prefix matching is written to support that, so this is plain reuse rather than a
 * new mechanism.
 */
type StatusSubsectionId = 'services' | 'queue' | 'ai'

const STATUS_SUBSECTIONS: readonly Section<StatusSubsectionId>[] = [
  { id: 'services', path: '/settings/status', labelKey: 'settings:status.nav.services' },
  { id: 'queue', path: '/settings/status/queue', labelKey: 'settings:status.nav.queue' },
  { id: 'ai', path: '/settings/status/ai', labelKey: 'settings:status.nav.ai' },
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

export function StatusPanel(props: SettingsPanelProps): ReactNode {
  const { t } = useT()
  const resource = useResource<Status>('/api/status')

  return (
    <Panel title={t('settings:status.title')} hint={t('settings:status.lede')}>
      <DataState resource={resource}>
        {(status) => <Report status={status} reload={resource.reload} {...props} />}
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
  reload,
  settings,
  state,
  owner,
  estimate,
}: SettingsPanelProps & {
  status: Status
  reload: () => void
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
        <ServicesGrid status={status} aiAvailability={settings.ai.availability} />
      ) : active === 'queue' ? (
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
      ) : (
        <AiUsage ai={settings.ai} state={state} owner={owner} estimate={estimate} />
      )}

      {/* Re-reads this panel's own endpoint. It starts nothing; the per-job buttons do.
          Shared across Services and Queue — the AI tab's own figures come from the
          settings payload instead, which this button does not touch. */}
      {active === 'ai' ? null : (
        <button type="button" className="button button--quiet" onClick={reload}>
          {t('action.refresh')}
        </button>
      )}
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
        href="/settings/status/ai"
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
 *
 * `href`, given only by the AI card, makes the whole card a link to its own tab — the
 * AI usage/cost history lives one click behind the card rather than on this grid, since
 * it is a monitoring view rather than an at-a-glance fact. Actual and Ghostfolio have no
 * `href`: their own detail (the job and probe rows behind their status) already has a
 * tab of its own — Queue — reachable from the strip above, so a second drill-in here
 * would be a second way to the same place.
 */
function ServiceCard({
  name,
  status,
  reason,
  lastSyncedAt,
  href,
}: {
  name: string
  status: string
  reason: string | null
  lastSyncedAt?: string | null
  href?: string
}): ReactNode {
  const { t } = useT()

  const body = (
    <>
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
    </>
  )

  if (href === undefined) return <div className="card status__service">{body}</div>

  return (
    <Link to={href} className="card status__service status__service--clickable">
      {body}
    </Link>
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

/** A count, Belgian grouping and no decimals: token totals reach six figures. */
const count = (value: number): string => formatDecimal(value, 0)

/**
 * What the assistant has cost this month, and what it cost before — moved here from its
 * own Settings tab, because nothing on it is a setting: it is read-only monitoring plus
 * the one button that starts an analysis by hand, which belongs beside the rest of "is
 * this instance working" rather than beside the thresholds and prompts that configure it.
 *
 * Figures are micro-euros, printed by `formatMicroEur` rather than divided here — one
 * analysis can cost €0,0004, and a page that rounded to cents would show `€ 0,00` beside
 * a button that charges for being pressed. The history is the server's, newest first, and
 * nothing on this panel is summed: `spentMicroEur` is a view over `ai_runs`, which is the
 * only place a month's total is computed.
 */
function AiUsage({
  ai,
  state,
  owner,
  estimate,
}: { ai: Settings['ai'] } & Pick<SettingsPanelProps, 'state' | 'owner' | 'estimate'>): ReactNode {
  const { t, language } = useT()

  return (
    <>
      <h3 className="panel__subtitle">{t('settings:ai.title')}</h3>
      <p className="panel__hint muted">
        {t('settings:ai.spend', {
          spent: formatMicroEur(ai.spentMicroEur),
          budget: formatMicroEur(ai.budgetMicroEur),
        })}
      </p>

      {ai.exceeded ? (
        <div className="notice notice--warn" role="status">
          <p className="notice__lead">{t('settings:ai.exceeded')}</p>
        </div>
      ) : null}

      <div className="grid-cards">
        <Metric
          label={t('settings:ai.spent')}
          value={formatMicroEur(ai.spentMicroEur)}
          unknown={t('empty.unknown')}
          note={t('settings:ai.used', { used: formatBp(ai.usedBp) })}
          {...(ai.exceeded ? { tone: 'negative' as const } : {})}
        />
        <Metric
          label={t('settings:ai.remaining')}
          value={formatMicroEur(ai.remainingMicroEur)}
          unknown={t('empty.unknown')}
          rows={[
            { label: t('settings:ai.month'), value: formatMonth(ai.month, language) },
            { label: t('settings:ai.budget'), value: formatMicroEur(ai.budgetMicroEur) },
            { label: t('settings:ai.model.fast'), value: ai.models.fast },
            { label: t('settings:ai.model.deep'), value: ai.models.deep },
          ]}
        />
      </div>

      {ai.availability.enabled ? (
        <Rerun state={state} owner={owner} estimate={estimate} />
      ) : (
        <RerunOff availability={ai.availability} />
      )}

      {ai.history.length === 0 ? null : (
        <>
          <h3 className="panel__subtitle">{t('settings:ai.history')}</h3>
          <ul className="months">
            {ai.history.map((month) => (
              <li className="months__row" key={month.month}>
                <span className="months__month">{formatMonth(month.month, language)}</span>
                <span className="months__cost num">{formatMicroEur(month.costMicroEur)}</span>
                <span className="months__meta muted num">
                  {t('settings:ai.runs')} {count(month.runCount)} ·{' '}
                  {t('settings:ai.tokens.input')} {count(month.inputTokens)} ·{' '}
                  {t('settings:ai.tokens.output')} {count(month.outputTokens)} ·{' '}
                  {t('settings:ai.tokens.cached')} {count(month.cachedTokens)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

/**
 * The one control on this page that spends money.
 *
 * Two presses rather than one. Everything else on the settings page is undoable — a
 * threshold can be set back, a prompt version can be re-activated — and this is not: the
 * call is made, the tokens are billed, and the month's remaining budget printed two
 * inches above is smaller than it was. A confirm step whose label carries the amount is
 * the cheapest way to make that a decision rather than a click.
 *
 * The price comes first and the button only exists once it has arrived. It is the page's
 * own read of `/api/ai/estimate` — the same number the prompt editor's test run prices
 * itself with, so the two cannot disagree — and it answers a `409` on a deployment that
 * has aggregated nothing, which is a sentence rather than a failure: there is no month to
 * analyse yet and no reason to offer a run.
 *
 * **Over budget it stays pressable.** The server takes that decision, not this button:
 * `POST /api/ai/refresh` accepts the request and the analysis degrades to the cached
 * answer with a banner, which is the documented behaviour of the cost guard and the only
 * way a reader can reach it. Disabling here would be a second cost rule in a different
 * place, and the warning line says what will happen instead.
 *
 * It does not join the refresh bar's polling. That bar waits on job rows, which is right
 * for four jobs that take a second each; an analysis takes as long as Gemini takes, and
 * the honest thing to say is where the result will appear rather than to spin until it
 * does.
 */
function Rerun({
  state,
  owner,
  estimate,
}: Pick<SettingsPanelProps, 'state' | 'owner' | 'estimate'>): ReactNode {
  const { t, language } = useT()
  const [armed, setArmed] = useState(false)
  const [started, setStarted] = useState<RefreshAccepted | null>(null)

  const priced: AiEstimate | null = estimate.data
  // The fresh-deployment answer, same as the prompt editor's: nothing aggregated, so no
  // month to price a run against. Any other failure leaves the section empty rather than
  // offering a button with no price on it. The other `409` from that endpoint — an
  // unavailable model — cannot reach here: this component is not rendered at all in that
  // case, which is the only reason one code can stand for one sentence (#165).
  const noMonth = estimate.error?.code === 'conflict'

  return (
    <section className="rerun">
      <h3 className="panel__subtitle">{t('settings:ai.rerun.title')}</h3>
      <p className="muted">{t('settings:ai.rerun.lede')}</p>

      {noMonth ? <p className="muted">{t('settings:ai.rerun.noMonth')}</p> : null}
      {priced === null ? null : (
        <>
          <p className="muted">
            {t('settings:ai.rerun.price', {
              month: formatMonth(priced.month, language),
              cost: formatMicroEur(priced.estimateMicroEur),
            })}
          </p>
          {priced.allowed || priced.reason === null ? null : (
            <p className="notice notice--warn" role="status">
              {t(`settings:ai.reason.${priced.reason}`)}
            </p>
          )}
          {armed ? (
            <div className="rerun__confirm">
              <button
                type="button"
                className="button"
                disabled={!owner || state.busy}
                onClick={() => {
                  state.ask<RefreshAccepted>(
                    'ai-refresh',
                    'POST',
                    '/api/ai/refresh',
                    undefined,
                    (accepted) => {
                      setArmed(false)
                      setStarted(accepted)
                    },
                  )
                }}
              >
                {state.pending === 'ai-refresh'
                  ? t('settings:ai.rerun.starting')
                  : t('settings:ai.rerun.confirm', {
                      cost: formatMicroEur(priced.estimateMicroEur),
                    })}
              </button>
              <button
                type="button"
                className="button button--quiet"
                disabled={state.busy}
                onClick={() => setArmed(false)}
              >
                {t('settings:ai.rerun.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="button button--quiet"
              disabled={!owner || state.busy}
              onClick={() => setArmed(true)}
            >
              {t('settings:ai.rerun.start')}
            </button>
          )}
        </>
      )}

      {started === null ? null : (
        <p className="muted" role="status">
          {t('settings:ai.rerun.started')}
        </p>
      )}
    </section>
  )
}

/**
 * The same section with the button removed and the reason in its place.
 *
 * Not a hidden control: a heading that disappears is read as a feature that was taken
 * away, and the number above it — a budget, a spend of zero — invites exactly the
 * question this answers. The wording is `ai:off.*`, shared with the panel on the
 * insights page, because two catalogues explaining the same three states in different
 * words is how one of them ends up wrong.
 *
 * No estimate is shown. Pricing a run that cannot start is what puts a figure in front
 * of someone as though pressing something would spend it.
 */
function RerunOff({ availability }: { availability: AiAvailabilityWire }): ReactNode {
  const { t } = useT()
  // Never null while `enabled` is false; the type cannot say so at this point.
  const reason = availability.reason ?? 'notConfigured'

  return (
    <section className="rerun">
      <h3 className="panel__subtitle">{t('settings:ai.rerun.title')}</h3>
      <p className="muted">{t(`ai:off.reason.${reason}`)}</p>
      <p className="muted">{t(`ai:off.how.${reason}`)}</p>
    </section>
  )
}
