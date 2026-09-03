/**
 * What is working, what is not, and how sure of that this process is.
 *
 * Three questions look alike and are not, and keeping them apart is the whole design
 * of this file and of `/healthz` next door:
 *
 *  - **Liveness** — can this process serve at all? `/healthz`, which touches nothing.
 *    A liveness check that consulted an upstream would restart the container because
 *    Ghostfolio was restarting, turning one degraded panel into a crash loop.
 *  - **Readiness** — should traffic be routed here? `ready` below, and it turns on
 *    exactly one thing: whether Balancr's own SQLite can be read. Everything else is
 *    reported and *does not* flip it. A failing upstream must not take the instance
 *    out of rotation, because the budget pages are served from the database and are
 *    still correct — pulling the container would replace a stale portfolio panel with
 *    a site that does not answer, which is strictly worse.
 *  - **Diagnosis** — what exactly is wrong? The rest of the payload, and it needs a
 *    session. See the note on messages below.
 *
 * There is deliberately no schema-version check. Migrations run at startup and are a
 * hard failure, so a process that is serving at all has already proved its schema is
 * current; a check here would be re-asking a question the boot sequence answers by
 * refusing to boot.
 *
 * **Why the reasons are codes rather than sentences.** A check reports `reason:
 * 'shapeMismatch'`, not "Ghostfolio answered with an unexpected shape", for the same
 * reason findings are codes: this application has two languages, and English prose
 * assembled on the server arrives on a Dutch settings page as English. The one thing
 * that does come through as text is the message an upstream or a job actually produced
 * — that is quoted, never translated, and never invented.
 *
 * **Why messages need a session.** `/readyz` is exempt from authentication, because a
 * container health check has no cookie and a 401 there would restart a healthy
 * instance. So it gets names and statuses only. The messages carry internal hostnames,
 * container addresses and upstream paths — `connect ECONNREFUSED 172.19.0.4:3333` is a
 * map of a private network — and handing that to anyone who can reach the port would
 * be a disclosure this application has no reason to make. `terse()` is what enforces
 * it: it builds the anonymous body by projection, so a field added below cannot leak by
 * being forgotten here.
 *
 * No `freshness` on this payload, alone among the endpoints in this directory. Every
 * other one carries it because a *figure* has to state its age; this response is that
 * age, for every job at once. A freshness block would be the same job table twice.
 */
import { config } from '../../../config.ts'
import type { Db } from '../../../db/index.ts'
import {
  describeSchedule,
  loadJobRows,
  loadProbes,
  registry,
  type JobRow,
  type ProbeState,
} from '../../../jobs/index.ts'
import { APP_REVISION, APP_VERSION } from '../../version.ts'
import { DATA_JOBS } from './freshness.ts'
import { statusSchema, type Status } from './schemas.ts'

const iso = (value: Date | null): string | null => value?.toISOString() ?? null

/** The schedule a job in the registry runs on, for the panel. Null if unregistered. */
function scheduleOf(name: string): string | null {
  const job = registry.find((candidate) => candidate.name === name)
  return job === undefined ? null : describeSchedule(job.schedule)
}

/**
 * Whether the database answers a trivial read.
 *
 * `select 1` rather than counting a table: the question is whether the file is open and
 * readable, not whether any particular row exists, and a fresh install has no rows. The
 * failure it catches is the real one — a volume that did not mount, a file whose
 * permissions changed under a non-root container, a disk with nothing left.
 */
function databaseReadable(db: Db): boolean {
  try {
    db.$client.prepare('select 1').get()
    return true
  } catch {
    return false
  }
}

/**
 * Actual's state, read from the sync job rather than from Actual.
 *
 * There is no cheap probe for Actual: reaching it means `downloadBudget`, which pulls
 * the whole budget file and takes the same `dataDir` lock the sync job holds. A probe
 * that expensive *is* the sync job, so this reports what that job last found. The
 * consequence is honest and worth stating: with jobs switched off, Actual's state is
 * whatever it was when something last ran, which is what `unknown` means here.
 */
type CheckVerdict = Pick<Status['checks'][number], 'status' | 'reason'>

function actualCheck(sync: JobRow | undefined): CheckVerdict {
  if (sync === undefined || (sync.lastRunAt === null && sync.lastSuccessAt === null)) {
    return { status: 'unknown', reason: 'neverRun' }
  }
  if (sync.status === 'error') return { status: 'failed', reason: 'jobFailed' }
  return { status: 'ok', reason: null }
}

/**
 * Ghostfolio's state, from the last probe.
 *
 * The two failures are not the same kind of thing and must not read as one. Unreachable
 * is transient by nature — a container restarting, a rejected token, a network that came
 * back — and the next probe will say so, so it is degraded. A shape mismatch is a
 * contract change: Ghostfolio answered, in a form no version of this code parses, and
 * nothing resolves it but a new Balancr. Reporting that as an outage waiting to pass is
 * how a permanent break gets waited out for a week.
 */
