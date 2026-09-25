/**
 * Nightly sweep that nulls `requestText`/`responseText`/`payloadJson` on
 * `ai_runs` rows past `AI_RUNS_TEXT_RETENTION_DAYS` (#503, #539).
 *
 * The rest of a swept row is untouched and stays forever — cost, tokens, status
 * and period are what `ai_spend_monthly` and the ledger read, and none of that
 * ever depends on the verbatim text or the payload it was built from. Only the
 * three columns that can grow to thousands of tokens, or carry the one
 * unredacted field (the month note), per call are bounded.
 *
 * `cursor` remembers the cutoff this job last swept up to (#512) — the ledger
 * only grows, so without it every night's sweep re-scans every row ever swept
 * before, not just what turned stale since last night. Read via `ctx.cursor`
 * and handed to `clearStaleRunData` as `since`; the fresh `cutoff` computed
 * this run becomes tomorrow's cursor, returned only on success.
 *
 * Backups inherit this for free: `backupJob` runs after this one in the
 * nightly registry (`jobs/index.ts`), so the nightly snapshot only ever
 * captures a row's payload as this sweep left it, never the pre-retention one.
 */
import { config } from '../config.ts'
import { clearStaleRunData } from '../domain/ai/runs.ts'
import type { Job, JobContext, JobDetail } from './runner.ts'

async function run({ db, tenantId, now, log, cursor }: JobContext): Promise<JobDetail> {
  const days = config.AI_RUNS_TEXT_RETENTION_DAYS
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const since = cursor === undefined || cursor === null ? undefined : new Date(cursor)
  const cleared = clearStaleRunData(db, tenantId, cutoff, since)
  if (cleared > 0) {
    log.info({ cleared, cutoff: cutoff.toISOString() }, 'cleared stale AI run text and payload')
  }
  return { cleared, cutoffDays: days, cursor: cutoff.toISOString() }
}

export const aiRunsRetentionJob: Job = {
  name: 'ai-runs-retention',
  schedule: { kind: 'daily', hour: config.JOBS_NIGHTLY_HOUR },
  run,
}
