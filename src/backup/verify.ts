/**
 * Proving a backup is restorable, by restoring it.
 *
 * #38 asks for "a restore actually performed and documented, not assumed", and that
 * wording is the requirement. A backup job that reports success every night proves that
 * a file was written, nothing more. The failures that actually happen to backups —
 * a passphrase that was changed and not written down, a volume that filled halfway
 * through, bit rot in a file nobody read for a year, an encryption format changed by an
 * upgrade — are all invisible until someone decrypts the thing and opens it.
 *
 * So this decrypts a snapshot into a scratch directory, opens it as a database, and asks
 * SQLite whether it is intact. Three levels of check, each catching what the one before
 * it cannot:
 *
 *  - **Decryption** proves the passphrase is right and no byte has changed, because GCM
 *    authenticates the whole file.
 *  - **`PRAGMA integrity_check`** proves the pages hang together — indexes agree with
 *    their tables, no orphaned rows, no truncation SQLite can see. GCM would catch a
 *    corrupt *file*; this catches a database that was already corrupt when it was
 *    backed up faithfully.
 *  - **Row counts on the tables that cannot be recomputed** prove it is this
 *    deployment's data and not an empty database that happens to be valid. A snapshot
 *    of a freshly migrated schema passes both checks above and is worth nothing.
 *
 * Run by hand — `npm run backup:verify` — rather than nightly. The point of a verify is
 * that it is a different code path exercised by a person who will read the output; a
 * verify that ran automatically and logged `ok` at 03:05 would be the same false comfort
 * as the backup job, one level up.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { decryptFile } from './crypto.ts'

/**
 * The tables whose contents represent work a person did, in the order they matter.
 *
 * Everything not on this list is derived: `net_worth_snapshots`, `portfolio_*` and the
 * signals are all recomputed from Actual and Ghostfolio by the next nightly pass. The
 * rows below are not. Category descriptions and COICOP codes exist because somebody
 * answered questions about their own budget; prompt versions exist because somebody
 * edited and activated them; the AI ledger is the audit trail of what was sent to Google
 * and what it cost, which cannot be reconstructed from anything at all.
 *
 * `monthly_category_facts` is on the list anyway, last, as a volume check rather than a
 * value one — a snapshot with categories but no facts is a database that was backed up
 * before its first successful sync, which is not what anyone means by a backup.
 */
const WITNESS_TABLES = [
  'category_meta',
  'clarification_queue',
  'prompts',
  'ai_runs',
  'account_map',
  'users',
  'settings',
  'monthly_category_facts',
] as const

export interface VerifyResult {
  /** Bytes of the encrypted file, and of the database inside it. */
  encryptedBytes: number
  plainBytes: number
  /** `ok`, or whatever SQLite said instead. */
  integrity: string
  /** Total user tables, migration bookkeeping included. */
  tables: number
  /** The last migration the snapshot had applied, or null on one taken before any. */
  migratedAt: Date | null
  /** Row counts for `WITNESS_TABLES`. A missing table is reported as null, not zero. */
  rows: Record<string, number | null>
  /** True when the integrity check passed and the snapshot holds category knowledge. */
  ok: boolean
}

/** One `count(*)`, or null when the snapshot predates the table entirely. */
function countRows(sqlite: Database.Database, table: string): number | null {
  const exists = sqlite
    .prepare(`select 1 from sqlite_master where type = 'table' and name = ?`)
    .get(table)
  if (exists === undefined) return null

  // The identifier is interpolated because SQLite has no parameter form for one. Safe
  // here and only here: every value comes from WITNESS_TABLES, a literal tuple in this
  // file, and never from the snapshot or from a caller.
  const row = sqlite.prepare(`select count(*) as n from "${table}"`).get()
  return typeof row === 'object' && row !== null && 'n' in row && typeof row.n === 'number'
    ? row.n
    : null
}

function lastMigration(sqlite: Database.Database): Date | null {
  const exists = sqlite
    .prepare(`select 1 from sqlite_master where type = 'table' and name = '__drizzle_migrations'`)
    .get()
  if (exists === undefined) return null

  const row = sqlite.prepare('select max(created_at) as at from __drizzle_migrations').get()
  if (typeof row !== 'object' || row === null || !('at' in row)) return null
  return typeof row.at === 'number' ? new Date(row.at) : null
}

function scalar(row: unknown, column: string): unknown {
  return typeof row === 'object' && row !== null && column in row
    ? (row as Record<string, unknown>)[column]
    : undefined
}

/**
 * Decrypts `path`, opens it, and reports what is inside.
 *
 * The scratch copy is written under the OS temp directory and deleted in a `finally`,
 * including when the caller's own reporting throws. It is a full plaintext copy of the
 * database for the duration, which is the unavoidable cost of proving a backup works;
 * `mkdtemp` gives it a directory only this user can enter.
 *
 * Read-only on the open, so nothing here can leave a mark on the file it is checking —
 * and so a snapshot that needs WAL recovery is reported as damaged rather than quietly
 * repaired, which would let the verify pass on a file a real restore would struggle
 * with.
 */
export async function verifyBackup(path: string, passphrase: string): Promise<VerifyResult> {
  const scratch = await mkdtemp(join(tmpdir(), 'balancr-verify-'))
  const restored = join(scratch, 'restored.db')

  try {
    const encryptedBytes = (await stat(path)).size
    const plainBytes = await decryptFile(path, restored, passphrase)

    const sqlite = new Database(restored, { readonly: true })
    try {
      const check = sqlite.prepare('PRAGMA integrity_check').get()
      const integrityValue = scalar(check, 'integrity_check')
      const integrity = integrityValue === undefined ? 'unreadable' : String(integrityValue)

      const tableCount = scalar(
        sqlite.prepare(`select count(*) as n from sqlite_master where type = 'table'`).get(),
        'n',
      )

      const rows: Record<string, number | null> = {}
      for (const table of WITNESS_TABLES) rows[table] = countRows(sqlite, table)

      return {
        encryptedBytes,
        plainBytes,
        integrity,
        tables: typeof tableCount === 'number' ? tableCount : 0,
        migratedAt: lastMigration(sqlite),
        rows,
        // `category_meta` is the specific thing #38 says would "genuinely hurt" to
        // lose, so a technically valid snapshot with none of it is not a pass. Zero is
        // also the honest answer on a brand-new instance, which is why the CLI prints
        // every count rather than only the verdict.
        ok: integrity === 'ok' && (rows['category_meta'] ?? 0) > 0,
      }
    } finally {
      sqlite.close()
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
