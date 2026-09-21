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
 * 2. **Nothing is deleted.** The database being replaced is renamed to a unique
 *    `<path>.pre-restore-<stamp>-<id>`, so restoring the wrong snapshot is undone
 *    with one `mv`. Cleaning those up is left to whoever ran the restore,
 *    deliberately.
 *
 * The `-wal` and `-shm` sidecars move with it. They belong to the database file they
 * were written beside, and leaving them next to a different one is the single way this
 * could corrupt data instead of just failing.
 */
import { randomUUID } from 'node:crypto'
import { chmod, lstat, rename, rm } from 'node:fs/promises'
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

export interface RollbackFailure {
  from: string
  to: string
  error: unknown
}

/**
 * Raised only when the restore failed and putting the live files back also failed.
 * The original error remains available as `cause`; every rollback error and the
 * retained verified replacement are named for manual recovery.
 */
export class RestoreRollbackError extends Error {
  constructor(
    readonly originalError: unknown,
    readonly rollbackFailures: readonly RollbackFailure[],
    readonly replacementPath: string,
  ) {
    const original = originalError instanceof Error ? originalError.message : String(originalError)
    const rollback = rollbackFailures
      .map(({ from, to, error }) =>
        `${from} -> ${to}: ${error instanceof Error ? error.message : String(error)}`,
      )
      .join('; ')
    super(
      `restore failed (${original}); rollback also failed (${rollback}). ` +
        `The verified replacement was kept at ${replacementPath} for manual recovery.`,
      { cause: originalError },
    )
    this.name = 'RestoreRollbackError'
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

/** Narrow injection seam for deterministic rename-failure tests. */
export interface RestoreOperations {
  rename: typeof rename
  reservationId: () => string
}

/** `2026-09-03T14:59:29Z` → `20260903T145929Z`, as the snapshot names use. */
export function stampOf(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

interface PlannedMove {
  from: string
  to: string
}

/** Plans only files that exist, then proves none of their destinations will be overwritten. */
async function planPreservation(target: string, stamp: string, id: string): Promise<PlannedMove[]> {
  const planned: PlannedMove[] = []
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${target}${suffix}`
    if (!(await pathExists(from))) continue
    planned.push({ from, to: `${from}${PRE_RESTORE}${stamp}-${id}` })
  }
  return planned
}

async function requireAbsent(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    if (await pathExists(path)) {
      throw new Error(`restore destination already exists: ${path} — nothing has been changed`)
    }
  }
}

export async function restoreBackup(
  request: RestoreRequest,
  operationOverrides: Partial<RestoreOperations> = {},
): Promise<RestoreResult> {
  const { from, to, passphrase, now } = request
  const stamp = stampOf(now)
  const move = operationOverrides.rename ?? rename
  const reservationId = (operationOverrides.reservationId ?? randomUUID)()

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
  const staging = `${to}.restore-${stamp}-${reservationId}`
  const planned = await planPreservation(to, stamp, reservationId)
  await requireAbsent([staging, ...planned.map(({ to: destination }) => destination)])

  const completed: PlannedMove[] = []
  let attemptedMove: PlannedMove | null = null
  let retainStaging = false
  try {
    await decryptFile(from, staging, passphrase)
    await chmod(staging, 0o600)
    try {
      for (const plannedMove of planned) {
        attemptedMove = plannedMove
        await move(plannedMove.from, plannedMove.to)
        completed.push(plannedMove)
        attemptedMove = null
      }

      // A process that created a new live path while the old one was being moved
      // aside must not have its file overwritten by POSIX rename semantics.
      if (await pathExists(to)) {
        throw new Error(`restore target reappeared before installation: ${to}`)
      }
      attemptedMove = { from: staging, to }
      await move(staging, to)
      attemptedMove = null
    } catch (originalError) {
      // A wrapper or unusual filesystem can report an error after the rename took
      // effect. Destination present plus source absent proves this move belongs in
      // the rollback even though its promise rejected.
      if (
        attemptedMove !== null &&
        !(await pathExists(attemptedMove.from)) &&
        (await pathExists(attemptedMove.to))
      ) {
        completed.push(attemptedMove)
      }

      const rollbackFailures: RollbackFailure[] = []
      for (const completedMove of [...completed].reverse()) {
        try {
          if (await pathExists(completedMove.from)) {
            throw new Error('original path is occupied; refusing to overwrite it', {
              cause: originalError,
            })
          }
          await move(completedMove.to, completedMove.from)
        } catch (error) {
          rollbackFailures.push({
            from: completedMove.to,
            to: completedMove.from,
            error,
          })
        }
      }

      if (rollbackFailures.length > 0) {
        retainStaging = true
        const replacementPath = (await pathExists(staging)) ? staging : to
        throw new RestoreRollbackError(originalError, rollbackFailures, replacementPath)
      }
      throw originalError
    }

    return {
      bytes: verified.plainBytes,
      verified,
      movedAside: planned.map(({ to: destination }) => destination),
    }
  } finally {
    // On incomplete rollback this may be the easiest valid replacement left. Keep
    // it and name it in RestoreRollbackError instead of deleting recovery material.
    if (!retainStaging) await rm(staging, { force: true })
  }
}
