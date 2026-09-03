/**
 * The nightly snapshot.
 *
 * What this protects is narrower than "the data", and worth naming precisely. Almost
 * everything in `balancr.db` is derived: the monthly facts, the baselines, the signals,
 * the net-worth series and the portfolio metrics are all recomputed from Actual and
 * Ghostfolio, so losing them costs one nightly pass. What is not derived is the
 * accumulated knowledge about the budget — every category description, COICOP code,
 * `nature` and sensitivity flag that exists because somebody answered a question about
 * their own envelopes — plus the prompt versions and the AI ledger. None of that is
 * anywhere else. That is what #38 means by "the one thing here that cannot be
 * recomputed", and it is what this job exists for.
 *
 * **No passphrase means the job stands down, successfully.** Not an error, not a
 * warning on every tick: an instance whose volume is already covered by a host
 * snapshot or a restic job wants nothing from this, and telling it off nightly would
 * train someone to ignore a red job row. Logged once at `info` per run with the
 * variable to set, the same shape the AI layer takes without a key (#165).
 *
 * **It is registered last, and that is a decision about time rather than dependency.**
 * Nothing reads a backup, so ordering cannot be derived from the dependency graph. But
 * every job with a nightly schedule becomes due in the same tick and runs in registry
 * order, so a backup placed anywhere earlier would capture the state from before that
 * night's work. Last means the file on disk is the newest thing this instance knew.
 *
 * The reverse case — wanting the state from *before* a nightly pass that went wrong —
 * is what `BACKUP_KEEP` answers, and better: the damage is usually noticed days later,
 * so what is wanted is last Tuesday's file, not this morning's pre-pass one.
 */
import { config } from '../config.ts'
import { prune, writeSnapshot } from '../backup/snapshot.ts'
import type { Job, JobContext, JobDetail } from './runner.ts'

async function run({ db, log, now }: JobContext): Promise<JobDetail> {
  const passphrase = config.BACKUP_PASSPHRASE
  if (passphrase === undefined) {
    log.info(
      { variable: 'BACKUP_PASSPHRASE' },
      'backups are switched off; set a passphrase to enable them',
    )
    return { skipped: true, reason: 'no-passphrase' }
  }

  const snapshot = await writeSnapshot(db, config.BACKUP_DIR, passphrase, now)
  // Only after a successful write. See `prune`: a run that fails must never be the run
  // that deleted the last good copy.
  const removed = await prune(config.BACKUP_DIR, config.BACKUP_KEEP, now)

  // The path is logged, the passphrase is not, and neither is anything from inside the
  // database — a `JobDetail` ends up in the `jobs` table, which the status panel shows.
  log.info(
    { file: snapshot.path, bytes: snapshot.bytes, pruned: removed.length },
    'backup written',
  )

  return {
    skipped: false,
    bytes: snapshot.bytes,
    plainBytes: snapshot.plainBytes,
    kept: config.BACKUP_KEEP,
    pruned: removed.length,
  }
}

export const backupJob: Job = {
  name: 'backup',
  // The nightly hour, like the other four, and last among them by registry position.
  // Hourly would be wrong in both directions: it multiplies the write volume by 24 for
  // a set of facts that only change once a night, and it would push a fortnight of
  // retention down to fourteen hours.
  schedule: { kind: 'daily', hour: config.JOBS_NIGHTLY_HOUR },
  run,
}
