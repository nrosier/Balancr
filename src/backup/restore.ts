/**
 * Putting a snapshot back.
 *
 * The order of operations here is the whole file, because a restore is the one
 * operation in Balancr that can destroy data rather than merely fail at producing
 * some. Two rules follow from that, and both are asserted in
 * `test/unit/backup-restore.test.ts`:
 *
 * 1. **Nothing moves until the snapshot has been decrypted and integrity-checked in
 *    full.** A wrong passphrase, a truncated file or a database that opens but fails
 *    `PRAGMA integrity_check` all stop while the current database is still in place.
 *    Restoring from a broken backup would otherwise turn a recoverable situation into
 *    the unrecoverable one.
 * 2. **Nothing is deleted.** The database being replaced is renamed to
 *    `<path>.pre-restore-<stamp>`, so restoring the wrong snapshot is undone with one
 *    `mv`. Cleaning those up is left to whoever ran the restore, deliberately.
 *
 * The `-wal` and `-shm` sidecars move with it. They belong to the database file they
 * were written beside, and leaving them next to a different one is the single way this
 * could corrupt data instead of just failing.
 */
import { existsSync } from 'node:fs'
import { chmod, rename, rm } from 'node:fs/promises'
import { decryptFile } from './crypto.ts'
import { verifyBackup, type VerifyResult } from './verify.ts'

/** Suffix pattern for the copies a restore leaves behind, so a caller can find them. */
export const PRE_RESTORE = '.pre-restore-'

/** Raised when the snapshot decrypts but is not a database worth restoring. */
export class UnusableBackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnusableBackupError'
  }
}

export interface RestoreRequest {
  /** The encrypted snapshot to read. */
  from: string
  /** Where the database should end up — normally `config.DATABASE_PATH`. */
  to: string
  passphrase: string
  /** Stamps the names of the files moved aside; the caller's clock, for tests. */
  now: Date
}

export interface RestoreResult {
  /** Size of the restored database, in bytes. */
  bytes: number
  /** What the snapshot proved about itself before it was put in place. */
  verified: VerifyResult
  /** Paths the previous database and its sidecars were renamed to. */
  movedAside: string[]
}

/** `2026-09-03T14:59:29Z` → `20260903T145929Z`, as the snapshot names use. */
export function stampOf(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

async function standAside(target: string, stamp: string): Promise<string[]> {
  const moved: string[] = []
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${target}${suffix}`
    if (!existsSync(path)) continue
    const aside = `${path}${PRE_RESTORE}${stamp}`
    await rename(path, aside)
    moved.push(aside)
  }
  return moved
}

export async function restoreBackup(request: RestoreRequest): Promise<RestoreResult> {
  const { from, to, passphrase, now } = request
  const stamp = stampOf(now)

  // Throws on a wrong passphrase or a damaged file, before anything has been touched.
  const verified = await verifyBackup(from, passphrase)
  if (!verified.ok) {
    throw new UnusableBackupError(
      `that snapshot decrypts but does not verify (integrity_check: ${verified.integrity}, ` +
        `${String(verified.tables)} tables) — nothing has been changed`,
    )
  }

  // Staged beside the target rather than in a temp directory, so the final step is a
  // rename within one filesystem: atomic, and it cannot fail halfway across a device
  // boundary having already moved the old database out of the way.
  const staging = `${to}.restore-${stamp}`
  await rm(staging, { force: true })
  try {
    await decryptFile(from, staging, passphrase)
    await chmod(staging, 0o600)
    const movedAside = await standAside(to, stamp)
    await rename(staging, to)
    return { bytes: verified.plainBytes, verified, movedAside }
  } finally {
    await rm(staging, { force: true })
  }
}
