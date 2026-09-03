#!/usr/bin/env tsx
/**
 * `npm run backup:restore` — puts a snapshot back.
 *
 * This command exists because the backup format is Balancr's own. There is no
 * `openssl enc` incantation that opens one of these files: the header carries the
 * scrypt parameters, the whole header is the AEAD's associated data, and the tag is the
 * last sixteen bytes. Without a restore command the nightly job would be writing files
 * that can only be read by writing code, which is not a backup.
 *
 *   npm run backup:restore -- --latest              # newest snapshot → DATABASE_PATH
 *   npm run backup:restore -- path/to/snapshot.enc  # a named one
 *   npm run backup:restore -- --latest --to /tmp/inspect.db
 *
 * Stop the server first. SQLite tolerates a great deal, but not having the file
 * underneath it replaced while it holds a connection to it.
 *
 * Everything that decides whether this is safe lives in `src/backup/restore.ts`, which
 * is tested; this file is argument parsing and output.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { isSnapshot } from '../src/backup/snapshot.ts'
import { restoreBackup } from '../src/backup/restore.ts'

const heading = (text: string): void => void process.stdout.write(`\n\x1b[1m${text}\x1b[0m\n`)
const ok = (text: string): void => void process.stdout.write(`  \x1b[32m✓\x1b[0m ${text}\n`)
const bad = (text: string): void => void process.stdout.write(`  \x1b[31m✗\x1b[0m ${text}\n`)
const line = (text: string): void => void process.stdout.write(`      ${text}\n`)

const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MiB`

/** `--to /some/path` → `/some/path`. */
function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

/**
 * Which file to restore from.
 *
 * `--latest` is spelled out rather than being what a bare run does: this command
 * replaces the database, and the newest snapshot is not always the one wanted —
 * whatever went wrong may already be in it.
 */
async function source(args: string[]): Promise<string | null> {
  const to = option(args, '--to')
  const named = args.filter((arg) => !arg.startsWith('--') && arg !== to)
  if (named[0] !== undefined) return named[0]
  if (!args.includes('--latest')) return null

  const names = (await readdir(config.BACKUP_DIR)).filter(isSnapshot).sort()
  const newest = names.at(-1)
  return newest === undefined ? null : join(config.BACKUP_DIR, newest)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const passphrase = config.BACKUP_PASSPHRASE
  const to = option(args, '--to') ?? config.DATABASE_PATH

  heading('Restore')

  if (passphrase === undefined) {
    bad('BACKUP_PASSPHRASE is not set, so nothing here can be decrypted.')
    line('It has to be the passphrase the snapshot was written with, not a new one.')
    process.exit(1)
  }

  const from = await source(args)
  if (from === null) {
    bad('Nothing to restore from.')
    line('Name a snapshot, or pass --latest to take the newest in BACKUP_DIR:')
    line(`  npm run backup:restore -- --latest        (${config.BACKUP_DIR})`)
    process.exit(1)
  }

  if (to === ':memory:') {
    bad('DATABASE_PATH is :memory:, which is not a file a restore can write to.')
    line('Pass --to <path> to say where the restored database should go.')
    process.exit(1)
  }

  line(`from ${from}`)
  line(`to   ${to}`)

  try {
    const result = await restoreBackup({ from, to, passphrase, now: new Date() })
    line(`integrity_check: ${result.verified.integrity}, ${String(result.verified.tables)} tables`)
    ok('snapshot verifies')
    ok(`restored ${mib(result.bytes)} to ${to}`)
    if (result.movedAside.length > 0) {
      line('the previous database is not deleted, it is beside it:')
      for (const path of result.movedAside) line(`  ${path}`)
    } else {
      line('there was nothing there to replace')
    }

    heading('Next')
    line("1. npm run db:migrate   — the snapshot may predate this build's schema")
    line('2. start the server, and check Settings → Status')
    line('3. the upstream figures re-sync on the next nightly run either way')
    if (result.movedAside.length > 0) {
      line('4. delete the .pre-restore- copies once you are satisfied')
    }
    process.stdout.write('\n')
  } catch (error) {
    bad(`Could not restore: ${error instanceof Error ? error.message : String(error)}`)
    line('A wrong passphrase and a damaged file look identical here — that is how')
    line('authenticated encryption works. Check BACKUP_PASSPHRASE first, then try an')
    line('older snapshot; `npm run backup:verify -- --all` says which ones are good.')
    line(`Nothing was changed: ${to} is as it was.`)
    process.exit(1)
  }
}

await main()