export function ghostfolioCheck(probe: ProbeState | undefined): CheckVerdict {
  if (probe === undefined) return { status: 'unknown', reason: 'neverRun' }
  if (probe.status === 'ok') return { status: 'ok', reason: null }
  if (probe.status === 'unreachable') return { status: 'degraded', reason: 'unreachable' }
  return { status: 'failed', reason: 'shapeMismatch' }
}

/**
 * Whether the scheduler is doing its work — taken as an argument rather than read from
 * `config` here, so the switched-off branch is testable without mocking the process.
 *
 * Off is a supported state, not a broken one: a second instance, or someone reading a
 * copy of the database. It is reported so that the age of everything else on the page
 * makes sense, and never as a failure. A failing data job is degraded rather than
 * failed, because every page is still served correctly from what the last successful
 * run wrote — just older than it looks.
 */
export function jobsCheck(rows: readonly JobRow[], enabled: boolean): CheckVerdict {
  if (!enabled) return { status: 'unknown', reason: 'jobsOff' }
  if (rows.some((row) => row.status === 'error')) return { status: 'degraded', reason: 'jobFailed' }
  if (rows.length === 0) return { status: 'unknown', reason: 'neverRun' }
  return { status: 'ok', reason: null }
}

export function buildStatus(db: Db): Status {
  // First, and on its own: everything below reads the database, so a database that
  // cannot be read has to be reported rather than thrown. A readiness endpoint that
  // answers 500 has told the orchestrator nothing it can act on.
  if (!databaseReadable(db)) {
    return statusSchema.parse({
      ready: false,
      degraded: true,
      at: new Date().toISOString(),
      version: APP_VERSION,
      revision: APP_REVISION,
      jobsEnabled: config.JOBS_ENABLED,
      checks: [
        { name: 'database', status: 'failed', reason: 'unreadable' },
        { name: 'actual', status: 'unknown', reason: 'unreadable' },
        { name: 'ghostfolio', status: 'unknown', reason: 'unreadable' },
        { name: 'jobs', status: 'unknown', reason: 'unreadable' },
      ],
      jobs: [],
      probes: [],
    })
  }

  const rows = loadJobRows(db)
  const byName = new Map(rows.map((row) => [row.name, row]))
  const probes = loadProbes(db)

  const actual = actualCheck(byName.get('sync'))

  const dataRows = DATA_JOBS.map((name) => byName.get(name)).filter(
    (row): row is JobRow => row !== undefined,
  )

  const checks: Status['checks'] = [
    { name: 'database', status: 'ok', reason: null },
    { name: 'actual', ...actual },
    { name: 'ghostfolio', ...ghostfolioCheck(probes.find((p) => p.source === 'ghostfolio')) },
    { name: 'jobs', ...jobsCheck(dataRows, config.JOBS_ENABLED) },
  ]

  return statusSchema.parse({
    // The database is readable, which is the whole of readiness. See the header.
    ready: true,
    degraded: checks.some((check) => check.name !== 'database' && check.status !== 'ok'),
    at: new Date().toISOString(),
    version: APP_VERSION,
    revision: APP_REVISION,
    jobsEnabled: config.JOBS_ENABLED,
    checks,
    jobs: rows.map((row) => ({
      name: row.name,
      status: row.status,
      lastRunAt: iso(row.lastRunAt),
      lastSuccessAt: iso(row.lastSuccessAt),
      nextRunAt: iso(row.nextRunAt),
      lastDurationMs: row.lastDurationMs,
      // Only while the status still says error: a message left by a failure a later
      // run fixed would report an outage that is over.
      error: row.status === 'error' ? row.error : null,
      schedule: scheduleOf(row.name),
    })),
    probes: probes.map((probe) => ({
      source: probe.source,
      status: probe.status,
      checkedAt: probe.checkedAt.toISOString(),
      // Null report means the stored JSON did not parse — an older build's shape. The
      // status above still stands, so the panel says "no detail" rather than nothing.
      checks: probe.report?.checks ?? [],
      warnings: probe.report?.warnings ?? [],
      detailAvailable: probe.report !== null,
    })),
  })
}

/**
 * The anonymous projection: names and statuses, no messages, no paths, no hostnames.
 *
 * Built by listing the fields that may leave rather than by deleting the ones that may
 * not, so a field added to `Status` is absent here until someone decides otherwise.
 */
export interface Readiness {
  ready: boolean
  degraded: boolean
  version: string | null
  at: string
  checks: { name: string; status: string }[]
}

export function terse(status: Status): Readiness {
  return {
    ready: status.ready,
    degraded: status.degraded,
    version: status.version,
    at: status.at,
    // `reason` is left out too. 'shapeMismatch' names a Ghostfolio contract to anyone
    // who asks; 'degraded' is all an orchestrator needs to decide anything.
    checks: status.checks.map((check) => ({ name: check.name, status: check.status })),
  }
}
