/**
 * The per-field encryption `src/db/field-crypto.ts` uses for credentials that
 * move out of `.env` into the database (#369/#371). The properties that
 * matter are the same as for the backup format in `backup-crypto.test.ts`:
 * round-tripping is necessary but not sufficient — a format with no
 * integrity at all would pass that too. There is no header here to tamper
 * with separately, since the wire format carries no metadata beyond the
 * nonce and the tag.
 */
import { describe, expect, it } from 'vitest'
import { FieldCryptoError, decryptField, encryptField } from '../../src/db/field-crypto.ts'

describe('encryptField / decryptField', () => {
  it('round-trips', () => {
    const plaintext = 'a-fairly-long-actual-budget-password'
    expect(decryptField(encryptField(plaintext))).toBe(plaintext)
  })

  it('round-trips the empty string', () => {
    expect(decryptField(encryptField(''))).toBe('')
  })

  it('round-trips non-ASCII content', () => {
    const plaintext = 'wachtwoord-métà-€uro-日本語'
    expect(decryptField(encryptField(plaintext))).toBe(plaintext)
  })

  it('produces a different ciphertext each time, since the nonce is random', () => {
    const plaintext = 'same-plaintext-both-times'
    expect(encryptField(plaintext)).not.toBe(encryptField(plaintext))
  })

  /** Flips one bit at `index` in a freshly-encrypted value and returns it re-encoded. */
  function tamperedAt(index: number): string {
    const raw = Buffer.from(encryptField('some-secret-value'), 'base64')
    raw.writeUInt8(raw.readUInt8(index) ^ 0xff, index)
    return raw.toString('base64')
  }

  it('fails to decrypt a flipped byte in the ciphertext', () => {
    expect(() => decryptField(tamperedAt(28))).toThrow() // byte 0 of the ciphertext
  })

  it('fails to decrypt a flipped byte in the auth tag', () => {
    expect(() => decryptField(tamperedAt(12))).toThrow() // byte 0 of the tag
  })

  it('fails to decrypt a flipped byte in the nonce', () => {
    expect(() => decryptField(tamperedAt(0))).toThrow() // byte 0 of the nonce
  })

  it('refuses a value too short to hold a nonce and a tag', () => {
    expect(() => decryptField(Buffer.from('short').toString('base64'))).toThrow(FieldCryptoError)
  })

  it('refuses garbage that was never produced by encryptField', () => {
    expect(() => decryptField(Buffer.alloc(40).toString('base64'))).toThrow()
  })
})
