/**
 * Asking Ghostfolio whether it still answers the way this build parses.
 *
 * `probe.ts` in the adapter has existed since `0.2.0` and until now nothing called it,
 * which made the startup capability check the plan describes a function rather than a
 * guarantee. This is what calls it — as a job, not at startup, and the difference is
 * the point: a check that runs once at boot has already gone stale by the time anyone
 * reads it, and a container that has been up for a week would report a contract it
 * verified against a Ghostfolio that has since been upgraded underneath it.
 *
 * **The report is written before the failure is raised.** A job that threw first and
 * recorded nothing would leave the status panel with no idea which path broke, which is
 * the only fact worth having. So: probe, persist, then fail if the verdict was not ok.
 *
 * Failing on a bad verdict rather than swallowing it is deliberate too. The probe never
 * throws on its own — it reports — so a job that simply returned would show `ok` in the
 * `jobs` table while Ghostfolio was returning nonsense, and `lastSuccessAt` would mean
 * "the probe ran" instead of "the upstream was healthy". The second is the useful
 * reading, and it is only true if a bad verdict is an error.
 *
 * It sits first in the registry, ahead of `portfolio`. Nothing depends on it, but when
 * Ghostfolio's shape has changed the portfolio job fails too, and a log where the
 * diagnosis precedes the symptom is worth the ordering. The extra cost is one
 * authentication: the probe resets the cached JWT on purpose, so an expired token is
 * diagnosed here rather than surfacing later as a mystery failure in a real job.
 */
import { describeProbeFailure, probeGhostfolio } from '../adapters/ghostfolio/probe.ts'
import type { ProbeCheck } from '../adapters/ghostfolio/probe.ts'
import { config } from '../config.ts'
import { saveProbe, type StoredReport } from './probe-state.ts'
import type { Job, JobContext, JobDetail } from './runner.ts'

/**
 * The adapter's check as the stored one.
 *
 * Written out field by field rather than spread, because `exactOptionalPropertyTypes`
 * makes `error?: string` and `error: string | undefined` different types, and because
 * a spread would carry any field a future adapter adds into the stored JSON without
 * anyone deciding it should be there.
 */
const storedCheck = (check: ProbeCheck): StoredReport['checks'][number] => ({
  path: check.path,
  status: check.status,
  detail: check.detail,
  ...(check.error === undefined ? {} : { error: check.error }),
})

async function run({ db, log }: JobContext): Promise<JobDetail> {
  const report = await probeGhostfolio()

  const stored: StoredReport = {
    checks: report.checks.map(storedCheck),
    warnings: [...report.warnings],
  }
  saveProbe(db, 'ghostfolio', report.status, stored, report.at)

  const failure = describeProbeFailure(report)
  if (failure !== null) throw new Error(failure)

  // Only on success: a failure is already logged by the probe itself, per path.
  log.debug({ checks: stored.checks.length, warnings: stored.warnings.length }, 'probe stored')

  return {
    status: report.status,
    checks: stored.checks.length,
    warnings: stored.warnings.length,
  }
}

export const probeJob: Job = {
  name: 'probe',
  // The same cadence as the reads it vouches for. Probing more often would learn
  // nothing the next portfolio fetch would not; probing less often would let
  // `/readyz` describe an upstream state that is older than the data on the page.
  schedule: { kind: 'interval', minutes: config.JOBS_SYNC_INTERVAL_MINUTES },
  run,
}
