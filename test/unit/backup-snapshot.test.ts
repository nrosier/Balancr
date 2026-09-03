/**
 * Taking a snapshot, naming it, and deciding what to delete.
 *
 * The snapshot half is straightforward — `VACUUM INTO` plus the format tested in
 * `backup-crypto.test.ts` — so what is asserted here is the surrounding bookkeeping,
 * which is where a backup system actually fails:
 *
 *  - **Nothing is left behind.** The intermediate plaintext and the partial ciphertext
 *    both exist for a moment, and both are named so a restore can never mistake them
 *    for a backup. A crash must not leave an unencrypted database in the directory.
 *  - **A leftover from a killed run does not break the next one.** `VACUUM INTO` and
 *    the `wx` open both refuse an existing target, so without the clearing step one
 *    interrupted night would fail every night after it.
 *  - **Retention deletes only what both clauses agree on.** The interesting cases are
 *    the two that a plain "keep the newest N" rule gets wrong: a manual backup must not
 *    evict a scheduled one, and an instance that was off for a month must not delete
 *    its own history on the way back up.
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations } from '../../src/db/apply-migrations.ts'
import { createTestDb } from '../../src/db/index.ts'
import { categoryMeta } from '../../src/db/schema.ts'
import {
  isSnapshot,
  prune,
  snapshotName,
  snapshotTime,
  writeSnapshot,
} from '../../src/backup/snapshot.ts'
import { verifyBackup } from '../../src/backup/verify.ts'

const PASS = 'a-passphrase-of-sixteen-plus'

let db: ReturnType<typeof createTestDb>['db']
let dir: string

beforeEach(() => {
  const test = createTestDb()
  db = test.db
  applyMigrations(db as never)
  dir = mkdtempSync(join(tmpdir(), 'balancr-snapshot-'))
})

/** A snapshot name for a given instant, as `at` would produce it. */
const nameAt = (iso: string): string => snapshotName(new Date(iso))

describe('snapshotName / snapshotTime', () => {
  it('round-trips an instant through the filename', () => {
    const at = new Date('2026-09-03T03:00:12.456Z')
    expect(snapshotName(at)).toBe('balancr-20260903T030012Z.db.enc')
    expect(snapshotTime(snapshotName(at))?.toISOString()).toBe('2026-09-03T03:00:12.000Z')
  })

  it('sorts chronologically as text', () => {
    // This is the property the pruner depends on, and the reason the stamp is UTC. A
    // local timestamp would put the repeated hour of the October DST change out of
    // order, and the pruner would delete from the wrong end of the list.
    const names = [
      nameAt('2026-10-25T02:30:00Z'),
      nameAt('2026-10-25T00:30:00Z'),
      nameAt('2026-01-01T00:00:00Z'),
    ]
    expect([...names].sort()).toEqual([names[2], names[1], names[0]])
  })

  it('refuses to date a name it does not recognise', () => {
    // Null means "do not delete this", so every one of these has to be null rather than
    // an epoch date, which would read as very old and be deleted first.
    expect(snapshotTime('balancr-2026-09-03.db.enc')).toBeNull()
    expect(snapshotTime('balancr-20261403T030012Z.db.enc')).toBeNull()
    expect(snapshotTime('notes.txt')).toBeNull()
  })

  it('recognises only its own files', () => {
    expect(isSnapshot('balancr-20260903T030012Z.db.enc')).toBe(true)
    expect(isSnapshot('balancr-20260903T030012Z.db.enc.plain')).toBe(false)
    expect(isSnapshot('balancr-20260903T030012Z.db.enc.part')).toBe(false)
    expect(isSnapshot('some-other-backup.db.enc')).toBe(false)
  })
})

describe('writeSnapshot', () => {
  it('writes a snapshot that verifies', async () => {
    db.insert(categoryMeta).values({ categoryId: 'c1', nameSnapshot: 'Groceries' }).run()

    const at = new Date('2026-09-03T03:00:12Z')
    const snapshot = await writeSnapshot(db, dir, PASS, at)
    expect(snapshot.path).toBe(join(dir, snapshotName(at)))

    const result = await verifyBackup(snapshot.path, PASS)
    expect(result.ok).toBe(true)
    expect(result.integrity).toBe('ok')
    expect(result.rows['category_meta']).toBe(1)
    // The whole schema came along, not just the tables that were written to.
    expect(result.tables).toBeGreaterThan(20)
  })

  it('leaves no plaintext and no partial file behind', async () => {
    const at = new Date('2026-09-03T03:00:12Z')
    await writeSnapshot(db, dir, PASS, at)

    // The plaintext is the one thing in this whole feature that must not survive: it is
    // an unencrypted copy of the database sitting in a directory whose entire purpose is
    // that its contents are encrypted.
    expect(readdirSync(dir)).toEqual([snapshotName(at)])
  })

  it('recovers from scratch files left by a killed run', async () => {
    const at = new Date('2026-09-03T03:00:12Z')
    const path = join(dir, snapshotName(at))
    writeFileSync(`${path}.plain`, 'a vacuum that was interrupted')
    writeFileSync(`${path}.part`, 'an encryption that was interrupted')

    // Without the clearing step this throws: `VACUUM INTO` refuses an existing target
    // and so does the `wx` open. One interrupted night would then fail every night after
    // it, which is the failure mode where a backup system is least likely to be noticed.
    await expect(writeSnapshot(db, dir, PASS, at)).resolves.toBeDefined()
    expect(readdirSync(dir)).toEqual([snapshotName(at)])
  })

  it('creates the directory it was pointed at', async () => {
    const nested = join(dir, 'a', 'b')
    expect(existsSync(nested)).toBe(false)
    await writeSnapshot(db, nested, PASS, new Date('2026-09-03T03:00:12Z'))
    expect(existsSync(nested)).toBe(true)
  })
})

