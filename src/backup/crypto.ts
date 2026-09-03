/**
 * The on-disk format of a backup, and the only code that encrypts or decrypts one.
 *
 * A backup is the one artefact Balancr writes that an attacker can take away and work
 * on at leisure. Nothing else here is like that: a session cookie expires, an API call
 * is over in a second, but a file sitting in a directory is offline-attackable at
 * whatever rate the attacker's hardware allows, for as long as they like. So the
 * choices below are made for that threat and not for speed.
 *
 * **AES-256-GCM, not AES-CBC or a bare stream cipher.** GCM authenticates as well as
 * encrypts, so a file that was altered — a flipped bit in a bad sector, a truncated
 * copy, a deliberate edit — fails to decrypt instead of yielding a plausible-looking
 * SQLite file with wrong numbers in it. For a backup that is the whole point: silence
 * about corruption is worse than a refusal, because a restore from a corrupt file is
 * discovered months later.
 *
 * **scrypt for the key, not the passphrase directly.** A passphrase is not 32 random
 * bytes and pretending otherwise is how these formats fail. scrypt's cost parameters
 * make each guess expensive in memory as well as time, which is what keeps a GPU from
 * turning a decent passphrase into an afternoon's work.
 *
 * **The header is self-describing, and it is authenticated.** Every parameter needed to
 * derive the key again — the KDF, its cost, the salt — is written into the file, so a
 * future Balancr that raises the cost still reads today's backups. And the header is fed
 * to GCM as additional authenticated data, so an attacker cannot rewrite `log2(N)` down
 * to 1 and hand the file back for a cheap crack: the tag would no longer verify.
 *
 * ```
 * offset  bytes  meaning
 *      0      8  magic, ASCII "BALANCR1"
 *      8      1  format version (1)
 *      9      1  KDF id (1 = scrypt)
 *     10      1  log2 of the scrypt N parameter
 *     11      1  scrypt r
 *     12      1  scrypt p
 *     13      1  reserved, zero
 *     14     16  KDF salt
 *     30     12  AES-GCM nonce
 *     42      …  ciphertext
 * end-16     16  AES-GCM authentication tag
 * ```
 *
 * The tag is at the end rather than in the header because the file is written as a
 * stream: GCM only knows the tag once the last byte has gone through it, and buffering
 * a whole database in memory to put the tag at the front would defeat the point.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

/** ASCII, so `file` and `head -c 8` both identify one of these without this module. */
const MAGIC = Buffer.from('BALANCR1', 'ascii')

const FORMAT_VERSION = 1
const KDF_SCRYPT = 1

const SALT_BYTES = 16
/** 96 bits, the size GCM is specified for. Longer nonces are hashed and gain nothing. */
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

export const HEADER_BYTES = MAGIC.length + 6 + SALT_BYTES + NONCE_BYTES

/**
 * What new backups are written with. Read from the header when decrypting, never
 * assumed, so raising these does not orphan the files already on disk.
 *
 * N = 2^15 costs about 32 MiB and 80 ms per derivation here. The knob is deliberately
 * not at the top of the scale: this runs once per nightly backup and once per verify,
 * so a slower setting would be free — but it also runs on whatever hardware someone
 * restores on, possibly years from now and possibly in a hurry, and a restore that
 * needs half a gigabyte of RAM to start is a worse failure than a cheaper KDF.
 */
const SCRYPT = { logN: 15, r: 8, p: 1 } as const

/**
 * Twice the memory scrypt is asked for.
 *
 * Node's default `maxmem` is exactly 32 MiB, which is exactly what N = 2^15, r = 8
 * needs — so the default rejects these parameters by a rounding error rather than by
 * intent. Stated explicitly, with room for a future bump, instead of tuning the cost
 * down to fit a limit that is not the real constraint.
 */
const MAXMEM = 256 * 1024 * 1024

/** The parameters a particular file was written with. */
interface Header {
  bytes: Buffer
  salt: Buffer
  nonce: Buffer
  logN: number
  r: number
  p: number
}

/** Raised for every rejected file, so a caller can tell "not ours" from "I/O died". */
export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupFormatError'
  }
}

function buildHeader(): Header {
  const salt = randomBytes(SALT_BYTES)
  const nonce = randomBytes(NONCE_BYTES)
  const bytes = Buffer.alloc(HEADER_BYTES)

  MAGIC.copy(bytes, 0)
  bytes[MAGIC.length] = FORMAT_VERSION
  bytes[MAGIC.length + 1] = KDF_SCRYPT
  bytes[MAGIC.length + 2] = SCRYPT.logN
  bytes[MAGIC.length + 3] = SCRYPT.r
  bytes[MAGIC.length + 4] = SCRYPT.p
  bytes[MAGIC.length + 5] = 0
  salt.copy(bytes, MAGIC.length + 6)
  nonce.copy(bytes, MAGIC.length + 6 + SALT_BYTES)

  return { bytes, salt, nonce, logN: SCRYPT.logN, r: SCRYPT.r, p: SCRYPT.p }
}

/**
 * Reads a header, rejecting anything it cannot fully account for.
 *
 * Every field is checked before the passphrase is used, because the alternative is an
 * 80 ms key derivation followed by a tag mismatch — which reports "wrong passphrase"
 * for a file that was never a backup at all, and sends whoever is restoring at 2am
 * looking for the wrong problem.
 */
