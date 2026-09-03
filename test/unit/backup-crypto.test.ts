/**
 * The backup file format.
 *
 * These assertions are about the one artefact Balancr writes that an attacker can carry
 * away and work on offline, so the properties being checked are not "it round-trips" —
 * that would pass for a format with no integrity at all. What is checked is that every
 * way a backup can be wrong ends in a refusal:
 *
 *  - a wrong passphrase
 *  - a byte changed anywhere in the ciphertext
 *  - a byte changed in the *header*, which is not encrypted and would otherwise be
 *    freely editable — including the key-derivation cost, whose whole point is that it
 *    cannot be turned down by whoever holds the file
 *  - a truncated file, which is what a full disk produces
 *  - a file that was never a backup
 *
 * The last two are distinguished from the first three deliberately: a
 * `BackupFormatError` means "this build cannot read this file", which is actionable,
 * while a cipher failure means "this file is not what it claims", which is not
 * recoverable and must not be reported as a version problem.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BackupFormatError,
  HEADER_BYTES,
  decryptFile,
  encryptFile,
  looksLikeBackup,
} from '../../src/backup/crypto.ts'

const PASS = 'a-passphrase-of-sixteen-plus'

/** A private scratch directory per test, so nothing here can collide or leak. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'balancr-crypto-'))
}

/** A plaintext big enough to span more than one stream chunk. */
function source(dir: string, size = 200_000): string {
  const path = join(dir, 'plain')
  writeFileSync(path, Buffer.alloc(size, 'balancr'))
  return path
}

describe('encryptFile / decryptFile', () => {
  it('round-trips the exact bytes', async () => {
    const dir = scratch()
    const plain = source(dir)
    const enc = join(dir, 'out.enc')

    const encBytes = await encryptFile(plain, enc, PASS)
    // 58 bytes of framing: a 42-byte header plus a 16-byte GCM tag. Asserted as an
    // identity rather than a constant, so a format change has to be deliberate.
    expect(encBytes).toBe(200_000 + HEADER_BYTES + 16)

    const back = join(dir, 'back')
    expect(await decryptFile(enc, back, PASS)).toBe(200_000)
    expect(readFileSync(back).equals(readFileSync(plain))).toBe(true)
  })

  it('writes a file that identifies itself', async () => {
    const dir = scratch()
    await encryptFile(source(dir, 64), join(dir, 'out.enc'), PASS)

    const head = readFileSync(join(dir, 'out.enc')).subarray(0, 8)
    expect(head.toString('ascii')).toBe('BALANCR1')
    expect(looksLikeBackup(head)).toBe(true)
    expect(looksLikeBackup(Buffer.from('SQLite f'))).toBe(false)
  })

  it('refuses to overwrite an existing file', async () => {
    const dir = scratch()
    const enc = join(dir, 'out.enc')
    await encryptFile(source(dir, 64), enc, PASS)

    // `wx`, not `w`. A bug that made two runs agree on a name must not be able to
    // destroy the older backup silently.
    await expect(encryptFile(source(dir, 64), enc, PASS)).rejects.toThrow(/EEXIST/)
  })

  it('rejects a wrong passphrase', async () => {
    const dir = scratch()
    const enc = join(dir, 'out.enc')
    await encryptFile(source(dir, 64), enc, PASS)

    await expect(decryptFile(enc, join(dir, 'back'), 'a-different-passphrase-x')).rejects.toThrow(
      /authenticate/i,
    )
  })

  it('rejects a single changed ciphertext byte', async () => {
    const dir = scratch()
    const enc = join(dir, 'out.enc')
    await encryptFile(source(dir, 4096), enc, PASS)

    const bytes = await readFile(enc)
    // `^=` would read the byte back through an index, which `noUncheckedIndexedAccess`
    // types as possibly undefined. `readUInt8` range-checks instead of widening.
    bytes[HEADER_BYTES + 100] = bytes.readUInt8(HEADER_BYTES + 100) ^ 0x01
    await writeFile(enc, bytes)

    await expect(decryptFile(enc, join(dir, 'back'), PASS)).rejects.toThrow(/authenticate/i)
  })

  it('rejects a changed header, because the header is authenticated', async () => {
    const dir = scratch()
    const enc = join(dir, 'out.enc')
    await encryptFile(source(dir, 4096), enc, PASS)

    // Byte 13 is the reserved padding — no code reads it, and only GCM's additional
    // authenticated data makes editing it detectable. If this test ever passes a
    // decryption, the header has stopped being covered by the tag and every parameter
    // in it has become attacker-controlled.
    const bytes = await readFile(enc)
    bytes[13] = 0x7f
    await writeFile(enc, bytes)

    await expect(decryptFile(enc, join(dir, 'back'), PASS)).rejects.toThrow(/authenticate/i)
  })

  it('rejects key-derivation parameters out of range before deriving anything', async () => {
    const dir = scratch()
    const enc = join(dir, 'out.enc')
    await encryptFile(source(dir, 64), enc, PASS)

    // log2(N) = 40 would be a terabyte of scrypt memory: not a slow decrypt but a
    // process that never returns, spelled with one byte. The tag would catch the edit,
    // but only after the derivation it is supposed to guard — so the range check has to
    // come first, and a `BackupFormatError` rather than a cipher error is how this test
    // knows it did.
    const bytes = await readFile(enc)
    bytes[10] = 40
    await writeFile(enc, bytes)

    await expect(decryptFile(enc, join(dir, 'back'), PASS)).rejects.toThrow(BackupFormatError)
  })

  it('names the problem for a file that is not a backup', async () => {
    const dir = scratch()
    const foreign = join(dir, 'foreign.enc')
    writeFileSync(foreign, Buffer.alloc(500, 0x41))

    await expect(decryptFile(foreign, join(dir, 'back'), PASS)).rejects.toThrow(
      /is not a Balancr backup/,
    )
  })

  it('names the problem for a truncated file', async () => {
    const dir = scratch()
    const enc = join(dir, 'out.enc')
    await encryptFile(source(dir, 4096), enc, PASS)

    // What a disk that filled up mid-write leaves behind. Reported as a format problem
    // and not as a cipher failure, because "the file is short" is a fact this build can
    // state without the passphrase.
    await writeFile(enc, (await readFile(enc)).subarray(0, HEADER_BYTES + 8))
    await expect(decryptFile(enc, join(dir, 'back'), PASS)).rejects.toThrow(BackupFormatError)
  })

  it('reports a future format version rather than guessing at it', async () => {
    const dir = scratch()
    const enc = join(dir, 'out.enc')
    await encryptFile(source(dir, 64), enc, PASS)

    const bytes = await readFile(enc)
    bytes[8] = 2
    await writeFile(enc, bytes)

    await expect(decryptFile(enc, join(dir, 'back'), PASS)).rejects.toThrow(
      /backup format 2; this build reads 1/,
    )
  })

  it('gives two encryptions of the same input different bytes', async () => {
    const dir = scratch()
    const plain = source(dir, 4096)
    await encryptFile(plain, join(dir, 'a.enc'), PASS)
    await encryptFile(plain, join(dir, 'b.enc'), PASS)

    // A fresh salt and nonce per file. Equal ciphertexts would mean one of the two is
    // being reused, and nonce reuse under GCM leaks the plaintext difference outright.
    expect(readFileSync(join(dir, 'a.enc')).equals(readFileSync(join(dir, 'b.enc')))).toBe(false)
  })
})
