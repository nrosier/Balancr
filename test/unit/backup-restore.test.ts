/**
 * The restore, which is the only operation here that can lose data.
 *
 * A backup system is judged on the day it is used, and the failure that matters is not
 * "the restore did not work" — it is "the restore did not work *and* the database it
 * replaced is gone". So the assertions come in pairs: what the good path produces, and
 * what the bad path left the target looking like. Every refusal below is checked by
 * reading the target file afterwards and finding it byte-for-byte unchanged.
 *
 * #38 asks for a restore "actually performed and documented, not assumed". This file is
 * the performed half kept honest on every run; the README carries the documented half.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { categoryMeta } from '../../src/db/schema.ts'
import { getSoleTenantId } from '../../src/db/tenant.ts'
import { writeSnapshot } from '../../src/backup/snapshot.ts'
import {
  PRE_RESTORE,
  RestoreRollbackError,
  restoreBackup,
  stampOf,
  UnusableBackupError,
} from '../../src/backup/restore.ts'

const PASS = 'a-passphrase-of-sixteen-plus'
const AT = new Date('2026-09-03T03:00:12Z')
const NOW = new Date('2026-09-14T09:30:00Z')

let dir: string
let snapshot: string

beforeEach(async () => {
  const { db } = createTestDb()
  applyMigrations(db as never)
  // One row of the kind that a resync cannot bring back: a description someone typed.
  db.insert(categoryMeta)
    .values({
      tenantId: getSoleTenantId(db),
      categoryId: 'c1',
      nameSnapshot: 'Groceries',
      userDescription: 'weekly shop',
    })
    .run()

  dir = mkdtempSync(join(tmpdir(), 'balancr-restore-'))
  snapshot = (await writeSnapshot(db, join(dir, 'backups'), PASS, AT)).path
})

/** What the restored database says about itself, read back through SQLite. */
async function description(path: string): Promise<string | null> {
  const { default: Database } = await import('better-sqlite3')
  const sqlite = new Database(path, { readonly: true })
  try {
    const row = sqlite.prepare('select user_description as d from category_meta').get()
    return typeof row === 'object' && row !== null && 'd' in row ? String(row.d) : null
  } finally {
    sqlite.close()
  }
}

