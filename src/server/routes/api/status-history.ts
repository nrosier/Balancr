/**
 * `GET /api/status/history?job=` — one job's past attempts, most recent first.
 *
 * Split out from `/api/status` on purpose: that payload is polled broadly and stays
 * light, while this one is bounded, paged, and only fetched when a row is expanded.
 * See `status.ts`'s own header for why the two are already separate fetches.
 *
 * `?job=` is validated against the registry rather than trusted, same posture the
 * frontend's `REFRESHABLE` list already takes on "run now": a stray or renamed job
 * name is a client bug, not a job with no history yet.
 */
import type { Db } from '../../../db/index.ts'
import { findJob, loadJobRuns, type JobRunRow, type JobStep } from '../../../jobs/index.ts'
import { badRequest } from '../../errors.ts'
import { jobHistorySchema, type JobHistory } from './schemas.ts'

/** Past this, the query param is refused rather than silently clamped. */
export const MAX_HISTORY_LIMIT = 100
const DEFAULT_HISTORY_LIMIT = 20

const iso = (value: Date | null): string | null => value?.toISOString() ?? null

/**
 * `stepsJson` is written by this same codebase, but a row from an older build may
 * predate the column meaning anything — parsed defensively rather than trusted.
 *
 * `error` defaults to `null` for a step that has none: a build before this
 * normalisation existed wrote an ok step with the key absent rather than `null`
 * (see `runner.ts`'s `makeStep`), and the wire schema — like `JobStepRow` on the
 * frontend — expects the key to always be there.
 */
function parseSteps(row: JobRunRow): JobStep[] {
  try {
    const parsed = JSON.parse(row.stepsJson)
    if (!Array.isArray(parsed)) return []
    return (parsed as Partial<JobStep>[]).map((step) => ({
      name: step.name ?? '',
      status: step.status === 'error' ? 'error' : 'ok',
      durationMs: typeof step.durationMs === 'number' ? step.durationMs : 0,
      error: step.error ?? null,
    }))
  } catch {
    return []
  }
}

function resolveLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_HISTORY_LIMIT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > MAX_HISTORY_LIMIT) {
    throw badRequest(`limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}.`)
  }
  return value
}

export function buildJobHistory(db: Db, jobParam: unknown, limitParam: unknown): JobHistory {
  if (typeof jobParam !== 'string' || findJob(jobParam) === undefined) {
    throw badRequest('job must name a registered job.')
  }
  const limit = resolveLimit(limitParam)

  const runs = loadJobRuns(db, jobParam, limit)

  return jobHistorySchema.parse({
    jobName: jobParam,
    runs: runs.map((run) => ({
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: iso(run.finishedAt),
      durationMs: run.durationMs,
      error: run.error,
      steps: parseSteps(run),
    })),
  })
}
