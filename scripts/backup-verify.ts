#!/usr/bin/env tsx
/**
 * `npm run backup:verify` — decrypts a backup and proves it is restorable.
 *
 * #38 asks for a restore "actually performed and documented, not assumed", and this is
 * the performing half; the README carries the documented half. It is the answer to a
 * question no nightly job can answer about itself: the passphrase in `.env` today is
 * the one those files were written with, they decrypt, and what comes out is this
 * deployment's data rather than an empty schema.
 *
 * Run it after changing `BACKUP_PASSPHRASE`, after upgrading Balancr, and once in a
 * while for no reason — that last one is the whole point of having it.
 *
 *   npm run backup:verify                  # the newest snapshot
 *   npm run backup:verify -- --all         # every snapshot in BACKUP_DIR
 *   npm run backup:verify -- path/to.enc   # one named file
 *
 * It writes nothing except a plaintext copy in a private temp directory, which it
 * deletes. It never touches the file it is checking, never touches the live database,
 * and never calls an upstream, so it is safe against production.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { isSnapshot } from '../src/backup/snapshot.ts'
import { verifyBackup, type VerifyResult } from '../src/backup/verify.ts'

const heading = (text: string): void => void process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n`)
const ok = (text: string): void => void process.stdout.write(`  \x1b[32m✓\x1b[0m ${text}\n`)
const bad = (text: string): void => void process.stdout.write(`  \x1b[31m✗\x1b[0m ${text}\n`)
const line = (text: string): void => void process.stdout.write(`      ${text}\n`)

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MiB`

/**
 * Which files to check, from the arguments.
 *
 * A bare run checks only the newest, because that is the question being asked nearly
 * every time — "is the backup I would restore from tonight good" — and because
 * `--all` on a fortnight of snapshots is fourteen key derivations and fourteen full
 * decryptions. It is offered, and it is not the default.
 */
async function targets(args: string[]): Promise<string[]> {
  const paths = args.filter((arg) => !arg.startsWith('--'))
  if (paths.length > 0) return paths

  const names = (await readdir(config.BACKUP_DIR)).filter(isSnapshot).sort()
  if (names.length === 0) return []

  const chosen = args.includes('--all') ? names : names.slice(-1)
  return chosen.map((name) => join(config.BACKUP_DIR, name))
}

function report(result: VerifyResult): void {
  line(`${mib(result.encryptedBytes)} encrypted → ${mib(result.plainBytes)} database`)
  line(`integrity_check: ${result.integrity}`)
  line(
    `${String(result.tables)} tables, migrated ` +
      `${result.migratedAt === null ? 'never' : result.migratedAt.toISOString().slice(0, 10)}`,
  )
  for (const [table, count] of Object.entries(result.rows)) {
    line(`${table}: ${count === null ? 'table absent' : String(count)} rows`)
  }
}

async function main(): Promise<void> {
  const passphrase = config.BACKUP_PASSPHRASE
  if (passphrase === undefined) {
    process.stdout.write(
      '\nBACKUP_PASSPHRASE is not set, so there is nothing to verify and nothing being ' +
        'written.\nSet it in .env to switch nightly backups on.\n',
    )
    // Not an error. "Backups are off" is a valid configuration, and a CI step or a cron
    // wrapper around this script should not go red for a deployment that meant it.
    process.exit(0)
  }

  const files = await targets(process.argv.slice(2))
  if (files.length === 0) {
    // This one *is* an error: the passphrase says backups are wanted, and there are none.
    process.stdout.write(
      `\n\x1b[31mNo backups found in ${config.BACKUP_DIR}.\x1b[0m\n` +
        'Backups are configured but none exist yet — the job runs overnight, or start one\n' +
        'from Settings → Status → Backup.\n',
    )
    process.exit(1)
  }

  let failed = false
  for (const file of files) {
    heading(file)
    try {
      const result = await verifyBackup(file, passphrase)
      if (result.ok) ok('restored and verified')
      else {
        failed = true
        // Two quite different faults, so the line says which. An integrity failure is a
        // damaged database; empty `category_meta` is a snapshot of nothing worth keeping.
        bad(
          result.integrity === 'ok'
            ? 'restored, but holds no category knowledge — is this the right instance?'
            : 'restored, but the database inside is damaged',
        )
      }
      report(result)
    } catch (error) {
      failed = true
      bad(error instanceof Error ? error.message : String(error))
      line('A wrong passphrase and a damaged file look identical here — that is how')
      line('authenticated encryption works. Check BACKUP_PASSPHRASE first.')
    }
  }

  process.stdout.write(
    failed
      ? '\n\x1b[31mVerification failed.\x1b[0m These backups cannot be relied on.\n'
      : `\n\x1b[32mVerification passed.\x1b[0m ${String(files.length)} checked.\n`,
  )
  process.exit(failed ? 1 : 0)
}

await main()
