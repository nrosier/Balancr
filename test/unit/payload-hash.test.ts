/**
 * `hashPayload` only has one job: move when anything in the payload moves, and
 * stay put when nothing does (#160). It is a thin wrapper over
 * `JSON.stringify` + sha256, so the tests are about that contract rather than
 * about hashing itself.
 */
import { describe, expect, it } from 'vitest'
import { hashPayload } from '../../src/domain/ai/payload-hash.ts'

describe('hashPayload', () => {
  it('is deterministic: the same payload hashes the same', () => {
    const payload = { month: '2026-08', categories: [{ label: 'c1', spentCents: 42_000 }] }
    expect(hashPayload(payload)).toBe(hashPayload(payload))
    expect(hashPayload(payload)).toBe(
      hashPayload({ month: '2026-08', categories: [{ label: 'c1', spentCents: 42_000 }] }),
    )
  })

  it('moves when any field changes, however small', () => {
    const before = hashPayload({ month: '2026-08', categories: [{ label: 'c1', spentCents: 42_000 }] })
    const after = hashPayload({ month: '2026-08', categories: [{ label: 'c1', spentCents: 42_001 }] })
    expect(after).not.toBe(before)
  })

  it('is sensitive to key order, since JSON.stringify is', () => {
    // Not a claim that this is the ideal behaviour, only that it is the actual
    // one: `hashPayload` mirrors `monthFingerprint`'s exact convention rather
    // than building a canonicalised hash, and callers build the payload in a
    // fixed shape rather than relying on order-independence here.
    const a = hashPayload({ a: 1, b: 2 })
    const b = hashPayload({ b: 2, a: 1 })
    expect(a).not.toBe(b)
  })

  it('looks like a sha256 hex digest', () => {
    expect(hashPayload({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })
})