function readHeader(bytes: Buffer, label: string): Header {
  if (bytes.length < HEADER_BYTES) {
    throw new BackupFormatError(`${label} is too short to be a Balancr backup`)
  }
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupFormatError(`${label} is not a Balancr backup`)
  }

  const version = bytes[MAGIC.length]
  if (version !== FORMAT_VERSION) {
    throw new BackupFormatError(
      `${label} is backup format ${String(version)}; this build reads ${String(FORMAT_VERSION)}`,
    )
  }

  const kdf = bytes[MAGIC.length + 1]
  if (kdf !== KDF_SCRYPT) {
    throw new BackupFormatError(`${label} uses key derivation ${String(kdf)}, which is unknown`)
  }

  const logN = bytes[MAGIC.length + 2] ?? 0
  const r = bytes[MAGIC.length + 3] ?? 0
  const p = bytes[MAGIC.length + 4] ?? 0
  // An upper bound as well as a lower one. `logN` comes off disk, and 2^64 would not
  // be a slow decrypt, it would be a process that never returns — a denial of service
  // spelled with one byte. The tag would catch the tampering, but only after the
  // derivation it is meant to guard, which is the wrong order.
  if (logN < 10 || logN > 22 || r < 1 || p < 1) {
    throw new BackupFormatError(`${label} declares key-derivation parameters out of range`)
  }

  return {
    bytes: bytes.subarray(0, HEADER_BYTES),
    salt: bytes.subarray(MAGIC.length + 6, MAGIC.length + 6 + SALT_BYTES),
    nonce: bytes.subarray(MAGIC.length + 6 + SALT_BYTES, HEADER_BYTES),
    logN,
    r,
    p,
  }
}

/**
 * scrypt, awaited.
 *
 * Wrapped by hand rather than with `promisify`, whose declared signature for `scrypt`
 * drops the options argument — and the options are the whole point here, since the cost
 * parameters come out of the file's own header. Not `scryptSync` either: 80 ms of
 * blocked event loop inside a running server would stall every in-flight HTTP request,
 * and this runs in that process every night.
 */
function deriveKey(passphrase: string, header: Header): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      header.salt,
      KEY_BYTES,
      { N: 2 ** header.logN, r: header.r, p: header.p, maxmem: MAXMEM },
      (error, key) => (error === null ? resolve(key) : reject(error)),
    )
  })
}

/**
 * Encrypts `source` to `destination`, streaming, and returns the bytes written.
 *
 * `wx` on the output: an existing file is an error rather than an overwrite. Nothing in
 * this app should ever be replacing a backup, and a bug that made two runs collide on a
 * name would otherwise destroy the older copy silently.
 */
export async function encryptFile(
  source: string,
  destination: string,
  passphrase: string,
): Promise<number> {
  const header = buildHeader()
  const key = await deriveKey(passphrase, header)
  const cipher = createCipheriv('aes-256-gcm', key, header.nonce)
  cipher.setAAD(header.bytes)

  await pipeline(
    createReadStream(source),
    cipher,
    // The framing, as a generator rather than two writes around a pipeline: it puts the
    // header before the first ciphertext byte and the tag after the last one, and
    // `getAuthTag` is only legal once the cipher has finalised — which, inside the
    // pipeline, is exactly when this loop ends.
    async function* frame(encrypted: AsyncIterable<Buffer>) {
      yield header.bytes
      for await (const chunk of encrypted) yield chunk
      yield cipher.getAuthTag()
    },
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
  )

  return (await stat(destination)).size
}

/**
 * Decrypts `source` to `destination`, streaming, and returns the plaintext bytes.
 *
 * Throws `BackupFormatError` for a file this build cannot read and a plain `Error` from
 * the cipher for one it can read but cannot authenticate — a wrong passphrase and a
 * damaged file are indistinguishable at that point, which is a property of GCM and not
 * something to paper over with a guess in the message.
 */
export async function decryptFile(
  source: string,
  destination: string,
  passphrase: string,
): Promise<number> {
  const size = (await stat(source)).size
  if (size < HEADER_BYTES + TAG_BYTES) {
    throw new BackupFormatError(`${source} is too short to be a Balancr backup`)
  }

  const handle = await open(source, 'r')
  try {
    const raw = Buffer.alloc(HEADER_BYTES)
    await handle.read(raw, 0, HEADER_BYTES, 0)
    const header = readHeader(raw, source)

    const tag = Buffer.alloc(TAG_BYTES)
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES)

    const key = await deriveKey(passphrase, header)
    const decipher = createDecipheriv('aes-256-gcm', key, header.nonce)
    decipher.setAAD(header.bytes)
    decipher.setAuthTag(tag)

    await pipeline(
      // Inclusive end, hence the -1: the tag is not ciphertext, and feeding it to the
      // decipher would make every file fail to authenticate.
      handle.createReadStream({ start: HEADER_BYTES, end: size - TAG_BYTES - 1, autoClose: false }),
      decipher,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    )
  } finally {
    await handle.close()
  }

  return (await stat(destination)).size
}

/** Whether `bytes` starts a Balancr backup. For listing a directory, not for trusting one. */
export function looksLikeBackup(bytes: Buffer): boolean {
  return bytes.length >= MAGIC.length && bytes.subarray(0, MAGIC.length).equals(MAGIC)
}
