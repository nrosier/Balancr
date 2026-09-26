/**
 * Reversible encryption for short strings stored in the database — the
 * Actual/Ghostfolio/Gemini credentials #369/#371 move out of `.env` into
 * per-tenant rows. AES-256-GCM, keyed from `config.CONFIG_ENCRYPTION_KEY`
 * (raw key material, no per-write key derivation — see that variable's doc
 * comment for why this differs from `src/backup/crypto.ts`).
 *
 * Self-describing, but without that module's header: no magic bytes or
 * format version, because there is exactly one caller, one key source and
 * one algorithm, and a header only earns its keep once more than one of
 * those can vary.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from '../config.ts'

const ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const TAG_BYTES = 16

export class FieldCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FieldCryptoError'
  }
}

/** AES-256-GCM under `config.CONFIG_ENCRYPTION_KEY`. Returns base64 of `nonce || tag || ciphertext`. */
export function encryptField(plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGORITHM, config.CONFIG_ENCRYPTION_KEY, nonce, { authTagLength: TAG_BYTES })
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, tag, ciphertext]).toString('base64')
}

/**
 * Inverse of `encryptField`. Throws `FieldCryptoError` for a value too short
 * to hold a nonce and a tag; anything else — wrong key, a flipped bit, or a
 * value that never came from `encryptField` — fails GCM's own tag check
 * inside `.final()` and is let through unwrapped, because none of those
 * cases give the caller anything more actionable to do with the distinction.
 */
export function decryptField(encoded: string): string {
  const raw = Buffer.from(encoded, 'base64')
  if (raw.length < NONCE_BYTES + TAG_BYTES) {
    throw new FieldCryptoError(`ciphertext too short (${raw.length} bytes)`)
  }

  const nonce = raw.subarray(0, NONCE_BYTES)
  const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES)
  const ciphertext = raw.subarray(NONCE_BYTES + TAG_BYTES)

  const decipher = createDecipheriv(ALGORITHM, config.CONFIG_ENCRYPTION_KEY, nonce, { authTagLength: TAG_BYTES })
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
