/**
 * The nightly backup, as a job.
 *
 * Three things here that the modules underneath cannot assert about themselves:
 *
 *  - **No passphrase is a success, not a failure.** An instance whose volume is already
 *    covered by a host snapshot wants nothing from this job, and a red row in the `jobs`
 *    table every night would teach whoever reads that panel to ignore it. The detail
 *    says why it did nothing, so "backups are off" is still visible.
 *  - **A failed run never costs an old copy.** Pruning happens after the write, so an
 *    encryption that throws leaves the directory exactly as it was. A fortnight of
 *    failures must still have a fortnight of backups.
 *  - **It is last in the registry**, which is not a dependency fact — nothing reads a
 *    backup — but a timing one. Every nightly job becomes due in the same tick and runs
 *    in registry order, so anywhere earlier would snapshot the state from before that
 *    night's work.
 */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { categoryMeta } from '../../src/db/schema.ts'
import { isSnapshot, snapshotName } from '../../src/backup/snapshot.ts'
import { verifyBackup } from '../../src/backup/verify.ts'
import { config } from '../../src/config.ts'
import { registry } from '../../src/jobs/index.ts'
import { backupJob } from '../../src/jobs/backup.ts'
import type { Job, JobContext } from '../../src/jobs/runner.ts'

const log = pino({ level: 'silent' })
const PASS = 'a-passphrase-of-sixteen-plus'

let db: ReturnType<typeof createTestDb>['db']
let dir: string

beforeEach(() => {
  const test = createTestDb()
  db = test.db
  applyMigrations(db as never)
  db.insert(categoryMeta).values({ categoryId: 'c1', nameSnapshot: 'Groceries' }).run()

  dir = mkdtempSync(join(tmpdir(), 'balancr-job-backup-'))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

const context = (now: Date): JobContext => ({ db, log, now })

/**
 * The job as an instance configured this way would have it.
 *
 * A fresh module graph, because `config` validates and freezes at import — the same
 * arrangement `jobs-ai.test.ts` uses for the AI switch. Spying on the frozen object is
 * not an option, and it would be testing a different thing anyway: what is under test
 * here is what a `.env` produces.
 */
async function freshJob(env: Record<string, string | undefined>): Promise<Job> {
  vi.resetModules()
  vi.stubEnv('BACKUP_DIR', dir)
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return (await import('../../src/jobs/backup.ts')).backupJob
}

describe('backupJob', () => {
  it('is the last job in the registry', () => {
    expect(registry.at(-1)).toBe(backupJob)
  })

  it('runs overnight, on the same hour as the other nightly jobs', () => {
    expect(backupJob.schedule).toEqual({ kind: 'daily', hour: config.JOBS_NIGHTLY_HOUR })
  })

  it('stands down without a passphrase, and reports success', async () => {
    const job = await freshJob({ BACKUP_PASSPHRASE: undefined })

    const detail = await job.run(context(new Date('2026-09-03T03:00:00Z')))

    // Returning normally is the assertion. The job's contract is that a throw is a
    // failure, so anything other than a clean return here would put a red row on the
    // status panel of every instance that deliberately has no passphrase.
    expect(detail).toEqual({ skipped: true, reason: 'no-passphrase' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('writes a verifiable snapshot and says how big it was', async () => {
    const job = await freshJob({ BACKUP_PASSPHRASE: PASS, BACKUP_KEEP: '14' })
    const now = new Date('2026-09-03T03:00:12Z')

    const detail = await job.run(context(now))

    expect(readdirSync(dir)).toEqual([snapshotName(now)])
    expect(detail).toMatchObject({ skipped: false, kept: 14, pruned: 0 })

    const result = await verifyBackup(join(dir, snapshotName(now)), PASS)
    expect(result.ok).toBe(true)
    expect(result.rows['category_meta']).toBe(1)
  })

  it('prunes after writing, never before', async () => {
    // Old enough for the age clause, and with `keep` at one the count clause needs the
    // new snapshot to exist before the old file can be surplus.
    writeFileSync(join(dir, 'balancr-20260101T030000Z.db.enc'), 'x')
    const job = await freshJob({ BACKUP_PASSPHRASE: PASS, BACKUP_KEEP: '1' })

    const now = new Date('2026-09-03T03:00:12Z')
    const detail = await job.run(context(now))

    expect(detail).toMatchObject({ pruned: 1 })
    expect(readdirSync(dir)).toEqual([snapshotName(now)])
  })

  it('leaves the old copies alone when the write fails', async () => {
    const existing = 'balancr-20260101T030000Z.db.enc'
    writeFileSync(join(dir, existing), 'x')

    // A directory that cannot be written to is the realistic version of this: a full
    // volume, or a read-only mount. Whatever the cause, the run must not be the run that
    // deleted the last good backup on its way to failing — so the failure is injected at
    // the write and the assertion is about the directory that was already there.
    const job = await freshJob({
      BACKUP_PASSPHRASE: PASS,
      BACKUP_KEEP: '1',
      BACKUP_DIR: join(dir, 'a-file-not-a-directory'),
    })
    writeFileSync(join(dir, 'a-file-not-a-directory'), 'in the way')

    await expect(job.run(context(new Date('2026-09-03T03:00:12Z')))).rejects.toThrow()
    expect(readdirSync(dir).filter(isSnapshot)).toEqual([existing])
  })
})