describe('prune', () => {
  /** Empty files with real snapshot names — the pruner reads names, never contents. */
  function seed(...isos: string[]): void {
    for (const iso of isos) writeFileSync(join(dir, nameAt(iso)), 'x')
  }

  const remaining = (): string[] => readdirSync(dir).sort()

  it('deletes the oldest once there are more than `keep`', async () => {
    seed('2026-09-01T03:00:00Z', '2026-09-02T03:00:00Z', '2026-09-03T03:00:00Z')

    const removed = await prune(dir, 2, new Date('2026-09-03T03:00:01Z'))
    expect(removed).toEqual([nameAt('2026-09-01T03:00:00Z')])
    expect(remaining()).toEqual([nameAt('2026-09-02T03:00:00Z'), nameAt('2026-09-03T03:00:00Z')])
  })

  it('keeps a young surplus, so a manual backup never evicts a scheduled one', async () => {
    // Four files inside a two-day window with keep = 2. A "newest N" rule would delete
    // two of them — which is what would happen to someone pressing "Back up now" before
    // a risky change, i.e. the person being most careful.
    seed(
      '2026-09-02T03:00:00Z',
      '2026-09-03T03:00:00Z',
      '2026-09-03T14:00:00Z',
      '2026-09-03T14:05:00Z',
    )

    expect(await prune(dir, 2, new Date('2026-09-03T14:10:00Z'))).toEqual([])
    expect(remaining()).toHaveLength(4)
  })

  it('keeps an old shortfall, so a restart after an outage deletes nothing', async () => {
    // Two files, both months old, keep = 14. Age alone would delete both — at the exact
    // moment they are the only copies that exist.
    seed('2026-06-01T03:00:00Z', '2026-06-02T03:00:00Z')

    expect(await prune(dir, 14, new Date('2026-09-03T03:00:00Z'))).toEqual([])
    expect(remaining()).toHaveLength(2)
  })

  it('never touches a file that is not a snapshot', async () => {
    seed('2026-09-01T03:00:00Z', '2026-09-02T03:00:00Z')
    writeFileSync(join(dir, 'README-restore.txt'), 'how to restore this')
    writeFileSync(join(dir, 'balancr-20260901T030000Z.db.enc.plain'), 'leftover')

    // A backup directory is somewhere a person keeps things — notes, a copy made by
    // hand, an export from something else. The pruner deletes what it wrote and nothing
    // else, which is why `isSnapshot` is an exact pattern rather than a suffix guess.
    await prune(dir, 1, new Date('2026-09-03T03:00:00Z'))
    expect(remaining()).toContain('README-restore.txt')
    expect(remaining()).toContain('balancr-20260901T030000Z.db.enc.plain')
  })

  it('never deletes a snapshot-shaped name it cannot date', async () => {
    // What a future format would look like to this build: our prefix and suffix, a stamp
    // it cannot read. Deleting it would be deleting a backup on a guess, and treating an
    // unreadable date as the epoch — the other obvious implementation — would delete it
    // first of all, as the oldest file in the directory.
    writeFileSync(join(dir, 'balancr-v2-something.db.enc'), 'x')
    seed('2026-06-01T03:00:00Z', '2026-06-02T03:00:00Z')

    const removed = await prune(dir, 1, new Date('2027-01-01T00:00:00Z'))
    expect(removed).not.toContain('balancr-v2-something.db.enc')
    expect(remaining()).toContain('balancr-v2-something.db.enc')
  })

  it('counts a name it cannot date towards the floor', async () => {
    // The consequence of the rule above, asserted because it is the surprising half: an
    // undateable file is still a backup as far as "how many do I have" is concerned, so
    // it holds a place and an older dateable one rolls off to make room. The alternative
    // — ignore it entirely — would quietly raise the retention count by one for ever.
    writeFileSync(join(dir, 'balancr-v2-something.db.enc'), 'x')
    seed('2026-06-01T03:00:00Z', '2026-06-02T03:00:00Z')

    expect(await prune(dir, 2, new Date('2027-01-01T00:00:00Z'))).toEqual([
      nameAt('2026-06-01T03:00:00Z'),
    ])
  })
})
