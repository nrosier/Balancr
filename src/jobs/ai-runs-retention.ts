/**
 * Nightly sweep that nulls `requestText`/`responseText` on `ai_runs` rows past
 * `AI_RUNS_TEXT_RETENTION_DAYS` (#503).
 *
 * The rest of a swept row is untouched and stays forever — cost, tokens, status
 * and period are what `ai_spend_monthly` and the ledger read, and none of that
 * ever depends on the verbatim text. Only the two columns that can grow to
 * thousands of tokens per call are bounded.
 */
import { config } from '../config.ts'
import { clearStaleRunText } from '../domain/ai/runs.ts'
import type { Job, JobContext, JobDetail } from './runner.ts'

async function run({ db, tenantId, now, log }: JobContext): Promise<JobDetail> {
  const days = config.AI_RUNS_TEXT_RETENTION_DAYS
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const cleared = clearStaleRunText(db, tenantId, cutoff)
  if (cleared > 0) {
    log.info({ cleared, cutoff: cutoff.toISOString() }, 'cleared stale AI run text')
  }
  return { cleared, cutoffDays: days }
}

export const aiRunsRetentionJob: Job = {
  name: 'ai-runs-retention',
  schedule: { kind: 'daily', hour: config.JOBS_NIGHTLY_HOUR },
  run,
}
