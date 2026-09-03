/**
 * Taking a snapshot of the database, and deciding which old ones to keep.
 *
 * **`VACUUM INTO`, not a file copy.** The database runs in WAL mode, so at any instant
 * the committed state is spread across `balancr.db` and `balancr.db-wal`, and a live
 * `cp` of either produces a file that is at best missing the last few transactions and
 * at worst structurally broken. `VACUUM INTO` asks SQLite to write a consistent,
 * defragmented copy while holding a read transaction — one statement, no coordination
 * with the writer, and the result is a plain database file that opens anywhere.
 *
 * It is also why this is safe to run beside the other jobs: a read transaction blocks
 * nothing in WAL mode. The job queue serialises it anyway, but not because it must.
 *
 * **`/data/actual` is deliberately not in here.** Actual's data directory is a local
 * cache of a sync server that still holds the budget; deleting it costs one
 * `downloadBudget` on the next run. Including it would multiply the size of every
 * snapshot by the largest thing in the volume in order to protect the one thing that
 * needs no protecting. What cannot be recomputed is in `balancr.db`: the category
 * descriptions and COICOP codes someone answered questions to build, the prompt
 * versions, the AI ledger. That is what this backs up.
 */
import { readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/index.ts'
import { encryptFile } from './crypto.ts'

/** `balancr-20260903T030112Z.db.enc` */
const PREFIX = 'balancr-'
const SUFFIX = '.db.enc'

/**
 * The name a snapshot taken at `at` gets.
 *
 * UTC, and stamped `Z` to say so, for one reason: these names are sorted as text to
 * decide what to delete. A local timestamp sorts wrongly across a DST change — the
 * hour that repeats in October would put a newer file before an older one, and the
 * pruner would delete the wrong end of the list.
 */
export function snapshotName(at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${PREFIX}${stamp}${SUFFIX}`
}

/** Whether a directory entry is one of ours, so pruning never touches a stranger's file. */
export function isSnapshot(name: string): boolean {
  return name.startsWith(PREFIX) && name.endsWith(SUFFIX)
}

/**
 * When the snapshot named `name` was taken, read back out of the name.
 *
 * From the name rather than from the file's mtime, because an mtime is whatever the
 * last thing to touch the file said it was — a `cp -r` of the backup directory, a
 * restore from a host snapshot, or an rsync without `-t` all rewrite it, and pruning by
 * a date that a copy operation can reset is how a retention policy quietly deletes
 * everything or nothing. The name travels with the bytes.
 *
 * Null for a name this build cannot parse, which the caller must treat as "do not
 * delete": an unrecognised file in the backup directory is either from a future version
 * or is not ours, and neither is something to remove on a guess.
 */
export function snapshotTime(name: string): Date | null {
  const stamp = /^balancr-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db\.enc$/.exec(name)
  if (stamp === null) return null

  const [, year, month, day, hour, minute, second] = stamp
  const date = `${String(year)}-${String(month)}-${String(day)}`
  const time = `${String(hour)}:${String(minute)}:${String(second)}`
  const at = new Date(`${date}T${time}Z`)
  return Number.isNaN(at.getTime()) ? null : at
}

export interface Snapshot {
  /** Full path of the encrypted file. */
  path: string
  /** Size of the encrypted file, which is the plaintext plus 58 bytes of framing. */
  bytes: number
  /** Size of the vacuumed database before encryption, for the "is this plausible" check. */
  plainBytes: number
}

/**
 * Writes one encrypted snapshot into `directory` and returns what it wrote.
 *
 * Two scratch files, both named so `isSnapshot` cannot match them, and the final name
 * only ever appears via `rename`. That is what makes a killed process harmless: a
 * half-written `.part` is invisible to the pruner and to any restore, whereas a
 * half-written `balancr-….db.enc` would be counted as a backup, kept for a fortnight,
 * and discovered to be unreadable on the one day it was needed.
 *
 * The intermediate plaintext is unavoidable: `VACUUM INTO` writes to a path, not to a
 * stream, so there is a window in which an unencrypted copy of the database exists. It
 * is narrowed as far as it can be — inside the backup directory at mode 0600 rather
 * than a shared `/tmp`, and removed in a `finally` whether or not the encryption
 * worked. Anyone troubled by that window should look at `DATABASE_PATH` first: the same
 * bytes live there unencrypted, permanently.
 */
export async function writeSnapshot(
  db: Db,
  directory: string,
  passphrase: string,
  at: Date,
): Promise<Snapshot> {
  mkdirSync(directory, { recursive: true, mode: 0o700 })

  const path = join(directory, snapshotName(at))
  const plain = `${path}.plain`
  const part = `${path}.part`

  // Both refuse an existing target — `VACUUM INTO` by design, `encryptFile` by opening
  // `wx` — so a leftover from a killed run would make every later backup fail with a
  // confusing message. Clearing them first is what makes the job self-healing.
  await rm(plain, { force: true })
  await rm(part, { force: true })

  try {
    db.run(sql`VACUUM INTO ${plain}`)
    const plainBytes = (await stat(plain)).size
    const bytes = await encryptFile(plain, part, passphrase)
    await rename(part, path)
    return { path, bytes, plainBytes }
  } finally {
    await rm(plain, { force: true })
    await rm(part, { force: true })
  }
}

/**
 * Deletes snapshots that are both older than `keep` days and surplus to `keep` files,
 * and returns the names it removed.
 *
 * Both clauses, and each one is there for a failure the other allows:
 *
 *  - **Older than `keep` days**, so a snapshot taken by hand never evicts a scheduled
 *    one. Retention by count alone would mean that pressing "Back up now" fourteen
 *    times before a risky change aged the entire fortnight of history out in an
 *    afternoon — and the person doing it would be someone deliberately trying to be
 *    careful.
 *  - **Surplus to `keep` files**, so an instance that was switched off for a month does
 *    not come back, run one backup and delete every copy it had for being old. That is
 *    the exact moment the old copies matter most.
 *
 * A consequence worth stating: on the daily schedule the count settles at `keep`, give
 * or take one file for a day when the run drifted a few seconds earlier than the one it
 * would have replaced. There is no upper bound on manual runs; disk is the only limit,
 * and a person pressing a button they can see the results of is a fair place to leave
 * that.
 *
 * Called only after a snapshot has been written successfully, and that order is the
 * point: pruning first would mean a run that fails at the encryption step has already
 * thrown away the oldest copy it had, so a fortnight of failures would leave nothing at
 * all. Failing runs must cost nothing.
 */
export async function prune(directory: string, keep: number, now: Date): Promise<string[]> {
  // Sorted, which for these names is oldest first — see `snapshotName`.
  const names = (await readdir(directory)).filter(isSnapshot).sort()
  const cutoff = now.getTime() - keep * 24 * 60 * 60 * 1000

  const doomed: string[] = []
  let remaining = names.length
  for (const name of names) {
    if (remaining <= keep) break
    const at = snapshotTime(name)
    // `break`, not `continue`. For the young case that is an optimisation the ordering
    // makes safe — the first file new enough to keep means every file after it is too.
    // For the undateable case it is the whole behaviour: a name this build cannot read
    // is either a future format or not ours, and neither is something to delete on a
    // guess. It still counted towards `remaining`, so it holds a place in the retention
    // window rather than silently widening it.
    if (at === null || at.getTime() >= cutoff) break
    doomed.push(name)
    remaining -= 1
  }

  for (const name of doomed) await unlink(join(directory, name))
  return doomed
}