describe('restoreBackup', () => {
  it('puts the database back where nothing was', async () => {
    const to = join(dir, 'balancr.db')

    const result = await restoreBackup({ from: snapshot, to, passphrase: PASS, now: NOW })

    expect(result.movedAside).toEqual([])
    expect(result.bytes).toBe(statSync(to).size)
    expect(await description(to)).toBe('weekly shop')
  })

  it('restores over a corrupted database and keeps the corrupted one', async () => {
    // The realistic case: the file is present and unreadable. SQLite will not open it,
    // so nothing can be salvaged from it — and it is still not this command's place to
    // delete it, because the operator may want to know what was in it.
    const to = join(dir, 'balancr.db')
    writeFileSync(to, 'not a database')

    const result = await restoreBackup({ from: snapshot, to, passphrase: PASS, now: NOW })

    expect(await description(to)).toBe('weekly shop')
    expect(result.movedAside).toHaveLength(1)
    expect(result.movedAside[0]).toMatch(
      new RegExp(`${PRE_RESTORE.replaceAll('.', '\\.')}\\d{8}T\\d{6}Z-[0-9a-f-]+$`),
    )
    expect(readFileSync(result.movedAside[0] ?? '', 'utf8')).toBe('not a database')
  })

  it('moves the -wal and -shm sidecars with the database they belong to', async () => {
    // The one way this operation could corrupt data rather than merely fail: a write
    // ahead log from a different database sitting next to the restored file.
    const to = join(dir, 'balancr.db')
    writeFileSync(to, 'old')
    writeFileSync(`${to}-wal`, 'stale log')
    writeFileSync(`${to}-shm`, 'stale index')

    const result = await restoreBackup({ from: snapshot, to, passphrase: PASS, now: NOW })

    expect(existsSync(`${to}-wal`)).toBe(false)
    expect(existsSync(`${to}-shm`)).toBe(false)
    expect(result.movedAside).toHaveLength(3)
    expect(await description(to)).toBe('weekly shop')
  })

  it('gives the restored file the mode a database with your finances should have', async () => {
    const to = join(dir, 'balancr.db')

    await restoreBackup({ from: snapshot, to, passphrase: PASS, now: NOW })

    expect(statSync(to).mode & 0o777).toBe(0o600)
  })

  it('leaves no staging file behind', async () => {
    const to = join(dir, 'balancr.db')

    await restoreBackup({ from: snapshot, to, passphrase: PASS, now: NOW })

    expect(readdirSync(dir).sort()).toEqual(['backups', 'balancr.db'])
  })

  it('refuses a wrong passphrase without touching the target', async () => {
    const to = join(dir, 'balancr.db')
    writeFileSync(to, 'the database that is still needed')

    await expect(
      restoreBackup({ from: snapshot, to, passphrase: 'a-different-passphrase', now: NOW }),
    ).rejects.toThrow(/authenticate/i)

    expect(readFileSync(to, 'utf8')).toBe('the database that is still needed')
    expect(readdirSync(dir).sort()).toEqual(['backups', 'balancr.db'])
  })

  it('refuses a damaged snapshot without touching the target', async () => {
    const to = join(dir, 'balancr.db')
    writeFileSync(to, 'the database that is still needed')
    const bytes = readFileSync(snapshot)
    bytes[200] = bytes.readUInt8(200) ^ 0x01
    chmodSync(snapshot, 0o600)
    writeFileSync(snapshot, bytes)

    await expect(
      restoreBackup({ from: snapshot, to, passphrase: PASS, now: NOW }),
    ).rejects.toThrow()

    expect(readFileSync(to, 'utf8')).toBe('the database that is still needed')
  })

  it('refuses a snapshot that decrypts but is not a usable database', async () => {
    // Reachable if a snapshot were ever taken of an empty or half-migrated database:
    // the file is authentic, the passphrase is right, and restoring it would still be
    // replacing a working database with a blank one.
    const { db } = createTestDb()
    applyMigrations(db as never)
    const empty = (await writeSnapshot(db, join(dir, 'empty'), PASS, AT)).path
    const to = join(dir, 'balancr.db')
    writeFileSync(to, 'the database that is still needed')

    await expect(
      restoreBackup({ from: empty, to, passphrase: PASS, now: NOW }),
    ).rejects.toThrow(UnusableBackupError)

    expect(readFileSync(to, 'utf8')).toBe('the database that is still needed')
  })

  it.each([
    [1, 'database preservation'],
    [2, 'WAL preservation'],
    [3, 'SHM preservation'],
    [4, 'staged database installation'],
  ] as const)('rolls back after a failure at rename step %i (%s)', async (failAt, _step) => {
    const to = join(dir, 'balancr.db')
    writeFileSync(to, 'live database')
    writeFileSync(`${to}-wal`, 'live wal')
    writeFileSync(`${to}-shm`, 'live shm')
    let calls = 0

    await expect(
      restoreBackup(
        { from: snapshot, to, passphrase: PASS, now: NOW },
        {
          reservationId: () => `failure-${String(failAt)}`,
          rename: async (from, destination) => {
            calls += 1
            if (calls === failAt) throw new Error(`injected rename failure ${String(failAt)}`)
            await rename(from, destination)
          },
        },
      ),
    ).rejects.toThrow(`injected rename failure ${String(failAt)}`)

    expect(readFileSync(to, 'utf8')).toBe('live database')
    expect(readFileSync(`${to}-wal`, 'utf8')).toBe('live wal')
    expect(readFileSync(`${to}-shm`, 'utf8')).toBe('live shm')
    expect(readdirSync(dir).filter((name) => name.includes(PRE_RESTORE))).toEqual([])
    expect(readdirSync(dir).filter((name) => name.includes('.restore-'))).toEqual([])
  })

  it('uses distinct preservation paths for restores in the same wall-clock second', async () => {
    const to = join(dir, 'balancr.db')
    writeFileSync(to, 'first live database')
    const first = await restoreBackup({ from: snapshot, to, passphrase: PASS, now: NOW })
    const second = await restoreBackup({ from: snapshot, to, passphrase: PASS, now: NOW })

    expect(first.movedAside).toHaveLength(1)
    expect(second.movedAside).toHaveLength(1)
    expect(first.movedAside[0]).not.toBe(second.movedAside[0])
    expect(readFileSync(first.movedAside[0] ?? '', 'utf8')).toBe('first live database')
    expect(existsSync(second.movedAside[0] ?? '')).toBe(true)
    expect(await description(to)).toBe('weekly shop')
  })

  it.each(['staging', 'database', 'wal', 'shm'] as const)(
    'preflights the %s destination before moving any live file',
    async (collision) => {
      const to = join(dir, 'balancr.db')
      writeFileSync(to, 'live database')
      writeFileSync(`${to}-wal`, 'live wal')
      writeFileSync(`${to}-shm`, 'live shm')
      const id = 'reserved-attempt'
      const stamp = stampOf(NOW)
      const destinations = {
        staging: `${to}.restore-${stamp}-${id}`,
        database: `${to}${PRE_RESTORE}${stamp}-${id}`,
        wal: `${to}-wal${PRE_RESTORE}${stamp}-${id}`,
        shm: `${to}-shm${PRE_RESTORE}${stamp}-${id}`,
      }
      writeFileSync(destinations[collision], 'must not be overwritten')

      await expect(
        restoreBackup(
          { from: snapshot, to, passphrase: PASS, now: NOW },
          { reservationId: () => id },
        ),
      ).rejects.toThrow(/destination already exists/)

      expect(readFileSync(to, 'utf8')).toBe('live database')
      expect(readFileSync(`${to}-wal`, 'utf8')).toBe('live wal')
      expect(readFileSync(`${to}-shm`, 'utf8')).toBe('live shm')
      expect(readFileSync(destinations[collision], 'utf8')).toBe('must not be overwritten')
    },
  )

  it('retains recovery material and both errors when rollback itself fails', async () => {
    const to = join(dir, 'balancr.db')
    writeFileSync(to, 'live database')
    writeFileSync(`${to}-wal`, 'live wal')
    writeFileSync(`${to}-shm`, 'live shm')
    const id = 'rollback-failure'
    let calls = 0

    const error = await restoreBackup(
      { from: snapshot, to, passphrase: PASS, now: NOW },
      {
        reservationId: () => id,
        rename: async (from, destination) => {
          calls += 1
          if (calls === 4) throw new Error('final installation failed')
          if (calls === 5) throw new Error('SHM rollback failed')
          await rename(from, destination)
        },
      },
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RestoreRollbackError)
    const rollbackError = error as RestoreRollbackError
    expect(rollbackError.cause).toBe(rollbackError.originalError)
    expect((rollbackError.originalError as Error).message).toBe('final installation failed')
    expect(rollbackError.rollbackFailures).toHaveLength(1)
    expect((rollbackError.rollbackFailures[0]?.error as Error).message).toBe('SHM rollback failed')

    // What could be restored is back. The failed sidecar and the fully verified
    // replacement remain named for manual recovery; cleanup removes neither.
    expect(readFileSync(to, 'utf8')).toBe('live database')
    expect(readFileSync(`${to}-wal`, 'utf8')).toBe('live wal')
    expect(existsSync(`${to}-shm`)).toBe(false)
    expect(existsSync(`${to}-shm${PRE_RESTORE}${stampOf(NOW)}-${id}`)).toBe(true)
    expect(existsSync(rollbackError.replacementPath)).toBe(true)
    expect(await description(rollbackError.replacementPath)).toBe('weekly shop')
  })
})
